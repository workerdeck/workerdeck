#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Prose(String),
    Heading(usize, String),
    List(Vec<ListItem>),
    Blockquote(String),
    ThematicBreak,
    Code { language: Option<String>, text: String, closed: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ListItem {
    pub depth: usize,
    pub ordinal: Option<i64>,
    pub text: String,
}

enum LineKind<'a> {
    Blank,
    ThematicBreak,
    Heading(usize, String),
    ListItem(usize, Option<i64>, &'a str),
    Quote(&'a str),
    Text,
}

fn is_ws(c: char) -> bool {
    c.is_whitespace()
}

fn all_ws(s: &str) -> bool {
    s.chars().all(is_ws)
}

// Swift `split(whereSeparator: \.isNewline)` over Characters: "\r\n" is one separator.
fn split_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        let newline = matches!(c, '\n' | '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}');
        if newline {
            out.push(&text[start..i]);
            let mut end = i + c.len_utf8();
            if c == '\r'
                && let Some(&(_, '\n')) = chars.peek()
            {
                chars.next();
                end += 1;
            }
            start = end;
        }
    }
    out.push(&text[start..]);
    out
}

fn trim_edges(lines: &[&str]) -> (usize, usize) {
    let mut a = 0;
    let mut b = lines.len();
    while a < b && all_ws(lines[a]) {
        a += 1;
    }
    while b > a && all_ws(lines[b - 1]) {
        b -= 1;
    }
    (a, b)
}

fn join_trimmed(lines: &[&str]) -> String {
    let (a, b) = trim_edges(lines);
    lines[a..b].join("\n")
}

struct Fence {
    marker: char,
    length: usize,
    indent: usize,
    language: Option<String>,
}

impl Fence {
    fn opening(line: &str) -> Option<Fence> {
        let mut indent = 0;
        let mut rest = line;
        while indent < 4 && rest.starts_with(' ') {
            indent += 1;
            rest = &rest[1..];
        }
        if indent >= 4 {
            return None;
        }
        let marker = rest.chars().next()?;
        if marker != '`' && marker != '~' {
            return None;
        }
        let run = rest.chars().take_while(|&c| c == marker).count();
        if run < 3 {
            return None;
        }
        let info = rest[run..].trim_matches(|c: char| c == ' ' || c == '\t');
        if marker == '`' && info.contains('`') {
            return None;
        }
        let language = info.split(' ').find(|s| !s.is_empty()).map(|s| s.to_lowercase());
        Some(Fence { marker, length: run, indent, language })
    }

    fn closes(&self, line: &str) -> bool {
        let mut rest = line;
        let mut seen = 0;
        while seen < 4 && rest.starts_with(' ') {
            seen += 1;
            rest = &rest[1..];
        }
        if seen >= 4 {
            return false;
        }
        let run = rest.chars().take_while(|&c| c == self.marker).count();
        if run < self.length {
            return false;
        }
        all_ws(&rest[run * self.marker.len_utf8()..])
    }

    fn strip_indent(&self, line: &str) -> String {
        let mut dropped = 0;
        let mut rest = line;
        while dropped < self.indent && rest.starts_with(' ') {
            dropped += 1;
            rest = &rest[1..];
        }
        rest.to_owned()
    }
}

fn heading_text(after: &str) -> String {
    let ws = |c: char| c == ' ' || c == '\t' || (c.is_whitespace() && c != '\n' && c != '\r');
    let mut text = after.trim_matches(ws).to_owned();
    let closing = text.chars().rev().take_while(|&c| c == '#').count();
    if closing > 0 {
        let head = &text[..text.len() - closing];
        if head.is_empty() || head.ends_with(' ') {
            text = head.trim_matches(ws).to_owned();
        }
    }
    text
}

fn classify(line: &str) -> LineKind<'_> {
    if all_ws(line) {
        return LineKind::Blank;
    }
    let mut indent = 0;
    let mut rest = line;
    while let Some(first) = rest.chars().next() {
        if first == ' ' || first == '\t' {
            indent += if first == '\t' { 2 } else { 1 };
            rest = &rest[1..];
        } else {
            break;
        }
    }
    let first = rest.chars().next();

    if indent <= 3
        && let Some(marker) = first.filter(|&m| m == '-' || m == '*' || m == '_')
    {
        let mut count = 0;
        let mut only = true;
        for c in rest.chars() {
            if c == marker {
                count += 1;
            } else if c != ' ' && c != '\t' {
                only = false;
                break;
            }
        }
        if only && count >= 3 {
            return LineKind::ThematicBreak;
        }
    }

    if indent <= 3 && first == Some('#') {
        let hashes = rest.chars().take_while(|&c| c == '#').count();
        let after = &rest[hashes..];
        if hashes <= 6 && (after.is_empty() || after.starts_with(' ') || after.starts_with('\t')) {
            return LineKind::Heading(hashes, heading_text(after));
        }
    }

    if let Some(marker) = first.filter(|&m| m == '-' || m == '*' || m == '+') {
        let _ = marker;
        let after = &rest[1..];
        if after.is_empty() {
            return LineKind::ListItem(indent, None, after);
        }
        if after.starts_with(' ') || after.starts_with('\t') {
            return LineKind::ListItem(indent, None, after.trim_start_matches(is_ws));
        }
    }

    if first.is_some_and(|c| c.is_ascii_digit()) {
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits <= 9 {
            let after_digits = &rest[digits..];
            if after_digits.starts_with('.') || after_digits.starts_with(')') {
                let after = &after_digits[1..];
                let ordinal = rest[..digits].parse::<i64>().ok();
                if after.is_empty() {
                    return LineKind::ListItem(indent, ordinal, after);
                }
                if after.starts_with(' ') || after.starts_with('\t') {
                    return LineKind::ListItem(indent, ordinal, after.trim_start_matches(is_ws));
                }
            }
        }
    }

    if indent <= 3 && first == Some('>') {
        let mut content = rest;
        while content.starts_with('>') {
            content = &content[1..];
            if content.starts_with(' ') {
                content = &content[1..];
            }
        }
        return LineKind::Quote(content);
    }

    LineKind::Text
}

#[allow(unused_assignments)]
pub fn parse(text: &str) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut prose: Vec<&str> = Vec::new();
    let mut code: Vec<String> = Vec::new();
    let mut fence: Option<Fence> = None;
    let mut items: Vec<ListItem> = Vec::new();
    let mut item_head: Option<(usize, Option<i64>)> = None;
    let mut item_lines: Vec<&str> = Vec::new();
    let mut list_indents: Vec<usize> = Vec::new();
    let mut quote: Vec<&str> = Vec::new();
    let mut in_quote = false;

    macro_rules! flush_prose {
        () => {{
            let (a, b) = trim_edges(&prose);
            if a < b {
                blocks.push(Block::Prose(prose[a..b].join("\n")));
            }
            prose.clear();
        }};
    }
    macro_rules! close_item {
        () => {{
            if let Some((depth, ordinal)) = item_head.take() {
                let text = join_trimmed(&item_lines);
                item_lines.clear();
                items.push(ListItem { depth, ordinal, text });
            }
        }};
    }
    macro_rules! flush_list {
        () => {{
            close_item!();
            list_indents.clear();
            if !items.is_empty() {
                blocks.push(Block::List(std::mem::take(&mut items)));
            }
        }};
    }
    macro_rules! flush_quote {
        () => {{
            if in_quote {
                in_quote = false;
                blocks.push(Block::Blockquote(join_trimmed(&quote)));
                quote.clear();
            }
        }};
    }

    for line in split_lines(text) {
        if let Some(open) = &fence {
            if open.closes(line) {
                blocks.push(Block::Code { language: open.language.clone(), text: code.join("\n"), closed: true });
                code.clear();
                fence = None;
            } else {
                code.push(open.strip_indent(line));
            }
            continue;
        }
        if let Some(open) = Fence::opening(line) {
            flush_prose!();
            flush_list!();
            flush_quote!();
            fence = Some(open);
            continue;
        }
        match classify(line) {
            LineKind::Blank => {
                flush_list!();
                flush_quote!();
                prose.push(line);
            }
            LineKind::ThematicBreak => {
                flush_prose!();
                flush_list!();
                flush_quote!();
                blocks.push(Block::ThematicBreak);
            }
            LineKind::Heading(level, text) => {
                flush_prose!();
                flush_list!();
                flush_quote!();
                blocks.push(Block::Heading(level, text));
            }
            LineKind::ListItem(indent, ordinal, rest) => {
                flush_prose!();
                flush_quote!();
                close_item!();
                while let Some(&last) = list_indents.last() {
                    if last >= 2 && indent <= last - 2 {
                        list_indents.pop();
                    } else {
                        break;
                    }
                }
                if let Some(&last) = list_indents.last() {
                    if indent >= last + 2 {
                        list_indents.push(indent);
                    } else {
                        let n = list_indents.len();
                        list_indents[n - 1] = indent;
                    }
                } else {
                    list_indents = vec![indent];
                }
                item_head = Some((list_indents.len() - 1, ordinal));
                item_lines = vec![rest];
            }
            LineKind::Quote(content) => {
                flush_prose!();
                flush_list!();
                in_quote = true;
                quote.push(content);
            }
            LineKind::Text => {
                if item_head.is_some() {
                    item_lines.push(line.trim_start_matches(is_ws));
                } else {
                    flush_quote!();
                    prose.push(line);
                }
            }
        }
    }

    if let Some(open) = fence {
        blocks.push(Block::Code { language: open.language, text: code.join("\n"), closed: false });
    } else {
        flush_prose!();
        flush_list!();
        flush_quote!();
    }
    blocks
}

pub const EM: u8 = 1;
pub const STRONG: u8 = 2;
pub const CODE: u8 = 4;
pub const STRIKE: u8 = 32;

pub struct Styled {
    pub plain: String,
    pub runs: Vec<(usize, usize, u8)>,
}

pub fn inline(text: &str) -> Styled {
    let chars: Vec<char> = text.chars().collect();
    let mut plain = String::with_capacity(text.len());
    let mut runs: Vec<(usize, usize, u8)> = Vec::new();
    let mut intent: u8 = 0;
    let mut run_start = 0usize;
    let mut i = 0usize;

    let flush = |plain: &String, run_start: &mut usize, intent: u8, runs: &mut Vec<(usize, usize, u8)>| {
        if plain.len() == *run_start {
            return;
        }
        if intent != 0 {
            if let Some(last) = runs.last_mut()
                && last.2 == intent
                && last.0 + last.1 == *run_start
            {
                last.1 = plain.len() - last.0;
                *run_start = plain.len();
                return;
            }
            runs.push((*run_start, plain.len() - *run_start, intent));
        }
        *run_start = plain.len();
    };
    let closes = |marker: &[char], start: usize| -> bool {
        let mut j = start;
        while j + marker.len() <= chars.len() {
            if chars[j] == '\n' {
                return false;
            }
            if &chars[j..j + marker.len()] == marker {
                return true;
            }
            j += 1;
        }
        false
    };

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '\\'
            && let Some(n) = next
            && "*_`~[]\\".contains(n)
        {
            plain.push(n);
            i += 2;
            continue;
        }
        if intent & CODE != 0 {
            if c == '`' {
                flush(&plain, &mut run_start, intent, &mut runs);
                intent &= !CODE;
                i += 1;
            } else {
                plain.push(c);
                i += 1;
            }
            continue;
        }
        let toggle = |flag: u8,
                      marker: &[char],
                      i: &mut usize,
                      intent: &mut u8,
                      plain: &String,
                      run_start: &mut usize,
                      runs: &mut Vec<(usize, usize, u8)>|
         -> bool {
            if *intent & flag != 0 {
                flush(plain, run_start, *intent, runs);
                *intent &= !flag;
                *i += marker.len();
                return true;
            }
            if closes(marker, *i + marker.len()) {
                flush(plain, run_start, *intent, runs);
                *intent |= flag;
                *i += marker.len();
                return true;
            }
            false
        };
        if c == '`' && toggle(CODE, &['`'], &mut i, &mut intent, &plain, &mut run_start, &mut runs) {
            continue;
        }
        if c == '*' && next == Some('*') && toggle(STRONG, &['*', '*'], &mut i, &mut intent, &plain, &mut run_start, &mut runs) {
            continue;
        }
        if c == '~' && next == Some('~') && toggle(STRIKE, &['~', '~'], &mut i, &mut intent, &plain, &mut run_start, &mut runs) {
            continue;
        }
        if (c == '*' || c == '_') && toggle(EM, &[c], &mut i, &mut intent, &plain, &mut run_start, &mut runs) {
            continue;
        }
        if c == '['
            && let Some(close) = chars[i + 1..].iter().position(|&x| x == ']').map(|p| p + i + 1)
            && close + 1 < chars.len()
            && chars[close + 1] == '('
            && let Some(end) = chars[close + 1..].iter().position(|&x| x == ')').map(|p| p + close + 1)
        {
            plain.extend(&chars[i + 1..close]);
            i = end + 1;
            continue;
        }
        plain.push(c);
        i += 1;
    }
    flush(&plain, &mut run_start, intent, &mut runs);
    Styled { plain, runs }
}
