//! Translucent, borderless surfaces; the desktop compositor supplies backdrop blur when
//! supported. Hierarchy comes from fill and spacing, never from strokes or dividers.
use eframe::egui::{self, Color32, CornerRadius, Frame, Margin, Stroke};

pub const ACCENT: Color32 = Color32::from_rgb(148, 220, 236);
pub const MUTED: Color32 = Color32::from_rgb(159, 178, 198);
/// Messenger presence colours.
pub const ONLINE: Color32 = Color32::from_rgb(126, 204, 92);
pub const AWAY: Color32 = Color32::from_rgb(240, 170, 60);
pub const BUSY: Color32 = Color32::from_rgb(222, 88, 88);
/// Send button and the user's own bubbles.
pub const MESSENGER_BLUE: Color32 = Color32::from_rgb(64, 150, 222);
const INK: Color32 = Color32::from_rgb(10, 20, 36);
const FIELD: Color32 = Color32::from_rgba_premultiplied(18, 18, 18, 18);

const NAME_COLORS: [Color32; 6] = [
    Color32::from_rgb(126, 204, 92),
    Color32::from_rgb(244, 164, 76),
    Color32::from_rgb(186, 154, 240),
    Color32::from_rgb(240, 130, 170),
    Color32::from_rgb(110, 196, 232),
    Color32::from_rgb(232, 208, 96),
];

pub fn install(ctx: &egui::Context) {
    ctx.set_theme(egui::Theme::Dark);
    let mut style = (*ctx.style_of(egui::Theme::Dark)).clone();
    style.visuals = egui::Visuals::dark();
    style.visuals.override_text_color = Some(Color32::from_rgb(231, 239, 249));
    style.visuals.panel_fill = Color32::TRANSPARENT;
    style.visuals.extreme_bg_color = Color32::from_rgba_unmultiplied(12, 22, 38, 160);
    style.visuals.text_edit_bg_color = Some(FIELD);
    style.visuals.faint_bg_color = Color32::from_white_alpha(7);
    style.visuals.selection.bg_fill = Color32::from_rgba_unmultiplied(70, 140, 164, 110);
    // The only stroke left in the app: the focus ring of a text field.
    style.visuals.selection.stroke = Stroke::new(1.0, ACCENT);
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
        (
            &mut style.visuals.widgets.inactive,
            Color32::from_white_alpha(14),
        ),
        (
            &mut style.visuals.widgets.hovered,
            Color32::from_white_alpha(28),
        ),
        (
            &mut style.visuals.widgets.active,
            Color32::from_rgba_unmultiplied(68, 135, 157, 130),
        ),
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
    ctx.set_style_of(egui::Theme::Dark, style);
}

/// The main content surface.
pub fn glass() -> Frame {
    Frame::new()
        .fill(Color32::from_rgba_unmultiplied(24, 35, 54, 170))
        .corner_radius(20)
        .inner_margin(18)
}

/// A dimmer surface than [`glass`], so the sidebar recedes without a divider.
pub fn sidebar() -> Frame {
    Frame::new()
        .fill(Color32::from_rgba_unmultiplied(14, 23, 40, 120))
        .corner_radius(20)
        .inner_margin(16)
}

/// A quiet inset surface for snapshots, tasks and grouped controls.
pub fn card() -> Frame {
    Frame::new()
        .fill(Color32::from_white_alpha(9))
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
        ACCENT
    } else {
        Color32::TRANSPARENT
    };
    Frame::new()
        .fill(FIELD)
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
            Color32::from_rgba_unmultiplied(64, 150, 222, 120),
            CornerRadius {
                nw: 16,
                ne: 5,
                sw: 16,
                se: 16,
            },
        )
    } else {
        (
            Color32::from_white_alpha(13),
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
    NAME_COLORS[hash as usize % NAME_COLORS.len()]
}

/// A round avatar with the user's initial and, optionally, a Messenger-style presence dot.
pub fn avatar(ui: &mut egui::Ui, name: &str, size: f32, presence: Option<Color32>) {
    let (rect, _) = ui.allocate_exact_size(egui::Vec2::splat(size), egui::Sense::hover());
    let painter = ui.painter();
    let color = name_color(name);
    painter.circle_filled(rect.center(), size / 2.0, color.gamma_multiply(0.35));
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
        painter.circle_filled(center, size * 0.19, INK);
        painter.circle_filled(center, size * 0.13, presence);
    }
}

/// The round send button inside the message pill.
pub fn send_button(ui: &mut egui::Ui, armed: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(egui::Vec2::splat(30.0), egui::Sense::click());
    let (fill, ink) = if !armed {
        (Color32::from_white_alpha(14), MUTED)
    } else if response.hovered() {
        (ACCENT, INK)
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
    painter.rect_filled(rect, 0, Color32::from_rgba_unmultiplied(9, 17, 32, 150));
    // Broad, feathered tint highlights remain subtle over the real desktop backdrop.
    for (center, radius, color) in [
        (
            rect.left_top() + egui::vec2(110.0, 30.0),
            340.0,
            [64, 135, 180],
        ),
        (
            rect.right_bottom() - egui::vec2(80.0, 50.0),
            300.0,
            [115, 86, 170],
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
