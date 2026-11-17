//! The state one plugin instance shares across requests and commands.

use crate::config::Config;
use crate::store::{IntentStore, ReceiptLog, TokenStore};
use crate::util::Log;
use crate::wallet::Wallet;
use std::sync::{Arc, OnceLock};

pub struct Plugin {
    pub config: Config,
    pub wallet: Wallet,
    pub tokens: TokenStore,
    pub receipts: ReceiptLog,
    pub intents: IntentStore,
    pub log: Log,
    /// Serializes payments in this process, and the `/intents` command
    /// against them, so two requests for the same model never pay twice and
    /// each budget check sees the intents written before it.
    pub payment_lock: tokio::sync::Mutex<()>,
}

impl Plugin {
    pub fn new(config: Config) -> Result<Self, String> {
        let log = Log::new(&config.data_dir);
        Ok(Self {
            wallet: Wallet::new(&config.gateway, &config.wallet_password)?,
            tokens: TokenStore::new(&config.data_dir, log.clone()),
            receipts: ReceiptLog::new(&config.data_dir),
            intents: IntentStore::new(&config.data_dir),
            log,
            payment_lock: tokio::sync::Mutex::new(()),
            config,
        })
    }

    /// The process-wide instance, configured from the environment on first
    /// use. A configuration error is reported on every request.
    pub fn global() -> Result<Arc<Self>, String> {
        static GLOBAL: OnceLock<Result<Arc<Plugin>, String>> = OnceLock::new();
        GLOBAL
            .get_or_init(|| Config::from_env().and_then(Plugin::new).map(Arc::new))
            .clone()
    }
}
