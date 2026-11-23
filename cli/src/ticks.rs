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

/// How far the second check sits to the right of the first, in px.
/// A few pixels: the strokes overlap instead of sitting side by side (ADR 0083).
pub const TICK_OFFSET_PX: i32 = 4;

/// Ticks belong on the sender's bubble. Another participant's message stays unmarked.
///
/// The CLI prints message JSON and does not draw ticks. Each client that paints them decides
/// the sender itself (ADR 0085): exact username, and not an agent posting under that name.
pub fn bubble_tick(own: bool, rows: Option<&Vec<Value>>) -> Tick {
    if !own {
        return Tick::None;
    }
    tick_of(rows)
}

/// How many thin checks to draw. Pending and none draw nothing.
pub fn tick_marks(tick: Tick) -> u8 {
    match tick {
        Tick::Read => 2,
        Tick::Delivered | Tick::Partial => 1,
        Tick::None | Tick::Pending => 0,
    }
}

/// Read is blue. Delivered and partial stay muted.
pub fn tick_tone_read(tick: Tick) -> bool {
    tick == Tick::Read
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

    fn read_rows() -> Value {
        json_rows(true)
    }

    fn json_rows(read: bool) -> Value {
        serde_json::json!([{
            "name": "dev",
            "deliveredAt": "2026-11-23T14:02:00.000Z",
            "readAt": if read { serde_json::json!("2026-11-23T14:03:00.000Z") } else { serde_json::Value::Null }
        }])
    }

    // I1 another participant's message, even fully read, draws no ticks.
    // I2 the sender's delivered message draws one muted check.
    // I3 the sender's read message draws two checks, the second a few px over.
    // I4 pending and unaddressed messages draw nothing.
    #[test]
    fn given_who_sent_it_when_the_bubble_is_marked_then_only_the_sender_gets_ticks() {
        let read = read_rows();
        let rows = read.as_array();
        assert_eq!(bubble_tick(false, rows), Tick::None);
        assert_eq!(tick_marks(bubble_tick(false, rows)), 0);

        assert_eq!(bubble_tick(true, rows), Tick::Read);
        assert_eq!(tick_marks(Tick::Read), 2);
        assert!(tick_tone_read(Tick::Read));

        let delivered = json_rows(false);
        assert_eq!(bubble_tick(true, delivered.as_array()), Tick::Delivered);
        assert_eq!(tick_marks(Tick::Delivered), 1);
        assert!(!tick_tone_read(Tick::Delivered));
        assert_eq!(tick_marks(Tick::Partial), 1);
        assert!(!tick_tone_read(Tick::Partial));

        assert_eq!(bubble_tick(true, None), Tick::None);
        assert_eq!(tick_marks(Tick::Pending), 0);
        assert_eq!(tick_marks(Tick::None), 0);
        assert!(
            (2..=6).contains(&TICK_OFFSET_PX),
            "the second check overlaps by a few px"
        );
    }
}
