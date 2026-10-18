# Changelog

## 0.4.1 — 2026-10-19

- **Negative prompt and CFG.** A negative text box with three shortcut chips and a CFG field (1–10, with one-click 2.5 / back-to-1) sits directly under the description and the instruction, where the positive prompt is. It is off by default, because at CFG 1 — the official Qwen path — the model never reads the negative conditioning, and the field says exactly that in the warning shown the moment you type something with CFG still at 1. Raising CFG costs a second conditioning pass per step: measured on an RTX 4060, 20 steps at 1024² went from 1.6 s/step to 3.0 s/step. Same seed, same prompt, only the negative swapped: `warm colors, red, orange` came out cool (R−B +9.5), `cool colors, blue, cyan` came out amber (R−B +55.8), and 100% of pixels differed — while the same pair at CFG 1 was pixel-for-pixel the same scene.
- The same two fields go through every entry point: `qil generate --negative "…" --cfg 2.5`, the desktop panel, and `POST /api/generate` (both optional, so existing remote clients keep the CFG 1 path). The `.json` sidecar records `negative` and `cfg`, and the info line under the image shows `cfg 2.5 · −` when guidance was used.
- **A progress bar instead of a curtain.** The centered "working" card and the dimmed, greyed-out picture are gone. Generation now reports through a bar pinned to the top edge of the viewer — stage, `12/30` steps, seconds per step and what is left — which is click-through and never moves the image, so you can keep looking at the current picture, zoom it, or browse the history while the sampler runs.
- **Batch.** A 张数 picker next to the Generate button (1–10, remembered between runs) produces that many pictures per press with one press. With the seed locked they walk forward from it (`777, 778, 779…`) so a batch stays reproducible; unlocked, each one picks its own. The single bar spans the whole batch (`第 2/3 张`), the footer shows a rough total time once it has one run to go on, and 取消 stops the remaining pictures rather than just the one in flight. If you click an older thumbnail mid-batch, the rest still land in the history without stealing the view.
- **Reuse prompt.** Next to 复制提示词 there is now 复用提示词: it puts the selected picture's own prompt back into the description or instruction box, its negative back into the negative box, and its CFG along with them — a negative pasted in at CFG 1 would only be a field that silently does nothing. Pictures made before 0.4.1 carry no negative in their sidecar, so on those the negative box is left as it was rather than wiped. The notice says which box it landed in and what CFG came with it.

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
