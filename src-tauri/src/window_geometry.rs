//! Restore normal window bounds within a connected display's usable area.
use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Serialize, Deserialize)]
pub struct Bounds {
    monitor: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn fit(b: &Bounds, width: f64, height: f64) -> Option<(f64, f64, f64, f64)> {
    if ![b.x, b.y, b.width, b.height].iter().all(|n| n.is_finite())
        || b.width < 480.0
        || b.height < 320.0
    {
        return None;
    }
    let w = b.width.min(width);
    let h = b.height.min(height);
    Some((b.x.clamp(0.0, width - w), b.y.clamp(0.0, height - h), w, h))
}

#[tauri::command]
pub fn window_bounds(window: WebviewWindow) -> Result<Option<Bounds>, String> {
    let read = || -> tauri::Result<Option<Bounds>> {
        if window.is_maximized()? || window.is_fullscreen()? || window.is_minimized()? {
            return Ok(None);
        }
        let Some(m) = window.current_monitor()? else {
            return Ok(None);
        };
        let scale = m.scale_factor();
        let origin = m.work_area().position;
        let pos = window.outer_position()?;
        let size = window.inner_size()?.to_logical::<f64>(scale);
        Ok(Some(Bounds {
            monitor: m.name().cloned(),
            x: (f64::from(pos.x) - f64::from(origin.x)) / scale,
            y: (f64::from(pos.y) - f64::from(origin.y)) / scale,
            width: size.width,
            height: size.height,
        }))
    };
    read().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_window_bounds(window: WebviewWindow, bounds: Bounds) -> Result<(), String> {
    let apply = || -> tauri::Result<()> {
        let monitors = window.available_monitors()?;
        let matched = monitors
            .iter()
            .find(|m| m.name().is_some() && m.name() == bounds.monitor.as_ref());
        let primary = window.primary_monitor()?;
        let Some(m) = matched.or(primary.as_ref()) else {
            return Ok(());
        };
        let scale = m.scale_factor();
        let work = m.work_area();
        let area = work.size.to_logical::<f64>(scale);
        let chrome = (window
            .outer_size()?
            .height
            .saturating_sub(window.inner_size()?.height)) as f64
            / window.scale_factor()?;
        let Some((x, y, w, h)) = fit(&bounds, area.width, (area.height - chrome).max(0.0)) else {
            return Ok(());
        };
        let (x, y) = if matched.is_some() {
            (x, y)
        } else {
            (
                (area.width - w) / 2.0,
                (area.height - chrome - h).max(0.0) / 2.0,
            )
        };
        window.set_size(PhysicalSize::new(
            (w * scale).round() as u32,
            (h * scale).round() as u32,
        ))?;
        window.set_position(PhysicalPosition::new(
            work.position.x + (x * scale).round() as i32,
            work.position.y + (y * scale).round() as i32,
        ))
    };
    apply().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_and_offscreen_bounds_are_handled() {
        let mut b = Bounds {
            monitor: None,
            x: -900.0,
            y: 2000.0,
            width: 1200.0,
            height: 500.0,
        };
        assert_eq!(fit(&b, 800.0, 600.0), Some((0.0, 100.0, 800.0, 500.0)));
        b.width = f64::NAN;
        assert!(fit(&b, 800.0, 600.0).is_none());
    }
}
