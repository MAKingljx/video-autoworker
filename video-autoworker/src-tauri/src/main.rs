use std::{
    env,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::Manager;

struct ServerState {
    child: Mutex<Option<Child>>,
}

fn main() {
    let app = tauri::Builder::default()
        .manage(ServerState {
            child: Mutex::new(None),
        })
        .setup(|app| {
            let port = desktop_port();
            let project_dir = project_dir();

            if let Some(child) = start_profiles_server(&project_dir, port)? {
                let state = app.state::<ServerState>();
                *state.child.lock().expect("server state lock poisoned") = Some(child);
            }

            if !wait_for_server(port) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("OpenClaw Profiles server did not become ready on port {port}"),
                )
                .into());
            }

            let url = format!("http://127.0.0.1:{port}/profiles")
                .parse()
                .expect("valid local OpenClaw Profiles URL");

            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("OpenClaw Control Center")
                .inner_size(1220.0, 820.0)
                .min_inner_size(980.0, 680.0)
                .resizable(true)
                .center()
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build OpenClaw Control Center");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let maybe_process = {
                let state = app_handle.state::<ServerState>();
                state.child.lock().ok().and_then(|mut child| child.take())
            };

            if let Some(mut process) = maybe_process {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    });
}

fn desktop_port() -> u16 {
    env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3017)
}

fn project_dir() -> PathBuf {
    if let Ok(value) = env::var("MC_MISSION_CONTROL_DIR") {
        return PathBuf::from(value);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.parent().unwrap_or(&manifest_dir).to_path_buf()
}

fn start_profiles_server(
    project_dir: &Path,
    port: u16,
) -> Result<Option<Child>, Box<dyn std::error::Error>> {
    if is_profiles_server_ready(port) {
        return Ok(None);
    }
    if is_port_open(port) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            format!("port {port} is already in use by a non OpenClaw Profiles server"),
        )
        .into());
    }

    let data_dir = home_dir()?.join(".mission-control-openclaw-profiles");
    let db_path = data_dir.join("mission-control.db");
    let tokens_path = data_dir.join("mission-control-tokens.json");
    std::fs::create_dir_all(&data_dir)?;

    let server_script = project_dir.join("scripts/start-openclaw-profiles-server.sh");
    if !server_script.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "server launcher was not found at {}",
                server_script.display()
            ),
        )
        .into());
    }

    let child = Command::new("/bin/bash")
        .arg(server_script)
        .current_dir(project_dir)
        .env("PORT", port.to_string())
        .env("MC_DESKTOP_MODE", "1")
        .env("MC_OPENCLAW_PROFILES_NO_AUTH", "1")
        .env("MC_DISABLE_RATE_LIMIT", "1")
        .env("NEXT_PUBLIC_OPENCLAW_PROFILES_DESKTOP", "1")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("MISSION_CONTROL_DATA_DIR", &data_dir)
        .env("MISSION_CONTROL_DB_PATH", db_path)
        .env("MISSION_CONTROL_TOKENS_PATH", tokens_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    Ok(Some(child))
}

fn home_dir() -> Result<PathBuf, std::io::Error> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "HOME is not set"))
}

fn wait_for_server(port: u16) -> bool {
    for _ in 0..120 {
        if is_profiles_server_ready(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

fn is_port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn is_profiles_server_ready(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/api/auth/me");
    let referer = format!("Referer: http://127.0.0.1:{port}/profiles");

    Command::new("curl")
        .arg("-fsS")
        .arg("-H")
        .arg(referer)
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
