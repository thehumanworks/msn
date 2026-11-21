//! Scheduled messages (ADR 0060): `msn send --at WHEN` and `msn scheduled list|change|cancel`.
//! Repeating ones (ADR 0072): `msn send --repeat daily|weekdays|Nh`.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::error::CliError;

/// What a send adds to its body to post later: `sendAt`, `repeat`, or both.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Later {
    /// The absolute time of the message, or of a repeat's first copy. A retry must send this.
    pub send_at: Option<String>,
    /// The repeat rule the Worker takes (ADR 0072).
    pub repeat: Option<Value>,
}

impl Later {
    pub fn is_some(&self) -> bool {
        self.send_at.is_some() || self.repeat.is_some()
    }

    /// Adds `sendAt` and `repeat` to a send body.
    pub fn apply(&self, body: &mut Value) {
        if let Some(send_at) = &self.send_at {
            body["sendAt"] = json!(send_at);
        }
        if let Some(repeat) = &self.repeat {
            body["repeat"] = repeat.clone();
        }
    }
}

/// Turns `--at`, `--repeat`, `--until` and `--tz` into what the Worker takes.
///
/// `--repeat` is `daily`, `weekdays` or every N hours as `Nh` (1 to 168). Daily and weekdays need
/// `--at`: a wall-clock time `HH:MM` read in the time zone (the Worker finds the first copy), or a
/// delay or zoned time for the first copy, whose wall-clock time then repeats. Hours take a delay
/// or zoned time for the first copy, or none to start one interval from now. The time zone is
/// `--tz`, else this computer's (see `local_zone`), else UTC; the Worker checks its name.
pub fn plan(
    at: Option<&str>,
    repeat: Option<&str>,
    until: Option<&str>,
    tz: Option<&str>,
    now_secs: u64,
) -> Result<Later, CliError> {
    let Some(rule) = repeat.map(str::trim) else {
        if until.is_some() || tz.is_some() {
            return Err(CliError::usage(
                "--until and --tz go with --repeat. For one message, give --at a time with a zone.",
            ));
        }
        return Ok(Later {
            send_at: at.map(|raw| parse_when(raw, now_secs)).transpose()?,
            repeat: None,
        });
    };
    let zone = tz
        .map(|value| value.trim().to_string())
        .unwrap_or_else(local_zone);
    let mut body = json!({ "timeZone": zone });
    let mut send_at = None;
    if rule == "daily" || rule == "weekdays" {
        body["every"] = json!(rule);
        let at = at.map(str::trim).ok_or_else(|| {
            CliError::usage(format!(
                "--repeat {rule} needs --at: a time of day like 09:00 (read in --tz, here {zone}), or a delay or zoned time for the first copy."
            ))
        })?;
        match wall_clock(at) {
            Some(clock) => body["at"] = json!(clock),
            None => send_at = Some(parse_when(at, now_secs).map_err(|_| {
                CliError::usage(
                    "--at with --repeat takes a time of day like 09:00, a delay like 10m, or a time with a zone like 2026-11-21T09:00:00Z.",
                )
            })?),
        }
    } else {
        let hours = rule
            .strip_suffix('h')
            .filter(|digits| !digits.is_empty() && digits.len() <= 3)
            .filter(|digits| digits.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|digits| digits.parse::<u32>().ok())
            .filter(|hours| (1..=168).contains(hours))
            .ok_or_else(|| {
                CliError::usage(
                    "--repeat takes daily, weekdays, or every N hours as Nh from 1h to 168h, like 6h.",
                )
            })?;
        body["every"] = json!("hours");
        body["hours"] = json!(hours);
        if let Some(at) = at {
            if wall_clock(at.trim()).is_some() {
                return Err(CliError::usage(
                    "--repeat Nh counts from the first copy: give --at a delay like 10m or a time with a zone, or leave it out to start one interval from now.",
                ));
            }
            send_at = Some(parse_when(at, now_secs)?);
        }
    }
    if let Some(until) = until {
        body["until"] = json!(until.trim());
    }
    Ok(Later {
        send_at,
        repeat: Some(body),
    })
}

/// `9:00`, `09:00` or `09:00:30` as the zero-padded 24-hour time the Worker takes.
fn wall_clock(value: &str) -> Option<String> {
    let parts: Vec<&str> = value.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let number = |part: &str, digits: std::ops::RangeInclusive<usize>, max: u32| {
        (digits.contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit()))
            .then(|| part.parse::<u32>().ok())
            .flatten()
            .filter(|n| *n <= max)
    };
    let hour = number(parts[0], 1..=2, 23)?;
    let minute = number(parts[1], 2..=2, 59)?;
    match parts.get(2) {
        Some(second) => Some(format!(
            "{hour:02}:{minute:02}:{:02}",
            number(second, 2..=2, 59)?
        )),
        None => Some(format!("{hour:02}:{minute:02}")),
    }
}

/// This computer's IANA time zone: `TZ` when it names one (like `Europe/Lisbon`), else the zone
/// `/etc/localtime` links to, else `UTC`. No lookup can fail the send: the Worker checks the name
/// and the result prints the zone, so a wrong guess is visible.
pub fn local_zone() -> String {
    zone_from(
        std::env::var("TZ").ok().as_deref(),
        std::fs::read_link("/etc/localtime")
            .ok()
            .and_then(|path| path.to_str().map(str::to_owned))
            .as_deref(),
    )
}

fn zone_from(tz: Option<&str>, localtime: Option<&str>) -> String {
    let named = |value: &str| {
        let value = value.strip_prefix(':').unwrap_or(value);
        let ok = !value.is_empty()
            && value.len() <= 64
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-' | b'/'))
            && (value.contains('/') || value == "UTC" || value == "GMT");
        ok.then(|| value.to_string())
    };
    tz.and_then(named)
        .or_else(|| {
            localtime
                .and_then(|path| path.split_once("zoneinfo/"))
                .and_then(|(_, zone)| named(zone))
        })
        .unwrap_or_else(|| "UTC".to_string())
}

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
        && value
            .as_bytes()
            .get(10)
            .is_some_and(|b| *b == b'T' || *b == b't')
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
    fn repeat_rules_become_the_body_the_worker_takes() {
        let now = 1_795_000_000;
        let daily = plan(
            Some("9:00"),
            Some("daily"),
            Some("2026-12-31"),
            Some("Europe/Lisbon"),
            now,
        )
        .unwrap();
        assert_eq!(daily.send_at, None);
        assert_eq!(
            daily.repeat.unwrap(),
            json!({"every":"daily","at":"09:00","timeZone":"Europe/Lisbon","until":"2026-12-31"})
        );
        let weekdays = plan(Some("17:30:15"), Some("weekdays"), None, Some("UTC"), now).unwrap();
        assert_eq!(
            weekdays.repeat.unwrap(),
            json!({"every":"weekdays","at":"17:30:15","timeZone":"UTC"})
        );
        // A delay or a zoned time is the first copy; the Worker repeats its wall-clock time.
        let from_delay = plan(Some("10m"), Some("daily"), None, Some("UTC"), now).unwrap();
        assert_eq!(from_delay.send_at.as_deref(), Some("2026-11-18T11:16:40Z"));
        assert_eq!(
            from_delay.repeat.unwrap(),
            json!({"every":"daily","timeZone":"UTC"})
        );
        let hours = plan(None, Some("6h"), None, Some("UTC"), now).unwrap();
        assert_eq!(hours.send_at, None);
        assert_eq!(
            hours.repeat.unwrap(),
            json!({"every":"hours","hours":6,"timeZone":"UTC"})
        );
        let hours_from = plan(
            Some("2026-11-21T09:00:00Z"),
            Some("168h"),
            None,
            Some("UTC"),
            now,
        )
        .unwrap();
        assert_eq!(hours_from.send_at.as_deref(), Some("2026-11-21T09:00:00Z"));
        let mut body = json!({"text":"x"});
        hours_from.apply(&mut body);
        assert_eq!(body["sendAt"], "2026-11-21T09:00:00Z");
        assert_eq!(body["repeat"]["hours"], 168);
    }

    #[test]
    fn repeat_rules_that_cannot_be_read_are_refused() {
        for (at, repeat, until, tz) in [
            (None, Some("daily"), None, None),
            (None, Some("weekdays"), None, None),
            (Some("tomorrow"), Some("daily"), None, None),
            (Some("09:00"), Some("6h"), None, None),
            (Some("09:00"), Some("weekly"), None, None),
            (None, Some("0h"), None, None),
            (None, Some("169h"), None, None),
            (None, Some("h"), None, None),
            (None, Some("1.5h"), None, None),
            (None, Some("90m"), None, None),
            (Some("10m"), None, Some("2026-12-31"), None),
            (Some("10m"), None, None, Some("UTC")),
        ] {
            assert!(
                plan(at, repeat, until, tz, 0).is_err(),
                "{at:?} {repeat:?} {until:?} {tz:?}"
            );
        }
        // Without --repeat it is the one-message path, unchanged.
        let once = plan(Some("10m"), None, None, None, 0).unwrap();
        assert_eq!(once.send_at.as_deref(), Some("1970-01-01T00:10:00Z"));
        assert!(once.repeat.is_none());
        assert!(!plan(None, None, None, None, 0).unwrap().is_some());
    }

    #[test]
    fn wall_clock_times_are_padded_and_bounded() {
        assert_eq!(wall_clock("9:05").as_deref(), Some("09:05"));
        assert_eq!(wall_clock("23:59:59").as_deref(), Some("23:59:59"));
        for bad in [
            "24:00",
            "9",
            "09:60",
            "09:5",
            "09:00:60",
            "10m",
            "a:00",
            "09:00:00:00",
            "",
        ] {
            assert_eq!(wall_clock(bad), None, "{bad}");
        }
    }

    #[test]
    fn local_zone_reads_tz_then_localtime_then_utc() {
        assert_eq!(zone_from(Some("Europe/Lisbon"), None), "Europe/Lisbon");
        assert_eq!(
            zone_from(Some(":America/New_York"), None),
            "America/New_York"
        );
        assert_eq!(
            zone_from(Some("UTC"), Some("/usr/share/zoneinfo/Asia/Tokyo")),
            "UTC"
        );
        // An abbreviation or a POSIX rule is not a zone name: fall through.
        assert_eq!(
            zone_from(
                Some("EST5EDT"),
                Some("/var/db/timezone/zoneinfo/Asia/Tokyo")
            ),
            "Asia/Tokyo"
        );
        assert_eq!(
            zone_from(None, Some("/usr/share/zoneinfo/Etc/UTC")),
            "Etc/UTC"
        );
        assert_eq!(zone_from(Some(""), Some("/etc/elsewhere")), "UTC");
        assert_eq!(zone_from(None, None), "UTC");
    }

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
        assert_eq!(
            parse_when("2026-11-21T09:00Z", 0).unwrap(),
            "2026-11-21T09:00Z"
        );
        for bad in [
            "2026-11-21T09:00:00",
            "tomorrow",
            "10",
            "m",
            "0m",
            "5w",
            "",
            "1h-",
        ] {
            assert!(parse_when(bad, 0).is_err(), "{bad}");
        }
    }
}
