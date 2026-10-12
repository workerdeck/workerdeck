use crate::vm::text::{is_js_space, trim_dashes, utf16_len, utf16_prefix};
use serde::{Deserialize, Serialize};

pub const PEER_MENTION_SIGIL: char = '#';
pub const PEER_MENTION_MAX: usize = 4;
pub const PEER_MENTION_BODY_MAX: usize = 64;
pub const PEER_MENTION_SCAN_MAX: usize = 32;
pub const PROMPT_SENTENCE_TAIL: [char; 11] = ['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', '\''];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeerMentionToken {
    pub start: u32,
    pub end: u32,
    pub body: String,
}

fn is_letter_or_number(ch: char) -> bool {
    ch.is_alphanumeric()
}

pub fn peer_mention_slug(title: Option<&str>, id: &str) -> String {
    let mut runs = String::new();
    let mut gap = false;
    for ch in title.unwrap_or("").chars() {
        if is_letter_or_number(ch) {
            if gap {
                runs.push('-');
                gap = false;
            }
            runs.push(ch);
        } else {
            gap = true;
        }
    }
    if gap {
        runs.push('-');
    }
    let slug = trim_dashes(utf16_prefix(trim_dashes(&runs), PEER_MENTION_BODY_MAX));
    if !slug.is_empty() {
        return slug.to_owned();
    }
    let units: Vec<u16> = id.encode_utf16().collect();
    let colon = units.iter().position(|u| *u == u16::from(b':')).map(|i| i as isize).unwrap_or(-1);
    let start = ((colon + 1) as usize).min(units.len());
    let end = ((colon + 9) as usize).min(units.len());
    String::from_utf16_lossy(&units[start..end.max(start)])
}

pub fn peer_mention_key(body: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for ch in body.to_lowercase().chars() {
        if ch == '_' || ch == '-' || is_js_space(ch) {
            gap = true;
        } else {
            if gap {
                out.push('-');
                gap = false;
            }
            out.push(ch);
        }
    }
    if gap {
        out.push('-');
    }
    trim_dashes(&out).to_owned()
}

pub fn is_peer_mention_body(body: &str) -> bool {
    let mut chars = body.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    utf16_len(body) <= PEER_MENTION_BODY_MAX && is_letter_or_number(first) && chars.all(|c| is_letter_or_number(c) || c == '-' || c == '_')
}

pub fn scan_peer_mentions(text: &str) -> Vec<PeerMentionToken> {
    let mut tokens = Vec::new();
    let mut words: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    for (index, ch) in text.char_indices() {
        match (is_js_space(ch), start) {
            (true, Some(at)) => {
                words.push((at, index));
                start = None;
            }
            (false, None) => start = Some(index),
            _ => {}
        }
    }
    if let Some(at) = start {
        words.push((at, text.len()));
    }
    for (from, to) in words {
        if tokens.len() >= PEER_MENTION_SCAN_MAX {
            break;
        }
        let word = &text[from..to];
        if !word.starts_with(PEER_MENTION_SIGIL) {
            continue;
        }
        let body = word[1..].trim_end_matches(|c| PROMPT_SENTENCE_TAIL.contains(&c));
        if !is_peer_mention_body(body) {
            continue;
        }
        let begin = utf16_len(&text[..from]);
        tokens.push(PeerMentionToken { start: begin as u32, end: (begin + 1 + utf16_len(body)) as u32, body: body.to_owned() });
    }
    tokens
}
