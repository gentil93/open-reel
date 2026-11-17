// No console window next to the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The desktop app: a window around the same server `bun run start` runs.
//! The server is a compiled sidecar on a free loopback port; the window shows
//! a splash until the server says where it listens, then opens the app there.

use std::sync::Mutex;

use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The line the server prints once it listens, followed by its address.
const READY: &str = "open-reel is running at ";
/// The darkroom's film base, so the window never flashes white.
const BACKGROUND: Color = Color(13, 11, 9, 255);

/// The running server. Dropping it closes the server's input, which tells it
/// to shut down cleanly; a kill would leave its lock and database unflushed.
struct Server(Mutex<Option<CommandChild>>);

/// Pages that belong to the app: its splash, the local server, and what the
/// webview loads on its own (WebView2 starts at `about:blank`).
fn is_internal(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "tauri.localhost")
        ),
        _ => false,
    }
}

/// Opens web and mail links, such as a provider's key page, in the system
/// browser. Anything else is just refused: handing an unknown scheme to the
/// system would ask the person which app should open it.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Shows the splash again, saying why the server stopped.
fn show_failure(window: &WebviewWindow, splash: &Url, detail: &str) {
    let mut url = splash.clone();
    url.query_pairs_mut().clear().append_pair("failed", detail.trim());
    let _ = window.navigate(url);
}

fn start_server(app: &AppHandle, window: WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?.join("resources");
    let splash = window.url()?;
    let (mut events, child) = app
        .shell()
        .sidecar("open-reel-server")?
        .args([
            "--port",
            "0",
            "--no-open",
            "--parent-pid",
            &std::process::id().to_string(),
        ])
        .arg("--resources")
        .arg(resources)
        .spawn()?;
    *app.state::<Server>().0.lock().unwrap() = Some(child);

    tauri::async_runtime::spawn(async move {
        let mut ready = false;
        // What the server said on stderr, to show if it stops.
        let mut errors = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    if let Some(address) = line.trim().strip_prefix(READY) {
                        if let (false, Ok(url)) = (ready, Url::parse(address.trim())) {
                            ready = true;
                            let _ = window.navigate(url);
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    errors.push_str(&String::from_utf8_lossy(&line));
                    errors.push('\n');
                }
                CommandEvent::Error(error) => {
                    errors.push_str(&error);
                    errors.push('\n');
                }
                CommandEvent::Terminated(status) => {
                    if errors.trim().is_empty() {
                        errors = format!("The server stopped (code {:?}).", status.code);
                    }
                    show_failure(&window, &splash, &errors);
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        // A second launch brings the open window forward instead of starting
        // another server on the same data directory.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            let navigation = app.handle().clone();
            let popups = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("splash.html".into()))
                .title("open-reel")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 520.0)
                .background_color(BACKGROUND)
                .on_navigation(move |url| {
                    if is_internal(url) {
                        return true;
                    }
                    open_outside(&navigation, url);
                    false
                })
                // Links that open a new tab go to the system browser.
                .on_new_window(move |url, _features| {
                    open_outside(&popups, &url);
                    NewWindowResponse::Deny
                })
                .build()?;
            if let Err(error) = start_server(app.handle(), window.clone()) {
                let splash = window.url()?;
                show_failure(&window, &splash, &error.to_string());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start open-reel");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            drop(app.state::<Server>().0.lock().unwrap().take());
        }
    });
}
