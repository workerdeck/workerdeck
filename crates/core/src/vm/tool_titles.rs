use crate::rest::Entries;
use crate::vm::text::{collapse_whitespace, js_trim};

pub const TOOL_TITLE_MAX_CHARS: usize = 64;

pub const PEER_SEND_TOOLS: [&str; 2] = ["peers_send", "mcp__workerdeck__peers_send"];

pub const BUILTIN_TOOL_TITLES: [(&str, &str); 25] = [
    ("fs_read", "Reading a file"),
    ("fs_write", "Writing a file"),
    ("fs_list", "Listing files"),
    ("eval_script", "Running a script"),
    ("web_fetch", "Fetching a web page"),
    ("web_search", "Searching the web"),
    ("deliver_file", "Delivering a file"),
    ("download", "Downloading a file"),
    ("CodexCommand", "Running a command"),
    ("CodexFileChange", "Editing a file"),
    ("CodexWebSearch", "Searching the web"),
    ("CodexImageGeneration", "Generating an image"),
    ("CodexImageView", "Viewing an image"),
    ("peers_list", "Listing peer sessions"),
    ("peers_peek", "Peeking at a peer session"),
    ("peers_send", "Messaging a peer session"),
    ("mcp__workerdeck__peers_list", "Listing peer sessions"),
    ("mcp__workerdeck__peers_peek", "Peeking at a peer session"),
    ("mcp__workerdeck__peers_send", "Messaging a peer session"),
    ("session_info", "Checking session info"),
    ("mcp__workerdeck__session_info", "Checking session info"),
    ("set_status", "Setting status"),
    ("mcp__workerdeck__set_status", "Setting status"),
    ("change_avatar", "Changing avatar"),
    ("mcp__workerdeck__change_avatar", "Changing avatar"),
];

pub fn builtin_tool_title(name: &str) -> Option<&'static str> {
    BUILTIN_TOOL_TITLES.iter().find(|(tool, _)| *tool == name).map(|(_, title)| *title)
}

pub fn tool_title(name: &str, titles: Option<&Entries<String>>) -> Option<String> {
    let title = titles.and_then(|t| t.get(name)).map(String::as_str).or_else(|| builtin_tool_title(name));
    sanitize_tool_title(title, Some(name))
}

pub fn sanitize_tool_title(title: Option<&str>, name: Option<&str>) -> Option<String> {
    let title = title?;
    let spaced: String = title.chars().map(|c| if c < ' ' || c == '\u{7f}' { ' ' } else { c }).collect();
    let flat = js_trim(&collapse_whitespace(&spaced)).to_owned();
    if flat.is_empty() || Some(flat.as_str()) == name {
        return None;
    }
    let points: Vec<char> = flat.chars().collect();
    if points.len() > TOOL_TITLE_MAX_CHARS {
        let mut clamped: String = points[..TOOL_TITLE_MAX_CHARS - 1].iter().collect();
        clamped.push('…');
        return Some(clamped);
    }
    Some(flat)
}

pub fn is_peer_send_tool(name: &str) -> bool {
    PEER_SEND_TOOLS.contains(&name)
}
