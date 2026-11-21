//! Quote a message in a reply (ADR 0059). Pure rules, matching `public/quote.js` on the web:
//! what the composer puts in the quote when a whole message is quoted.

/// The server's quote limit, in UTF-8 bytes.
pub const MAX_QUOTE_BYTES: usize = 2048;

/// The quote for `text`: trailing spaces and blank lines at either end go, and runs of blank
/// lines become one. Text over the limit is cut at a character boundary and ends with "…".
/// `None` when nothing is left to quote.
pub fn quote_of(text: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut kept: Vec<&str> = Vec::new();
    for line in normalized.split('\n').map(str::trim_end) {
        if !line.is_empty() || kept.last().is_some_and(|last| !last.is_empty()) {
            kept.push(line);
        }
    }
    while kept.last().is_some_and(|last| last.is_empty()) {
        kept.pop();
    }
    let quote = kept.join("\n");
    if quote.trim().is_empty() {
        return None;
    }
    if quote.len() <= MAX_QUOTE_BYTES {
        return Some(quote);
    }
    let budget = MAX_QUOTE_BYTES - "…".len();
    let mut end = 0;
    for (index, ch) in quote.char_indices() {
        if index + ch.len_utf8() > budget {
            break;
        }
        end = index + ch.len_utf8();
    }
    Some(format!("{}…", quote[..end].trim_end()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidies_the_edges_and_keeps_inner_lines() {
        assert_eq!(
            quote_of("  Ship it.  \r\n\r\n\r\nThen tag.\n\n").as_deref(),
            Some("  Ship it.\n\nThen tag.")
        );
        assert_eq!(
            quote_of("\n\nfirst\nsecond").as_deref(),
            Some("first\nsecond")
        );
    }

    #[test]
    fn nothing_to_quote_is_none() {
        for blank in ["", " ", "\n\n", " \t\n "] {
            assert_eq!(quote_of(blank), None, "{blank:?}");
        }
    }

    #[test]
    fn long_text_is_cut_at_a_character_boundary() {
        let ascii = quote_of(&"x".repeat(5000)).unwrap();
        assert!(ascii.ends_with('…') && ascii.len() <= MAX_QUOTE_BYTES);
        let emoji = quote_of(&"🙂".repeat(1000)).unwrap();
        assert!(emoji.len() <= MAX_QUOTE_BYTES);
        assert!(emoji.trim_end_matches('…').chars().all(|c| c == '🙂'));
        let exact = "y".repeat(MAX_QUOTE_BYTES);
        assert_eq!(quote_of(&exact), Some(exact));
    }
}
