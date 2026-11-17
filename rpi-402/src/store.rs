//! Durable state in the data directory shared with the TS extension
//! (`PI402_DATA_DIR`, default `~/.pi402`).
//!
//! `tokens.json` and `receipts.ndjson` are also written by concurrent Pi
//! sessions, so these stores follow the TS rules exactly: every operation
//! reads fresh; a rewrite re-reads, merges, writes a uniquely named temporary
//! file and renames it over the original; a receipt is one single-write line;
//! files are mode 0600; a corrupt file is moved aside, never deleted.
//! `intents/` is rpi-402's own: one atomically replaced file per payment.

use crate::util::{self, json_number, Log};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Create a directory (and parents) with owner-only permissions.
pub fn ensure_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Replace `path` atomically with `contents`, mode 0600. The temporary name
/// is unique per write, so concurrent writers never truncate each other's
/// temporary file before the rename.
fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    ensure_dir(dir)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        "{name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = options
        .open(&tmp)
        .and_then(|mut file| file.write_all(contents))
        .and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Serialize the way `JSON.stringify(state, null, "\t")` does.
fn to_tab_json(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    value
        .serialize(&mut serializer)
        .expect("JSON values always serialize");
    out
}

/// A `{"version":1,"<field>":{...}}` file of keyed entries. Entries stay raw
/// JSON so a rewrite never drops fields another writer added.
struct KeyedFile {
    path: PathBuf,
    field: &'static str,
    log: Log,
}

impl KeyedFile {
    /// Read the entries fresh. A missing file is empty. A corrupt file is set
    /// aside and reads as empty: a broken cache must never block payments.
    /// Any other read failure propagates, because the intact file may still
    /// hold other sessions' entries that a rewrite from "empty" would destroy.
    fn read(&self) -> io::Result<Map<String, Value>> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Map::new()),
            Err(err) => return Err(err),
        };
        match serde_json::from_str::<Value>(&raw) {
            Ok(state) => Ok(state
                .get(self.field)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()),
            Err(_) => {
                self.log.warn(&format!(
                    "{} is corrupt, setting it aside",
                    self.path.display()
                ));
                let aside = PathBuf::from(format!(
                    "{}.{}.corrupt",
                    self.path.display(),
                    util::now_ms()
                ));
                // Another session may have set it aside already; losing that
                // race is fine.
                let _ = fs::rename(&self.path, aside);
                Ok(Map::new())
            }
        }
    }

    fn write(&self, entries: Map<String, Value>) -> io::Result<()> {
        let mut state = Map::new();
        state.insert("version".into(), Value::from(1));
        state.insert(self.field.into(), Value::Object(entries));
        write_atomic(&self.path, &to_tab_json(&Value::Object(state)))
    }
}

/// A paid L402 credential: the bearer token for a bundle's unspent balance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub macaroon_b64: String,
    pub preimage_hex: String,
    #[serde(default)]
    pub expires_at: String,
}

impl Token {
    /// The `Authorization` header value presenting this credential.
    pub fn authorization(&self) -> String {
        format!("L402 {}:{}", self.macaroon_b64, self.preimage_hex)
    }
}

/// Whether a stored token is past its expiry. An empty expiry never expires;
/// one that fails to parse counts as expired, because an immortal bearer
/// credential is the wrong failure mode for garbage input.
fn token_expired(entry: &Value) -> bool {
    match entry.get("expiresAt") {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) if text.is_empty() => false,
        Some(Value::String(text)) => match util::parse_time_ms(text) {
            Some(expires) => util::now_ms() > expires,
            None => true,
        },
        Some(_) => true,
    }
}

/// `tokens.json`: paid L402 tokens keyed by `<origin>|<path>|<model>|POST`.
pub struct TokenStore {
    file: KeyedFile,
}

impl TokenStore {
    pub fn new(dir: &Path, log: Log) -> Self {
        Self {
            file: KeyedFile {
                path: dir.join("tokens.json"),
                field: "tokens",
                log,
            },
        }
    }

    /// Live entries, dropping expired ones.
    fn live(&self) -> io::Result<Map<String, Value>> {
        let mut entries = self.file.read()?;
        entries.retain(|_, entry| entry.is_object() && !token_expired(entry));
        Ok(entries)
    }

    /// The token cached under `key`. A store that cannot be read is a reason
    /// to buy, not to fail the request: the worst case is buying a bundle.
    pub fn get(&self, key: &str) -> Option<Token> {
        match self.live() {
            Ok(entries) => entries
                .get(key)
                .and_then(|entry| serde_json::from_value(entry.clone()).ok()),
            Err(err) => {
                self.file.log.warn(&format!(
                    "token store {} is unreadable, continuing without it: {err}",
                    self.file.path.display()
                ));
                None
            }
        }
    }

    /// Cache `token` under `key`, merging with what other sessions wrote.
    pub fn put(&self, key: &str, token: &Token) -> io::Result<()> {
        let mut entries = self.live()?;
        entries.insert(
            key.to_string(),
            serde_json::to_value(token).expect("tokens serialize"),
        );
        self.file.write(entries)
    }

    /// Drop the token under `key` if it is still `token`. Another session may
    /// have replaced a spent token with a fresh one in the meantime.
    pub fn remove_if(&self, key: &str, token: &Token) -> io::Result<()> {
        let mut entries = self.live()?;
        let matches = entries
            .get(key)
            .and_then(|entry| entry.get("preimageHex"))
            .and_then(Value::as_str)
            == Some(token.preimage_hex.as_str());
        if !matches {
            return Ok(());
        }
        entries.remove(key);
        self.file.write(entries)
    }
}

/// One line of the receipt ledger. The fields and their names match the TS
/// extension's receipts, so both extensions read each other's spend.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub payment_hash: String,
    /// Invoice face value.
    pub amount_sat: u64,
    /// What the wallet paid, fees included.
    pub paid_sat: u64,
    pub invoice: String,
    pub preimage_hex: String,
    pub url: String,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// What a receipt line counts against the day: the larger of `paidSat` and
/// the invoice amount. A payment cannot cost less than its invoice, but the
/// TS extension records what left the wallet, which credit can bring below
/// it; this keeps those receipts from understating the shared total. Only
/// finite non-negative values count, so one bad line cannot poison or erode
/// the day's total.
fn receipt_paid_sat(line: &Value) -> f64 {
    ["paidSat", "amountSat"]
        .iter()
        .filter_map(|field| line.get(*field).and_then(json_number))
        .filter(|sat| sat.is_finite() && *sat >= 0.0)
        .fold(0.0, f64::max)
}

/// Whether a file's last byte is something other than a newline.
fn ends_mid_line(file: &mut fs::File) -> io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom};
    if file.metadata()?.len() == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    Ok(last[0] != b'\n')
}

/// `receipts.ndjson`: the append-only ledger of settled payments.
pub struct ReceiptLog {
    path: PathBuf,
}

impl ReceiptLog {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("receipts.ndjson"),
        }
    }

    /// Append one receipt as a single write, so concurrent writers interleave
    /// whole lines. A crash mid-append can leave a line without its newline;
    /// the new line starts on a line of its own rather than joining it.
    pub fn append(&self, receipt: &Receipt) -> io::Result<()> {
        ensure_dir(self.path.parent().unwrap_or(Path::new(".")))?;
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true).read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&self.path)?;
        let mut line = String::new();
        if ends_mid_line(&mut file)? {
            line.push('\n');
        }
        line.push_str(&serde_json::to_string(receipt).expect("receipts serialize"));
        line.push('\n');
        file.write_all(line.as_bytes())?;
        // The mode above only applies on creation; receipts hold preimages,
        // so tighten a file another writer created too.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// Every well-formed line, oldest first. A partial trailing line or any
    /// line without a string `paymentHash` and `timestamp` is skipped.
    pub fn read_all(&self) -> io::Result<Vec<Value>> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err),
        };
        Ok(raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|line| {
                line.get("paymentHash").is_some_and(Value::is_string)
                    && line.get("timestamp").is_some_and(Value::is_string)
            })
            .collect())
    }

    /// Sats paid on the current UTC day, fees included, by Pi and rpi alike.
    pub fn spent_today_sat(&self) -> io::Result<f64> {
        Ok(spent_on(&self.read_all()?, &util::today()))
    }

    /// Whether a receipt for `payment_hash` is already in the ledger.
    pub fn contains(&self, payment_hash: &str) -> io::Result<bool> {
        Ok(self
            .read_all()?
            .iter()
            .any(|line| line["paymentHash"].as_str() == Some(payment_hash)))
    }
}

/// Where an intent stands. Settled and failed payments leave the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IntentStatus {
    /// Dispatched, or about to be, with the outcome unknown. Blocks further
    /// payments for its cache key.
    Pending,
    /// Cleared by hand while the wallet still reported it pending. No longer
    /// blocks its cache key, still counts against the daily budget, and is
    /// recovered if the wallet later reports it settled.
    Abandoned,
}

/// A payment recorded before dispatch, holding everything needed to rebuild
/// the credential and the receipt without the original request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub payment_hash: String,
    pub send_intent_id: String,
    pub cache_key: String,
    pub macaroon_b64: String,
    pub invoice: String,
    /// The credential's expiry from the challenge; empty when it carried none.
    #[serde(default)]
    pub expires_at: String,
    /// Invoice face value.
    pub amount_sat: u64,
    /// The quoted fee.
    pub fee_sat: u64,
    /// The fee cap the wallet enforces at dispatch. The daily budget
    /// reserves the invoice plus this until the payment resolves.
    pub max_fee_sat: u64,
    pub url: String,
    pub model: String,
    pub created_at: String,
    /// When the wallet's quote expires; a send never dispatched cannot
    /// happen after this.
    #[serde(default)]
    pub quote_expires_at_unix: i64,
    pub status: IntentStatus,
}

impl Intent {
    /// The most this payment can still cost: the invoice with the fee at
    /// its cap.
    pub fn reserved_sat(&self) -> u64 {
        self.amount_sat + self.fee_sat.max(self.max_fee_sat)
    }
}

/// `intents/`: payments whose outcome is not known yet, one file per payment
/// named by its payment hash. Each rpi process writes only its own payments'
/// files, each replaced atomically, so concurrent processes cannot erase each
/// other's records the way a shared read-merge-write file could.
pub struct IntentStore {
    dir: PathBuf,
}

impl IntentStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.join("intents"),
        }
    }

    /// The file for a payment. The hash names a file, so anything but hex is
    /// refused rather than turned into a path.
    fn path(&self, payment_hash: &str) -> io::Result<PathBuf> {
        if payment_hash.is_empty() || !payment_hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("payment hash {payment_hash:?} is not hex"),
            ));
        }
        Ok(self.dir.join(format!("{payment_hash}.json")))
    }

    /// Every intent, oldest first. A file that cannot be parsed is an error,
    /// not a skipped entry: it may be a payment still in flight, so the day's
    /// spend and the model it blocks are unknown until someone looks at it.
    pub fn all(&self) -> io::Result<Vec<Intent>> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err),
        };
        let mut intents = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                // Closed by another process since the listing.
                Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                Err(err) => return Err(err),
            };
            let intent = serde_json::from_str::<Intent>(&raw).map_err(|err| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("cannot parse recorded payment {}: {err}", path.display()),
                )
            })?;
            intents.push(intent);
        }
        intents.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(intents)
    }

    pub fn for_key(&self, cache_key: &str) -> io::Result<Vec<Intent>> {
        Ok(self
            .all()?
            .into_iter()
            .filter(|intent| intent.cache_key == cache_key)
            .collect())
    }

    pub fn put(&self, intent: &Intent) -> io::Result<()> {
        let path = self.path(&intent.payment_hash)?;
        let value = serde_json::to_value(intent).expect("intents serialize");
        write_atomic(&path, &to_tab_json(&value))
    }

    pub fn remove(&self, payment_hash: &str) -> io::Result<()> {
        match fs::remove_file(self.path(payment_hash)?) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
            _ => Ok(()),
        }
    }
}

/// What receipt lines dated `day` count against it, each payment once. Two
/// processes recovering the same payment can both append its receipt; a
/// payment hash counts at the larger of its lines.
pub fn spent_on(lines: &[Value], day: &str) -> f64 {
    let mut by_payment: HashMap<&str, f64> = HashMap::new();
    for line in lines {
        if line["timestamp"].as_str().and_then(util::day_of) != Some(day) {
            continue;
        }
        let Some(hash) = line["paymentHash"].as_str() else {
            continue;
        };
        let paid = receipt_paid_sat(line);
        let counted = by_payment.entry(hash).or_insert(0.0);
        *counted = counted.max(paid);
    }
    by_payment.values().sum()
}

/// What intents created on `day` reserve against it, leaving out those in
/// `recorded`, whose receipts are in the ledger and count instead.
pub fn reserved_on(intents: &[Intent], day: &str, recorded: &HashSet<&str>) -> f64 {
    intents
        .iter()
        .filter(|intent| util::day_of(&intent.created_at) == Some(day))
        .filter(|intent| !recorded.contains(intent.payment_hash.as_str()))
        .map(|intent| intent.reserved_sat() as f64)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(dir: &Path) -> Log {
        Log::new(dir)
    }

    fn token(preimage: &str, expires_at: &str) -> Token {
        Token {
            macaroon_b64: "mac".into(),
            preimage_hex: preimage.into(),
            expires_at: expires_at.into(),
        }
    }

    #[test]
    fn tokens_use_the_ts_file_format() {
        let dir = tempfile::tempdir().unwrap();
        let store = TokenStore::new(dir.path(), log(dir.path()));
        store.put("k", &token("aa", "")).unwrap();
        let raw = fs::read_to_string(dir.path().join("tokens.json")).unwrap();
        let state: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(state["version"], 1);
        assert_eq!(
            state["tokens"]["k"],
            serde_json::json!({"macaroonB64": "mac", "preimageHex": "aa", "expiresAt": ""})
        );
        assert!(
            raw.contains("\n\t\"version\""),
            "tab-indented like the TS writer"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join("tokens.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn tokens_written_by_ts_are_read_and_their_fields_kept() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("tokens.json"),
            r#"{"version":1,"tokens":{
                "pi":{"macaroonB64":"m1","preimageHex":"p1","expiresAt":"","extra":7},
                "old":{"macaroonB64":"m2","preimageHex":"p2","expiresAt":"2000-01-01T00:00:00.000Z"},
                "bad":{"macaroonB64":"m3","preimageHex":"p3","expiresAt":"garbage"}
            }}"#,
        )
        .unwrap();
        let store = TokenStore::new(dir.path(), log(dir.path()));
        assert_eq!(
            store.get("pi"),
            Some(token("p1", "")).map(|t| Token {
                macaroon_b64: "m1".into(),
                ..t
            })
        );
        assert_eq!(store.get("old"), None, "expired");
        assert_eq!(
            store.get("bad"),
            None,
            "an unparseable expiry counts as expired"
        );

        store.put("rpi", &token("p4", "")).unwrap();
        let state: Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("tokens.json")).unwrap())
                .unwrap();
        assert_eq!(
            state["tokens"]["pi"]["extra"], 7,
            "another writer's fields survive"
        );
        assert!(
            state["tokens"].get("old").is_none(),
            "expired entries fall out on rewrite"
        );
        assert!(state["tokens"].get("rpi").is_some());
    }

    #[test]
    fn remove_if_leaves_a_replacement_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = TokenStore::new(dir.path(), log(dir.path()));
        store.put("k", &token("new", "")).unwrap();
        store.remove_if("k", &token("old", "")).unwrap();
        assert!(store.get("k").is_some());
        store.remove_if("k", &token("new", "")).unwrap();
        assert!(store.get("k").is_none());
    }

    #[test]
    fn a_corrupt_token_file_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("tokens.json"), "{not json").unwrap();
        let store = TokenStore::new(dir.path(), log(dir.path()));
        assert_eq!(store.get("k"), None);
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            names
                .iter()
                .any(|name| name.starts_with("tokens.json.") && name.ends_with(".corrupt")),
            "{names:?}"
        );
        assert!(!dir.path().join("tokens.json").exists());
    }

    #[test]
    fn receipts_match_the_ts_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let log = ReceiptLog::new(dir.path());
        let now = util::now_iso();
        log.append(&Receipt {
            payment_hash: "h1".into(),
            amount_sat: 100,
            paid_sat: 103,
            invoice: "lnbc".into(),
            preimage_hex: "p".into(),
            url: "http://seller/v1/chat/completions".into(),
            timestamp: now.clone(),
            model: Some("m".into()),
        })
        .unwrap();
        // Lines another writer added: a Pi receipt, a string amount, junk,
        // yesterday's spend, a negative value, and a partial line.
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(dir.path().join("receipts.ndjson"))
            .unwrap();
        writeln!(
            file,
            r#"{{"paymentHash":"h2","amountSat":50,"paidSat":"52","timestamp":"{now}"}}"#
        )
        .unwrap();
        writeln!(file, "not json").unwrap();
        writeln!(
            file,
            r#"{{"paymentHash":"h3","paidSat":1000,"timestamp":"2000-01-01T00:00:00.000Z"}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"paymentHash":"h4","paidSat":-40,"timestamp":"{now}"}}"#
        )
        .unwrap();
        writeln!(file, r#"{{"paymentHash":"h5","paidSat":7,"timestamp":12}}"#).unwrap();
        // A receipt counts at least its invoice amount: a zero, garbage, or
        // a Pi receipt for a credit-funded payment (paidSat below the
        // invoice) all count the invoice.
        writeln!(
            file,
            r#"{{"paymentHash":"h7","amountSat":50,"paidSat":0,"timestamp":"{now}"}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"paymentHash":"h8","amountSat":20,"paidSat":"x","timestamp":"{now}"}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"paymentHash":"h9","amountSat":10000,"paidSat":7020,"timestamp":"{now}"}}"#
        )
        .unwrap();
        write!(file, r#"{{"paymentHash":"h6","paid"#).unwrap();

        assert_eq!(log.spent_today_sat().unwrap(), 10_225.0);
        // The same payment recorded twice counts once, at the larger line.
        writeln!(file).unwrap();
        writeln!(
            file,
            r#"{{"paymentHash":"h1","amountSat":100,"paidSat":110,"timestamp":"{now}"}}"#
        )
        .unwrap();
        assert_eq!(log.spent_today_sat().unwrap(), 10_232.0);
        assert!(log.contains("h1").unwrap());
        assert!(!log.contains("h6").unwrap());
        let first: Value = serde_json::from_str(
            fs::read_to_string(dir.path().join("receipts.ndjson"))
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        let keys: Vec<&str> = first
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "paymentHash",
                "amountSat",
                "paidSat",
                "invoice",
                "preimageHex",
                "url",
                "timestamp",
                "model"
            ]
        );
    }

    #[test]
    fn a_receipt_after_a_partial_line_starts_its_own_line() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("receipts.ndjson"),
            r#"{"paymentHash":"crashed","pai"#,
        )
        .unwrap();
        let log = ReceiptLog::new(dir.path());
        log.append(&Receipt {
            payment_hash: "h1".into(),
            amount_sat: 1,
            paid_sat: 1,
            invoice: "i".into(),
            preimage_hex: "p".into(),
            url: "u".into(),
            timestamp: util::now_iso(),
            model: None,
        })
        .unwrap();
        assert!(log.contains("h1").unwrap());
    }

    #[test]
    fn a_malformed_intent_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = IntentStore::new(dir.path());
        fs::create_dir_all(dir.path().join("intents")).unwrap();
        fs::write(dir.path().join("intents/ab.json"), "{ not json").unwrap();
        let err = store.all().unwrap_err();
        assert!(err.to_string().contains("ab.json"), "{err}");
    }

    #[test]
    fn intents_round_trip_and_count_today() {
        let dir = tempfile::tempdir().unwrap();
        let store = IntentStore::new(dir.path());
        let intent = Intent {
            payment_hash: "aa".into(),
            send_intent_id: "s".into(),
            cache_key: "k".into(),
            macaroon_b64: "m".into(),
            invoice: "i".into(),
            expires_at: String::new(),
            amount_sat: 90,
            fee_sat: 5,
            max_fee_sat: 30,
            url: "u".into(),
            model: "model".into(),
            created_at: util::now_iso(),
            quote_expires_at_unix: 0,
            status: IntentStatus::Pending,
        };
        store.put(&intent).unwrap();
        store
            .put(&Intent {
                payment_hash: "bb".into(),
                created_at: "2000-01-01T00:00:00.000Z".into(),
                status: IntentStatus::Abandoned,
                ..intent.clone()
            })
            .unwrap();
        // Leftovers that are not intents are ignored.
        fs::write(dir.path().join("intents/cc.json.1.x.tmp"), "{").unwrap();
        assert_eq!(store.for_key("k").unwrap().len(), 2);
        assert_eq!(
            reserved_on(&store.all().unwrap(), &util::today(), &HashSet::new()),
            120.0,
            "reserves the fee cap"
        );
        assert_eq!(
            reserved_on(
                &store.all().unwrap(),
                &util::today(),
                &HashSet::from(["aa"])
            ),
            0.0,
            "a recorded receipt replaces the reservation"
        );
        let raw = fs::read_to_string(dir.path().join("intents/bb.json")).unwrap();
        assert!(raw.contains("\"status\": \"abandoned\""), "{raw}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join("intents/aa.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(store
            .put(&Intent {
                payment_hash: "../x".into(),
                ..intent.clone()
            })
            .is_err());
        store.remove("aa").unwrap();
        store.remove("aa").unwrap();
        assert_eq!(store.all().unwrap().len(), 1);
    }
}
