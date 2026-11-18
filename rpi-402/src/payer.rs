//! Buying a credential: quote, limits, a durable intent, one send, the
//! preimage, then the credential and receipt. Also reconciling intents whose
//! outcome a cancel, timeout, or restart left unknown.

use crate::challenge::L402Challenge;
use crate::plugin::Plugin;
use crate::store::{self, Intent, IntentStatus, Receipt, Token};
use crate::util::{self, format_sat};
use crate::wallet::{Quote, SendState};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Every limit refusal starts with this, so it reads as a budget decision.
const OUT_OF_BUDGET: &str = "rpi-402: out of budget:";

/// How long to wait for the wallet's activity stream to answer before
/// sending anyway. A wallet with history answers at once; an idle one only
/// after its first event, which may be the send itself.
const SUBSCRIBE_GRACE: Duration = Duration::from_secs(2);

/// What to buy a credential for.
#[derive(Clone, Debug)]
pub struct Purchase {
    pub cache_key: String,
    pub url: String,
    pub model: String,
    pub challenge: L402Challenge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayError {
    /// A limit or the balance refused the payment; nothing was sent.
    Refused(String),
    /// The request was cancelled before anything was sent.
    Aborted,
    /// A payment may have been sent and its outcome is not known.
    Unresolved(String),
    /// The payment failed or could not start.
    Failed(String),
}

impl fmt::Display for PayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PayError::Refused(message)
            | PayError::Unresolved(message)
            | PayError::Failed(message) => f.write_str(message),
            PayError::Aborted => f.write_str("Request aborted"),
        }
    }
}

/// The outcome of asking the wallet about a recorded intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// The payment settled; its credential and receipt are stored.
    Recovered(Token),
    /// The payment failed or was never sent; the intent is gone.
    Closed(String),
    /// The wallet still reports it pending.
    StillPending,
}

/// A refusal for a payment above the per-request ceiling.
pub fn per_payment_limit_message(amount_sat: f64, cap_sat: f64) -> String {
    format!(
        "{OUT_OF_BUDGET} this payment, with fees, is {} sat, over the {} sat per-payment limit \
         (PI402_MAX_SAT_PER_REQUEST). Raise it and restart rpi to allow it.",
        format_sat(amount_sat),
        format_sat(cap_sat)
    )
}

/// A refusal for a payment that would take today's spend past the daily cap.
pub fn daily_limit_message(amount_sat: f64, counted_sat: f64, cap_sat: f64) -> String {
    let limit = format!(
        "{} sat daily limit (PI402_DAILY_CAP_SAT)",
        format_sat(cap_sat)
    );
    if amount_sat > cap_sat {
        return format!(
            "{OUT_OF_BUDGET} this payment, with fees, is {} sat, more than the whole {limit}. \
             Raise it and restart rpi to allow it.",
            format_sat(amount_sat)
        );
    }
    format!(
        "{OUT_OF_BUDGET} this payment, with fees, is {} sat and {} sat is already counted against \
         today, over the {limit}. It resets at 00:00 UTC, or raise it and restart rpi.",
        format_sat(amount_sat),
        format_sat(counted_sat)
    )
}

/// Check that a preimage hashes to the payment hash, both hex.
pub fn verify_preimage(preimage_hex: &str, payment_hash_hex: &str) -> Result<(), String> {
    let preimage = hex::decode(preimage_hex)
        .map_err(|_| format!("the wallet returned a preimage that is not hex: {preimage_hex}"))?;
    let hash = hex::decode(payment_hash_hex)
        .map_err(|_| format!("the payment hash is not hex: {payment_hash_hex}"))?;
    if Sha256::digest(&preimage).as_slice() != hash.as_slice() {
        return Err(format!(
            "the wallet's preimage does not match payment hash {payment_hash_hex}"
        ));
    }
    Ok(())
}

fn unresolved_message(intent: &Intent) -> String {
    format!(
        "rpi-402: an earlier payment for this model ({}) has not settled, so no new payment is \
         made. Run /intents to check on it, or /intents abandon {} to allow a new payment.",
        intent.payment_hash, intent.payment_hash
    )
}

impl Plugin {
    /// Buy a credential for `purchase`, at most one payment at a time per
    /// process. `cancel` is honoured until just before the send: once it may
    /// be dispatched, the payment runs to its end so its credential and
    /// receipt are stored even if the request that started it is gone.
    pub async fn buy(
        &self,
        purchase: Purchase,
        cancel: CancellationToken,
    ) -> Result<Token, PayError> {
        let _guard = self.payment_lock.lock().await;

        // Another request may have paid while this one waited for the lock.
        if let Some(token) = self.tokens.get(&purchase.cache_key) {
            return Ok(token);
        }

        let open = self.intents.for_key(&purchase.cache_key).map_err(|err| {
            PayError::Failed(format!("rpi-402: cannot read the recorded payments: {err}"))
        })?;
        self.wallet.ensure_ready().await.map_err(PayError::Failed)?;
        for intent in open {
            match self.reconcile(&intent).await.map_err(PayError::Failed)? {
                Resolution::Recovered(token) => return Ok(token),
                Resolution::Closed(_) => {}
                Resolution::StillPending if intent.status == IntentStatus::Pending => {
                    return Err(PayError::Unresolved(unresolved_message(&intent)));
                }
                Resolution::StillPending => {}
            }
        }

        // Quote twice. The first quote gives the invoice amount and fee; the
        // second carries a fee cap the wallet enforces at dispatch, sized so
        // the invoice plus the fee at that cap stays within what this payment
        // may cost, since the fee can move between the quote and the send.
        let counted = self.counted_today().map_err(PayError::Failed)?;
        let first = self.quote(&purchase, None, counted).await?;
        let budget = self
            .config
            .max_sat_per_request
            .min(self.config.daily_cap_sat - counted)
            .floor() as i128;
        let fee_cap = (budget - first.amount_sat as i128).max(0) as u64;
        // The wallet reads a zero cap as its default, about 1% of the
        // invoice, so a cap of zero cannot hold the fee at zero.
        if fee_cap == 0 {
            return Err(PayError::Refused(format!(
                "{OUT_OF_BUDGET} this payment would use all {} sat it may spend, leaving no room \
                 for a fee the wallet can cap.",
                format_sat(budget as f64)
            )));
        }
        let quote = self.quote(&purchase, Some(fee_cap), counted).await?;
        // The wallet refuses at dispatch a send whose fee exceeds the cap;
        // refuse it here instead, before an intent exists.
        if quote.fee_sat > fee_cap {
            return Err(PayError::Refused(format!(
                "{OUT_OF_BUDGET} the wallet quotes a fee of {} sat, above the {} sat this payment \
                 can spend on fees within its limits.",
                format_sat(quote.fee_sat as f64),
                format_sat(fee_cap as f64)
            )));
        }
        // The most this payment can cost: the invoice with the fee at its
        // cap. Credit changes only where the sats come from, not the cost.
        let max_cost = quote.amount_sat as i128 + fee_cap as i128;
        if max_cost > budget {
            return Err(PayError::Refused(format!(
                "{OUT_OF_BUDGET} with its fee at the {} sat cap, this payment could cost {} sat, \
                 over the {} sat it may spend. Send the prompt again to requote.",
                format_sat(fee_cap as f64),
                format_sat(max_cost as f64),
                format_sat(budget as f64)
            )));
        }
        // The balance must cover what leaves the wallet now: the swap funding
        // and any credit top-up, which is zero when credit covers it all.
        self.wallet
            .funds()
            .await
            .map_err(PayError::Failed)?
            .check_covers(quote.outflow_sat as f64)
            .map_err(PayError::Refused)?;

        // Open the activity stream before the send so a fast settle cannot
        // be missed. The gateway answers only once the daemon sends stream
        // headers, which an idle wallet holds back until its first event, and
        // that event may be this very send. So wait briefly, giving way to a
        // cancel, then send even if the stream has not answered: the request
        // is already with the daemon, and its replay of existing entries
        // covers a send made just before it subscribed.
        let subscribe = self.wallet.subscribe();
        tokio::pin!(subscribe);
        let opened = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(PayError::Aborted),
            opened = &mut subscribe => Some(opened.map_err(PayError::Failed)?),
            _ = tokio::time::sleep(SUBSCRIBE_GRACE) => None,
        };
        if cancel.is_cancelled() {
            return Err(PayError::Aborted);
        }

        let intent = Intent {
            payment_hash: quote.payment_hash.clone(),
            send_intent_id: quote.send_intent_id.clone(),
            cache_key: purchase.cache_key.clone(),
            macaroon_b64: purchase.challenge.macaroon.clone(),
            invoice: purchase.challenge.invoice.clone(),
            expires_at: purchase.challenge.expires_at.clone(),
            amount_sat: quote.amount_sat,
            fee_sat: quote.fee_sat,
            max_fee_sat: fee_cap,
            url: purchase.url.clone(),
            model: purchase.model.clone(),
            created_at: util::now_iso(),
            quote_expires_at_unix: quote.expires_at_unix,
            status: IntentStatus::Pending,
        };
        self.intents.put(&intent).map_err(|err| {
            PayError::Failed(format!(
                "rpi-402: cannot record the payment before sending it: {err}"
            ))
        })?;
        // The write can block; a cancel during it still stops the payment,
        // whose record is known unsent and goes.
        if cancel.is_cancelled() {
            self.drop_intent(&intent);
            return Err(PayError::Aborted);
        }

        if let Err(err) = self.wallet.send(&quote.send_intent_id).await {
            // The wallet checks the fee against the cap before it starts the
            // payment, so this rejection means nothing was sent.
            if err.message.contains("exceeds max fee") {
                self.drop_intent(&intent);
                return Err(PayError::Refused(format!(
                    "{OUT_OF_BUDGET} the fee rose above its {} sat cap before the send, so \
                     nothing was sent. Send the prompt again to requote.",
                    format_sat(fee_cap as f64)
                )));
            }
            // Any other error does not mean nothing was sent: the wallet
            // starts the payment before it writes the activity row, and the
            // response can be lost after that. Only a failure the wallet
            // reports closes the intent; anything else keeps it blocking new
            // payments for this model until it resolves or is abandoned.
            return match self.wallet.find_send(&intent.payment_hash).await {
                Ok(SendState::Failed { reason }) => {
                    self.drop_intent(&intent);
                    Err(PayError::Failed(format!(
                        "rpi-402: the payment failed: {reason}"
                    )))
                }
                Ok(SendState::Settled { preimage, fee_sat }) => {
                    self.finish(&intent, &preimage, fee_sat, true).await
                }
                Ok(SendState::Pending) | Ok(SendState::NotFound) | Err(_) => {
                    Err(PayError::Unresolved(format!(
                        "rpi-402: payment {} may have been sent ({err}). It stays recorded and \
                         blocks new payments for this model until the wallet reports it settled \
                         or failed; run /intents to check on it.",
                        intent.payment_hash
                    )))
                }
            };
        }

        let mut stream = match opened {
            Some(stream) => stream,
            None => match tokio::time::timeout(self.config.preimage_timeout, subscribe).await {
                Ok(Ok(stream)) => stream,
                Ok(Err(err)) => return Err(self.unopened(&intent, &err)),
                Err(_) => return Err(self.unopened(&intent, "it did not open in time")),
            },
        };
        match stream
            .wait_for(&intent.payment_hash, self.config.preimage_timeout)
            .await
        {
            Ok(SendState::Settled { preimage, fee_sat }) => {
                self.finish(&intent, &preimage, fee_sat, true).await
            }
            Ok(SendState::Failed { reason }) => {
                self.drop_intent(&intent);
                Err(PayError::Failed(format!(
                    "rpi-402: the payment failed: {reason}"
                )))
            }
            Ok(_) => Err(PayError::Unresolved(unresolved_message(&intent))),
            Err(err) => Err(PayError::Unresolved(format!(
                "rpi-402: payment {} was sent but has not settled ({err}). It stays recorded; \
                 run /intents to check on it.",
                intent.payment_hash
            ))),
        }
    }

    /// The error for a sent payment whose activity stream never opened.
    fn unopened(&self, intent: &Intent, why: &str) -> PayError {
        PayError::Unresolved(format!(
            "rpi-402: payment {} was sent, but the wallet's activity stream did not open ({why}). \
             It stays recorded; run /intents to check on it.",
            intent.payment_hash
        ))
    }

    /// Quote `purchase` and check the quote against the limits: a known
    /// total, within the per-request ceiling and what is left of today's
    /// budget after `counted`.
    async fn quote(
        &self,
        purchase: &Purchase,
        max_fee_sat: Option<u64>,
        counted: f64,
    ) -> Result<Quote, PayError> {
        let cap = self.config.max_sat_per_request;
        let quote = self
            .wallet
            .prepare_send(&purchase.challenge.invoice, cap.floor() as u64, max_fee_sat)
            .await
            .map_err(PayError::Failed)?;
        if quote.send_intent_id.is_empty() || quote.payment_hash.is_empty() {
            return Err(PayError::Failed(
                "rpi-402: prepare-send returned a quote without a send intent or payment hash"
                    .into(),
            ));
        }
        // When waved or its swap server predates the quote RPC, the wallet
        // reports only the invoice amount and finds the fee at dispatch. The
        // limits cannot be checked on a total the wallet does not know, so
        // nothing is sent. Retrying does not help; upgrading does.
        if !quote.total_known {
            let why = if quote.warning.is_empty() {
                "the fee is not known yet".to_string()
            } else {
                quote.warning.clone()
            };
            return Err(PayError::Failed(format!(
                "rpi-402: the wallet could not quote this payment's total ({why}), so it was not \
                 sent. This happens when waved or its swap server is too old to quote fees; \
                 upgrade them to pay this seller."
            )));
        }

        // The limits apply to what the payment costs: the invoice plus its
        // fee, however it is funded. A credit top-up only moves sats into
        // the swap server's credit and is not a cost; credit counts when a
        // payment spends it.
        let cost = quote.amount_sat as f64 + quote.fee_sat as f64;
        if cost > cap {
            return Err(PayError::Refused(per_payment_limit_message(cost, cap)));
        }
        if counted + cost > self.config.daily_cap_sat {
            return Err(PayError::Refused(daily_limit_message(
                cost,
                counted,
                self.config.daily_cap_sat,
            )));
        }
        Ok(quote)
    }

    /// Store the credential and receipt for a settled intent and close it.
    /// The receipt records the cost: the invoice plus the settled fee (see
    /// `settled_fee`). The intent is closed only once the credential is
    /// stored and the receipt reads back from the ledger: otherwise it stays
    /// so the next purchase for the model or `/intents` recovers the payment
    /// again, and its receipt, once recorded, replaces its reservation in the
    /// daily count. A preimage that does not match leaves the intent in
    /// place. A recovered payment (`replace` false) does not displace a
    /// credential the model already has: the cache holds one per model, and
    /// the one in use wins.
    async fn finish(
        &self,
        intent: &Intent,
        preimage: &str,
        settled_fee_sat: Option<u64>,
        replace: bool,
    ) -> Result<Token, PayError> {
        verify_preimage(preimage, &intent.payment_hash)
            .map_err(|err| PayError::Unresolved(format!("rpi-402: {err}")))?;
        let fee_sat = self.settled_fee(intent, settled_fee_sat).await;
        let token = Token {
            macaroon_b64: intent.macaroon_b64.clone(),
            preimage_hex: preimage.to_string(),
            expires_at: intent.expires_at.clone(),
        };

        // The money moved, so a failed write does not fail the request; the
        // credential in hand still serves it.
        let mut stored = true;
        if !replace && self.tokens.get(&intent.cache_key).is_some() {
            self.log.warn(&format!(
                "payment {} settled after another credential was bought for {}; keeping that one",
                intent.payment_hash, intent.model
            ));
        } else if let Err(err) = self.tokens.put(&intent.cache_key, &token) {
            self.log.warn(&format!(
                "cannot store the credential for {}: {err}",
                intent.payment_hash
            ));
            stored = false;
        }

        let receipt = Receipt {
            payment_hash: intent.payment_hash.clone(),
            amount_sat: intent.amount_sat,
            paid_sat: intent.amount_sat + fee_sat,
            invoice: intent.invoice.clone(),
            preimage_hex: preimage.to_string(),
            url: intent.url.clone(),
            // Dated by the intent, whether it settles live or is recovered
            // after a restart, so the receipt replaces the reservation on
            // the day that reservation was counted.
            timestamp: intent.created_at.clone(),
            model: Some(intent.model.clone()),
        };
        let receipted = match self.receipts.contains(&intent.payment_hash) {
            Ok(true) => Ok(()),
            Ok(false) => self.receipts.append(&receipt).and_then(|()| {
                // Only a receipt the ledger's reader sees counts.
                match self.receipts.contains(&intent.payment_hash)? {
                    true => Ok(()),
                    false => Err(std::io::Error::other(
                        "the appended receipt does not read back",
                    )),
                }
            }),
            Err(err) => Err(err),
        };
        if let Err(err) = receipted {
            self.log.warn(&format!(
                "cannot record the receipt for {}: {err}",
                intent.payment_hash
            ));
            stored = false;
        }

        if stored {
            self.drop_intent(intent);
        } else {
            self.log.warn(&format!(
                "keeping intent {} so the payment can be recovered",
                intent.payment_hash
            ));
        }
        Ok(token)
    }

    fn drop_intent(&self, intent: &Intent) {
        if let Err(err) = self.intents.remove(&intent.payment_hash) {
            self.log.warn(&format!(
                "cannot close intent {}: {err}",
                intent.payment_hash
            ));
        }
    }

    /// Ask the wallet about a recorded intent and act on the answer. The
    /// caller holds the payment lock and has made sure the wallet is ready.
    /// An intent the wallet has no record of stays: its activity row can
    /// appear late, so only `/intents abandon` stops it blocking.
    pub async fn reconcile(&self, intent: &Intent) -> Result<Resolution, String> {
        match self.wallet.find_send(&intent.payment_hash).await? {
            // A recovered payment keeps the day it was counted against.
            SendState::Settled { preimage, fee_sat } => self
                .finish(intent, &preimage, fee_sat, false)
                .await
                .map(Resolution::Recovered)
                .map_err(|err| err.to_string()),
            SendState::Failed { reason } => {
                self.drop_intent(intent);
                Ok(Resolution::Closed(format!("failed: {reason}")))
            }
            SendState::Pending | SendState::NotFound => Ok(Resolution::StillPending),
        }
    }

    /// The fee a settled payment cost. The swap behind it is authoritative.
    /// Without it, a nonzero fee on the activity row is real (a swap-backed
    /// row), but a zero may be a credit-only row's missing fee, so the fee
    /// cap the payment was authorized for is counted instead.
    async fn settled_fee(&self, intent: &Intent, row_fee_sat: Option<u64>) -> u64 {
        match self.wallet.swap_fee(&intent.payment_hash).await {
            Ok(Some(fee)) => return fee,
            Ok(None) => {}
            Err(err) => self.log.warn(&format!(
                "cannot read the swap fee of {}, counting from the activity row: {err}",
                intent.payment_hash
            )),
        }
        match row_fee_sat {
            Some(fee) if fee > 0 => fee,
            _ => intent.fee_sat.max(intent.max_fee_sat),
        }
    }

    /// Sats counted against today: settled payments from the shared ledger,
    /// plus this machine's intents that may still settle, each counted once:
    /// an intent whose receipt is already recorded counts through the
    /// receipt. When either cannot be read the day's spend is unknown, and no
    /// payment is made.
    pub fn counted_today(&self) -> Result<f64, String> {
        let today = util::today();
        // Intents first, then the ledger once. A payment that settles
        // between the two reads then shows as an intent and a receipt and
        // counts once, through the receipt; read the other way round, it
        // could show as neither. One ledger read gives both the total and
        // the receipts that replace reservations, and one date serves both.
        let intents = self.intents.all().map_err(|err| {
            format!(
                "rpi-402: cannot read the recorded payments ({err}), so today's spend is unknown \
                 and no payment is made"
            )
        })?;
        let lines = self.receipts.read_all().map_err(|err| {
            format!(
                "rpi-402: cannot read the receipt ledger ({err}), so today's spend is unknown and \
                 no payment is made"
            )
        })?;
        let recorded: HashSet<&str> = lines
            .iter()
            .filter_map(|line| line["paymentHash"].as_str())
            .collect();
        Ok(store::spent_on(&lines, &today) + store::reserved_on(&intents, &today, &recorded))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_messages_match_the_ts_wording() {
        let message = per_payment_limit_message(1_200.0, 1_000.0);
        assert!(message.starts_with("rpi-402: out of budget:"));
        assert!(message.contains(
            "this payment, with fees, is 1,200 sat, over the 1,000 sat per-payment limit"
        ));
        let message = daily_limit_message(10_000.0, 0.0, 9_500.0);
        assert!(
            message.contains("more than the whole 9,500 sat daily limit"),
            "{message}"
        );
        let message = daily_limit_message(600.0, 9_000.0, 9_500.0);
        assert!(
            message.contains("9,000 sat is already counted against today"),
            "{message}"
        );
    }

    #[test]
    fn preimages_must_hash_to_the_payment_hash() {
        let preimage = "00".repeat(32);
        let hash = hex::encode(Sha256::digest([0u8; 32]));
        assert!(verify_preimage(&preimage, &hash).is_ok());
        assert!(verify_preimage(&"01".repeat(32), &hash).is_err());
        assert!(verify_preimage("zz", &hash).is_err());
    }
}
