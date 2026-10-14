// Pairing rules for a native app: what a typed gateway address means, what to call it, and what an answer says
// about the address and key it was reached with.
use crate::planner::image_media_type;
use crate::rest::encode_component;
use crate::transcript::ProducedFile;

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

// One picture of a tool result, under the API base: the web's `toolResultImage`. A stale seq 404s, never another call's.
pub fn result_image_path(session_id: &str, seq: i64, tool_use_id: &str, part_index: i64) -> String {
    format!("/sessions/{}/events/{seq}/result?toolUseId={}&part={part_index}", encode_component(session_id), encode_component(tool_use_id))
}

// The web's `useHostImage`: a picture codex names by its host path is served as the produced file the session
// announced for it, which needs no host-file root; any other path goes through `/fs/read` and its roots.
// A produced file answers raw bytes; `/fs/read` answers JSON for `host_image_base64`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostImageFetch {
    pub path: String,
    pub fs_read: bool,
}

pub fn host_image_path(session_id: &str, path: &str, produced: Option<&ProducedFile>) -> HostImageFetch {
    match produced {
        Some(file) => HostImageFetch {
            path: format!("/sessions/{}/produced/{}", encode_component(session_id), encode_component(&file.file_id)),
            fs_read: false,
        },
        None => HostImageFetch { path: format!("/fs/read?path={}", encode_component(path)), fs_read: true },
    }
}

// What `/fs/read` answered, as base64 image bytes: only a binary read of a path named like a picture counts.
pub fn host_image_base64(body: &str, path: &str) -> Option<String> {
    image_media_type(path)?;
    let file: serde_json::Value = serde_json::from_str(body).ok()?;
    if file.get("encoding")?.as_str()? != "base64" {
        return None;
    }
    file.get("content")?.as_str().map(str::to_owned)
}

fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split('/').next().unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => host.split(':').next().unwrap_or_default(),
    }
}

// A tailnet or LAN name reads as its first label; an IP address stays whole.
pub fn gateway_name(base_url: &str) -> String {
    let url = normalize_base_url(base_url);
    let host = host_of(&url);
    if host.contains(':') || host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        host.to_owned()
    } else {
        host.split('.').next().unwrap_or_default().to_owned()
    }
}

// Names for every paired gateway at once: the short `gateway_name`, but two that share one fall back to the URL's
// authority (`host:port`), which is what tells them apart.
pub fn gateway_names(base_urls: &[String]) -> Vec<String> {
    let short: Vec<String> = base_urls.iter().map(|url| gateway_name(url)).collect();
    short
        .iter()
        .zip(base_urls)
        .map(|(name, url)| {
            if short.iter().filter(|other| *other == name).count() < 2 {
                return name.clone();
            }
            let url = normalize_base_url(url);
            let rest = url.split_once("://").map_or(url.as_str(), |(_, rest)| rest);
            let authority = rest.split('/').next().unwrap_or_default();
            authority.rsplit_once('@').map_or(authority, |(_, host)| host).to_owned()
        })
        .collect()
}

// The auth key rides every request, so plain `http` is only for a host the network itself keeps private: loopback,
// a LAN, link-local, a tailnet (WireGuard encrypts it; `*.ts.net` and Tailscale's 100.64.0.0/10), `*.local`.
pub fn cleartext_refusal(base_url: &str) -> Option<String> {
    let url = normalize_base_url(base_url);
    if !url.to_ascii_lowercase().starts_with("http://") {
        return None;
    }
    let host = host_of(&url).to_ascii_lowercase();
    let private = match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            let [a, b, ..] = ip.octets();
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || (a == 100 && (64..128).contains(&b))
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
        Err(_) => host == "localhost" || host.ends_with(".ts.net") || host.ends_with(".local") || !host.contains('.'),
    };
    (!private).then(|| "Use https for a gateway outside your LAN or tailnet: plain http would send the auth key in the clear".to_owned())
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

// `classify_answer` with the gateway's own reason: a refused action answers JSON `{ "error": "..." }`.
pub fn answer_error(status: u16, content_type: Option<&str>, body: &str) -> Option<String> {
    let generic = classify_answer(status, content_type)?;
    if !(400..600).contains(&status) || status == 401 || status == 403 || classify_answer(200, content_type).is_some() {
        return Some(generic);
    }
    let reason = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v.get("error")?.as_str().map(str::to_owned));
    Some(reason.filter(|r| !r.trim().is_empty()).unwrap_or(generic))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_names_tell_colliding_gateways_apart() {
        let urls = ["http://10.0.2.2:8790".to_owned(), "http://10.0.2.2:8791/".to_owned(), "http://mini.tail.ts.net:8787".to_owned()];
        assert_eq!(super::gateway_names(&urls), ["10.0.2.2:8790", "10.0.2.2:8791", "mini"]);
    }

    #[test]
    fn a_typed_address_gains_a_scheme_and_loses_its_api_suffix() {
        assert_eq!(normalize_base_url(" mac.tail.ts.net:8787/ "), "http://mac.tail.ts.net:8787");
        assert_eq!(normalize_base_url("https://deck.example/v1"), "https://deck.example");
        assert_eq!(api_base("https://deck.example/v1/"), "https://deck.example/v1");
    }

    #[test]
    fn a_host_picture_prefers_its_produced_file_and_reads_the_host_otherwise() {
        let file = ProducedFile { file_id: "f 1".into(), media_type: Some("image/png".into()), bytes: None };
        let fetch = |path: &str, fs_read| HostImageFetch { path: path.to_owned(), fs_read };
        assert_eq!(host_image_path("s 1", "/tmp/a b.png", Some(&file)), fetch("/sessions/s%201/produced/f%201", false));
        assert_eq!(host_image_path("s 1", "/tmp/a b.png", None), fetch("/fs/read?path=%2Ftmp%2Fa%20b.png", true));
    }

    #[test]
    fn only_a_binary_read_of_a_picture_name_is_a_host_picture() {
        let body = r#"{"path":"/tmp/a.png","content":"iVBO","encoding":"base64","bytes":3}"#;
        assert_eq!(host_image_base64(body, "/tmp/a.PNG").as_deref(), Some("iVBO"));
        assert_eq!(host_image_base64(body, "/tmp/a.txt"), None);
        assert_eq!(host_image_base64(&body.replace("base64", "utf8"), "/tmp/a.png"), None);
        assert_eq!(host_image_base64("<html>", "/tmp/a.png"), None);
    }

    #[test]
    fn a_result_image_path_encodes_both_ids() {
        assert_eq!(result_image_path("a b", 12, "toolu/1", 0), "/sessions/a%20b/events/12/result?toolUseId=toolu%2F1&part=0");
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
        assert_eq!(gateway_name("http://[::1]:8787"), "::1");
    }

    #[test]
    fn plain_http_is_only_for_a_private_network() {
        for ok in [
            "10.0.2.2:8790",
            "http://192.168.1.4",
            "http://127.0.0.1",
            "http://100.101.1.2",
            "mac.tail.ts.net",
            "http://deck.local",
            "http://deck",
            "http://[::1]:8787",
            "http://[fd7a:115c::1]",
            "https://deck.example",
        ] {
            assert_eq!(cleartext_refusal(ok), None, "{ok}");
        }
        for refused in ["deck.example", "http://8.8.8.8", "http://100.128.0.1", "http://[2001:db8::1]"] {
            assert!(cleartext_refusal(refused).is_some(), "{refused}");
        }
    }

    #[test]
    fn only_a_json_success_is_a_gateway() {
        assert_eq!(classify_answer(200, Some("application/json; charset=utf-8")), None);
        assert!(classify_answer(200, Some("text/html")).is_some());
        assert!(classify_answer(405, Some("text/html")).is_some());
        assert!(classify_answer(401, Some("application/json")).is_some());
        assert_eq!(classify_answer(500, Some("application/json")).as_deref(), Some("The gateway answered 500"));
    }

    #[test]
    fn a_refusal_carries_the_gateways_reason() {
        let json = Some("application/json");
        let body = r#"{"error":"cannot sleep: the engine has not started a conversation yet"}"#;
        assert_eq!(answer_error(409, json, body).as_deref(), Some("cannot sleep: the engine has not started a conversation yet"));
        assert_eq!(answer_error(500, json, "{}").as_deref(), Some("The gateway answered 500"));
        assert_eq!(answer_error(401, json, body).as_deref(), Some("The gateway refused the auth key"));
        assert_eq!(answer_error(409, Some("text/html"), body).as_deref(), Some("Not a WorkerDeck gateway, or the auth key is wrong"));
        assert_eq!(answer_error(200, json, body), None);
    }
}
