use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use base64::Engine as _;
use qil_core::{engine, generate, gpu, setup, surprise, Config, Dit, Engine, EngineState, GenRequest, GenResult, Profile, Speed};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Guard against double generation; released on Drop even if the task fails.
static BUSY: AtomicBool = AtomicBool::new(false);
static INSTALLING: AtomicBool = AtomicBool::new(false);
struct Flag(&'static AtomicBool);
impl Drop for Flag {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct Settings(RwLock<Config>);

fn cfg(s: &State<'_, Settings>) -> Config {
    s.0.read().unwrap().clone()
}

// ── Setup ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupInfo {
    status: setup::Status,
    config: Config,
    configured: bool,
    recommended: Profile,
}

#[tauri::command]
async fn setup_status(settings: State<'_, Settings>) -> Result<SetupInfo, String> {
    let c = cfg(&settings);
    let status = tauri::async_runtime::spawn_blocking({
        let c = c.clone();
        move || setup::status(&c)
    })
    .await
    .map_err(|e| e.to_string())?;
    let recommended = status.gpu.as_ref().map(|g| Profile::for_vram(g.total_mb)).unwrap_or_default();
    Ok(SetupInfo { status, config: c, configured: Config::exists(), recommended })
}

#[tauri::command]
fn setup_configure(settings: State<'_, Settings>, profile: Profile, dit: Option<Dit>, speed: Option<Speed>, models_dir: Option<String>) -> Result<Config, String> {
    let mut c = settings.0.write().unwrap();
    c.profile = profile;
    if let Some(d) = dit {
        c.dit = d;
    }
    if let Some(s) = speed {
        c.speed = s;
    }
    if let Some(d) = models_dir.filter(|d| !d.trim().is_empty()) {
        c.models_dir = PathBuf::from(d);
    }
    // Persist immediately so the choice survives a restart; setup::run saves again at the end.
    c.save().map_err(|e| e.to_string())?;
    Ok(c.clone())
}

#[tauri::command]
fn setup_run(app: AppHandle, settings: State<'_, Settings>) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("Setup is already running.".into());
    }
    let c = cfg(&settings);
    // A system thread, not an async command: the installer blocks on pipes and downloads.
    std::thread::spawn(move || {
        let _flag = Flag(&INSTALLING);
        let res = setup::run(&c, &mut |ev| {
            let _ = app.emit("setup", &ev);
        });
        let _ = app.emit("setup-finished", res.err());
    });
    Ok(())
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose the models folder")
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

// ── Engine ──

fn engine_emitter(app: &AppHandle) -> impl Fn(EngineState) + Send + Sync {
    let app = app.clone();
    move |s: EngineState| {
        let _ = app.emit("engine", s);
    }
}

#[tauri::command]
async fn engine_start(app: AppHandle, engine: State<'_, Engine>, settings: State<'_, Settings>) -> Result<(), String> {
    let c = cfg(&settings);
    engine.start(&c, &engine_emitter(&app)).await
}

#[tauri::command]
fn engine_stop(app: AppHandle, engine: State<'_, Engine>) -> bool {
    let stopped = engine.stop();
    if stopped {
        let _ = app.emit("engine", EngineState { state: "off", detail: "Engine stopped".into(), external: false });
    }
    stopped
}

// ── Generation ──

#[tauri::command]
async fn generate(app: AppHandle, settings: State<'_, Settings>, req: GenRequest) -> Result<GenResult, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("A generation is already running.".into());
    }
    let _flag = Flag(&BUSY);
    let c = cfg(&settings);
    if !engine::is_up(&c).await {
        return Err("The engine is off.".into());
    }
    let emit = move |p: qil_core::Progress| {
        let _ = app.emit("gen-progress", p);
    };
    generate::run(&c, req, c.output_dir.clone(), &emit).await
}

#[tauri::command]
async fn cancel(settings: State<'_, Settings>) -> Result<(), String> {
    generate::interrupt(&cfg(&settings)).await;
    Ok(())
}

#[tauri::command]
fn surprise_idea(theme: Option<String>) -> surprise::Idea {
    surprise::idea(theme.as_deref())
}

#[tauri::command]
async fn gpu_stats() -> Option<gpu::Gpu> {
    tauri::async_runtime::spawn_blocking(gpu::detect).await.ok().flatten()
}

/// Decodes an image as it should be seen: phone photos are often stored sideways with an
/// EXIF orientation tag, which image::open ignores.
fn open_upright(path: &str) -> Result<image::DynamicImage, String> {
    let err = |e: &dyn std::fmt::Display| format!("Cannot open the image: {e}");
    let mut decoder = image::ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| err(&e))?
        .into_decoder()
        .map_err(|e| err(&e))?;
    let orientation = image::ImageDecoder::orientation(&mut decoder).unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| err(&e))?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// JPEG thumbnail as a data URL, so the UI can show references without file-system access.
#[tauri::command]
async fn thumbnail(path: String, size: Option<u32>) -> Result<String, String> {
    let size = size.unwrap_or(256);
    tauri::async_runtime::spawn_blocking(move || {
        let t = open_upright(&path)?.thumbnail(size, size).to_rgb8();
        let mut buf = std::io::Cursor::new(Vec::new());
        t.write_to(&mut buf, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
        Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf.into_inner())))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Let the UI show a user-picked reference file through asset:// by allowing that
/// exact path — one file at a time, never a whole directory.
#[tauri::command]
fn allow_asset(app: AppHandle, path: String) -> Result<(), String> {
    app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())
}

/// Raw file bytes as a data URL for the image editor. Loading through asset:// would taint
/// the canvas and break toDataURL; a data URL keeps the export working.
#[tauri::command]
async fn read_image(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
        let mime = match std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "application/octet-stream",
        };
        Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the editor's PNG export (data URL) into runtime/edited/ and returns the new path.
#[tauri::command]
async fn save_edited(settings: State<'_, Settings>, data_url: String) -> Result<String, String> {
    let dir = cfg(&settings).runtime_dir.join("edited");
    tauri::async_runtime::spawn_blocking(move || {
        let b64 = data_url.split_once(',').ok_or("bad data URL")?.1;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let out = dir.join(format!("edit_{stamp}.png"));
        std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn pick_images(app: AppHandle) -> Vec<String> {
    app.dialog()
        .file()
        .set_title("Choose reference photos")
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "bmp"])
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[derive(Serialize)]
struct OutputItem {
    path: String,
    meta: Option<serde_json::Value>,
}

#[tauri::command]
fn list_outputs(settings: State<'_, Settings>, limit: Option<usize>) -> Vec<OutputItem> {
    let dir = cfg(&settings).output_dir;
    let Ok(rd) = std::fs::read_dir(&dir) else { return vec![] };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")))
        .filter_map(|p| Some((p.metadata().ok()?.modified().ok()?, p)))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files
        .into_iter()
        .take(limit.unwrap_or(80))
        .map(|(_, p)| OutputItem {
            meta: std::fs::read(p.with_extension("json")).ok().and_then(|b| serde_json::from_slice(&b).ok()),
            path: p.to_string_lossy().into_owned(),
        })
        .collect()
}

#[tauri::command]
fn output_dir(settings: State<'_, Settings>) -> Result<String, String> {
    let dir = cfg(&settings).output_dir;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https links".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Engine::default())
        .manage(Settings(RwLock::new(Config::load())))
        .setup(|app| {
            // Let the UI show images from the output folder through asset://
            let out = app.state::<Settings>().0.read().unwrap().output_dir.clone();
            let _ = std::fs::create_dir_all(&out);
            let _ = app.asset_protocol_scope().allow_directory(&out, true);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            setup_status,
            setup_configure,
            setup_run,
            pick_folder,
            engine_start,
            engine_stop,
            generate,
            cancel,
            surprise_idea,
            gpu_stats,
            thumbnail,
            pick_images,
            allow_asset,
            read_image,
            save_edited,
            list_outputs,
            output_dir,
            reveal,
            open_path,
            open_url
        ])
        .build(tauri::generate_context!())
        .expect("could not start Qwen Image Local");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Engine>().stop();
        }
    });
}
