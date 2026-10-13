// Pairing rules for a native app: what a typed gateway address means, what to call it, and what an answer says
// about the address and key it was reached with.
use crate::rest::encode_component;

pub fn normalize_base_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    let with_scheme = if trimmed.contains("://") { trimmed.to_owned() } else { format!("http://{trimmed}") };
    with_scheme.strip_suffix("/v1").map(str::to_owned).unwrap_or(with_scheme)
}

pub fn api_base(base_url: &str) -> String {
    format!("{}/v1", normalize_base_url(base_url))
}

pub fn socket_url(base_url: &str, session_id: &str, after_seq: i64) -> String {
    let base = api_base(base_url);
    let base = base.strip_prefix("http").map_or(base.clone(), |rest| format!("ws{rest}"));
    format!("{base}/sessions/{}/ws?afterSeq={after_seq}&truncateResults=1&imageRefs=1", encode_component(session_id))
}

// A tailnet or LAN name reads as its first label; an IP address stays whole.
pub fn gateway_name(base_url: &str) -> String {
    let url = normalize_base_url(base_url);
    let rest = url.split_once("://").map_or(url.as_str(), |(_, rest)| rest);
    let host = rest.split('/').next().unwrap_or_default();
    let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
    let host = host.split(':').next().unwrap_or_default();
    if host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        host.to_owned()
    } else {
        host.split('.').next().unwrap_or_default().to_owned()
    }
}

// A wrong key or path falls through to the dashboard, which answers HTML (or 405), never JSON.
pub fn classify_answer(status: u16, content_type: Option<&str>) -> Option<String> {
    if status == 401 || status == 403 {
        return Some("The gateway refused the auth key".to_owned());
    }
    if !content_type.is_some_and(|value| value.trim_start().to_ascii_lowercase().starts_with("application/json")) {
        return Some("Not a WorkerDeck gateway, or the auth key is wrong".to_owned());
    }
    if !(200..300).contains(&status) {
        return Some(format!("The gateway answered {status}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typed_address_gains_a_scheme_and_loses_its_api_suffix() {
        assert_eq!(normalize_base_url(" mac.tail.ts.net:8787/ "), "http://mac.tail.ts.net:8787");
        assert_eq!(normalize_base_url("https://deck.example/v1"), "https://deck.example");
        assert_eq!(api_base("https://deck.example/v1/"), "https://deck.example/v1");
    }

    #[test]
    fn the_socket_url_swaps_the_scheme_and_encodes_the_id() {
        assert_eq!(
            socket_url("https://deck.example", "a b", 7),
            "wss://deck.example/v1/sessions/a%20b/ws?afterSeq=7&truncateResults=1&imageRefs=1"
        );
        assert!(socket_url("10.0.2.2:8790", "s", -1).starts_with("ws://10.0.2.2:8790/v1/"));
    }

    #[test]
    fn a_name_is_the_first_label_unless_it_is_an_address() {
        assert_eq!(gateway_name("http://mac.tail.ts.net:8787"), "mac");
        assert_eq!(gateway_name("http://10.0.2.2:8790"), "10.0.2.2");
        assert_eq!(gateway_name("deck"), "deck");
    }

    #[test]
    fn only_a_json_success_is_a_gateway() {
        assert_eq!(classify_answer(200, Some("application/json; charset=utf-8")), None);
        assert!(classify_answer(200, Some("text/html")).is_some());
        assert!(classify_answer(405, Some("text/html")).is_some());
        assert!(classify_answer(401, Some("application/json")).is_some());
        assert_eq!(classify_answer(500, Some("application/json")).as_deref(), Some("The gateway answered 500"));
    }
}
