//! Restore normal window bounds within a connected display's usable area and
//! place each further document window clear of the ones already open.
use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

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

/// The distance between the title bars of two cascaded windows, in points.
const STEP: f64 = 26.0;

/// Step a new window down and to the right of `from` until its corner is clear
/// of every corner in `taken`. A window that would leave the usable `area`
/// (x, y, width, height) wraps to that area's top or left edge.
fn cascade(
    from: (f64, f64),
    size: (f64, f64),
    area: (f64, f64, f64, f64),
    taken: &[(f64, f64)],
) -> (f64, f64) {
    let (mut x, mut y) = from;
    for _ in 0..=taken.len() {
        x += STEP;
        y += STEP;
        if x < area.0 || x + size.0 > area.0 + area.2 {
            x = area.0;
        }
        if y < area.1 || y + size.1 > area.1 + area.3 {
            y = area.1;
        }
        let free = |corner: &(f64, f64)| {
            (corner.0 - x).abs() >= STEP / 2.0 || (corner.1 - y).abs() >= STEP / 2.0
        };
        if taken.iter().all(free) {
            break;
        }
    }
    (x, y)
}

/// Give a new document window the size of the window it was opened from and a
/// position beside it. Without this every window opens exactly over the last.
pub fn place_beside(source: &WebviewWindow, config: &mut tauri::utils::config::WindowConfig) {
    let place = || -> tauri::Result<Option<(f64, f64, f64, f64)>> {
        let Some(monitor) = source.current_monitor()? else {
            return Ok(None);
        };
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let origin = work.position.to_logical::<f64>(scale);
        let extent = work.size.to_logical::<f64>(scale);
        let area = (origin.x, origin.y, extent.width, extent.height);
        let chrome = source
            .outer_size()?
            .height
            .saturating_sub(source.inner_size()?.height) as f64
            / scale;
        // A zoomed, full-screen or minimized source says nothing about a good
        // size. Start from the configured size, centred like a first window.
        let normal =
            !(source.is_maximized()? || source.is_fullscreen()? || source.is_minimized()?);
        let (from, inner) = if normal {
            let position = source.outer_position()?.to_logical::<f64>(scale);
            let size = source.inner_size()?.to_logical::<f64>(scale);
            ((position.x, position.y), (size.width, size.height))
        } else {
            let (w, h) = (config.width.min(area.2), config.height.min(area.3 - chrome));
            let centre = (
                area.0 + (area.2 - w) / 2.0,
                area.1 + (area.3 - h - chrome) / 2.0,
            );
            ((centre.0 - STEP, centre.1 - STEP), (w, h))
        };
        let taken: Vec<_> = source
            .app_handle()
            .webview_windows()
            .values()
            .filter_map(|window| window.outer_position().ok())
            .map(|position| {
                let position = position.to_logical::<f64>(scale);
                (position.x, position.y)
            })
            .collect();
        let (x, y) = cascade(from, (inner.0, inner.1 + chrome), area, &taken);
        Ok(Some((x, y, inner.0, inner.1)))
    };
    if let Ok(Some((x, y, width, height))) = place() {
        config.x = Some(x);
        config.y = Some(y);
        config.width = width;
        config.height = height;
        config.center = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn further_windows_step_clear_of_open_ones_and_wrap_inside_the_display() {
        let area = (0.0, 25.0, 1440.0, 875.0);
        let size = (1240.0, 800.0);
        // Three documents opened from the same first window never share a corner.
        let first = (100.0, 60.0);
        let mut taken = vec![first];
        for n in 1..=2 {
            let next = cascade(first, (1000.0, 700.0), area, &taken);
            assert_eq!(next, (100.0 + STEP * n as f64, 60.0 + STEP * n as f64));
            taken.push(next);
        }
        // A window that no longer fits wraps to the left and top edge.
        assert_eq!(
            cascade((190.0, 90.0), size, area, &[(190.0, 90.0)]),
            (0.0, 25.0)
        );
        assert_eq!(cascade((190.0, 60.0), size, area, &[]), (0.0, 86.0));
        // A window as large as the display cannot move. The search still ends.
        let full = [(0.0, 25.0)];
        assert_eq!(cascade(full[0], (1440.0, 875.0), area, &full), full[0]);
    }
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
