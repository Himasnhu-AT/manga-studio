//! Tauri shell for Manga Studio.
//!
//! The Python backend (`uv run studio serve`) owns the model, the story files and the pipeline.
//! This shell makes it feel like one app: on launch it reuses a backend that is already running
//! (an agent or a terminal may have started one) or spawns its own, and on quit it stops only the
//! backend it spawned. The UI talks to the backend over HTTP on 127.0.0.1:7860.
//!
//! Two layouts (see `Layout::detect`):
//! - **Dev**: running from a checkout (a debug build, or MANGA_STUDIO_ROOT set). `uv run studio serve`
//!   in the repo; state in <repo>/.studio, stories in <repo>/stories. Release builds never look for
//!   the checkout they were built from, so no path from the build machine ends up in them.
//! - **Installed**: a downloaded .app. The backend ships as resources in Contents/Resources/backend
//!   (code-signed: never written to). It runs as `uv run --frozen --project <that dir> studio serve`
//!   with env that sends every write to the user's folders: venv, settings, log and bytecode under
//!   ~/Library/Application Support/Manga Studio, stories in ~/Manga Studio/stories (seeded with the
//!   sample story on first launch).
//!
//! A backend that is already running is reused only if it serves the same stories folder (it says
//! which in /api/status). Otherwise the app shows that another studio holds the port instead of
//! quietly reading and writing that studio's stories.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const PORT: u16 = 7860;
const SAMPLE: &str = "cheek-squish";
const UV_INSTALL: &str = "curl -LsSf https://astral.sh/uv/install.sh | sh";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// The checkout a debug build was built from (<repo>/app/src-tauri/../..). Debug builds only: a
/// release binary must not carry the build machine's paths.
#[cfg(debug_assertions)]
fn manifest_repo() -> Option<PathBuf> {
    let here = Path::new(env!("CARGO_MANIFEST_DIR")); // <repo>/app/src-tauri
    here.parent().and_then(Path::parent).map(Path::to_path_buf)
}

#[cfg(not(debug_assertions))]
fn manifest_repo() -> Option<PathBuf> {
    None
}

/// Where the backend's code lives and where everything it writes goes.
struct Layout {
    installed: bool,
    /// The uv project: the repo (dev) or Contents/Resources/backend (installed, read-only).
    root: PathBuf,
    /// App state: <repo>/.studio (dev) or ~/Library/Application Support/Manga Studio (installed).
    data: PathBuf,
    /// The settings file the backend reads (STUDIO_SETTINGS wins in both modes).
    settings: PathBuf,
    log: PathBuf,
    /// Installed only; dev leaves these to the backend's defaults.
    stories: Option<PathBuf>,
    venv: Option<PathBuf>,
    launcher: Option<PathBuf>,
}

fn env_path(k: &str) -> Option<PathBuf> {
    std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from)
}

impl Layout {
    fn detect(app: &AppHandle) -> Layout {
        let dev_root = env_path("MANGA_STUDIO_ROOT").or_else(manifest_repo);
        match dev_root {
            Some(root) => {
                let data = root.join(".studio");
                Layout {
                    installed: false,
                    settings: env_path("STUDIO_SETTINGS").unwrap_or_else(|| data.join("settings.json")),
                    log: data.join("backend.log"),
                    root,
                    data,
                    stories: None,
                    venv: None,
                    launcher: None,
                }
            }
            None => {
                let res = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
                let data = home().join("Library/Application Support/Manga Studio");
                Layout {
                    installed: true,
                    root: res.join("backend"),
                    settings: env_path("STUDIO_SETTINGS").unwrap_or_else(|| data.join("settings.json")),
                    log: data.join("backend.log"),
                    stories: Some(env_path("STUDIO_STORIES").unwrap_or_else(|| home().join("Manga Studio").join("stories"))),
                    venv: Some(env_path("UV_PROJECT_ENVIRONMENT").unwrap_or_else(|| data.join("venv"))),
                    launcher: Some(data.join("bin").join("manga-studio-mcp")),
                    data,
                }
            }
        }
    }

    /// The stories folder this app's backend uses (dev: the backend's default, <repo>/stories).
    fn stories_dir(&self) -> PathBuf {
        self.stories.clone().or_else(|| env_path("STUDIO_STORIES")).unwrap_or_else(|| self.root.join("stories"))
    }

    /// Env for the backend and the MCP launcher in installed mode, so nothing is written into the bundle.
    fn backend_env(&self) -> Vec<(&'static str, PathBuf)> {
        let (Some(stories), Some(venv), Some(launcher)) = (&self.stories, &self.venv, &self.launcher) else {
            return vec![];
        };
        vec![
            ("UV_PROJECT_ENVIRONMENT", venv.clone()),
            ("STUDIO_STORIES", stories.clone()),
            ("STUDIO_HOME", self.data.clone()),
            ("STUDIO_SETTINGS", self.settings.clone()),
            ("PYTHONPYCACHEPREFIX", self.data.join("pycache")),
            ("STUDIO_MCP_LAUNCHER", launcher.clone()),
        ]
    }

    /// True until the installed app's venv exists: the first `uv run` installs every dependency.
    fn first_run(&self) -> bool {
        self.venv.as_ref().is_some_and(|v| !v.join("pyvenv.cfg").is_file())
    }

    /// Installed mode: create the user folders, seed the sample story on first launch, and (re)write
    /// the MCP launcher so it points at wherever the app lives now.
    fn prepare(&self) -> Result<(), String> {
        let _ = fs::create_dir_all(&self.data);
        if !self.installed {
            return Ok(());
        }
        if !self.root.join("pyproject.toml").is_file() {
            return Err(format!("The app's backend files are missing ({}). Reinstall Manga Studio.", self.root.display()));
        }
        if let Some(stories) = &self.stories {
            if !stories.exists() {
                fs::create_dir_all(stories).map_err(|e| format!("could not create {}: {e}", stories.display()))?;
                let _ = copy_dir(&self.root.join("stories").join(SAMPLE), &stories.join(SAMPLE));
            }
        }
        if let Some(launcher) = &self.launcher {
            write_launcher(launcher, &self.root, &self.backend_env()).map_err(|e| format!("could not write {}: {e}", launcher.display()))?;
        }
        Ok(())
    }
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

fn sh_quote(p: &Path) -> String {
    format!("'{}'", p.display().to_string().replace('\'', r"'\''"))
}

/// A tiny script outside the bundle that agents register as their MCP server
/// (`claude mcp add manga-studio -- <launcher>`). Rewritten on every launch, so moving or updating
/// the app keeps registrations working. Env set by the agent (`claude mcp add -e ...`) wins.
fn write_launcher(path: &Path, root: &Path, env: &[(&str, PathBuf)]) -> std::io::Result<()> {
    let mut s = String::from("#!/bin/sh\n# Written by Manga Studio on every launch: runs its MCP bridge (studio mcp) from the installed app.\n");
    s.push_str("PATH=\"$PATH:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin\"\nexport PATH\n");
    for (k, v) in env.iter().filter(|(k, _)| *k != "STUDIO_MCP_LAUNCHER") {
        s.push_str(&format!("[ -n \"${k}\" ] || {k}={}\nexport {k}\n", sh_quote(v)));
    }
    s.push_str(&format!("exec uv run --frozen --project {} studio mcp \"$@\"\n", sh_quote(root)));
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, s)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

/// GUI apps on macOS start with PATH=/usr/bin:/bin:/usr/sbin:/sbin. Append the usual install places
/// so the backend finds ffmpeg, claude, codex and ollama the way a terminal would.
fn gui_path() -> String {
    let h = home();
    let mut dirs: Vec<String> = std::env::var("PATH").unwrap_or_default().split(':').filter(|d| !d.is_empty()).map(String::from).collect();
    let extras = [h.join(".local/bin"), h.join(".cargo/bin"), h.join(".bun/bin"), "/opt/homebrew/bin".into(), "/opt/homebrew/sbin".into(), "/usr/local/bin".into()];
    for e in extras.iter().map(|p| p.display().to_string()) {
        if !dirs.contains(&e) {
            dirs.push(e);
        }
    }
    dirs.join(":")
}

fn backend_up() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// The stories folder the backend on PORT reports in /api/status. Some("") when it answers without
/// one (an older backend), None when it can't be asked.
fn running_backend_stories() -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(250)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    s.write_all(b"GET /api/status HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let body = text.split_once("\r\n\r\n")?.1;
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    Some(v.get("stories").and_then(|x| x.as_str()).unwrap_or_default().to_string())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

/// When the backend on PORT isn't ours to share (it serves another stories folder), say why.
fn foreign_backend(layout: &Layout) -> Option<String> {
    let theirs = running_backend_stories()?;
    let ours = layout.stories_dir();
    if !theirs.is_empty() && same_dir(Path::new(&theirs), &ours) {
        return None;
    }
    let where_ = if theirs.is_empty() { "an unknown folder (it's an older version)".to_string() } else { theirs };
    Some(format!(
        "Another Manga Studio backend is already running on port {PORT}, and it saves stories in {where_}. \
         This app saves them in {}. Quit the other one (usually a `studio serve` started from a terminal or \
         an agent), then click Try again.",
        ours.display()
    ))
}

/// GUI apps on macOS start with a minimal PATH, so look for uv where installers put it.
fn find_uv() -> Option<PathBuf> {
    let home = home();
    let mut candidates: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|d| Path::new(d).join("uv"))
        .collect();
    for d in [".local/bin", ".cargo/bin"] {
        candidates.push(home.join(d).join("uv"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/uv"));
    candidates.push(PathBuf::from("/usr/local/bin/uv"));
    candidates.into_iter().find(|p| p.is_file())
}

#[derive(Default)]
struct Backend {
    child: Mutex<Option<Child>>,
    error: Mutex<Option<String>>,
    /// The spawned backend is doing the installed app's first `uv sync` (slow: a minute or more).
    first_run: Mutex<bool>,
}

#[derive(Serialize)]
struct BackendStatus {
    url: String,
    up: bool,
    spawned: bool,
    root: String,
    log: String,
    error: Option<String>,
    /// Installed .app (true) or a checkout (false).
    installed: bool,
    first_run: bool,
    /// Path of uv, or null when it isn't installed.
    uv: Option<String>,
    uv_install: String,
    stories: Option<String>,
    data: String,
    /// Set when the backend on the port belongs to another studio (different stories folder).
    foreign: Option<String>,
}

fn spawn_backend(state: &Backend, layout: &Layout) {
    // Before the reuse check: the MCP launcher and the seeded stories are needed either way.
    if let Err(e) = layout.prepare() {
        *state.error.lock().unwrap() = Some(e);
        return;
    }
    if backend_up() {
        return; // someone else runs it (terminal, agent): share it, don't own it
    }
    let Some(uv) = find_uv() else {
        *state.error.lock().unwrap() = Some(format!("uv not found. Manga Studio runs its backend with uv. Install it in Terminal with  {UV_INSTALL}  then click Restart."));
        return;
    };
    *state.first_run.lock().unwrap() = layout.first_run();
    let log = File::create(&layout.log).ok();
    let mut cmd = Command::new(uv);
    if layout.installed {
        // --frozen: use the shipped uv.lock as is (never rewrite it inside the bundle).
        let root = layout.root.display().to_string();
        cmd.args(["run", "--frozen", "--project", &root, "studio", "serve", "--port", &PORT.to_string()])
            .current_dir(&layout.data)
            .envs(layout.backend_env());
    } else {
        cmd.args(["run", "studio", "serve", "--port", &PORT.to_string()]).current_dir(&layout.root);
    }
    cmd.env("PATH", gui_path())
        .stdin(Stdio::null())
        // Own process group: the child is `uv`, which doesn't forward signals to the Python server,
        // so stopping it means signalling the whole group (see stop_child).
        .process_group(0);
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

/// Stop a backend we spawned: SIGTERM the process group (uvicorn shuts down cleanly), then SIGKILL it.
fn stop_child(mut c: Child) {
    let group = format!("-{}", c.id());
    let _ = Command::new("kill").args(["-TERM", "--", &group]).status();
    for _ in 0..30 {
        if matches!(c.try_wait(), Ok(Some(_))) && !backend_up() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
    let _ = c.wait();
}

#[tauri::command]
fn backend_status(state: State<'_, Backend>, layout: State<'_, Layout>) -> BackendStatus {
    let mut child = state.child.lock().unwrap();
    // If our child died, surface it instead of pretending it is still starting.
    if let Some(c) = child.as_mut() {
        if let Ok(Some(code)) = c.try_wait() {
            *state.error.lock().unwrap() = Some(format!("backend exited ({code}); see {}", layout.log.display()));
            *child = None;
        }
    }
    let up = backend_up();
    let foreign = if up && child.is_none() { foreign_backend(&layout) } else { None };
    BackendStatus {
        url: format!("http://127.0.0.1:{PORT}"),
        up,
        spawned: child.is_some(),
        root: layout.root.display().to_string(),
        log: layout.log.display().to_string(),
        error: state.error.lock().unwrap().clone(),
        installed: layout.installed,
        first_run: *state.first_run.lock().unwrap() && !up,
        uv: find_uv().map(|p| p.display().to_string()),
        uv_install: UV_INSTALL.into(),
        stories: layout.stories.as_ref().map(|p| p.display().to_string()),
        data: layout.data.display().to_string(),
        foreign,
    }
}

#[tauri::command]
fn restart_backend(state: State<'_, Backend>, layout: State<'_, Layout>) -> Result<(), String> {
    let child = state.child.lock().unwrap().take();
    if let Some(c) = child {
        stop_child(c);
    } else if backend_up() {
        if let Some(why) = foreign_backend(&layout) {
            return Err(why);
        }
        return Err("The backend was started outside the app; restart it where it runs.".into());
    }
    *state.error.lock().unwrap() = None;
    for _ in 0..20 {
        if !backend_up() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    spawn_backend(&state, &layout);
    Ok(())
}

/// First run is decided by the backend's settings file (`onboarded: true` once setup is done).
fn onboarded(layout: &Layout) -> bool {
    fs::read_to_string(&layout.settings)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("onboarded").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/// Setup runs in its own small window: borderless (no traffic lights), transparent so the page
/// draws its own rounded card, and fixed in size. The main window stays hidden until it's done.
fn open_onboarding(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "onboarding", WebviewUrl::App("index.html".into()))
        .title("Welcome to Manga Studio")
        .inner_size(880.0, 580.0)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .center()
        .focused(true)
        .build()?;
    Ok(())
}

/// Called by the onboarding window when setup is done (or skipped): show the main window, tell
/// it where to go, close the onboarding window.
#[tauri::command]
fn finish_onboarding(app: AppHandle, view: String, slug: Option<String>) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("onboarded", serde_json::json!({ "view": view, "slug": slug }));
        main.show().map_err(|e| e.to_string())?;
        let _ = main.set_focus();
    }
    if let Some(w) = app.get_webview_window("onboarding") {
        let _ = w.close();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Backend::default())
        .on_window_event(|window, event| {
            // Closing setup with Cmd+W (there's no close button) quits instead of leaving an app with no window.
            if window.label() == "onboarding" && matches!(event, WindowEvent::Destroyed) {
                let app = window.app_handle();
                let main_visible = app.get_webview_window("main").and_then(|m| m.is_visible().ok()).unwrap_or(false);
                if !main_visible {
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![backend_status, restart_backend, finish_onboarding])
        .setup(|app| {
            let layout = Layout::detect(app.handle());
            spawn_backend(&app.state::<Backend>(), &layout);
            let done = onboarded(&layout);
            app.manage(layout);
            if done {
                if let Some(main) = app.get_webview_window("main") {
                    main.show()?;
                }
            } else {
                open_onboarding(app.handle())?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Manga Studio");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Stop only the backend we started (the whole process group, not just `uv`).
            let child = handle.state::<Backend>().child.lock().unwrap().take();
            if let Some(c) = child {
                stop_child(c);
            }
        }
    });
}
