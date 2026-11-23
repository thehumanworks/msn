//! One mark for an addressed message's per-recipient delivery (ADR 0082).
//! Read counts as delivered. Two ticks only when every recipient has read.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tick {
    None,
    Pending,
    Partial,
    Delivered,
    Read,
}

pub fn tick_of(rows: Option<&Vec<Value>>) -> Tick {
    let Some(rows) = rows else {
        return Tick::None;
    };
    if rows.is_empty() {
        return Tick::None;
    }
    let mut delivered = 0usize;
    let mut read = 0usize;
    for row in rows {
        if row.get("readAt").is_some_and(|value| !value.is_null()) {
            read += 1;
            delivered += 1;
        } else if row.get("deliveredAt").is_some_and(|value| !value.is_null()) {
            delivered += 1;
        }
    }
    if read == rows.len() {
        Tick::Read
    } else if delivered == rows.len() {
        Tick::Delivered
    } else if delivered > 0 {
        Tick::Partial
    } else {
        Tick::Pending
    }
}

pub fn tick_glyph(tick: Tick) -> &'static str {
    match tick {
        Tick::Read => "✓✓",
        Tick::Delivered | Tick::Partial => "✓",
        Tick::None | Tick::Pending => "",
    }
}

pub fn tick_label(rows: Option<&Vec<Value>>) -> String {
    let Some(rows) = rows else {
        return String::new();
    };
    rows.iter()
        .filter_map(|row| {
            let name = row["name"].as_str()?;
            let state = if row.get("readAt").is_some_and(|v| !v.is_null()) {
                "read"
            } else if row.get("deliveredAt").is_some_and(|v| !v.is_null()) {
                "delivered"
            } else {
                "not yet delivered"
            };
            Some(format!("{name} {state}"))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Rows of `message["delivery"]`, when it is an array.
pub fn delivery_rows(message: &Value) -> Option<&Vec<Value>> {
    message.get("delivery").and_then(Value::as_array)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_the_shared_cases_when_folded_then_the_mark_matches() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/tick-cases.json")).unwrap();
        for case in cases {
            let rows = case.get("rows").and_then(Value::as_array);
            let tick = tick_of(rows);
            let name = match tick {
                Tick::None => "none",
                Tick::Pending => "pending",
                Tick::Partial => "partial",
                Tick::Delivered => "delivered",
                Tick::Read => "read",
            };
            assert_eq!(name, case["tick"].as_str().unwrap(), "{case}");
            assert_eq!(tick_glyph(tick), case["glyph"].as_str().unwrap(), "{case}");
            assert_eq!(tick_label(rows), case["label"].as_str().unwrap(), "{case}");
        }
    }
}
