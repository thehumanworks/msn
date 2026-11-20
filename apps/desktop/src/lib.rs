//! Native desktop client for msn. The binary in `main.rs` only launches the GUI or the headless
//! smoke check; everything else lives here so integration tests can drive it over real HTTP.

pub mod app;
pub mod markdown;
pub mod net;
pub mod profile;
pub mod read_marks;
pub mod smoke;
pub mod state;
mod theme;
