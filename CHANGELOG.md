# Changelog

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
