use std::cmp::Ordering;

const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

struct Weight {
    primary: u32,
    accent: u32,
    upper: bool,
}

fn fold_accent(ch: char) -> Option<char> {
    let base = match ch {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ō' | 'ø' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' => 'u',
        'ý' | 'ÿ' => 'y',
        'š' | 'ś' => 's',
        'ž' | 'ź' | 'ż' => 'z',
        'ř' => 'r',
        'ď' => 'd',
        'ť' => 't',
        'ł' => 'l',
        _ => return None,
    };
    Some(base)
}

fn weight(ch: char) -> Option<Weight> {
    let lower = ch.to_lowercase().next().unwrap_or(ch);
    let upper = lower != ch;
    match lower {
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' => {
            return Some(Weight { primary: 100 + lower as u32, accent: 0, upper });
        }
        c if c.is_whitespace() => return Some(Weight { primary: 140, accent: 0, upper }),
        c if c.is_control() => return None,
        _ => {}
    }
    if let Some(index) = PUNCTUATION.find(lower) {
        return Some(Weight { primary: 200 + index as u32, accent: 0, upper });
    }
    if lower.is_ascii_digit() {
        return Some(Weight { primary: 300 + (lower as u32 - '0' as u32), accent: 0, upper });
    }
    if lower.is_ascii_lowercase() {
        return Some(Weight { primary: 400 + (lower as u32 - 'a' as u32), accent: 0, upper });
    }
    if let Some(base) = fold_accent(lower) {
        return Some(Weight { primary: 400 + (base as u32 - 'a' as u32), accent: lower as u32, upper });
    }
    Some(Weight { primary: 1000 + lower as u32, accent: 0, upper })
}

fn weights(text: &str) -> Vec<Weight> {
    text.chars().filter_map(weight).collect()
}

fn level(a: &[Weight], b: &[Weight], key: impl Fn(&Weight) -> u32) -> Ordering {
    a.iter().map(&key).cmp(b.iter().map(&key))
}

pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let (x, y) = (weights(a), weights(b));
    level(&x, &y, |w| w.primary).then_with(|| level(&x, &y, |w| w.accent)).then_with(|| level(&x, &y, |w| w.upper as u32))
}

pub fn locale_compare_base(a: &str, b: &str) -> Ordering {
    level(&weights(a), &weights(b), |w| w.primary)
}
