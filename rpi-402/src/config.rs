//! Settings, read from the same environment variables as the TypeScript
//! extension so Pi and rpi share one configuration.

use std::path::PathBuf;
use std::time::Duration;

/// Seller URL used when `L402_PROXY_URL` is unset, the TS extension's default.
/// Like there, a set value includes the API prefix (for aperture, `/v1`).
pub const DEFAULT_PROXY_URL: &str = "http://localhost:8402";

/// The `waved` HTTP/JSON gateway used when `PI402_WALLETD_GATEWAY` is unset.
pub const DEFAULT_GATEWAY: &str = "http://localhost:10031";

/// The throwaway password used on non-mainnet networks. Mainnet refuses it.
pub const DEFAULT_WALLET_PASSWORD: &str = "pi402-dev-password";

const DEFAULT_MAX_SAT_PER_REQUEST: f64 = 1_000.0;
const DEFAULT_DAILY_CAP_SAT: f64 = 100_000.0;

/// How long a dispatched send may take to settle before the payer stops
/// waiting. Swaps take seconds; minutes means stuck.
pub const DEFAULT_PREIMAGE_TIMEOUT: Duration = Duration::from_secs(120);

/// Plugin settings. Deliberately not `Debug`: it carries the wallet password.
#[derive(Clone)]
pub struct Config {
    pub gateway: String,
    pub wallet_password: String,
    pub max_sat_per_request: f64,
    pub daily_cap_sat: f64,
    pub data_dir: PathBuf,
    pub preimage_timeout: Duration,
}

impl Config {
    /// Read the settings from the process environment.
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Read the settings through `get`, which returns a variable's value.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let set = |name: &str| get(name).filter(|value| !value.is_empty());

        let gateway = set("PI402_WALLETD_GATEWAY")
            .unwrap_or_else(|| DEFAULT_GATEWAY.to_string())
            .trim_end_matches('/')
            .to_string();

        let network = set("PI402_NETWORK").unwrap_or_else(|| "regtest".to_string());
        let wallet_password =
            set("PI402_WALLET_PASSWORD").unwrap_or_else(|| DEFAULT_WALLET_PASSWORD.to_string());
        if network == "mainnet" && wallet_password == DEFAULT_WALLET_PASSWORD {
            return Err(
                "refusing to start a mainnet wallet with the default password; \
                 set PI402_WALLET_PASSWORD to a strong secret"
                    .to_string(),
            );
        }

        let max_sat_per_request = read_sat_ceiling(
            "PI402_MAX_SAT_PER_REQUEST",
            set("PI402_MAX_SAT_PER_REQUEST"),
            DEFAULT_MAX_SAT_PER_REQUEST,
        )?;
        let daily_cap_sat = read_sat_ceiling(
            "PI402_DAILY_CAP_SAT",
            set("PI402_DAILY_CAP_SAT"),
            DEFAULT_DAILY_CAP_SAT,
        )?;

        let data_dir = match set("PI402_DATA_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => {
                let home = set("HOME").ok_or("HOME is unset; set PI402_DATA_DIR")?;
                PathBuf::from(home).join(".pi402")
            }
        };

        Ok(Self {
            gateway,
            wallet_password,
            max_sat_per_request,
            daily_cap_sat,
            data_dir,
            preimage_timeout: DEFAULT_PREIMAGE_TIMEOUT,
        })
    }
}

/// The model endpoint the provider is registered with: `L402_PROXY_URL` plus
/// `/chat/completions`, the URL the TS extension's OpenAI client posts to.
/// Registering the full endpoint keeps rpi from inserting `/v1`, so both
/// extensions post to the same path and share cached credentials. Requests
/// use the URL of the model they are given, which `models.json` may override.
pub fn proxy_endpoint() -> String {
    let proxy = std::env::var("L402_PROXY_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_PROXY_URL.to_string());
    endpoint_for(&proxy)
}

/// Append `/chat/completions` to a proxy URL unless it already ends with it.
pub fn endpoint_for(proxy: &str) -> String {
    let base = proxy.trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

/// Parse a positive sat ceiling. A missing value yields the default. A present
/// value that is not a positive number is an error, so a typo such as "1,000"
/// fails loudly instead of disabling the cap.
pub fn read_sat_ceiling(name: &str, raw: Option<String>, fallback: f64) -> Result<f64, String> {
    let Some(raw) = raw else {
        return Ok(fallback);
    };
    match raw.trim().parse::<f64>() {
        Ok(value) if value.is_finite() && value > 0.0 => Ok(value),
        _ => Err(format!("{name} must be a positive number, got {raw:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Result<Config, String> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn defaults_follow_the_ts_extension() {
        let config = config(&[("HOME", "/home/u")]).unwrap();
        assert_eq!(config.gateway, DEFAULT_GATEWAY);
        assert_eq!(config.max_sat_per_request, 1_000.0);
        assert_eq!(config.daily_cap_sat, 100_000.0);
        assert_eq!(config.data_dir, PathBuf::from("/home/u/.pi402"));
        assert_eq!(config.wallet_password, DEFAULT_WALLET_PASSWORD);
    }

    #[test]
    fn a_malformed_ceiling_is_an_error_not_a_disabled_cap() {
        let err = config(&[("HOME", "/h"), ("PI402_DAILY_CAP_SAT", "1,000")])
            .err()
            .unwrap();
        assert!(err.contains("PI402_DAILY_CAP_SAT"), "{err}");
        assert!(config(&[("HOME", "/h"), ("PI402_MAX_SAT_PER_REQUEST", "0")]).is_err());
        assert!(config(&[("HOME", "/h"), ("PI402_MAX_SAT_PER_REQUEST", "-5")]).is_err());
    }

    #[test]
    fn mainnet_refuses_the_default_password() {
        assert!(config(&[("HOME", "/h"), ("PI402_NETWORK", "mainnet")]).is_err());
        assert!(config(&[
            ("HOME", "/h"),
            ("PI402_NETWORK", "mainnet"),
            ("PI402_WALLET_PASSWORD", "a strong secret")
        ])
        .is_ok());
    }

    #[test]
    fn endpoints_match_the_ts_openai_client() {
        assert_eq!(
            endpoint_for("http://localhost:8402"),
            "http://localhost:8402/chat/completions"
        );
        assert_eq!(
            endpoint_for("http://seller:8404/v1/"),
            "http://seller:8404/v1/chat/completions"
        );
        assert_eq!(
            endpoint_for("http://seller/v1/chat/completions"),
            "http://seller/v1/chat/completions"
        );
    }

    #[test]
    fn data_dir_and_gateway_overrides() {
        let config = config(&[
            ("PI402_DATA_DIR", "/data"),
            ("PI402_WALLETD_GATEWAY", "http://127.0.0.1:9/"),
        ])
        .unwrap();
        assert_eq!(config.data_dir, PathBuf::from("/data"));
        assert_eq!(config.gateway, "http://127.0.0.1:9");
    }
}
