//! Client for the `waved` HTTP/JSON gateway (`PI402_WALLETD_GATEWAY`), ported
//! from the TS extension's sidecar path. The gateway marshals proto JSON with
//! snake_case names and encodes 64-bit integers as strings.

use crate::util::{format_sat, json_number};
use base64::Engine;
use serde_json::{json, Value};
use std::fmt;
use std::time::Duration;

/// The ErrorInfo reason `waved` returns while no wallet has been created.
const WALLET_NOT_READY_REASON: &str = "WALLET_NOT_READY";

/// Bound on one unary gateway call.
const REST_TIMEOUT: Duration = Duration::from_secs(30);

/// Activity pages read when looking a send up by payment hash.
const LIST_PAGE_SIZE: u64 = 100;
const LIST_MAX_PAGES: usize = 50;

/// A failed gateway call, carrying the machine-readable cause when the
/// daemon sent one, so callers branch on it rather than on prose.
#[derive(Debug, Clone)]
pub struct WalletError {
    pub path: String,
    pub status: Option<u16>,
    pub code: Option<i64>,
    pub reason: Option<String>,
    pub message: String,
}

impl fmt::Display for WalletError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(
                f,
                "walletd {} failed ({status}): {}",
                self.path, self.message
            ),
            None => write!(f, "walletd {} unreachable: {}", self.path, self.message),
        }
    }
}

impl WalletError {
    /// Whether this error means no wallet exists yet, so creating one is the
    /// right recovery, as opposed to a wrong password or an unreachable
    /// daemon, which must propagate.
    pub fn is_wallet_missing(&self) -> bool {
        if self.reason.as_deref() == Some(WALLET_NOT_READY_REASON) {
            return true;
        }
        if self.status.is_none() {
            return false;
        }
        let message = self.to_string().to_lowercase();
        [
            "not found",
            "no wallet",
            "does not exist",
            "wallet not initialized",
            "wallet is not ready",
            // Unlocking a never-created wallet reports that it is not locked
            // with state=none; any other state means it exists.
            "state=none",
        ]
        .iter()
        .any(|needle| message.contains(needle))
            || self.code == Some(5)
    }
}

/// The ErrorInfo reason from a gateway error payload, if it carries one.
fn error_info_reason(payload: &Value) -> Option<String> {
    payload
        .get("details")?
        .as_array()?
        .iter()
        .find_map(|detail| detail.get("reason").and_then(Value::as_str))
        .filter(|reason| !reason.is_empty())
        .map(str::to_string)
}

/// A quote from `prepare-send`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    pub send_intent_id: String,
    pub payment_hash: String,
    /// The invoice's face value.
    pub amount_sat: u64,
    /// What the wallet will pay in total: the swap's funding amount, fees
    /// included, plus any credit top-up. Zero when credit covers it all.
    pub outflow_sat: u64,
    /// The quoted routing or swap fee.
    pub fee_sat: u64,
    /// Whether the wallet knows the total. When waved or its swap server
    /// predates the quote RPC, it reports only the invoice amount, with the
    /// fee left to be found at dispatch.
    pub total_known: bool,
    /// Why the total is unknown, when the wallet says.
    pub warning: String,
    pub expires_at_unix: i64,
}

fn sat_field(value: &Value, names: &[&str]) -> f64 {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(json_number))
        .filter(|sat| sat.is_finite())
        .unwrap_or(0.0)
}

/// The total sats a quote commits the wallet to: the stated total outflow
/// when the wallet gives one, else the principal plus the fee.
pub fn quoted_outflow_sat(quote: &Value) -> f64 {
    let total = sat_field(quote, &["expected_total_outflow_sat", "total_outflow_sat"]);
    if total > 0.0 {
        return total;
    }
    let principal = sat_field(quote, &["amount_sat"]);
    let fee = sat_field(
        quote,
        &[
            "expected_fee_sat",
            "fee_sat",
            "swap_fee_sat",
            "total_fee_sat",
        ],
    );
    principal + fee
}

impl Quote {
    pub fn from_json(value: &Value) -> Self {
        let text = |name: &str| {
            value
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let whole = |sat: f64| if sat > 0.0 { sat.ceil() as u64 } else { 0 };
        // proto3 JSON omits false, so only an explicit true counts.
        let total_known = value.get("total_outflow_known").and_then(Value::as_bool) == Some(true);
        Self {
            send_intent_id: text("send_intent_id"),
            payment_hash: text("payment_hash"),
            amount_sat: whole(sat_field(value, &["amount_sat"])),
            // A known total is taken as stated, zero included: credit can
            // cover the whole invoice. Only an unknown one is estimated.
            outflow_sat: if total_known {
                whole(sat_field(
                    value,
                    &["expected_total_outflow_sat", "total_outflow_sat"],
                ))
            } else {
                whole(quoted_outflow_sat(value))
            },
            fee_sat: whole(sat_field(value, &["expected_fee_sat"])),
            total_known,
            warning: text("warning"),
            expires_at_unix: sat_field(value, &["expires_at_unix"]) as i64,
        }
    }
}

/// Spendable and arriving funds. Credit is left out: the quoted outflow
/// already includes any credit top-up, and both come out of confirmed funds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Funds {
    pub confirmed_sat: f64,
    pub arriving_sat: f64,
}

impl Funds {
    pub fn from_json(balance: &Value) -> Self {
        let sat = |name: &str| {
            balance
                .get(name)
                .and_then(json_number)
                .filter(|sat| sat.is_finite() && *sat > 0.0)
                .unwrap_or(0.0)
        };
        Self {
            confirmed_sat: sat("confirmed_sat"),
            arriving_sat: sat("pending_in_sat"),
        }
    }

    /// Refuse a payment the wallet cannot cover. Sent anyway, it would fail
    /// inside the swap and surface only as a preimage timeout.
    pub fn check_covers(&self, outflow_sat: f64) -> Result<(), String> {
        if self.confirmed_sat >= outflow_sat {
            return Ok(());
        }
        let next = if self.arriving_sat > 0.0 {
            format!(
                "{} sat is still arriving; send the prompt again once it lands.",
                format_sat(self.arriving_sat)
            )
        } else {
            "Fund the wallet, then send the prompt again.".to_string()
        };
        Err(format!(
            "rpi-402: the wallet's available balance is {} sat, but this payment needs {} sat. {next}",
            format_sat(self.confirmed_sat),
            format_sat(outflow_sat)
        ))
    }
}

/// What the wallet says about one send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendState {
    Settled {
        preimage: String,
        /// The fee the settled entry shows. It is real for a swap-backed row
        /// and zero for a credit-only one, whose row carries no fee.
        fee_sat: Option<u64>,
    },
    Failed {
        reason: String,
    },
    Pending,
    /// The wallet's activity shows no such send. This is not proof that it
    /// was never sent: the wallet starts a payment before writing its
    /// activity row, and the lookup reads a bounded number of pages.
    NotFound,
}

/// Classify a wallet entry for the send with `payment_hash`: `None` when the
/// entry is for another payment.
pub fn classify_entry(entry: &Value, payment_hash: &str) -> Option<SendState> {
    let progress = entry.get("progress")?;
    if progress.get("payment_hash").and_then(Value::as_str) != Some(payment_hash) {
        return None;
    }
    if entry.get("status").and_then(Value::as_str) == Some("ENTRY_STATUS_FAILED") {
        let reason = entry
            .get("failure_reason")
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty())
            .unwrap_or("unknown");
        return Some(SendState::Failed {
            reason: reason.to_string(),
        });
    }
    // The entry's amount is rail-specific (invoice plus fee on Lightning,
    // the face value for credit), so only its fee is read.
    let fee_sat = entry
        .get("fee_sat")
        .and_then(json_number)
        .filter(|fee| fee.is_finite() && *fee >= 0.0)
        .map(|fee| fee.ceil() as u64);
    match progress.get("preimage").and_then(Value::as_str) {
        Some(preimage) if !preimage.is_empty() => Some(SendState::Settled {
            preimage: preimage.to_string(),
            fee_sat,
        }),
        _ => Some(SendState::Pending),
    }
}

/// Classify one decoded SubscribeWallet frame. Returns the send's state once
/// it is settled or failed, `None` for other frames, and an error for a
/// gateway error frame or a gap, which means the settle may have been lost.
pub fn classify_frame(frame: &Value, payment_hash: &str) -> Result<Option<SendState>, String> {
    if let Some(error) = frame.get("error").filter(|error| !error.is_null()) {
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        return Err(format!("subscribe stream error: {detail}"));
    }
    let update = frame.get("result").unwrap_or(frame);
    if let Some(gap) = update.get("gap").filter(|gap| !gap.is_null()) {
        let reason = gap
            .get("reason")
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty())
            .unwrap_or("subscriber fell behind");
        return Err(format!("subscribe stream gapped: {reason}"));
    }
    // Tolerate the bare WalletEntry shape of pre-envelope daemons.
    let entry = update.get("entry").unwrap_or(update);
    Ok(match classify_entry(entry, payment_hash) {
        Some(SendState::Pending) | None => None,
        Some(state) => Some(state),
    })
}

/// Reassembles newline-delimited JSON from arbitrary byte chunks.
#[derive(Default)]
pub struct NdjsonFramer {
    buffer: Vec<u8>,
}

impl NdjsonFramer {
    /// Feed a chunk and return the complete, non-blank lines it finished.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=newline).collect();
            let line = String::from_utf8_lossy(&line).trim().to_string();
            if !line.is_empty() {
                lines.push(line);
            }
        }
        lines
    }
}

/// An open SubscribeWallet stream.
pub struct WalletStream {
    response: reqwest::Response,
    framer: NdjsonFramer,
}

impl WalletStream {
    /// Read until the send with `payment_hash` settles or fails.
    pub async fn wait_for(
        &mut self,
        payment_hash: &str,
        timeout: Duration,
    ) -> Result<SendState, String> {
        let read = async {
            loop {
                let chunk = match self.response.chunk().await {
                    Ok(Some(chunk)) => chunk,
                    Ok(None) => {
                        return Err(format!(
                            "subscribe stream ended before preimage of {payment_hash}"
                        ))
                    }
                    Err(err) => return Err(format!("subscribe stream failed: {err}")),
                };
                for line in self.framer.push(&chunk) {
                    let frame: Value = serde_json::from_str(&line)
                        .map_err(|err| format!("subscribe stream sent malformed JSON: {err}"))?;
                    if let Some(state) = classify_frame(&frame, payment_hash)? {
                        return Ok(state);
                    }
                }
            }
        };
        tokio::time::timeout(timeout, read)
            .await
            .map_err(|_| format!("timed out waiting for preimage of {payment_hash}"))?
    }
}

/// The `waved` gateway client.
pub struct Wallet {
    base: String,
    password: String,
    http: reqwest::Client,
    ready: tokio::sync::Mutex<bool>,
}

impl Wallet {
    pub fn new(base: &str, password: &str) -> Result<Self, String> {
        // The gateway is a local daemon; like Node's fetch in the TS
        // extension, do not route it through an environment proxy. Payments
        // run on the provider's runtime and commands on their own, so keep
        // no idle connections: a pooled connection is bound to the runtime
        // that opened it.
        let http = reqwest::Client::builder()
            .no_proxy()
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|err| format!("wallet HTTP client: {err}"))?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            password: password.to_string(),
            http,
            ready: tokio::sync::Mutex::new(false),
        })
    }

    /// One unary gateway call.
    pub async fn rest(&self, path: &str, body: Value) -> Result<Value, WalletError> {
        let unreachable = |message: String| WalletError {
            path: path.to_string(),
            status: None,
            code: None,
            reason: None,
            message,
        };
        let response = self
            .http
            .post(format!("{}{path}", self.base))
            .timeout(REST_TIMEOUT)
            .json(&body)
            .send()
            .await
            .map_err(|err| unreachable(err.to_string()))?;
        let status = response.status();
        let payload: Value = response.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            return Err(WalletError {
                path: path.to_string(),
                status: Some(status.as_u16()),
                code: payload.get("code").and_then(Value::as_i64),
                reason: error_info_reason(&payload),
                message: payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            });
        }
        Ok(payload)
    }

    /// Make sure the wallet is unlocked, once per process: unlock it if it is
    /// locked, and create it if none exists. A wrong password or an
    /// unreachable daemon is an error, never a reason to create a wallet.
    pub async fn ensure_ready(&self) -> Result<(), String> {
        let mut ready = self.ready.lock().await;
        if *ready {
            return Ok(());
        }

        // waved answers the status probe with WALLET_NOT_READY when no wallet
        // exists yet; that is the state the create path resolves.
        let unlocked = match self.rest("/v1/wallet/status", json!({})).await {
            Ok(status) => status
                .get("unlocked")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            Err(err) if err.is_wallet_missing() => false,
            Err(err) => return Err(err.to_string()),
        };

        if !unlocked {
            let password = base64::engine::general_purpose::STANDARD.encode(&self.password);
            match self
                .rest("/v1/wallet/unlock", json!({"wallet_password": password}))
                .await
            {
                Ok(_) => {}
                Err(err) if err.is_wallet_missing() => {
                    // FIXME: this ports the TS extension's daemon path, which
                    // sends only a password and discards the response. waved
                    // returns the generated mnemonic in it, which the caller
                    // must save; the TS embedded path writes it to a seed
                    // file. This path also ignores PI402_WALLET_MNEMONIC.
                    // Port pi-402's fix once it lands:
                    // https://github.com/lightninglabs/pi-402/issues/48
                    self.rest("/v1/wallet/create", json!({"wallet_password": password}))
                        .await
                        .map_err(|err| err.to_string())?;
                }
                Err(err) => return Err(err.to_string()),
            }
        }

        *ready = true;
        Ok(())
    }

    /// Quote paying `invoice`. Small payments go over the swap server's
    /// credit rail, which the wallet only authorizes under an explicit cap;
    /// without one it refuses quotes below about 1,000 sat. The per-request
    /// ceiling is passed for both caps.
    /// `max_fee_sat`, when given, is the fee cap the wallet enforces when
    /// the send is dispatched; without it the daemon's default applies.
    pub async fn prepare_send(
        &self,
        invoice: &str,
        ceiling_sat: u64,
        max_fee_sat: Option<u64>,
    ) -> Result<Quote, String> {
        let mut request = json!({
            "invoice": invoice,
            "max_credit_sat": ceiling_sat,
            "max_credit_topup_sat": ceiling_sat,
        });
        if let Some(max_fee_sat) = max_fee_sat {
            request["max_fee_sat"] = json!(max_fee_sat);
        }
        let raw = self
            .rest("/v1/wallet/prepare-send", request)
            .await
            .map_err(|err| err.to_string())?;
        Ok(Quote::from_json(&raw))
    }

    pub async fn funds(&self) -> Result<Funds, String> {
        let balance = self
            .rest("/v1/wallet/balance", json!({}))
            .await
            .map_err(|err| err.to_string())?;
        Ok(Funds::from_json(&balance))
    }

    /// Open the activity stream, replaying existing entries. Open it before
    /// dispatching a send so a fast settle cannot be missed.
    pub async fn subscribe(&self) -> Result<WalletStream, String> {
        let response = self
            .http
            .post(format!("{}/v1/wallet/subscribe", self.base))
            .json(&json!({"include_existing": true}))
            .send()
            .await
            .map_err(|err| format!("subscribe failed: {err}"))?;
        if !response.status().is_success() {
            return Err(format!("subscribe failed: {}", response.status().as_u16()));
        }
        Ok(WalletStream {
            response,
            framer: NdjsonFramer::default(),
        })
    }

    /// Dispatch a quoted send.
    pub async fn send(&self, send_intent_id: &str) -> Result<(), WalletError> {
        self.rest("/v1/wallet/send", json!({"send_intent_id": send_intent_id}))
            .await
            .map(|_| ())
    }

    /// The fee the swap behind a settled payment reports, from the wallet's
    /// activity inspection. `None` when the wallet shows no swap for it. The
    /// activity row itself is no substitute: a credit-only row carries no
    /// fee, which the gateway serializes as zero.
    pub async fn swap_fee(&self, payment_hash: &str) -> Result<Option<u64>, String> {
        let inspected = self
            .rest(
                "/v1/wallet/inspect/activity",
                json!({"id": payment_hash, "ledger_limit": 1}),
            )
            .await
            .map_err(|err| err.to_string())?;
        let Some(swap) = inspected.get("swap").filter(|swap| swap.is_object()) else {
            return Ok(None);
        };
        if swap.get("payment_hash").and_then(Value::as_str) != Some(payment_hash) {
            return Ok(None);
        }
        Ok(swap
            .get("fee_sat")
            .and_then(json_number)
            .filter(|fee| fee.is_finite() && *fee >= 0.0)
            .map(|fee| fee.ceil() as u64))
    }

    /// Look a send up by payment hash in the wallet's activity.
    pub async fn find_send(&self, payment_hash: &str) -> Result<SendState, String> {
        let mut cursor = String::new();
        for _ in 0..LIST_MAX_PAGES {
            let mut request = json!({
                "view": "LIST_VIEW_ACTIVITY",
                "kinds": ["ENTRY_KIND_SEND"],
                "limit": LIST_PAGE_SIZE,
            });
            if !cursor.is_empty() {
                request["cursor"] = Value::String(cursor.clone());
            }
            let page = self
                .rest("/v1/wallet/list", request)
                .await
                .map_err(|err| err.to_string())?;
            let activity = page.get("activity").unwrap_or(&Value::Null);
            if let Some(entries) = activity.get("entries").and_then(Value::as_array) {
                if let Some(state) = entries
                    .iter()
                    .find_map(|entry| classify_entry(entry, payment_hash))
                {
                    return Ok(state);
                }
            }
            let more = activity
                .get("has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            cursor = activity
                .get("next_cursor")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !more || cursor.is_empty() {
                break;
            }
        }
        Ok(SendState::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(
        status: Option<u16>,
        code: Option<i64>,
        reason: Option<&str>,
        message: &str,
    ) -> WalletError {
        WalletError {
            path: "/v1/wallet/unlock".into(),
            status,
            code,
            reason: reason.map(str::to_string),
            message: message.into(),
        }
    }

    #[test]
    fn wallet_missing_detection() {
        assert!(error(Some(412), Some(9), Some("WALLET_NOT_READY"), "x").is_wallet_missing());
        assert!(
            error(Some(400), None, None, "wallet is not locked (state=none)").is_wallet_missing()
        );
        assert!(error(Some(404), Some(5), None, "nope").is_wallet_missing());
        assert!(!error(
            Some(400),
            None,
            None,
            "wallet is not locked (state=unlocked)"
        )
        .is_wallet_missing());
        assert!(!error(Some(400), Some(3), None, "invalid passphrase").is_wallet_missing());
        assert!(!error(None, None, None, "connection refused").is_wallet_missing());
    }

    #[test]
    fn quotes_read_the_total_outflow() {
        let quote = Quote::from_json(&json!({
            "send_intent_id": "si", "payment_hash": "ab", "amount_sat": "100",
            "expected_fee_sat": "3", "expected_total_outflow_sat": "103", "expires_at_unix": "1700000000"
        }));
        assert_eq!(quote.amount_sat, 100);
        assert_eq!(quote.fee_sat, 3);
        assert_eq!(quote.outflow_sat, 103);
        assert!(!quote.total_known, "an absent flag is false in proto3 JSON");
        let local_only = Quote::from_json(&json!({
            "amount_sat": "1000", "expected_total_outflow_sat": "1000", "total_outflow_known": false,
            "warning": "server quote unavailable"
        }));
        assert!(!local_only.total_known);
        assert_eq!(local_only.warning, "server quote unavailable");
        assert!(Quote::from_json(&json!({"total_outflow_known": true})).total_known);
        let credit_funded = Quote::from_json(&json!({
            "amount_sat": "100", "expected_fee_sat": "3",
            "expected_total_outflow_sat": "0", "total_outflow_known": true
        }));
        assert_eq!(credit_funded.outflow_sat, 0, "a known zero total stands");
        assert_eq!(quote.expires_at_unix, 1_700_000_000);
        assert_eq!(
            quoted_outflow_sat(&json!({"amount_sat": "100", "expected_fee_sat": "4"})),
            104.0
        );
        assert_eq!(quoted_outflow_sat(&json!({})), 0.0);
    }

    #[test]
    fn funds_and_the_balance_check() {
        let funds = Funds::from_json(&json!({"confirmed_sat": "500", "pending_in_sat": "-3"}));
        assert_eq!(funds.arriving_sat, 0.0);
        assert!(funds.check_covers(500.0).is_ok());
        let err = funds.check_covers(1_200.0).unwrap_err();
        assert!(
            err.contains("available balance is 500 sat") && err.contains("needs 1,200 sat"),
            "{err}"
        );
    }

    #[test]
    fn frames() {
        let settled = json!({"result": {"cursor": "4", "entry": {
            "status": "ENTRY_STATUS_COMPLETE", "progress": {"payment_hash": "h", "preimage": "p"}}}});
        assert_eq!(
            classify_frame(&settled, "h").unwrap(),
            Some(SendState::Settled {
                preimage: "p".into(),
                fee_sat: None,
            })
        );
        assert_eq!(classify_frame(&settled, "other").unwrap(), None);
        let with_amounts = json!({"result": {"entry": {"status": "ENTRY_STATUS_COMPLETE",
            "amount_sat": "-107", "fee_sat": "7", "progress": {"payment_hash": "h", "preimage": "p"}}}});
        assert_eq!(
            classify_frame(&with_amounts, "h").unwrap(),
            Some(SendState::Settled {
                preimage: "p".into(),
                fee_sat: Some(7),
            })
        );
        let pending = json!({"result": {"entry": {"status": "ENTRY_STATUS_PENDING", "progress": {"payment_hash": "h"}}}});
        assert_eq!(classify_frame(&pending, "h").unwrap(), None);
        let failed = json!({"result": {"entry": {"status": "ENTRY_STATUS_FAILED", "failure_reason": "no route", "progress": {"payment_hash": "h"}}}});
        assert_eq!(
            classify_frame(&failed, "h").unwrap(),
            Some(SendState::Failed {
                reason: "no route".into()
            })
        );
        let bare = json!({"status": "ENTRY_STATUS_COMPLETE", "progress": {"payment_hash": "h", "preimage": "p"}});
        assert!(classify_frame(&bare, "h").unwrap().is_some());
        assert!(classify_frame(&json!({"error": {"message": "boom"}}), "h").is_err());
        assert!(
            classify_frame(&json!({"result": {"gap": {"reason": ""}}}), "h")
                .unwrap_err()
                .contains("fell behind")
        );
    }

    #[test]
    fn framing_across_chunks() {
        let mut framer = NdjsonFramer::default();
        assert!(framer.push(b"{\"a\":").is_empty());
        assert_eq!(
            framer.push(b"1}\n\n{\"b\":2}\n{\"c\""),
            vec!["{\"a\":1}", "{\"b\":2}"]
        );
        assert_eq!(framer.push(b":3}\n"), vec!["{\"c\":3}"]);
    }
}
