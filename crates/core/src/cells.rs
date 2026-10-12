use unicode_segmentation::UnicodeSegmentation;

pub const TAB_SIZE: usize = 2;

const WIDE_RANGES: &[(u32, u32)] = &[
    (0x1100, 0x115F),
    (0x2E80, 0x303E),
    (0x3041, 0x33FF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xA000, 0xA4CF),
    (0xAC00, 0xD7A3),
    (0xF900, 0xFAFF),
    (0xFE30, 0xFE4F),
    (0xFF00, 0xFF60),
    (0xFFE0, 0xFFE6),
    (0x20000, 0x3FFFD),
];

// Emoji_Presentation=Yes, Unicode 15.1.
const EMOJI_PRESENTATION: &[(u32, u32)] = &[
    (0x231A, 0x231B),
    (0x23E9, 0x23EC),
    (0x23F0, 0x23F0),
    (0x23F3, 0x23F3),
    (0x25FD, 0x25FE),
    (0x2614, 0x2615),
    (0x2648, 0x2653),
    (0x267F, 0x267F),
    (0x2693, 0x2693),
    (0x26A1, 0x26A1),
    (0x26AA, 0x26AB),
    (0x26BD, 0x26BE),
    (0x26C4, 0x26C5),
    (0x26CE, 0x26CE),
    (0x26D4, 0x26D4),
    (0x26EA, 0x26EA),
    (0x26F2, 0x26F3),
    (0x26F5, 0x26F5),
    (0x26FA, 0x26FA),
    (0x26FD, 0x26FD),
    (0x2705, 0x2705),
    (0x270A, 0x270B),
    (0x2728, 0x2728),
    (0x274C, 0x274C),
    (0x274E, 0x274E),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2795, 0x2797),
    (0x27B0, 0x27B0),
    (0x27BF, 0x27BF),
    (0x2B1B, 0x2B1C),
    (0x2B50, 0x2B50),
    (0x2B55, 0x2B55),
    (0x1F004, 0x1F004),
    (0x1F0CF, 0x1F0CF),
    (0x1F18E, 0x1F18E),
    (0x1F191, 0x1F19A),
    (0x1F1E6, 0x1F1FF),
    (0x1F201, 0x1F201),
    (0x1F21A, 0x1F21A),
    (0x1F22F, 0x1F22F),
    (0x1F232, 0x1F236),
    (0x1F238, 0x1F23A),
    (0x1F250, 0x1F251),
    (0x1F300, 0x1F320),
    (0x1F32D, 0x1F335),
    (0x1F337, 0x1F37C),
    (0x1F37E, 0x1F393),
    (0x1F3A0, 0x1F3CA),
    (0x1F3CF, 0x1F3D3),
    (0x1F3E0, 0x1F3F0),
    (0x1F3F4, 0x1F3F4),
    (0x1F3F8, 0x1F43E),
    (0x1F440, 0x1F440),
    (0x1F442, 0x1F4FC),
    (0x1F4FF, 0x1F53D),
    (0x1F54B, 0x1F54E),
    (0x1F550, 0x1F567),
    (0x1F57A, 0x1F57A),
    (0x1F595, 0x1F596),
    (0x1F5A4, 0x1F5A4),
    (0x1F5FB, 0x1F64F),
    (0x1F680, 0x1F6C5),
    (0x1F6CC, 0x1F6CC),
    (0x1F6D0, 0x1F6D2),
    (0x1F6D5, 0x1F6D7),
    (0x1F6DC, 0x1F6DF),
    (0x1F6EB, 0x1F6EC),
    (0x1F6F4, 0x1F6FC),
    (0x1F7E0, 0x1F7EB),
    (0x1F7F0, 0x1F7F0),
    (0x1F90C, 0x1F93A),
    (0x1F93C, 0x1F945),
    (0x1F947, 0x1F9FF),
    (0x1FA70, 0x1FA7C),
    (0x1FA80, 0x1FA89),
    (0x1FA8F, 0x1FAC6),
    (0x1FACE, 0x1FADC),
    (0x1FADF, 0x1FAE9),
    (0x1FAF0, 0x1FAF8),
];

#[inline]
pub fn in_ranges(ranges: &[(u32, u32)], v: u32) -> bool {
    ranges.iter().any(|&(lo, hi)| v >= lo && v <= hi)
}

#[inline]
pub fn is_emoji_presentation(v: u32) -> bool {
    v >= 0x231A && in_ranges(EMOJI_PRESENTATION, v)
}

pub fn cluster_cells(cluster: &str) -> (usize, bool) {
    for c in cluster.chars() {
        if c == '\u{200D}' || c == '\u{FE0F}' {
            return (2, false);
        }
    }
    let Some(first) = cluster.chars().next() else {
        return (0, true);
    };
    let v = first as u32;
    if is_emoji_presentation(v) {
        return (2, false);
    }
    if in_ranges(WIDE_RANGES, v) {
        return (2, false);
    }
    if v < 0x20 {
        return (0, true);
    }
    (1, true)
}

pub fn is_plain_ascii(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

pub fn gcount(s: &str) -> usize {
    if s.is_ascii() && !s.contains("\r\n") {
        s.len()
    } else {
        s.graphemes(true).count()
    }
}

pub fn gprefix(s: &str, n: usize) -> &str {
    if s.is_ascii() && !s.contains("\r\n") {
        return &s[..n.min(s.len())];
    }
    match s.grapheme_indices(true).nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[derive(Clone, Copy)]
struct Token {
    space: bool,
    width: usize,
    exact: bool,
    start: usize,
    end: usize,
}

enum Clusters<'a> {
    Ascii { len: usize, at: usize },
    Graphemes(unicode_segmentation::GraphemeIndices<'a>),
}

impl<'a> Iterator for Clusters<'a> {
    type Item = (usize, usize);
    #[inline]
    fn next(&mut self) -> Option<(usize, usize)> {
        match self {
            Clusters::Ascii { len, at } => {
                if *at >= *len {
                    None
                } else {
                    *at += 1;
                    Some((*at - 1, *at))
                }
            }
            Clusters::Graphemes(g) => g.next().map(|(i, s)| (i, i + s.len())),
        }
    }
}

fn clusters(line: &str, ascii: bool) -> Clusters<'_> {
    if ascii {
        Clusters::Ascii { len: line.len(), at: 0 }
    } else {
        Clusters::Graphemes(line.grapheme_indices(true))
    }
}

fn is_number_cluster(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_numeric())
}

#[allow(unused_assignments)]
fn tokenize(line: &str, tokens: &mut Vec<Token>) {
    tokens.clear();
    let ascii = is_plain_ascii(line);
    let bytes = line.as_bytes();
    let mut column = 0usize;
    let mut it = clusters(line, ascii).peekable();
    let mut word_start = 0usize;
    let mut word_width = 0usize;
    let mut word_exact = true;

    macro_rules! flush_word {
        ($index:expr) => {{
            let index = $index;
            if word_width > 0 || word_start < index {
                if word_start < index {
                    tokens.push(Token {
                        space: false,
                        width: word_width,
                        exact: word_exact,
                        start: word_start,
                        end: index,
                    });
                }
                word_width = 0;
                word_exact = true;
            }
        }};
    }

    while let Some((s, e)) = it.next() {
        let one = e - s == 1;
        if one && (bytes[s] == b' ' || bytes[s] == b'\t') {
            flush_word!(s);
            let mut width = 0usize;
            let mut cursor_end = e;
            let tab_or_space = |b: u8, width: &mut usize| {
                if b == b'\t' {
                    let stop = ((column + *width) / TAB_SIZE + 1) * TAB_SIZE;
                    *width += stop - (column + *width);
                } else {
                    *width += 1;
                }
            };
            tab_or_space(bytes[s], &mut width);
            while let Some(&(ns, ne)) = it.peek() {
                if ne - ns == 1 && (bytes[ns] == b' ' || bytes[ns] == b'\t') {
                    tab_or_space(bytes[ns], &mut width);
                    cursor_end = ne;
                    it.next();
                } else {
                    break;
                }
            }
            tokens.push(Token {
                space: true,
                width,
                exact: true,
                start: s,
                end: cursor_end,
            });
            column += width;
            word_start = cursor_end;
            continue;
        }

        let (cells, exact) = if ascii { (1, true) } else { cluster_cells(&line[s..e]) };
        if cells > 1 {
            flush_word!(s);
            tokens.push(Token {
                space: false,
                width: cells,
                exact,
                start: s,
                end: e,
            });
            column += cells;
            word_start = e;
            continue;
        }

        word_width += cells;
        word_exact = word_exact && exact;
        column += cells;

        if one && (bytes[s] == b'-' || bytes[s] == b'?') {
            let follows_digit = match it.peek() {
                Some(&(ns, ne)) => is_number_cluster(&line[ns..ne]),
                None => false,
            };
            if !follows_digit {
                tokens.push(Token {
                    space: false,
                    width: word_width,
                    exact: word_exact,
                    start: word_start,
                    end: e,
                });
                word_width = 0;
                word_exact = true;
                word_start = e;
                continue;
            }
        }
    }
    flush_word!(line.len());
}

thread_local! {
    static TOKENS: std::cell::RefCell<Vec<Token>> = const { std::cell::RefCell::new(Vec::new()) };
}

pub fn wrap_into(line: &str, cols: usize, base: usize, out: &mut Vec<(usize, usize)>) -> bool {
    if cols == 0 {
        out.push((base, base + line.len()));
        return false;
    }
    TOKENS.with(|cell| {
        let mut tokens = cell.borrow_mut();
        tokenize(line, &mut tokens);
        if tokens.is_empty() {
            out.push((base, base + line.len()));
            return true;
        }
        let mut exact = true;
        let mut line_start = 0usize;
        let mut position = 0usize;
        for token in tokens.iter() {
            exact = exact && token.exact;
            if token.space {
                position += token.width;
                continue;
            }
            if position + token.width <= cols {
                position += token.width;
                continue;
            }
            if token.width <= cols {
                out.push((base + line_start, base + token.start));
                line_start = token.start;
                position = token.width;
                continue;
            }
            if position > 0 {
                out.push((base + line_start, base + token.start));
                line_start = token.start;
            }
            let text = &line[token.start..token.end];
            let ascii = is_plain_ascii(text);
            let mut carried = 0usize;
            for (cs, ce) in clusters(text, ascii) {
                let size = if ascii { 1 } else { cluster_cells(&text[cs..ce]).0 };
                if carried + size > cols {
                    out.push((base + line_start, base + token.start + cs));
                    line_start = token.start + cs;
                    carried = 0;
                }
                carried += size;
            }
            position = carried;
        }
        out.push((base + line_start, base + line.len()));
        exact
    })
}

pub fn wrapped_ranges(text: &str, cols: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut base = 0usize;
    for hard in text.split('\n') {
        wrap_into(hard, cols, base, &mut out);
        base += hard.len() + 1;
    }
    out
}

pub fn wrapped(text: &str, cols: usize) -> Vec<String> {
    wrapped_ranges(text, cols).into_iter().map(|(s, e)| text[s..e].to_owned()).collect()
}

pub fn clipped(text: &str, cols: usize) -> String {
    if cols == 0 {
        return String::new();
    }
    let mut width = 0usize;
    for g in text.graphemes(true) {
        width += cluster_cells(g).0;
        if width > cols {
            break;
        }
    }
    if width <= cols {
        return text.to_owned();
    }
    let mut head = String::new();
    let mut used = 0usize;
    for g in text.graphemes(true) {
        let size = cluster_cells(g).0;
        if used + size > cols - 1 {
            break;
        }
        head.push_str(g);
        used += size;
    }
    head.push('…');
    head
}

pub fn text_width(text: &str) -> usize {
    text.graphemes(true).map(|g| cluster_cells(g).0).sum()
}
