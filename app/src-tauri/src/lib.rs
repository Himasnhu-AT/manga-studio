//! Tauri shell for Manga Studio.
//!
//! The Python backend (`uv run studio serve`) owns the model, the story files and the pipeline.
//! This shell makes it feel like one app: on launch it reuses a backend that is already running
//! (an agent or a terminal may have started one) or spawns its own, and on quit it stops only the
//! backend it spawned. The UI talks to the backend over HTTP on 127.0.0.1:7860.

use std::fs::{self, File};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, RunEvent, State};

const PORT: u16 = 7860;

/// Repo root: MANGA_STUDIO_ROOT if set, else the checkout this binary was built from.
fn repo_root() -> PathBuf {
    if let Ok(p) = std::env::var("MANGA_STUDIO_ROOT") {
        return PathBuf::from(p);
    }
    let here = Path::new(env!("CARGO_MANIFEST_DIR")); // <repo>/app/src-tauri
    here.parent().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_else(|| here.to_path_buf())
}

fn backend_up() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// GUI apps on macOS start with a minimal PATH, so look for uv where installers put it.
fn find_uv() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|d| Path::new(d).join("uv"))
        .collect();
    for d in [".local/bin", ".cargo/bin"] {
        candidates.push(Path::new(&home).join(d).join("uv"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/uv"));
    candidates.push(PathBuf::from("/usr/local/bin/uv"));
    candidates.into_iter().find(|p| p.is_file())
}

#[derive(Default)]
struct Backend {
    child: Mutex<Option<Child>>,
    error: Mutex<Option<String>>,
}

#[derive(Serialize)]
struct BackendStatus {
    url: String,
    up: bool,
    spawned: bool,
    root: String,
    log: String,
    error: Option<String>,
}

fn log_path(root: &Path) -> PathBuf {
    root.join(".studio").join("backend.log")
}

fn spawn_backend(state: &Backend) {
    if backend_up() {
        return; // someone else runs it (terminal, agent): share it, don't own it
    }
    let root = repo_root();
    let Some(uv) = find_uv() else {
        *state.error.lock().unwrap() = Some("uv not found. Install it from https://docs.astral.sh/uv/ and reopen the app.".into());
        return;
    };
    let _ = fs::create_dir_all(root.join(".studio"));
    let log = File::create(log_path(&root)).ok();
    let mut cmd = Command::new(uv);
    cmd.args(["run", "studio", "serve", "--port", &PORT.to_string()])
        .current_dir(&root)
        .stdin(Stdio::null());
    match log.as_ref().and_then(|f| Some((f.try_clone().ok()?, f.try_clone().ok()?))) {
        Some((out, err)) => {
            cmd.stdout(out).stderr(err);
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    match cmd.spawn() {
        Ok(child) => *state.child.lock().unwrap() = Some(child),
        Err(e) => *state.error.lock().unwrap() = Some(format!("could not start the backend: {e}")),
    }
}

#[tauri::command]
fn backend_status(state: State<'_, Backend>) -> BackendStatus {
    let root = repo_root();
    let mut child = state.child.lock().unwrap();
    // If our child died, surface it instead of pretending it is still starting.
    if let Some(c) = child.as_mut() {
        if let Ok(Some(code)) = c.try_wait() {
            *state.error.lock().unwrap() = Some(format!("backend exited ({code}); see {}", log_path(&root).display()));
            *child = None;
        }
    }
    BackendStatus {
        url: format!("http://127.0.0.1:{PORT}"),
        up: backend_up(),
        spawned: child.is_some(),
        root: root.display().to_string(),
        log: log_path(&root).display().to_string(),
        error: state.error.lock().unwrap().clone(),
    }
}

#[tauri::command]
fn restart_backend(state: State<'_, Backend>) -> Result<(), String> {
    if let Some(mut c) = state.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    } else if backend_up() {
        return Err("The backend was started outside the app; restart it where it runs.".into());
    }
    *state.error.lock().unwrap() = None;
    for _ in 0..20 {
        if !backend_up() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    spawn_backend(&state);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Backend::default())
        .invoke_handler(tauri::generate_handler![backend_status, restart_backend])
        .setup(|app| {
            spawn_backend(&app.state::<Backend>());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Manga Studio");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Stop only the backend we started. Interrupt first so uvicorn exits cleanly.
            if let Some(mut c) = handle.state::<Backend>().child.lock().unwrap().take() {
                let _ = Command::new("kill").args(["-INT", &c.id().to_string()]).status();
                for _ in 0..30 {
                    if matches!(c.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _ = c.kill();
            }
        }
    });
}
