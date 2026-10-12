pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, ch) in text.char_indices() {
        used += ch.len_utf16();
        if used > units {
            return &text[..index];
        }
    }
    text
}

pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut gap = false;
    for ch in text.chars() {
        if is_js_space(ch) {
            gap = true;
        } else {
            if gap {
                out.push(' ');
                gap = false;
            }
            out.push(ch);
        }
    }
    if gap {
        out.push(' ');
    }
    out
}

pub fn is_js_space(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{feff}'
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

pub fn trim_dashes(text: &str) -> &str {
    text.trim_matches('-')
}
