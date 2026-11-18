//! Small helpers shared by the modules: time, amounts, logging.

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The current time as an ISO 8601 string with millisecond precision, the
/// format JavaScript's `toISOString` writes into the shared files.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// The current UTC day as `YYYY-MM-DD`, the key the daily budget counts by.
pub fn today() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

/// The UTC day of an ISO timestamp, by the same rule as the TS ledger: the
/// first ten characters.
pub fn day_of(timestamp: &str) -> Option<&str> {
    timestamp.get(..10)
}

/// Parse an expiry timestamp to milliseconds since the epoch. Accepts RFC 3339
/// and a bare date, the forms a JavaScript `Date` reads from these files.
pub fn parse_time_ms(value: &str) -> Option<i64> {
    if let Ok(time) = DateTime::parse_from_rfc3339(value) {
        return Some(time.timestamp_millis());
    }
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

/// Read a JSON number that may also arrive as a decimal string, which is how
/// the wallet gateway encodes 64-bit integers.
pub fn json_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// Group the digits of a sat amount for display ("58,000").
pub fn format_sat(sat: f64) -> String {
    let whole = sat.trunc() as i128;
    let fraction = sat - sat.trunc();
    let digits = whole.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    if whole < 0 {
        grouped.insert(0, '-');
    }
    if fraction.abs() > f64::EPSILON {
        let rest = format!("{:.3}", fraction.abs());
        grouped.push_str(rest.trim_start_matches('0').trim_end_matches('0'));
    }
    grouped
}

/// Log appends warnings to `rpi-402.log` in the data directory. The plugin
/// runs inside rpi's terminal UI, where writing to stderr would draw over it.
#[derive(Clone)]
pub struct Log {
    path: PathBuf,
}

impl Log {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("rpi-402.log"),
        }
    }

    /// Append one line. Logging never fails the caller.
    pub fn warn(&self, message: &str) {
        let _ = crate::store::ensure_dir(self.path.parent().unwrap_or(Path::new(".")));
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(&self.path) {
            let _ = writeln!(file, "{} {}", now_iso(), message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sat_amounts_group_like_to_locale_string() {
        assert_eq!(format_sat(0.0), "0");
        assert_eq!(format_sat(999.0), "999");
        assert_eq!(format_sat(1_200.0), "1,200");
        assert_eq!(format_sat(58_000.0), "58,000");
        assert_eq!(format_sat(1_234_567.0), "1,234,567");
        assert_eq!(format_sat(1_000.5), "1,000.5");
    }

    #[test]
    fn timestamps_match_the_ts_format() {
        let now = now_iso();
        assert_eq!(now.len(), "2026-11-17T10:20:30.123Z".len());
        assert!(now.ends_with('Z'));
        assert_eq!(day_of(&now), Some(today().as_str()));
    }

    #[test]
    fn expiry_parsing() {
        assert_eq!(parse_time_ms("1970-01-01T00:00:01.000Z"), Some(1_000));
        assert_eq!(parse_time_ms("1970-01-02"), Some(86_400_000));
        assert_eq!(parse_time_ms("not a date"), None);
    }

    #[test]
    fn numbers_arrive_as_numbers_or_strings() {
        assert_eq!(json_number(&serde_json::json!(12)), Some(12.0));
        assert_eq!(json_number(&serde_json::json!("12")), Some(12.0));
        assert_eq!(json_number(&serde_json::json!(null)), None);
        assert_eq!(json_number(&serde_json::json!("x")), None);
    }
}
