#[cfg(debug_assertions)]
pub(crate) const DISPLAY_NAME: &str = "Lyrico [DEBUG]";
#[cfg(not(debug_assertions))]
pub(crate) const DISPLAY_NAME: &str = "Lyrico";

pub(crate) fn context() -> tauri::Context<tauri::Wry> {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    {
        // Set before plugin initialization: the single-instance lock and data paths
        // both use this identifier, so debug and release remain independent.
        context.config_mut().identifier.push_str(".debug");
        context.set_default_window_icon(Some(tauri::include_image!("icons/debug.png")));
    }
    context
}
