//! Translucent, borderless surfaces; the desktop compositor supplies backdrop blur when
//! supported. Hierarchy comes from fill and spacing, never from strokes or dividers.
use eframe::egui::{self, Color32, CornerRadius, Frame, Margin, Stroke};

/// Messenger presence colours. They are dots, not text, and read on both themes.
pub const ONLINE: Color32 = Color32::from_rgb(126, 204, 92);
pub const AWAY: Color32 = Color32::from_rgb(240, 170, 60);
pub const BUSY: Color32 = Color32::from_rgb(222, 88, 88);
/// Send button and the user's own bubbles.
pub const MESSENGER_BLUE: Color32 = Color32::from_rgb(40, 112, 190);

/// Every colour that differs between the dark and light themes (ADR 0049). Text colours
/// (`text`, `muted`, `accent`, `error`, `warn`, `names`) meet WCAG AA (4.5:1) on every surface
/// of their own theme; `palette_tests` checks it.
pub struct Palette {
    pub text: Color32,
    pub muted: Color32,
    pub accent: Color32,
    pub error: Color32,
    pub warn: Color32,
    /// Links in formatted messages.
    pub link: Color32,
    /// Inline code and code blocks in formatted messages.
    pub code_bg: Color32,
    /// The ring around a presence dot and the arrow of a hovered send button.
    ink: Color32,
    field: Color32,
    extreme_bg: Color32,
    faint_bg: Color32,
    selection: Color32,
    inactive: Color32,
    hovered: Color32,
    active: Color32,
    pub glass: Color32,
    pub sidebar: Color32,
    pub card: Color32,
    pub bubble_own: Color32,
    pub bubble_other: Color32,
    /// The window fill under every surface; it covers whatever the desktop shows through.
    pub backdrop: Color32,
    tints: [[u8; 3]; 2],
    pub names: [Color32; 6],
    /// How strongly an avatar's disc takes its name colour.
    avatar_tint: f32,
}

pub const DARK: Palette = Palette {
    text: Color32::from_rgb(231, 239, 249),
    muted: Color32::from_rgb(159, 178, 198),
    accent: Color32::from_rgb(148, 220, 236),
    error: Color32::from_rgb(240, 120, 120),
    warn: Color32::from_rgb(232, 168, 72),
    link: Color32::from_rgb(148, 220, 236),
    code_bg: Color32::from_gray(64),
    ink: Color32::from_rgb(10, 20, 36),
    field: Color32::from_rgba_premultiplied(18, 18, 18, 18),
    extreme_bg: Color32::from_rgba_unmultiplied_const(12, 22, 38, 160),
    faint_bg: Color32::from_rgba_premultiplied(7, 7, 7, 7),
    selection: Color32::from_rgba_unmultiplied_const(70, 140, 164, 110),
    inactive: Color32::from_rgba_premultiplied(14, 14, 14, 14),
    hovered: Color32::from_rgba_premultiplied(28, 28, 28, 28),
    active: Color32::from_rgba_unmultiplied_const(68, 135, 157, 130),
    glass: Color32::from_rgba_unmultiplied_const(24, 35, 54, 170),
    sidebar: Color32::from_rgba_unmultiplied_const(14, 23, 40, 120),
    card: Color32::from_rgba_premultiplied(9, 9, 9, 9),
    bubble_own: Color32::from_rgba_unmultiplied_const(64, 150, 222, 80),
    bubble_other: Color32::from_rgba_premultiplied(13, 13, 13, 13),
    backdrop: Color32::from_rgba_unmultiplied_const(9, 17, 32, 150),
    tints: [[64, 135, 180], [115, 86, 170]],
    names: [
        Color32::from_rgb(126, 204, 92),
        Color32::from_rgb(244, 164, 76),
        Color32::from_rgb(186, 154, 240),
        Color32::from_rgb(240, 130, 170),
        Color32::from_rgb(110, 196, 232),
        Color32::from_rgb(232, 208, 96),
    ],
    avatar_tint: 0.15,
};

pub const LIGHT: Palette = Palette {
    text: Color32::from_rgb(22, 30, 44),
    muted: Color32::from_rgb(78, 90, 108),
    accent: Color32::from_rgb(0, 106, 135),
    error: Color32::from_rgb(178, 34, 34),
    warn: Color32::from_rgb(140, 82, 0),
    link: Color32::from_rgb(0, 106, 135),
    code_bg: Color32::from_rgb(226, 231, 238),
    ink: Color32::from_rgb(250, 252, 255),
    field: Color32::from_rgba_unmultiplied_const(255, 255, 255, 200),
    extreme_bg: Color32::from_rgba_unmultiplied_const(255, 255, 255, 220),
    faint_bg: Color32::from_black_alpha(6),
    selection: Color32::from_rgba_unmultiplied_const(64, 150, 222, 70),
    inactive: Color32::from_black_alpha(12),
    hovered: Color32::from_black_alpha(22),
    active: Color32::from_rgba_unmultiplied_const(64, 150, 222, 90),
    glass: Color32::from_rgba_unmultiplied_const(255, 255, 255, 190),
    sidebar: Color32::from_rgba_unmultiplied_const(236, 241, 248, 170),
    card: Color32::from_black_alpha(8),
    bubble_own: Color32::from_rgba_unmultiplied_const(64, 150, 222, 60),
    bubble_other: Color32::from_black_alpha(10),
    backdrop: Color32::from_rgba_unmultiplied_const(236, 241, 248, 235),
    tints: [[120, 180, 225], [175, 150, 225]],
    names: [
        Color32::from_rgb(38, 104, 24),
        Color32::from_rgb(146, 72, 0),
        Color32::from_rgb(110, 70, 190),
        Color32::from_rgb(176, 40, 100),
        Color32::from_rgb(0, 104, 150),
        Color32::from_rgb(104, 88, 0),
    ],
    avatar_tint: 0.12,
};

thread_local! {
    /// The theme this frame is drawn in; [`sync`] sets it from the context at the start of
    /// each frame. egui draws on one thread, so the helpers below need no context argument.
    static CURRENT: std::cell::Cell<egui::Theme> = const { std::cell::Cell::new(egui::Theme::Dark) };
}

pub fn palette() -> &'static Palette {
    match CURRENT.with(std::cell::Cell::get) {
        egui::Theme::Dark => &DARK,
        egui::Theme::Light => &LIGHT,
    }
}

pub fn muted() -> Color32 {
    palette().muted
}
pub fn accent() -> Color32 {
    palette().accent
}
pub fn error() -> Color32 {
    palette().error
}
pub fn warn() -> Color32 {
    palette().warn
}

/// Follows the context's theme: the system setting, or the one forced on this computer.
pub fn sync(ctx: &egui::Context) {
    CURRENT.with(|current| current.set(ctx.theme()));
}

/// Installs both styles, following the system theme.
#[cfg(test)]
pub fn install(ctx: &egui::Context) {
    install_with(ctx, egui::ThemePreference::System);
}

/// Installs both styles and applies `preference` (the theme saved on this computer).
pub fn install_with(ctx: &egui::Context, preference: egui::ThemePreference) {
    for (theme, palette) in [(egui::Theme::Dark, &DARK), (egui::Theme::Light, &LIGHT)] {
        ctx.set_style_of(theme, style(ctx, theme, palette));
    }
    ctx.set_theme(preference);
    sync(ctx);
}

fn style(ctx: &egui::Context, theme: egui::Theme, p: &Palette) -> egui::Style {
    let mut style = (*ctx.style_of(theme)).clone();
    style.visuals = match theme {
        egui::Theme::Dark => egui::Visuals::dark(),
        egui::Theme::Light => egui::Visuals::light(),
    };
    style.visuals.override_text_color = Some(p.text);
    style.visuals.weak_text_color = Some(p.muted);
    style.visuals.hyperlink_color = p.link;
    style.visuals.code_bg_color = p.code_bg;
    style.visuals.panel_fill = Color32::TRANSPARENT;
    style.visuals.window_fill = match theme {
        egui::Theme::Dark => style.visuals.window_fill,
        egui::Theme::Light => Color32::from_rgb(250, 252, 255),
    };
    style.visuals.extreme_bg_color = p.extreme_bg;
    style.visuals.text_edit_bg_color = Some(p.field);
    style.visuals.faint_bg_color = p.faint_bg;
    style.visuals.selection.bg_fill = p.selection;
    // The only stroke left in the app: the focus ring of a text field.
    style.visuals.selection.stroke = Stroke::new(1.0, p.accent);
    for widget in [
        &mut style.visuals.widgets.inactive,
        &mut style.visuals.widgets.hovered,
        &mut style.visuals.widgets.active,
    ] {
        widget.corner_radius = 10.into();
        widget.bg_stroke = Stroke::NONE;
        widget.expansion = 0.0;
    }
    let fills = [
        (&mut style.visuals.widgets.inactive, p.inactive),
        (&mut style.visuals.widgets.hovered, p.hovered),
        (&mut style.visuals.widgets.active, p.active),
    ];
    for (widget, fill) in fills {
        widget.bg_fill = fill;
        widget.weak_bg_fill = fill;
    }
    style.spacing.item_spacing = egui::vec2(10.0, 8.0);
    style.spacing.button_padding = egui::vec2(12.0, 7.0);
    style.spacing.interact_size.y = 32.0;
    style
        .text_styles
        .insert(egui::TextStyle::Body, egui::FontId::proportional(14.0));
    style
        .text_styles
        .insert(egui::TextStyle::Button, egui::FontId::proportional(13.0));
    style
        .text_styles
        .insert(egui::TextStyle::Small, egui::FontId::proportional(11.0));
    style
        .text_styles
        .insert(egui::TextStyle::Heading, egui::FontId::proportional(22.0));
    style
}

/// The theme choice kept on this computer: `$XDG_CONFIG_HOME/msn/desktop-theme` (or
/// `~/.config/msn/desktop-theme`) holding `light` or `dark`. No file means follow the system.
pub fn preference_file() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| std::path::PathBuf::from(home).join(".config"))
        })?;
    Some(base.join("msn").join("desktop-theme"))
}

pub fn load_preference(path: &std::path::Path) -> egui::ThemePreference {
    match std::fs::read_to_string(path).as_deref().map(str::trim) {
        Ok("light") => egui::ThemePreference::Light,
        Ok("dark") => egui::ThemePreference::Dark,
        _ => egui::ThemePreference::System,
    }
}

pub fn save_preference(
    path: &std::path::Path,
    preference: egui::ThemePreference,
) -> std::io::Result<()> {
    let value = match preference {
        egui::ThemePreference::Light => "light",
        egui::ThemePreference::Dark => "dark",
        egui::ThemePreference::System => {
            return match std::fs::remove_file(path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            };
        }
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Written beside the file and renamed into place, so a crash never leaves half a file.
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, format!("{value}\n"))?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        std::fs::remove_file(&tmp).ok();
    })
}

/// The main content surface.
pub fn glass() -> Frame {
    Frame::new()
        .fill(palette().glass)
        .corner_radius(20)
        .inner_margin(18)
}

/// A dimmer surface than [`glass`], so the sidebar recedes without a divider.
pub fn sidebar() -> Frame {
    Frame::new()
        .fill(palette().sidebar)
        .corner_radius(20)
        .inner_margin(16)
}

/// A quiet inset surface for snapshots, tasks and grouped controls.
pub fn card() -> Frame {
    Frame::new()
        .fill(palette().card)
        .corner_radius(14)
        .inner_margin(12)
}

/// A single-line text field with messaging-app padding instead of egui's 4×2 default.
pub fn field(text: &mut String) -> egui::TextEdit<'_> {
    egui::TextEdit::singleline(text).margin(Margin::symmetric(12, 8))
}

/// The pill around the message input. The stroke is always 1px wide so focus never shifts
/// the layout; it is only visible while the input has focus.
pub fn message_pill(focused: bool) -> Frame {
    let ring = if focused {
        accent()
    } else {
        Color32::TRANSPARENT
    };
    Frame::new()
        .fill(palette().field)
        .stroke(Stroke::new(1.0, ring))
        .corner_radius(21)
        .inner_margin(Margin {
            left: 16,
            right: 5,
            top: 5,
            bottom: 5,
        })
}

/// A chat bubble. The corner nearest the sender's name is tightened, like a speech tail.
pub fn bubble(own: bool) -> Frame {
    let (fill, corner_radius) = if own {
        (
            palette().bubble_own,
            CornerRadius {
                nw: 16,
                ne: 5,
                sw: 16,
                se: 16,
            },
        )
    } else {
        (
            palette().bubble_other,
            CornerRadius {
                nw: 5,
                ne: 16,
                sw: 16,
                se: 16,
            },
        )
    };
    Frame::new()
        .fill(fill)
        .corner_radius(corner_radius)
        .inner_margin(Margin::symmetric(13, 9))
}

/// A stable per-user colour so participants are distinguishable at a glance.
pub fn name_color(name: &str) -> Color32 {
    let hash = name.bytes().fold(0u32, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(byte as u32)
    });
    let names = &palette().names;
    names[hash as usize % names.len()]
}

/// The disc behind an avatar's initial: the name colour, faint.
fn avatar_fill(p: &Palette, name: Color32) -> Color32 {
    name.gamma_multiply(p.avatar_tint)
}

/// A round avatar with the user's initial and, optionally, a Messenger-style presence dot.
pub fn avatar(ui: &mut egui::Ui, name: &str, size: f32, presence: Option<Color32>) {
    let (rect, _) = ui.allocate_exact_size(egui::Vec2::splat(size), egui::Sense::hover());
    let painter = ui.painter();
    let color = name_color(name);
    painter.circle_filled(rect.center(), size / 2.0, avatar_fill(palette(), color));
    let initial: String = name
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_default();
    painter.text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        initial,
        egui::FontId::proportional(size * 0.45),
        color,
    );
    if let Some(presence) = presence {
        let center = rect.right_bottom() - egui::Vec2::splat(size * 0.14);
        painter.circle_filled(center, size * 0.19, palette().ink);
        painter.circle_filled(center, size * 0.13, presence);
    }
}

/// The round send button inside the message pill.
pub fn send_button(ui: &mut egui::Ui, armed: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(egui::Vec2::splat(30.0), egui::Sense::click());
    let (fill, ink) = if !armed {
        (palette().inactive, muted())
    } else if response.hovered() {
        (accent(), palette().ink)
    } else {
        (MESSENGER_BLUE, Color32::WHITE)
    };
    let painter = ui.painter();
    let center = rect.center();
    painter.circle_filled(center, 15.0, fill);
    let stroke = Stroke::new(2.0, ink);
    let tip = center + egui::vec2(0.0, -6.0);
    painter.line_segment([center + egui::vec2(0.0, 6.0), tip], stroke);
    painter.line_segment([center + egui::vec2(-5.0, -1.0), tip], stroke);
    painter.line_segment([center + egui::vec2(5.0, -1.0), tip], stroke);
    response.on_hover_text("Send (Enter)")
}

pub fn backdrop(ui: &egui::Ui) {
    let rect = ui.max_rect();
    let painter = ui.painter();
    let palette = palette();
    painter.rect_filled(rect, 0, palette.backdrop);
    // Broad, feathered tint highlights remain subtle over the real desktop backdrop.
    for (center, radius, color) in [
        (
            rect.left_top() + egui::vec2(110.0, 30.0),
            340.0,
            palette.tints[0],
        ),
        (
            rect.right_bottom() - egui::vec2(80.0, 50.0),
            300.0,
            palette.tints[1],
        ),
    ] {
        for step in (1..=24).rev() {
            painter.circle_filled(
                center,
                radius * step as f32 / 24.0,
                Color32::from_rgba_unmultiplied(color[0], color[1], color[2], 2),
            );
        }
    }
}

pub fn outer() -> Frame {
    Frame::new().inner_margin(Margin::same(16))
}

#[cfg(test)]
mod palette_tests {
    use super::*;

    fn over(top: Color32, under: [f32; 3]) -> [f32; 3] {
        // Color32 is premultiplied: out = top + under * (1 - alpha).
        let alpha = top.a() as f32 / 255.0;
        let [r, g, b, _] = top.to_array();
        [
            r as f32 + under[0] * (1.0 - alpha),
            g as f32 + under[1] * (1.0 - alpha),
            b as f32 + under[2] * (1.0 - alpha),
        ]
    }

    fn luminance(rgb: [f32; 3]) -> f32 {
        let channel = |c: f32| {
            let v = c / 255.0;
            if v <= 0.03928 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
    }

    fn contrast(a: [f32; 3], b: [f32; 3]) -> f32 {
        let (x, y) = (luminance(a), luminance(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    /// Every surface text is drawn on, over the backdrop, over a desktop that is `desktop`.
    fn surfaces(p: &Palette, desktop: [f32; 3]) -> Vec<(&'static str, [f32; 3])> {
        let window = over(p.backdrop, desktop);
        let glass = over(p.glass, window);
        vec![
            ("glass", glass),
            ("sidebar", over(p.sidebar, window)),
            ("card", over(p.card, glass)),
            ("other bubble", over(p.bubble_other, glass)),
            ("field", over(p.field, glass)),
        ]
    }

    type Texts<'a> = &'a [(&'static str, Color32)];

    fn failures(p: &Palette, desktops: &[[f32; 3]]) -> Vec<String> {
        let mut texts = vec![
            ("text", p.text),
            ("muted", p.muted),
            ("accent", p.accent),
            ("error", p.error),
            ("warn", p.warn),
        ];
        texts.extend(p.names.iter().map(|color| ("name", *color)));
        // Names, errors and warnings are never drawn inside the user's own bubble.
        let own = [("text", p.text), ("muted", p.muted), ("link", p.link)];
        texts.push(("link", p.link));
        let mut out = Vec::new();
        for desktop in desktops {
            let glass = over(p.glass, over(p.backdrop, *desktop));
            let mut checks: Vec<(&str, [f32; 3], Texts)> = surfaces(p, *desktop)
                .into_iter()
                .map(|(surface, under)| (surface, under, texts.as_slice()))
                .collect();
            checks.push(("own bubble", over(p.bubble_own, glass), &own));
            // Code spans hold message text only.
            let code: Texts = &[("text", p.text)];
            checks.push(("code", over(p.code_bg, glass), code));
            for (surface, under, texts) in checks {
                for (name, color) in texts {
                    let [r, g, b, _] = color.to_array();
                    let ratio = contrast([r as f32, g as f32, b as f32], under);
                    if ratio < 4.5 {
                        out.push(format!(
                            "{name} {color:?} on {surface} over {desktop:?}: {ratio:.2}"
                        ));
                    }
                }
            }
        }
        out
    }

    /// An avatar's initial is its name colour on a faint disc of the same colour, on glass.
    fn avatar_failures(p: &Palette, desktops: &[[f32; 3]]) -> Vec<String> {
        let mut out = Vec::new();
        for desktop in desktops {
            let glass = over(p.glass, over(p.backdrop, *desktop));
            for name in p.names {
                let [r, g, b, _] = name.to_array();
                let ratio = contrast(
                    [r as f32, g as f32, b as f32],
                    over(avatar_fill(p, name), glass),
                );
                if ratio < 4.5 {
                    out.push(format!("initial {name:?} over {desktop:?}: {ratio:.2}"));
                }
            }
        }
        out
    }

    #[test]
    fn avatar_initials_meet_aa() {
        assert_eq!(
            avatar_failures(&LIGHT, &[[0.0; 3], [255.0; 3]]),
            Vec::<String>::new()
        );
        assert_eq!(
            avatar_failures(&DARK, &[[0.0; 3], [40.0; 3]]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn light_text_meets_aa_over_any_desktop() {
        // The window is translucent: check a black and a white desktop behind it.
        assert_eq!(
            failures(&LIGHT, &[[0.0; 3], [255.0; 3]]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn dark_text_meets_aa_over_a_dark_desktop() {
        assert_eq!(
            failures(&DARK, &[[0.0; 3], [40.0; 3]]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn install_follows_the_preference_and_sync_picks_the_palette() {
        let ctx = egui::Context::default();
        install_with(&ctx, egui::ThemePreference::Light);
        assert_eq!(ctx.theme(), egui::Theme::Light);
        assert_eq!(accent(), LIGHT.accent);
        assert_eq!(
            ctx.style_of(egui::Theme::Light).visuals.override_text_color,
            Some(LIGHT.text)
        );
        ctx.set_theme(egui::ThemePreference::Dark);
        sync(&ctx);
        assert_eq!(accent(), DARK.accent);
        assert!(ctx.style_of(egui::Theme::Dark).visuals.dark_mode);
    }

    #[test]
    fn the_saved_preference_round_trips_and_system_removes_the_file() {
        let dir = std::env::temp_dir().join(format!("msn-theme-{}", uuid::Uuid::new_v4()));
        let path = dir.join("msn").join("desktop-theme");
        assert_eq!(load_preference(&path), egui::ThemePreference::System);
        save_preference(&path, egui::ThemePreference::Light).unwrap();
        assert_eq!(load_preference(&path), egui::ThemePreference::Light);
        save_preference(&path, egui::ThemePreference::Dark).unwrap();
        assert_eq!(load_preference(&path), egui::ThemePreference::Dark);
        save_preference(&path, egui::ThemePreference::System).unwrap();
        assert!(!path.exists());
        save_preference(&path, egui::ThemePreference::System).unwrap();
        // Only the preference file is left behind: the temporary file was renamed into place.
        save_preference(&path, egui::ThemePreference::Light).unwrap();
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("desktop-theme")]);
        std::fs::write(&path, "purple").unwrap();
        assert_eq!(load_preference(&path), egui::ThemePreference::System);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
