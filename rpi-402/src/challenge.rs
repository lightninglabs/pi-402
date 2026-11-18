//! Parsing a seller's 402 challenge.
//!
//! Aperture run with `--enablempp` merges an MPP `Payment` offer and the L402
//! challenge into one `WWW-Authenticate` header, so the header is split into
//! its challenges (RFC 7235) and the L402 one is taken.

use serde_json::Value;

/// One challenge from a `WWW-Authenticate` header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Challenge {
    pub scheme: String,
    /// Parameters with lowercased names and unescaped values.
    pub params: Vec<(String, String)>,
    pub token68: Option<String>,
}

impl Challenge {
    pub fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// What an L402 challenge asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct L402Challenge {
    pub macaroon: String,
    pub invoice: String,
    /// The credential's expiry, when the seller states one.
    pub expires_at: String,
}

fn is_tchar(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(ch)
}

/// Split on commas that are outside quoted strings.
fn split_top_level(header: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (index, ch) in header.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            ',' if !quoted => {
                parts.push(&header[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&header[start..]);
    parts
}

/// Parse `name = value` where value is a token or a quoted string.
fn parse_param(text: &str) -> Option<(String, String)> {
    let text = text.trim();
    let name_end = text.find(|ch: char| !is_tchar(ch))?;
    if name_end == 0 {
        return None;
    }
    let name = &text[..name_end];
    let rest = text[name_end..]
        .trim_start()
        .strip_prefix('=')?
        .trim_start();
    let value = if let Some(quoted) = rest.strip_prefix('"') {
        let mut value = String::new();
        let mut chars = quoted.chars();
        loop {
            match chars.next()? {
                '\\' => value.push(chars.next()?),
                '"' => break,
                ch => value.push(ch),
            }
        }
        if !chars.as_str().trim().is_empty() {
            return None;
        }
        value
    } else {
        if rest.is_empty() || !rest.chars().all(is_tchar) {
            return None;
        }
        rest.to_string()
    };
    Some((name.to_ascii_lowercase(), value))
}

/// Parse every challenge in the given `WWW-Authenticate` header values.
pub fn parse_challenges<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<Challenge> {
    let mut challenges: Vec<Challenge> = Vec::new();
    for value in values {
        for element in split_top_level(value) {
            let element = element.trim();
            if element.is_empty() {
                continue;
            }
            // A new challenge starts with a scheme token followed by
            // whitespace and something other than '=' (or by nothing).
            let token_end = element
                .find(|ch: char| !is_tchar(ch))
                .unwrap_or(element.len());
            let after = &element[token_end..];
            let starts_challenge = token_end > 0
                && (after.is_empty()
                    || (after.starts_with(char::is_whitespace)
                        && !after.trim_start().starts_with('=')));
            if starts_challenge {
                let mut challenge = Challenge {
                    scheme: element[..token_end].to_string(),
                    params: Vec::new(),
                    token68: None,
                };
                let rest = after.trim();
                if !rest.is_empty() {
                    match parse_param(rest) {
                        Some(param) => challenge.params.push(param),
                        None => challenge.token68 = Some(rest.to_string()),
                    }
                }
                challenges.push(challenge);
            } else if let (Some(current), Some(param)) =
                (challenges.last_mut(), parse_param(element))
            {
                current.params.push(param);
            }
        }
    }
    challenges
}

/// The first L402 (or legacy LSAT) challenge carrying a macaroon and invoice.
pub fn l402_from_headers<'a>(values: impl IntoIterator<Item = &'a str>) -> Option<L402Challenge> {
    parse_challenges(values).into_iter().find_map(|challenge| {
        let scheme = challenge.scheme.to_ascii_lowercase();
        if scheme != "l402" && scheme != "lsat" {
            return None;
        }
        let macaroon = challenge.param("macaroon").filter(|v| !v.is_empty())?;
        let invoice = challenge.param("invoice").filter(|v| !v.is_empty())?;
        Some(L402Challenge {
            macaroon: macaroon.to_string(),
            invoice: invoice.to_string(),
            expires_at: String::new(),
        })
    })
}

/// The challenge from a JSON 402 body, which the TS client prefers when the
/// seller answers with `application/json`.
pub fn l402_from_json(body: &Value) -> Option<L402Challenge> {
    let field = |name: &str| {
        body.get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let macaroon = field("macaroon");
    let invoice = field("invoice");
    if macaroon.is_empty() || invoice.is_empty() {
        return None;
    }
    Some(L402Challenge {
        macaroon,
        invoice,
        expires_at: field("expires_at"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_l402_challenge() {
        let challenge =
            l402_from_headers([r#"L402 macaroon="AgEDbG5k==", invoice="lnbcrt10u1p""#]).unwrap();
        assert_eq!(challenge.macaroon, "AgEDbG5k==");
        assert_eq!(challenge.invoice, "lnbcrt10u1p");
    }

    #[test]
    fn a_merged_mpp_and_l402_header() {
        let header = concat!(
            r#"Payment id="abc", realm="seller", method="lightning", intent="charge", "#,
            r#"request="eyJhIjoxfQ", description="a, quoted \"comma\"", "#,
            r#"L402 macaroon="mac==", invoice="lninv""#
        );
        let challenges = parse_challenges([header]);
        assert_eq!(challenges.len(), 2);
        assert_eq!(challenges[0].scheme, "Payment");
        assert_eq!(
            challenges[0].param("description"),
            Some(r#"a, quoted "comma""#)
        );
        assert_eq!(challenges[1].scheme, "L402");
        let l402 = l402_from_headers([header]).unwrap();
        assert_eq!(
            (l402.macaroon.as_str(), l402.invoice.as_str()),
            ("mac==", "lninv")
        );
    }

    #[test]
    fn challenges_across_header_lines_and_legacy_lsat() {
        let l402 = l402_from_headers([
            r#"Payment id="x", realm="r", method="lightning", intent="charge", request="e30""#,
            r#"LSAT macaroon=mac, invoice = "inv""#,
        ])
        .unwrap();
        assert_eq!(
            (l402.macaroon.as_str(), l402.invoice.as_str()),
            ("mac", "inv")
        );
    }

    #[test]
    fn token68_and_incomplete_challenges() {
        let challenges = parse_challenges(["Basic YWxhZGRpbjpvcGVu==, Bearer"]);
        assert_eq!(challenges[0].token68.as_deref(), Some("YWxhZGRpbjpvcGVu=="));
        assert_eq!(challenges[1].scheme, "Bearer");
        assert!(
            l402_from_headers([r#"L402 macaroon="m""#]).is_none(),
            "no invoice"
        );
        assert!(l402_from_headers(["Payment id=\"x\""]).is_none());
        assert!(l402_from_headers([""]).is_none());
    }

    #[test]
    fn json_challenges() {
        let body = serde_json::json!({"macaroon": "m", "invoice": "i", "expires_at": "2030-01-01T00:00:00Z"});
        let challenge = l402_from_json(&body).unwrap();
        assert_eq!(challenge.expires_at, "2030-01-01T00:00:00Z");
        assert!(l402_from_json(&serde_json::json!({"invoice": "i"})).is_none());
    }
}
