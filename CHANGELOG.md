# Changelog

## 0.4.0 — 2026-10-14

- **Remote access.** The app now opens a LAN HTTP API on its own port (8199) as soon as it starts, so a phone or another PC can drive it: check the engine, start and stop it, read the history, fetch full images and thumbnails, upload reference photos, delete an output, change the model and speed, and run generations while polling for progress. A bearer token is generated on first launch and shown, with the addresses to type, in a new "Remote access" section of the panel. Everything is limited to the output folder — path checks resolve symlinks and `..` before comparing — and uploaded references have to decode as real images before the generator will accept them. See `GET /api/ping` for the endpoint list.
- **History right-click menu.** Right-click any thumbnail to open it, reveal it in Explorer, copy its prompt or delete it; deleting takes the `.json` sidecar with it and asks first.
- **Close confirmation.** The window's X button now asks before quitting, and says what is at stake — an unfinished generation, or the engine that stops with the app.
- **Prompt presets.** Save the description or instruction you just wrote under a name; presets are kept per mode, load with one click, and can be removed from the chip or its right-click menu.
- **Dev path overrides no longer reach the disk.** Running under `QIL_RUNTIME` / `QIL_MODELS` and then saving a setting used to write those throwaway paths into the real `config.json`, pointing the install at an empty folder. Only the paths you chose in the app are persisted now.


## 0.3.0 — 2026-10-11

- **Turbo speed tier.** Pick the distilled 8-step checkpoint instead of the 20–40-step standard one: about 3–4× faster sampling. It is orthogonal to the VRAM profile and the DiT choice, so you can run Turbo on Balanced or Compact; the Uncensored model doesn't have Turbo weights yet and falls back to the standard checkpoint. Selectable in the app (setup screen and main UI) and in the CLI (`qil setup --speed turbo`, `qil config --speed turbo`).
- **Markup editor for reference photos.** Draw, circle, box, arrow, erase or crop a photo before it goes into the model, with a 9-color palette plus custom colors, three brush widths, undo/redo (40 steps), whole-image 90° rotation and Ctrl+wheel zoom. Replaces the old rotate-only button. Edits are saved as new PNGs — your original files are never touched.
- **Click to zoom.** Reference photos and the main result open a full-size preview; clicking a reference shows the original file, not the 240 px thumbnail.
- Config now persists the speed choice the moment you pick it, like the other setup options.

## 0.2.0 — 2026-10-10

- **Compact profile verified on a real 8 GB card.** Tested on an RTX 5060 Laptop 8 GB: 7.2 GB peak VRAM (desktop included), runs well. The profile is no longer experimental; the app, CLI and docs now present 8 GB as the entry point.
- **Uncensored DiT option.** Switch the image model to the third-party int8 convrot build from the setup screen or the main UI; the encoder and VAE are shared, so only one ~6.8 GB file is added.
- **Simplified Chinese UI.** The app now ships in English, Spanish and Chinese, auto-picked from your system language.
- **Config persists immediately.** Changing profile, DiT or models folder on the setup screen saves to disk at once, even if you never press install.
- Reference photos: rotation and EXIF orientation are respected; `/history` polling until done makes long generations reliable.

## 0.1.0 — 2026-09-24

First public release, four days after Qwen-Image-2.1 came out.

- Desktop app (Windows): text-to-image, editing with up to 10 reference photos, "Surprise me", three quality presets, history, English/Spanish UI.
- First-run installer: detects the GPU and driver, checks disk space, installs a pinned ComfyUI, Python 3.12 and PyTorch CUDA 13, downloads the weights with resume and SHA-256 checks.
- `qil` CLI: `doctor`, `setup`, `generate`, `edit`, `surprise`, `bench`, `config`.
- VRAM profiles: balanced (12 GB+, tested) and compact (8–10 GB, experimental).
- Benchmark: 20 tests against gpt-image-2 with every image, prompt and timing published.
