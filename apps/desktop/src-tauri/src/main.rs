// Fellowship as a desktop app.
//
// This is a window over the same one process host that `fellowship serve`
// runs, and nothing else. It starts that host with the Node runtime bundled
// beside it, waits for /health, points a webview at it, and stops it on quit.
// The UI talks to the host over HTTP on loopback exactly as a browser tab
// does, so the desktop app gets no path into the silo the browser does not
// have, and is granted no Tauri commands at all.
//
// If a host is already answering on the usual port and runs the same code as
// this app (same surface fingerprint), it is reused rather than started again:
// the silo has one writer, and a second host pointed at the same file is how a
// local first app ends up with two. A host running other code, say a dev host
// left over from before a commit, is stopped and replaced, so the UI never
// talks to a host that lacks the tools it calls.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// The port the CLI uses, so the two find each other.
const PREFERRED_PORT: u16 = 4319;

/// How long the host gets to migrate, open the silo and bind.
const STARTUP_BUDGET: Duration = Duration::from_secs(45);

/// The least time the splash stays up, so a host that is already running does
/// not turn it into a flash.
const MIN_SPLASH: Duration = Duration::from_millis(1400);

/// The fingerprint of the host this app bundles, from scripts/bundle.mjs.
const FINGERPRINT: Option<&str> = option_env!("FELLOWSHIP_FINGERPRINT");

/// The host process, when this app started it. None when one was reused.
struct Host(Mutex<Option<Child>>);

/// True when a Fellowship host answers /health on this port.
fn is_fellowship(port: u16) -> bool {
    health(port).is_some()
}

/// One field of the /health body: a number or a string, as text. The body is
/// small and flat, so this stays clear of a JSON dependency.
fn field(body: &str, key: &str) -> Option<String> {
    let start = body.find(&format!("\"{key}\":"))? + key.len() + 3;
    let rest = body[start..].trim_start();
    if let Some(quoted) = rest.strip_prefix('"') {
        return quoted.find('"').map(|end| quoted[..end].to_string());
    }
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    (end > 0).then(|| rest[..end].to_string())
}

/// The pid listening on a port, from lsof, for a host too old to report it.
fn listener_pid(port: u16) -> Option<String> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(|line| line.trim().to_string()).filter(|pid| !pid.is_empty())
}

/// Stops the host on a port, by the pid it reports or, failing that, the pid
/// listening there and nothing else, and waits for the port to come free.
fn stop_host(port: u16, body: &str) {
    if let Some(pid) = field(body, "pid").or_else(|| listener_pid(port)) {
        let _ = Command::new("/bin/kill").arg(&pid).status();
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && is_fellowship(port) {
        thread::sleep(Duration::from_millis(200));
    }
}

/// The /health body when a Fellowship host answers on this port. Checks the
/// body as well as the status, so some other server that happens to own the
/// port is not mistaken for one.
fn health(port: u16) -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return None;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let ok = response.starts_with("HTTP/1.1 200")
        && response.contains("\"ok\":true")
        && response.contains("\"tools\"");
    ok.then_some(response)
}

/// Where the host should be: reuse one that is up, else the usual port if it
/// is free, else whatever the OS hands out.
fn choose_port() -> (u16, bool) {
    if let Some(body) = health(PREFERRED_PORT) {
        match FINGERPRINT {
            // A build without a stamp cannot tell old code from new.
            None => return (PREFERRED_PORT, true),
            Some(ours) if field(&body, "fingerprint").as_deref() == Some(ours) => {
                return (PREFERRED_PORT, true);
            }
            // Older code. One host at a time: stop it and start ours.
            Some(_) => stop_host(PREFERRED_PORT, &body),
        }
    }
    if TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_ok() {
        return (PREFERRED_PORT, false);
    }
    let port = TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(PREFERRED_PORT);
    (port, false)
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let (port, reuse) = choose_port();

            let child = if reuse {
                None
            } else {
                let resources = app.path().resource_dir()?;
                let runtime = std::env::current_exe()?
                    .parent()
                    .map(|directory| directory.join("node"))
                    .ok_or("no directory beside the executable")?;

                // The host's own output goes to a log the user can find,
                // rather than to a pipe nobody reads, which would fill and
                // stall the process.
                let logs = app.path().app_log_dir()?;
                create_dir_all(&logs)?;
                let log = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(logs.join("host.log"))?;

                let child = Command::new(runtime)
                    .arg(resources.join("server").join("dist").join("cli.js"))
                    .args(["serve", "--port", &port.to_string()])
                    .env("FELLOWSHIP_UI_DIR", resources.join("ui"))
                    .env("FELLOWSHIP_HOST", "127.0.0.1")
                    // The host exits when this pid does, so a crash of the
                    // app never leaves it running with the silo open.
                    .env("FELLOWSHIP_PARENT_PID", std::process::id().to_string())
                    .stdin(Stdio::null())
                    .stdout(Stdio::from(log.try_clone()?))
                    .stderr(Stdio::from(log))
                    .spawn()?;
                Some(child)
            };

            app.manage(Host(Mutex::new(child)));

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Fellowship")
                .inner_size(1280.0, 840.0)
                .min_inner_size(900.0, 600.0)
                .build()?;

            let shown = Instant::now();
            thread::spawn(move || {
                let deadline = Instant::now() + STARTUP_BUDGET;
                while Instant::now() < deadline {
                    if is_fellowship(port) {
                        if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) {
                            thread::sleep(MIN_SPLASH.saturating_sub(shown.elapsed()));
                            let _ = window.navigate(url);
                        }
                        return;
                    }
                    thread::sleep(Duration::from_millis(200));
                }
                let _ = window.eval(
                    "document.body.innerHTML = '<p>The host did not start. Another Fellowship host may be running on a different port: it refuses a second one. Its log is host.log in the app log folder.</p>';",
                );
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Fellowship could not start its window");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Only the host this app started is stopped. One that was already
            // running belongs to whoever started it.
            if let Some(host) = handle.try_state::<Host>() {
                if let Ok(mut guard) = host.0.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        }
    });
}
