//! The `/intents` command: list payments whose outcome is unknown, or clear
//! one by hand so it stops blocking new payments for its model.

use crate::payer::Resolution;
use crate::plugin::Plugin;
use crate::store::{Intent, IntentStatus};
use crate::util::format_sat;
use rpi_plugin_sdk::{PluginApi, StbStringRef};
use serde_json::{json, Value};
use std::future::Future;
use std::time::Duration;

/// How long the command waits for an in-flight payment before giving up.
const LOCK_WAIT: Duration = Duration::from_secs(5);

const USAGE: &str = "Usage: /intents lists payments whose outcome is unknown; \
     /intents abandon <payment hash> stops one from blocking new payments.";

pub fn register(api: &PluginApi) -> i32 {
    // A host without commands still gets the provider.
    let Some(register_command) = api.register_command else {
        return 0;
    };
    register_command(
        StbStringRef::from_str("intents"),
        StbStringRef::from_str(
            "List rpi-402 payments whose outcome is unknown, or abandon one: /intents abandon <payment hash>",
        ),
        intents_handler,
    )
}

rpi_plugin_sdk::string_handler! {
    fn intents_handler(input, out, _data) {
        let args = serde_json::from_str::<Value>(input)
            .ok()
            .and_then(|envelope| envelope.get("args").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        let text = block_on_thread(move || async move {
            match Plugin::global() {
                Ok(plugin) => run(&plugin, &args).await,
                Err(err) => format!("rpi-402: {err}"),
            }
        });
        i32::from(!out.write(json!({"kind": "message", "text": text}).to_string()))
    }
}

/// Run async work to completion on a thread of its own, whatever runtime the
/// host calls the command from.
fn block_on_thread<F, Fut>(make: F) -> String
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = String>,
{
    std::thread::spawn(move || {
        match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime.block_on(make()),
            Err(err) => format!("rpi-402: cannot start a runtime: {err}"),
        }
    })
    .join()
    .unwrap_or_else(|_| "rpi-402: the command failed unexpectedly".to_string())
}

/// Execute `/intents <args>` and return the text to show.
pub async fn run(plugin: &Plugin, args: &str) -> String {
    let words: Vec<&str> = args.split_whitespace().collect();
    match words.as_slice() {
        [] | ["list"] => list(plugin).await,
        ["abandon", hash] => abandon(plugin, hash).await,
        _ => USAGE.to_string(),
    }
}

async fn lock(plugin: &Plugin) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
    tokio::time::timeout(LOCK_WAIT, plugin.payment_lock.lock())
        .await
        .map_err(|_| "rpi-402: a payment is in progress; try again once it finishes.".to_string())
}

fn describe(intent: &Intent) -> String {
    format!(
        "{}  {} sat  {}  {}",
        intent.payment_hash,
        format_sat((intent.amount_sat + intent.fee_sat) as f64),
        intent.model,
        intent.created_at
    )
}

async fn list(plugin: &Plugin) -> String {
    let _guard = match lock(plugin).await {
        Ok(guard) => guard,
        Err(message) => return message,
    };
    let intents = match plugin.intents.all() {
        Ok(intents) => intents,
        Err(err) => return format!("rpi-402: cannot read the recorded payments: {err}"),
    };
    if intents.is_empty() {
        return "rpi-402: no payments with an unknown outcome.".to_string();
    }

    // Ask the wallet about each one, which also recovers any that settled.
    let wallet = plugin.wallet.ensure_ready().await;
    let mut lines = Vec::new();
    for intent in &intents {
        let state = match &wallet {
            Err(err) => format!("not checked: {err}"),
            Ok(()) => match plugin.reconcile(intent).await {
                Ok(Resolution::Recovered(_)) => {
                    "settled; credential and receipt recovered".to_string()
                }
                Ok(Resolution::Closed(why)) => format!("closed ({why})"),
                Ok(Resolution::StillPending) => match intent.status {
                    IntentStatus::Pending => {
                        "pending; blocks new payments for this model".to_string()
                    }
                    IntentStatus::Abandoned => "abandoned; still pending in the wallet".to_string(),
                },
                Err(err) => format!("not checked: {err}"),
            },
        };
        lines.push(format!("{}  {state}", describe(intent)));
    }
    lines.join("\n")
}

async fn abandon(plugin: &Plugin, hash: &str) -> String {
    let _guard = match lock(plugin).await {
        Ok(guard) => guard,
        Err(message) => return message,
    };
    let intents = match plugin.intents.all() {
        Ok(intents) => intents,
        Err(err) => return format!("rpi-402: cannot read the recorded payments: {err}"),
    };
    let Some(intent) = intents
        .into_iter()
        .find(|intent| intent.payment_hash == hash)
    else {
        return format!("rpi-402: no recorded payment {hash}.");
    };

    // Ask the wallet once more before clearing anything.
    if let Err(err) = plugin.wallet.ensure_ready().await {
        return format!("rpi-402: cannot reach the wallet ({err}); nothing changed.");
    }
    match plugin.reconcile(&intent).await {
        Ok(Resolution::Recovered(_)) => format!(
            "rpi-402: payment {hash} settled; its credential and receipt are stored, so there is nothing to abandon."
        ),
        Ok(Resolution::Closed(why)) => format!("rpi-402: payment {hash} is {why}; its record is closed."),
        Ok(Resolution::StillPending) if intent.status == IntentStatus::Abandoned => {
            format!("rpi-402: payment {hash} is already abandoned and still pending in the wallet.")
        }
        Ok(Resolution::StillPending) => {
            let abandoned = Intent {
                status: IntentStatus::Abandoned,
                ..intent
            };
            match plugin.intents.put(&abandoned) {
                Ok(()) => format!(
                    "rpi-402: payment {hash} is still pending in the wallet. It no longer blocks new \
                     payments for {}, still counts toward today's limit, and is recovered if it settles.",
                    abandoned.model
                ),
                Err(err) => format!("rpi-402: cannot update the recorded payment ({err}); nothing changed."),
            }
        }
        Err(err) => format!("rpi-402: cannot check payment {hash} with the wallet ({err}); nothing changed."),
    }
}
