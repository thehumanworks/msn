//! Scheduled messages (ADR 0060): `msn send --at WHEN` and `msn scheduled list|change|cancel`.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::CliError;

/// Turns `--at` into the `sendAt` the Worker takes. A relative time (`90s`, `10m`, `2h`, `1d`, or
/// a sum such as `1h30m`, with an optional leading `+`) is added to `now_secs` and printed in UTC.
/// Anything else must be an RFC 3339 time with a zone and is passed through for the Worker to
/// check; a time without a zone is refused here, because it would read differently in each zone.
pub fn parse_when(raw: &str, now_secs: u64) -> Result<String, CliError> {
    let value = raw.trim();
    if let Some(seconds) = relative_seconds(value.strip_prefix('+').unwrap_or(value)) {
        if seconds == 0 {
            return Err(CliError::usage("--at must be in the future."));
        }
        return Ok(rfc3339(now_secs.saturating_add(seconds)));
    }
    let zoned = value.len() >= 16
        && value.as_bytes().get(10).is_some_and(|b| *b == b'T' || *b == b't')
        && (value.ends_with('Z')
            || value.ends_with('z')
            || value
                .get(value.len().saturating_sub(6)..)
                .is_some_and(|tail| {
                    let b = tail.as_bytes();
                    (b[0] == b'+' || b[0] == b'-') && b[3] == b':'
                }));
    if !zoned {
        return Err(CliError::usage(
            "--at takes a delay like 10m, 2h or 1d30m, or a time with a zone like 2026-11-21T09:00:00Z or 2026-11-21T10:00:00+01:00.",
        ));
    }
    Ok(value.to_string())
}

/// Seconds now, for `parse_when`.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn relative_seconds(value: &str) -> Option<u64> {
    if value.is_empty() {
        return None;
    }
    let mut total: u64 = 0;
    let mut digits = String::new();
    for c in value.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let unit = match c {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86400,
            _ => return None,
        };
        if digits.is_empty() || digits.len() > 9 {
            return None;
        }
        total = total.checked_add(digits.parse::<u64>().ok()?.checked_mul(unit)?)?;
        digits.clear();
    }
    digits.is_empty().then_some(total)
}

/// UTC RFC 3339 for epoch seconds (proleptic Gregorian, days-from-civil inverse).
fn rfc3339(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_times_add_to_now_in_utc() {
        let now = 1_795_000_000; // 2026-11-18T11:06:40Z
        assert_eq!(parse_when("10m", now).unwrap(), "2026-11-18T11:16:40Z");
        assert_eq!(parse_when("+1h30m", now).unwrap(), "2026-11-18T12:36:40Z");
        assert_eq!(parse_when("2d", now).unwrap(), "2026-11-20T11:06:40Z");
        assert_eq!(parse_when("45s", 0).unwrap(), "1970-01-01T00:00:45Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn zoned_times_pass_through_and_others_are_refused() {
        assert_eq!(
            parse_when("2026-11-21T10:00:00+01:00", 0).unwrap(),
            "2026-11-21T10:00:00+01:00"
        );
        assert_eq!(parse_when("2026-11-21T09:00Z", 0).unwrap(), "2026-11-21T09:00Z");
        for bad in ["2026-11-21T09:00:00", "tomorrow", "10", "m", "0m", "5w", "", "1h-"] {
            assert!(parse_when(bad, 0).is_err(), "{bad}");
        }
    }
}
