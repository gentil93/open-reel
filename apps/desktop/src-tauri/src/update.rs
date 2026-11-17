//! Updates: checked and downloaded quietly after launch, installed only when
//! the person asks from the app's own page.

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::Server;

/// A verified update, downloaded and waiting to be installed.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

/// Set while the app stops its server to update, so the stop is not shown
/// as a failure.
#[derive(Default)]
pub struct Updating(pub AtomicBool);

/// Appends a line to `app.log`, next to `server.log`.
pub fn log<R: Runtime>(app: &AppHandle<R>, line: &str) {
    let Ok(dir) = app.path().app_log_dir() else {
        return;
    };
    if create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app.log"))
    {
        let _ = writeln!(file, "{line}");
    }
}

/// Looks for a newer version and downloads it. Failures, such as being
/// offline, are only logged: nobody needs to hear that a check failed.
pub async fn check(app: AppHandle) {
    let result = async {
        let mut builder = app.updater_builder();
        // Lets a development build try updates against another feed, such as a
        // test prerelease.
        if cfg!(debug_assertions) {
            if let Ok(feed) = std::env::var("OPEN_REEL_UPDATE_URL") {
                builder = builder.endpoints(vec![feed.parse()?])?;
            }
        }
        let Some(update) = builder.build()?.check().await? else {
            log(&app, "no update available");
            return Ok::<(), Box<dyn std::error::Error>>(());
        };
        log(&app, &format!("downloading version {}", update.version));
        let bytes = update.download(|_, _| {}, || {}).await?;
        let version = update.version.clone();
        *app.state::<Pending>().0.lock().unwrap() = Some((update, bytes));
        log(&app, &format!("version {version} is ready to install"));
        app.emit("update-ready", version)?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        log(&app, &format!("update check failed: {error}"));
    }
}

/// The version waiting to be installed, for a page that loaded after the
/// `update-ready` event was sent.
#[tauri::command]
pub fn update_status(pending: State<'_, Pending>) -> Option<String> {
    pending
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|(update, _)| update.version.clone())
}

/// Stops the server cleanly, installs the update and starts the new version.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let Some((update, bytes)) = app.state::<Pending>().0.lock().unwrap().take() else {
        return Err("No update is waiting".into());
    };
    app.state::<Updating>().0.store(true, Ordering::SeqCst);
    // The installer replaces the server's executable, so it must have exited.
    drop(app.state::<Server>().0.lock().unwrap().take());
    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(1500)))
        .await
        .ok();
    log(&app, &format!("installing version {}", update.version));
    if let Err(error) = update.install(bytes) {
        log(&app, &format!("install failed: {error}"));
        app.state::<Updating>().0.store(false, Ordering::SeqCst);
        return Err(error.to_string());
    }
    // On Windows the installer has already closed the app; elsewhere, start
    // the new version.
    app.restart();
}
