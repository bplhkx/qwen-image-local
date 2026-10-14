//! The desktop half of remote access: accept LAN connections and answer them with the
//! app's own state. The protocol itself (parsing, auth, path guards, job state) lives in
//! `qil_core::remote` where it can be tested without a Tauri runtime.

use std::net::TcpListener;

use base64::Engine as _;
use qil_core::remote::{self, JobCell};
use qil_core::{engine, generate, setup, surprise, Config, GenRequest, Progress};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

/// Opens the listener and keeps it for the life of the process. A port already in use is
/// not fatal: the window still works, it just cannot be reached remotely until the user
/// changes `remote.port` and restarts.
pub fn spawn(app: AppHandle, job: JobCell) {
    std::thread::spawn(move || {
        let cfg = config(&app);
        if !cfg.remote.enabled {
            return;
        }
        let port = cfg.remote.port;
        let Ok(listener) = TcpListener::bind(("0.0.0.0", port)) else {
            let _ = app.emit("remote", json!({ "listening": false, "port": port, "error": "port busy" }));
            return;
        };
        let _ = app.emit("remote", json!({ "listening": true, "port": port, "urls": remote::lan_urls(port) }));
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let (app, job) = (app.clone(), job.clone());
            std::thread::spawn(move || {
                let mut stream = stream;
                let Ok(Some(req)) = remote::read_request(&mut stream) else { return };
                let reply = match route(&req, &app, &job) {
                    Ok(reply) => reply,
                    Err(e) => remote::Reply::json(400, json!({ "error": e })),
                };
                let _ = reply.send(&mut stream);
            });
        }
    });
}

fn config(app: &AppHandle) -> Config {
    app.state::<crate::Settings>().0.read().unwrap().clone()
}

fn route(req: &remote::Request, app: &AppHandle, job: &JobCell) -> Result<remote::Reply, String> {
    let cfg = config(app);

    if req.method == "GET" && req.path == "/api/ping" {
        let mut hello = remote::capabilities();
        hello["name"] = json!("qwen-image-local");
        hello["version"] = json!(env!("CARGO_PKG_VERSION"));
        hello["paired"] = json!(!cfg.remote.token.is_empty());
        return Ok(remote::Reply::json(200, hello));
    }
    if !remote::authorized(req, &cfg) {
        return Ok(remote::Reply::json(
            401,
            json!({ "error": "missing or wrong token", "hint": "copy it from the desktop app under Remote access" }),
        ));
    }

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/status") => {
            let status = setup::status(&cfg);
            let (state, detail, external) = crate::engine_snapshot();
            let busy = crate::BUSY.load(std::sync::atomic::Ordering::SeqCst);
            let engine = json!({ "state": state, "detail": detail, "external": external });
            Ok(remote::Reply::json(200, json!({
                "busy": busy,
                "engine": engine,
                "gpu": status.gpu,
                "ready": status.ready,
                "problems": status.problems,
                "ditReady": status.dit_ready,
                "config": {
                    "profile": cfg.profile, "dit": cfg.dit, "speed": cfg.speed,
                    "outputDir": cfg.output_dir, "modelsDir": cfg.models_dir,
                },
                "outputs": remote::list_outputs(&cfg, 24),
                "historyCount": remote::list_outputs(&cfg, usize::MAX).len(),
                "job": &*job.lock().unwrap(),
            })))
        }

        ("GET", "/api/settings") => {
            let mut caps = remote::capabilities();
            caps["profile"] = json!(cfg.profile);
            caps["dit"] = json!(cfg.dit);
            caps["speed"] = json!(cfg.speed);
            caps["outputDir"] = json!(cfg.output_dir);
            caps["modelsDir"] = json!(cfg.models_dir);
            caps["quick"] = json!(remote::quick_prompts());
            caps["remote"] = json!({ "enabled": cfg.remote.enabled, "port": cfg.remote.port, "urls": remote::lan_urls(cfg.remote.port) });
            Ok(remote::Reply::json(200, caps))
        }

        ("POST", "/api/settings") => {
            let body = req.json()?;
            let settings = app.state::<crate::Settings>();
            let mut c = settings.0.write().unwrap();
            if let Some(p) = body.get("profile").and_then(serde_json::Value::as_str) {
                c.profile = qil_core::Profile::parse(p).ok_or("unknown profile")?;
            }
            if let Some(d) = body.get("dit").and_then(serde_json::Value::as_str) {
                c.dit = qil_core::Dit::parse(d).ok_or("unknown dit")?;
            }
            if let Some(s) = body.get("speed").and_then(serde_json::Value::as_str) {
                c.speed = qil_core::Speed::parse(s).ok_or("unknown speed")?;
            }
            c.save().map_err(|e| e.to_string())?;
            Ok(remote::Reply::json(200, json!({ "profile": c.profile, "dit": c.dit, "speed": c.speed })))
        }

        ("POST", "/api/engine/start") => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let c = config(&app);
                let _ = app.state::<engine::Engine>().start(&c, &crate::engine_emitter(&app)).await;
            });
            Ok(remote::Reply::json(202, json!({ "starting": true })))
        }

        ("POST", "/api/engine/stop") => {
            let stopped = app.state::<engine::Engine>().stop();
            if stopped {
                let _ = app.emit("engine", engine::EngineState { state: "off", detail: "Engine stopped by a remote client".into(), external: false });
            }
            Ok(remote::Reply::json(200, json!({ "stopped": stopped })))
        }

        ("POST", "/api/generate") => {
            let mut req_body: GenRequest = serde_json::from_slice(&req.body).map_err(|e| format!("bad GenRequest: {e}"))?;
            if req_body.mode == "surprise" {
                // Whatever the client sent as `prompt` is the theme; the idea replaces it.
                let theme = req.param("theme").map(str::to_string).or_else(|| {
                    let t = req_body.prompt.trim();
                    (!t.is_empty() && t != "surprise").then(|| t.to_string())
                });
                let idea = surprise::idea(theme.as_deref());
                if req_body.aspect.is_empty() || req_body.aspect == "random" {
                    req_body.aspect = idea.aspect.clone();
                }
                req_body.prompt = idea.prompt;
            }
            if req_body.prompt.trim().is_empty() {
                return Ok(remote::Reply::json(400, json!({ "error": "`prompt` is required" })));
            }
            // References must have come through /api/upload (or be earlier outputs);
            // otherwise this endpoint would be a way to read any file on the disk.
            let inbox = cfg.runtime_dir.join("remote-inbox");
            for image in &req_body.images {
                if remote::inside(&inbox, image).is_none() && remote::inside(&cfg.output_dir, image).is_none() {
                    return Ok(remote::Reply::json(403, json!({ "error": "upload reference images first", "path": image })));
                }
            }
            if !remote::begin(job, &req_body.prompt, "remote") {
                return Ok(remote::Reply::json(409, json!({ "error": "a generation is already running", "job": &*job.lock().unwrap() })));
            }
            let (app, job) = (app.clone(), job.clone());
            let started = req_body.prompt.clone();
            tauri::async_runtime::spawn(async move {
                let watch = job.clone();
                let notify: crate::ProgressHook = Box::new(move |p: Progress| remote::advance(&watch, p.stage, p.value, p.max));
                match crate::run_generation(&app, req_body, Some(notify)).await {
                    Ok(result) => remote::settle(&job, Some(result), None),
                    Err(e) => remote::settle(&job, None, Some(e)),
                }
            });
            Ok(remote::Reply::json(202, json!({ "started": true, "prompt": started })))
        }

        ("GET", "/api/job") => Ok(remote::Reply::json(200, json!({ "job": &*job.lock().unwrap() }))),

        ("POST", "/api/job/cancel") => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                generate::interrupt(&config(&app)).await;
            });
            Ok(remote::Reply::json(200, json!({ "cancelling": true })))
        }

        ("GET", "/api/history") => {
            let limit = req.param("limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(60);
            Ok(remote::Reply::json(200, json!({ "items": remote::list_outputs(&cfg, limit) })))
        }

        ("GET", "/api/file") => {
            let Some(p) = req.param("p") else {
                return Ok(remote::Reply::json(400, json!({ "error": "`p` is a path from /api/history" })));
            };
            let Some(file) = remote::inside(&cfg.output_dir, p) else {
                return Ok(remote::Reply::json(403, json!({ "error": "only files in the output folder can be read" })));
            };
            let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
            if req.param("thumb").is_some() {
                let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
                let small = img.thumbnail(256, 256).to_rgb8();
                let mut out = std::io::Cursor::new(Vec::new());
                small.write_to(&mut out, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
                return Ok(remote::Reply::bytes(200, "image/jpeg", out.into_inner()));
            }
            let ctype = match file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                _ => "application/octet-stream",
            };
            Ok(remote::Reply::bytes(200, ctype, bytes))
        }

        ("POST", "/api/delete") => {
            let path = req.field("path").ok_or("`path` is required")?;
            let Some(file) = remote::inside(&cfg.output_dir, &path) else {
                return Ok(remote::Reply::json(403, json!({ "error": "only files in the output folder can be deleted" })));
            };
            if !file.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")) {
                return Ok(remote::Reply::json(400, json!({ "error": "only generated PNGs can be deleted" })));
            }
            let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            std::fs::remove_file(&file).map_err(|e| format!("could not delete {name}: {e}"))?;
            let _ = std::fs::remove_file(file.with_extension("json"));
            Ok(remote::Reply::json(200, json!({ "deleted": name })))
        }

        ("POST", "/api/upload") => {
            let name = req.field("name").unwrap_or_else(|| "ref.png".into());
            let data = req.field("data").ok_or("`data` must be a base64 data URL")?;
            let b64 = data.rsplit(',').next().filter(|_| data.contains("base64")).ok_or("`data` must be a base64 data URL")?;
            let raw = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("bad base64: {e}"))?;
            // Decode before trusting it: this endpoint must not become a file drop.
            let img = image::load_from_memory(&raw).map_err(|_| "that is not a readable image".to_string())?;
            let ext = if name.to_ascii_lowercase().ends_with(".jpg") || name.to_ascii_lowercase().ends_with(".jpeg") { "jpg" } else { "png" };
            let dir = cfg.runtime_dir.join("remote-inbox");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let out = dir.join(format!("remote_{stamp}.{ext}"));
            img.save(&out).map_err(|e| e.to_string())?;
            Ok(remote::Reply::json(200, json!({ "path": out.to_string_lossy(), "width": img.width(), "height": img.height() })))
        }

        _ => Ok(remote::Reply::json(404, json!({ "error": "no such endpoint", "path": req.path }))),
    }
}
