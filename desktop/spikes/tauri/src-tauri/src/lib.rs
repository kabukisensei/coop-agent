use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const READY_LIMIT: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReady {
    #[serde(rename = "type")]
    event_type: String,
    contract_version: u32,
    transport: String,
    endpoint: String,
    one_time_token: String,
    runtime_pid: u32,
}

struct RuntimeChild(Mutex<Option<Child>>);

#[tauri::command]
fn choose_workspace() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn shell_info() -> serde_json::Value {
    serde_json::json!({ "shell": "tauri", "platform": std::env::consts::OS })
}

fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn read_runtime_ready(stdout: impl Read) -> Result<RuntimeReady, String> {
    let mut line = String::new();
    BufReader::new(stdout)
        .take(READY_LIMIT + 1)
        .read_line(&mut line)
        .map_err(|error| format!("Could not read Coop Runtime ready event: {error}"))?;
    if line.len() as u64 > READY_LIMIT {
        return Err("Coop Runtime ready event exceeded the safety limit.".into());
    }
    serde_json::from_str(line.trim())
        .map_err(|_| "Coop Runtime returned an invalid ready event.".to_string())
}

fn start_runtime(workspace: &str) -> Result<(Child, RuntimeReady), String> {
    let coop = std::env::var("COOP_BIN").unwrap_or_else(|_| "coop".into());
    let mut child = Command::new(coop)
        .args([
            "runtime",
            "--transport",
            "http",
            "--json",
            "--port",
            "0",
            "--cwd",
            workspace,
        ])
        .current_dir(workspace)
        .env("COOP_DESKTOP_SHELL", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start Coop Runtime: {error}"))?;

    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = [0_u8; 4096];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                eprint!("{}", String::from_utf8_lossy(&buffer[..count]));
            }
        });
    }

    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child);
        return Err("Coop Runtime did not expose its ready stream.".into());
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(read_runtime_ready(stdout));
    });
    let ready = match receiver.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(ready)) => ready,
        Ok(Err(error)) => {
            stop_child(&mut child);
            return Err(error);
        }
        Err(_) => {
            stop_child(&mut child);
            return Err("Coop Runtime did not become ready in time.".into());
        }
    };
    let endpoint = match url::Url::parse(&ready.endpoint) {
        Ok(endpoint) => endpoint,
        Err(_) => {
            stop_child(&mut child);
            return Err("Coop Runtime returned an invalid endpoint.".into());
        }
    };
    if ready.event_type != "runtime.ready"
        || ready.contract_version != 1
        || ready.transport != "http"
        || endpoint.scheme() != "http"
        || endpoint.host_str() != Some("127.0.0.1")
        || ready.one_time_token.len() != 32
        || !ready
            .one_time_token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || ready.runtime_pid == 0
    {
        stop_child(&mut child);
        return Err("Coop Runtime returned an incompatible ready event.".into());
    }
    Ok((child, ready))
}

pub fn run() {
    let workspace = std::env::var("COOP_WORKSPACE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let app = tauri::Builder::default()
        .manage(RuntimeChild(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![choose_workspace, shell_info])
        .setup(move |app| {
            let (child, ready) = start_runtime(&workspace).map_err(std::io::Error::other)?;
            *app.state::<RuntimeChild>().0.lock().expect("runtime lock") = Some(child);
            let mut url = url::Url::parse(&ready.endpoint).map_err(std::io::Error::other)?;
            url.query_pairs_mut()
                .append_pair("token", &ready.one_time_token);
            let origin = url.origin().ascii_serialization();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Coop Desktop Tauri Spike")
                .inner_size(1440.0, 920.0)
                .min_inner_size(960.0, 640.0)
                .on_navigation(move |target| target.origin().ascii_serialization() == origin)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Coop Desktop Tauri spike");

    app.run(|handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(mut child) = handle
                .state::<RuntimeChild>()
                .0
                .lock()
                .expect("runtime lock")
                .take()
            {
                stop_child(&mut child);
            }
        }
    });
}
