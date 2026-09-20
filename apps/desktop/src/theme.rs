//! Translucent surfaces; the desktop compositor supplies backdrop blur when supported.
use eframe::egui::{self, Color32, Frame, Margin, Stroke};

pub const ACCENT: Color32 = Color32::from_rgb(148, 220, 236);
pub const MUTED: Color32 = Color32::from_rgb(159, 178, 198);

pub fn install(ctx: &egui::Context) {
    ctx.set_theme(egui::Theme::Dark);
    let mut style = (*ctx.style_of(egui::Theme::Dark)).clone();
    style.visuals = egui::Visuals::dark();
    style.visuals.override_text_color = Some(Color32::from_rgb(231, 239, 249));
    style.visuals.panel_fill = Color32::TRANSPARENT;
    style.visuals.extreme_bg_color = Color32::from_rgba_unmultiplied(12, 22, 38, 160);
    style.visuals.faint_bg_color = Color32::from_white_alpha(7);
    style.visuals.selection.bg_fill = Color32::from_rgba_unmultiplied(70, 140, 164, 110);
    style.visuals.selection.stroke = Stroke::new(1.0, ACCENT);
    for widget in [
        &mut style.visuals.widgets.inactive,
        &mut style.visuals.widgets.hovered,
        &mut style.visuals.widgets.active,
    ] {
        widget.corner_radius = 9.into();
        widget.bg_stroke = Stroke::new(1.0, Color32::from_white_alpha(25));
    }
    style.visuals.widgets.inactive.bg_fill = Color32::from_white_alpha(10);
    style.visuals.widgets.hovered.bg_fill = Color32::from_white_alpha(23);
    style.visuals.widgets.active.bg_fill = Color32::from_rgba_unmultiplied(68, 135, 157, 130);
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
        .insert(egui::TextStyle::Heading, egui::FontId::proportional(23.0));
    ctx.set_style_of(egui::Theme::Dark, style);
}

pub fn glass() -> Frame {
    Frame::new()
        .fill(Color32::from_rgba_unmultiplied(24, 35, 54, 170))
        .stroke(Stroke::new(1.0, Color32::from_white_alpha(32)))
        .corner_radius(20)
        .inner_margin(18)
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
