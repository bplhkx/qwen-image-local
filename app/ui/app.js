// Qwen Image Local — UI logic. Plain JS with withGlobalTauri (no bundler).
(() => {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;
  const fileSrc = (p) => T.core.convertFileSrc(p);
  const $ = (id) => document.getElementById(id);
  const t = (...a) => window.i18n.t(...a);

  const MAX_REFS = 10;
  const QUICK = [
    ["qRemoveBg", "Remove the background, and output a PNG image"],
    ["qSnow", "Change the scene to a snowy winter night with warm lights in the windows. Keep everything else the same."],
    ["qWatercolor", "Turn this photo into a hand-painted watercolor illustration. Keep the composition."],
    ["qGolden", "Relight this photo as a golden-hour scene with soft warm sunlight. Keep the subject and composition identical."],
    ["qNoPeople", "Remove all the people from the photo and fill the background naturally. Keep everything else identical."],
    ["qCombine", "Place the subject from <image2> into the scene of <image1>, matching lighting and perspective, with a realistic contact shadow."],
  ];
  const STAGE_KEY = { upload: "stUpload", load: "stLoad", encode: "stEncode", sample: "stSample", decode: "stDecode", save: "stSave" };
  const PRESET_KEY = { draft: "pDraft", standard: "pStandard", max: "pMax" };

  const state = {
    mode: "text",
    preset: localGet("preset", "standard"),
    aspect: localGet("aspect", "1:1"),
    surpriseAspect: "random",
    refs: [],
    engine: "off",
    engineExternal: false,
    busy: false,
    current: null,
    history: [],
    lastIdea: null,
    stepTimes: [],
    setup: null, // SetupInfo from Rust
    installing: false,
    stepState: {}, // id -> {state, detail, done, total, bps}
    remote: null, // {enabled, port, token, urls[]} from Rust
  };

  function localGet(k, d) { try { return localStorage.getItem("qil." + k) ?? d; } catch { return d; } }
  function localSet(k, v) { try { localStorage.setItem("qil." + k, v); } catch { /* no storage */ } }
  const fmtBytes = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.round(b / 1048576) + " MB");
  const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`);

  // ═════════ Setup (first run) ═════════

  const STEP_LABEL = { uv: "stepUv", comfy: "stepComfy", python: "stepPython", deps: "stepDeps" };
  const DIT_LABEL = { official: "ditOfficial", uncensored: "ditUncensored" };
  const SPEED_LABEL = { base: "speedBase", turbo: "speedTurbo" };

  // Readiness is keyed per "dit:speed" combo (e.g. "official:turbo"). Combos with no
  // published weights (uncensored + turbo) are absent from the map → "unsupported".
  function comboSupported(ditId, speedId) {
    return (state.setup?.status?.ditReady || {})[`${ditId}:${speedId}`] !== undefined;
  }
  function comboReady(ditId, speedId) {
    return state.setup?.status?.ditReady?.[`${ditId}:${speedId}`] === true;
  }
  // Uncensored only ships base-tier weights, so its badge always follows the base combo.
  function speedForDit(ditId) {
    const cur = state.setup?.config.speed || "base";
    return ditId === "uncensored" ? "base" : cur;
  }
  function ditBadge(btn, ready) {
    const name = btn.querySelector(".p-name");
    let b = name.querySelector(".p-badge");
    if (!b) { b = document.createElement("span"); b.className = "p-badge"; name.appendChild(b); }
    b.textContent = ready ? t("ditInstalled") : t("ditMissing");
    b.classList.toggle("missing", !ready);
  }
  function unsupportedBadge(btn) {
    const name = btn.querySelector(".p-name");
    let b = name.querySelector(".p-badge");
    if (!b) { b = document.createElement("span"); b.className = "p-badge"; name.appendChild(b); }
    b.textContent = t("speedUnsupported");
    b.classList.remove("missing");
  }
  function renderDitGroup(rootId) {
    const cur = state.setup?.config.dit || "official";
    document.querySelectorAll(`#${rootId} [data-dit]`).forEach((btn) => {
      btn.setAttribute("aria-checked", String(btn.dataset.dit === cur));
      ditBadge(btn, comboReady(btn.dataset.dit, speedForDit(btn.dataset.dit)));
    });
  }
  function renderDitTags() {
    const dit = state.setup?.config.dit || "official";
    const speed = state.setup?.config.speed || "base";
    $("ditTag").textContent = speed === "turbo" ? `${dit} · turbo` : dit;
  }
  function renderDitMain() {
    const cur = state.setup?.config.dit || "official";
    document.querySelectorAll("#ditsMain [data-dit]").forEach((btn) => {
      btn.setAttribute("aria-checked", String(btn.dataset.dit === cur));
      ditBadge(btn, comboReady(btn.dataset.dit, speedForDit(btn.dataset.dit)));
    });
  }
  function renderSpeedGroup(rootId) {
    const curDit = state.setup?.config.dit || "official";
    const curSpeed = state.setup?.config.speed || "base";
    document.querySelectorAll(`#${rootId} [data-speed]`).forEach((btn) => {
      const id = btn.dataset.speed;
      btn.setAttribute("aria-checked", String(id === curSpeed));
      const supported = comboSupported(curDit, id);
      btn.disabled = !supported || state.installing;
      btn.title = supported ? "" : t("turboUnsupported");
      if (supported) ditBadge(btn, comboReady(curDit, id));
      else unsupportedBadge(btn);
    });
  }
  function backToSetup() {
    $("mainView").hidden = true;
    $("setupView").hidden = false;
  }

  async function loadSetup() {
    state.setup = await invoke("setup_status");
    renderSetup();
    return state.setup;
  }

  function renderSetup() {
    const s = state.setup;
    if (!s) return;
    const g = s.status.gpu;
    $("gpuCard").innerHTML = g
      ? `<strong>${g.name.replace("NVIDIA GeForce ", "")}</strong><span class="mono">${(g.totalMb / 1024).toFixed(1)} GB VRAM · ${t("driver")} ${g.driver}</span>`
      : `<strong>${t("noGpu")}</strong>`;
    const probs = s.status.problems;
    $("problems").hidden = !probs.length;
    $("problems").innerHTML = probs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");

    document.querySelectorAll("#profiles [data-profile]").forEach((b) =>
      b.setAttribute("aria-checked", String(b.dataset.profile === s.config.profile)));
    renderDitGroup("dits");
    renderSpeedGroup("speeds");
    renderDitTags();
    document.querySelectorAll("[data-rec]").forEach((el) => { el.hidden = el.dataset.rec !== s.recommended; });
    $("modelsDir").textContent = s.config.modelsDir;
    $("modelsDir").title = s.config.modelsDir;

    const dl = s.status.downloadBytes;
    const free = s.status.freeBytes;
    $("summary").textContent = (dl ? `${fmtBytes(dl)} ${t("toDownload")}` : t("nothingToDownload")) + (free != null ? ` · ${fmtBytes(free)} ${t("free")}` : "");

    const steps = $("steps");
    steps.innerHTML = "";
    for (const st of s.status.steps) {
      const live = state.stepState[st.id] || {};
      const isModel = st.id.startsWith("model:");
      const name = isModel ? st.id.slice(6) : t(STEP_LABEL[st.id] || st.id);
      let meta;
      let cls = "";
      if (live.state === "error") { meta = t("failed"); cls = "err"; }
      else if (live.state === "done" || live.state === "skipped" || (st.done && !live.state)) { meta = live.state === "skipped" || st.done ? t("skipped") : t("done"); cls = "ok"; }
      else if (live.state === "running") {
        cls = "pend";
        if (live.total) {
          const pct = Math.floor((live.done / live.total) * 100);
          meta = live.detail === "verifying checksum" ? `${t("verifying")} ${pct}%` : `${pct}% · ${fmtBytes(live.done)} / ${fmtBytes(live.total)}` + (live.bps ? ` · ${fmtBytes(live.bps)}/s` : "");
        } else meta = live.detail || "…";
      } else meta = st.downloadBytes ? fmtBytes(st.downloadBytes) : t("waiting");
      if (live.state === "done") { meta = t("done"); cls = "ok"; }
      const pct = live.state === "running" && live.total ? (live.done / live.total) * 100 : live.state === "done" || live.state === "skipped" || st.done ? 100 : 0;
      const row = document.createElement("div");
      row.className = "srow";
      row.innerHTML = `<span class="dot ${cls}"></span><span class="s-name mono">${escapeHtml(name)}</span><span class="s-meta mono">${escapeHtml(meta)}</span><span class="s-bar"><i style="width:${pct}%"></i></span>`;
      steps.appendChild(row);
    }
    const blocked = probs.some((p) => /NVIDIA|driver|disk|VRAM/i.test(p));
    const btn = $("installBtn");
    if (state.installing) { btn.textContent = t("installing"); btn.disabled = true; }
    else if (s.status.ready) { btn.textContent = t("startApp"); btn.disabled = false; }
    else { btn.textContent = state.failed ? t("retry") : t("install", dl ? fmtBytes(dl) : "0 MB"); btn.disabled = blocked; }
    document.querySelectorAll("#profiles button, #dits button, #modelsPick").forEach((b) => { b.disabled = state.installing; });
  }

  document.querySelectorAll("#profiles [data-profile]").forEach((b) =>
    b.addEventListener("click", async () => {
      await invoke("setup_configure", { profile: b.dataset.profile, dit: null, speed: null, modelsDir: null });
      loadSetup();
    }));
  document.querySelectorAll("#dits [data-dit]").forEach((b) =>
    b.addEventListener("click", async () => {
      // Uncensored ships base-tier weights only: switching to it drops turbo back to base.
      const speed = b.dataset.dit === "uncensored" ? "base" : null;
      await invoke("setup_configure", { profile: state.setup.config.profile, dit: b.dataset.dit, speed, modelsDir: null });
      loadSetup();
    }));
  document.querySelectorAll("#speeds [data-speed]").forEach((b) =>
    b.addEventListener("click", async () => {
      await invoke("setup_configure", { profile: state.setup.config.profile, dit: null, speed: b.dataset.speed, modelsDir: null });
      loadSetup();
    }));
  $("modelsPick").addEventListener("click", async () => {
    const dir = await invoke("pick_folder");
    if (!dir) return;
    await invoke("setup_configure", { profile: state.setup.config.profile, dit: null, speed: null, modelsDir: dir });
    loadSetup();
  });
  $("installBtn").addEventListener("click", async () => {
    if (state.setup?.status.ready) return enterApp();
    state.installing = true;
    state.failed = false;
    state.stepState = {};
    $("log").textContent = "";
    renderSetup();
    try { await invoke("setup_run"); } catch (e) { state.installing = false; notifySetup(String(e)); renderSetup(); }
  });

  function onSetupEvent(ev) {
    if (ev.kind === "step") {
      const cur = state.stepState[ev.id] || {};
      state.stepState[ev.id] = { ...cur, state: ev.state, detail: ev.detail };
      if (ev.detail === "verifying checksum") state.stepState[ev.id].total = 0;
      appendLog(`${ev.state === "done" ? "✓" : ev.state === "skipped" ? "·" : ev.state === "error" ? "✗" : "…"} ${ev.id} ${ev.detail || ""}`);
    } else if (ev.kind === "progress") {
      const cur = state.stepState[ev.id] || { state: "running" };
      state.stepState[ev.id] = { ...cur, done: ev.done, total: ev.total, bps: ev.bytesPerSec };
    } else if (ev.kind === "log") {
      appendLog(ev.line);
    }
    throttledRender();
  }
  let renderPending = false;
  function throttledRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; renderSetup(); });
  }
  function appendLog(line) {
    const log = $("log");
    log.textContent += line + "\n";
    if (log.textContent.length > 60000) log.textContent = log.textContent.slice(-40000);
    log.scrollTop = log.scrollHeight;
  }
  async function onSetupFinished(err) {
    state.installing = false;
    if (err) {
      state.failed = true;
      appendLog("✗ " + err);
      $("logBox").open = true;
      notifySetup(err);
    }
    await loadSetup();
  }
  function notifySetup(msg) {
    $("problems").hidden = false;
    $("problems").insertAdjacentHTML("afterbegin", `<p>${escapeHtml(msg)}</p>`);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

  // ═════════ Main app ═════════

  function enterApp() {
    $("setupView").hidden = true;
    $("mainView").hidden = false;
    ["engineStat", "engineBtn", "folderBtn"].forEach((id) => { $(id).hidden = false; });
    const p = state.setup?.config.profile === "compact" ? "w4a8" : "int8";
    $("profileTag").textContent = p;
    renderDitTags();
    renderDitMain();
    renderSpeedGroup("speedsMain");
    renderPresets();
    renderUserPresets();
    loadRemote();
    invoke("output_dir").then((d) => { $("outDirTxt").textContent = d; }).catch(() => {});
    loadHistory();
    startEngine();
  }

  // Mode
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
    document.querySelectorAll("[data-show]").forEach((el) => { el.hidden = !el.dataset.show.split(" ").includes(mode); });
    document.querySelectorAll("[data-only]").forEach((el) => { el.hidden = el.dataset.only !== mode; });
    renderModeHint();
    renderPresets();
    renderAspects();
    updateGenButton();
  }
  function renderModeHint() { $("modeHint").textContent = t({ text: "hintText", photos: "hintPhotos", surprise: "hintSurprise" }[state.mode]); }
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  // Quality
  function renderPresets() {
    const turbo = (state.setup?.config.speed || "base") === "turbo";
    document.querySelectorAll("#presets [data-preset]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.preset === state.preset));
      const meta = b.querySelector(".p-meta");
      meta.textContent = turbo ? meta.dataset.tt : state.mode === "photos" ? meta.dataset.e : meta.dataset.t;
    });
  }
  document.querySelectorAll("#presets [data-preset]").forEach((b) =>
    b.addEventListener("click", () => { state.preset = b.dataset.preset; localSet("preset", state.preset); renderPresets(); updateGenButton(); }));

  // Generation model (main view): switching to a model whose weights are missing
  // only warns and sends the user back to the installer — it never downloads on its own.
  document.querySelectorAll("#ditsMain [data-dit]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.dit;
      const curDit = state.setup?.config.dit || "official";
      if (id === curDit) return;
      // Uncensored ships base-tier weights only; official keeps the current speed.
      const speed = id === "uncensored" ? "base" : (state.setup?.config.speed || "base");
      if (!comboReady(id, speed)) {
        notify(t("ditNeedInstall", t(DIT_LABEL[id])));
        await invoke("setup_configure", { profile: state.setup.config.profile, dit: id, speed, modelsDir: null });
        await loadSetup();
        backToSetup();
        return;
      }
      await invoke("setup_configure", { profile: state.setup.config.profile, dit: id, speed, modelsDir: null });
      await loadSetup();
      renderDitTags();
      renderDitMain();
      renderSpeedGroup("speedsMain");
      renderPresets();
      notify(t("ditSwitched", t(DIT_LABEL[id])), true);
    }));

  // Sampling speed (main view): same rule as the model switch — warn and go back if not downloaded.
  document.querySelectorAll("#speedsMain [data-speed]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.speed;
      if (id === (state.setup?.config.speed || "base")) return;
      const curDit = state.setup?.config.dit || "official";
      if (!comboReady(curDit, id)) {
        notify(t("ditNeedInstall", t(SPEED_LABEL[id])));
        await invoke("setup_configure", { profile: state.setup.config.profile, dit: null, speed: id, modelsDir: null });
        await loadSetup();
        backToSetup();
        return;
      }
      await invoke("setup_configure", { profile: state.setup.config.profile, dit: null, speed: id, modelsDir: null });
      await loadSetup();
      renderDitTags();
      renderDitMain();
      renderSpeedGroup("speedsMain");
      renderPresets();
      notify(t("ditSwitched", t(SPEED_LABEL[id])), true);
    }));

  // Format
  function renderAspects() {
    const a = state.mode === "surprise" ? state.surpriseAspect : state.aspect;
    document.querySelectorAll("#aspects [data-ar]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ar === a)));
  }
  document.querySelectorAll("#aspects [data-ar]").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.mode === "surprise") state.surpriseAspect = b.dataset.ar;
      else { state.aspect = b.dataset.ar; localSet("aspect", state.aspect); }
      renderAspects();
    }));

  // Seed
  $("seedLock").addEventListener("change", (e) => {
    $("seed").disabled = !e.target.checked;
    if (e.target.checked && !$("seed").value && state.current?.meta?.seed != null) $("seed").value = state.current.meta.seed;
    if (e.target.checked) $("seed").focus();
  });
  $("seed").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 15); });

  // Guidance (negative prompt + CFG). CFG 1.0 is the model's official path: the negative
  // conditioning is computed but never used, so we say so instead of pretending otherwise.
  const NEG_QUICK = [
    ["negqQuality", "low quality, blurry, jpeg artifacts, watermark, text, extra fingers, deformed hands"],
    ["negqPaint", "photo, realistic, photograph, 3d render, plastic skin"],
    ["negqText", "letters, captions, subtitles, logo, signature, frame, border"],
  ];
  const isTurbo = () => (state.setup?.config?.speed || "base") === "turbo";
  function cfgValue() {
    const v = parseFloat($("cfg").value);
    return Number.isFinite(v) ? Math.min(10, Math.max(1, v)) : 1.0;
  }
  function renderGuidance() {
    const cfg = cfgValue(), neg = $("negative").value.trim(), on = cfg > 1.0001;
    const badge = $("advState");
    badge.textContent = on ? `CFG ${cfg}` : t("advOff");
    badge.classList.toggle("on", on);
    const note = $("cfgNote");
    const warn = (on && !neg) || (!on && !!neg);
    note.classList.toggle("warn", warn);
    note.textContent = !on && neg ? t("negInert")
      : on && !neg ? t("cfgNoNeg")
      : on && isTurbo() ? t("cfgTurbo")
      : on ? t("cfgOn") : t("cfgDefault");
  }
  function saveGuidance() { localSet("cfg", String(cfgValue())); localSet("negative", $("negative").value); }
  $("cfg").addEventListener("input", () => { renderGuidance(); saveGuidance(); });
  $("cfg").addEventListener("blur", () => { $("cfg").value = String(cfgValue()); saveGuidance(); });
  $("negative").addEventListener("input", () => { renderGuidance(); saveGuidance(); });
  $("cfg25").addEventListener("click", () => { $("cfg").value = "2.5"; renderGuidance(); saveGuidance(); $("advBox").open = true; });
  $("cfg10").addEventListener("click", () => { $("cfg").value = "1"; renderGuidance(); saveGuidance(); });
  $("advBox").addEventListener("toggle", (e) => localSet("advOpen", e.target.open ? "1" : "0"));
  function renderNegQuick() {
    const box = $("negQuick");
    box.innerHTML = "";
    for (const [key, text] of NEG_QUICK) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-xs";
      b.textContent = t(key);
      b.title = text;
      b.addEventListener("click", () => {
        const cur = $("negative").value.trim();
        $("negative").value = cur && !cur.endsWith(",") ? `${cur}, ${text}` : (cur ? `${cur} ${text}` : text);
        renderGuidance(); saveGuidance();
      });
      box.appendChild(b);
    }
  }
  function initGuidance() {
    $("cfg").value = localGet("cfg", "1");
    $("negative").value = localGet("negative", "");
    $("advBox").open = localGet("advOpen", "0") === "1";
    renderNegQuick();
    renderGuidance();
  }

  // References
  async function addRefs(paths) {
    const room = MAX_REFS - state.refs.length;
    const fresh = paths.filter((p) => /\.(png|jpe?g|webp|bmp)$/i.test(p) && !state.refs.some((r) => r.path === p || r.orig === p));
    if (fresh.length > room) notify(t("limitRefs", room, fresh.length, MAX_REFS));
    for (const path of fresh.slice(0, room)) {
      const ref = { path, thumb: "" };
      state.refs.push(ref);
      renderRefs();
      invoke("allow_asset", { path }).catch(() => {});
      try { ref.thumb = await invoke("thumbnail", { path, size: 240 }); } catch (e) { notify(String(e)); }
      renderRefs();
    }
    updateGenButton();
  }
  // Opens the annotation editor; saving swaps the reference to the edited copy.
  function editRef(ref) {
    window.qilEditor.open({
      path: ref.path,
      notify,
      onSave: async (path) => {
        ref.orig ??= ref.path;
        ref.path = path;
        invoke("allow_asset", { path }).catch(() => {});
        ref.thumb = await invoke("thumbnail", { path, size: 240 }).catch(() => "");
        renderRefs();
        updateGenButton();
      },
    });
  }
  function renderRefs() {
    const box = $("refs");
    box.innerHTML = "";
    box.classList.toggle("empty", state.refs.length === 0);
    state.refs.forEach((r, i) => {
      const el = document.createElement("div");
      el.className = "ref" + (i === 0 ? " canvas" : "");
      el.title = (i === 0 ? t("canvas") + " · " : "") + r.path;
      el.innerHTML = `${r.thumb ? `<img src="${r.thumb}" alt="">` : ""}<span class="n">${i + 1}</span><button type="button" class="rot" aria-label="${t("edit")}" title="${t("edit")}">✎</button><button type="button" class="x" aria-label="${t("remove")}">×</button>`;
      el.querySelector(".x").addEventListener("click", () => { state.refs.splice(i, 1); renderRefs(); updateGenButton(); });
      el.querySelector(".rot").addEventListener("click", (e) => { e.stopPropagation(); editRef(r); });
      el.addEventListener("click", (e) => { if (!e.target.closest("button")) openZoom(fileSrc(r.path)); });
      box.appendChild(el);
    });
    if (state.refs.length < MAX_REFS) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "ref-add";
      add.innerHTML = `<b>+</b>${state.refs.length ? t("add") : t("dropOrClick")}`;
      add.addEventListener("click", async () => addRefs(await invoke("pick_images")));
      box.appendChild(add);
    }
    $("refCount").textContent = `${state.refs.length} / ${MAX_REFS}`;
  }
  function renderQuick() {
    const q = $("quick");
    q.innerHTML = "";
    for (const [key, prompt] of QUICK) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-xs";
      b.textContent = t(key);
      b.addEventListener("click", () => { $("promptPhotos").value = prompt; updateGenButton(); });
      q.appendChild(b);
    }
  }

  // Generate button: the label says what will happen
  function currentPrompt() {
    if (state.mode === "text") return $("promptText").value.trim();
    if (state.mode === "photos") return $("promptPhotos").value.trim();
    return "surprise";
  }
  function updateGenButton() {
    const btn = $("genBtn");
    let label = t("gen");
    let ok = true;
    if (state.busy) { label = t("generating"); ok = false; }
    else if (state.engine === "starting") { label = t("starting"); ok = false; }
    else if (state.engine !== "ready") { label = t("engineOffBtn"); ok = false; }
    else if (state.mode === "photos" && state.refs.length === 0) { label = t("needPhoto"); ok = false; }
    else if (!currentPrompt()) { label = state.mode === "photos" ? t("needInstr") : t("needDesc"); ok = false; }
    else if (state.mode === "surprise") label = t("genSurprise");
    else if (state.mode === "photos") label = state.refs.length > 1 ? t("genWith", state.refs.length) : t("genEdit");
    btn.textContent = label;
    btn.disabled = !ok;
    $("cancelBtn").hidden = !state.busy;
  }
  ["promptText", "promptPhotos"].forEach((id) => $(id).addEventListener("input", updateGenButton));

  // Engine
  function renderEngine(ev) {
    if (ev) { state.engine = ev.state; state.engineExternal = !!ev.external; state.engineDetail = ev.detail || ""; }
    $("engineDot").className = "dot " + ({ ready: "ok", starting: "pend", error: "err" }[state.engine] || "");
    $("engineTxt").textContent = t({
      ready: state.engineExternal ? "engineReadyExt" : "engineReady",
      starting: "engineStarting", error: "engineError", off: "engineOff",
    }[state.engine] || "engineOff");
    $("engineStat").title = state.engineDetail || "";
    const eb = $("engineBtn");
    eb.textContent = state.engine === "ready" ? t("stopEngine") : state.engine === "starting" ? t("starting") : t("startEngine");
    eb.disabled = state.engine === "starting" || (state.engine === "ready" && state.engineExternal) || state.busy;
    eb.title = state.engine === "ready" && state.engineExternal ? t("externalTip") : "";
    if (ev && ev.state === "error" && ev.detail) notify(ev.detail);
    updateGenButton();
  }
  async function startEngine() {
    renderEngine({ state: "starting", detail: "" });
    try { await invoke("engine_start"); } catch (e) { renderEngine({ state: "error", detail: String(e) }); }
  }
  $("engineBtn").addEventListener("click", async () => {
    if (state.engine === "ready") await invoke("engine_stop");
    else startEngine();
  });

  // GPU meter
  async function pollGpu() {
    const g = await invoke("gpu_stats").catch(() => null);
    if (!g) { $("gpuStat").hidden = true; return; }
    $("gpuName").textContent = g.name.replace("NVIDIA GeForce ", "").replace("NVIDIA ", "");
    const pct = Math.round((g.usedMb / g.totalMb) * 100);
    $("vramFill").style.width = pct + "%";
    $("vramFill").classList.toggle("high", pct > 92);
    $("vramTxt").textContent = `${(g.usedMb / 1024).toFixed(1)} / ${(g.totalMb / 1024).toFixed(1)} GB`;
    $("gpuStat").title = `VRAM ${pct}% · GPU ${g.util}%`;
  }

  // Generate
  async function generate() {
    if ($("genBtn").disabled) return;
    let prompt = currentPrompt();
    let aspect = state.aspect;
    if (state.mode === "surprise") {
      const idea = await invoke("surprise_idea", { theme: $("theme").value || null });
      prompt = idea.prompt;
      aspect = state.surpriseAspect === "random" ? idea.aspect : state.surpriseAspect;
      state.lastIdea = prompt;
      $("idea").hidden = false;
      $("ideaTxt").textContent = prompt;
    }
    const seed = $("seedLock").checked && $("seed").value ? Number($("seed").value) : null;
    const req = {
      mode: state.mode,
      prompt,
      images: state.mode === "photos" ? state.refs.map((r) => r.path) : [],
      preset: state.preset,
      aspect,
      seed,
      transparent: state.mode === "text" && $("transparent").checked,
      negative: $("negative").value.trim(),
      cfg: cfgValue(),
    };
    state.busy = true;
    state.stepTimes = [];
    hideNotice();
    showWorking("load", 0, 0);
    updateGenButton();
    renderEngine();
    try {
      const r = await invoke("generate", { req });
      const item = { path: r.path, meta: { ...req, seed: r.seed, width: r.width, height: r.height, seconds: r.seconds, references: req.images } };
      state.history.unshift(item);
      showImage(item);
      renderHistory();
    } catch (e) {
      const msg = String(e);
      if (msg === "Cancelled") notify(t("cancelled"), true); else notify(msg);
    } finally {
      state.busy = false;
      hideWorking();
      updateGenButton();
      renderEngine();
    }
  }
  $("genBtn").addEventListener("click", generate);
  $("cancelBtn").addEventListener("click", () => { $("cancelBtn").disabled = true; invoke("cancel"); });

  function showWorking(stage, value, max) {
    $("working").hidden = false;
    $("shot").classList.add("dim");
    $("empty").hidden = true;
    $("wStage").textContent = t(STAGE_KEY[stage] || "stSample");
    const bar = $("progress");
    bar.classList.add("visible");
    if (stage === "sample" && max > 0) {
      bar.classList.remove("indeterminate");
      $("progressFill").style.width = Math.round((value / max) * 100) + "%";
      state.stepTimes.push(performance.now());
      const ts = state.stepTimes.slice(-6);
      const spi = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / (ts.length - 1) / 1000 : 0;
      const left = spi ? Math.max(0, Math.round((max - value) * spi)) : null;
      $("wStep").textContent = t("step", value, max) + (spi ? ` · ${spi.toFixed(1)} ${t("perStep")} · ${fmtSecs(left)} ${t("left")}` : "");
    } else {
      bar.classList.add("indeterminate");
      $("progressFill").style.width = "";
      $("wStep").textContent = stage === "load" ? t("firstSlow") : "";
    }
  }
  function hideWorking() {
    $("working").hidden = true;
    $("shot").classList.remove("dim");
    $("progress").classList.remove("visible", "indeterminate");
    $("progressFill").style.width = "0";
    $("cancelBtn").disabled = false;
    if ($("shot").hidden) $("empty").hidden = false;
  }

  // Viewer and history
  function showImage(item) {
    state.current = item;
    const img = $("shot");
    img.src = fileSrc(item.path);
    img.hidden = false;
    $("empty").hidden = true;
    const m = item.meta || {};
    $("info").hidden = false;
    $("infoPrompt").textContent = m.prompt || item.path.split(/[\\/]/).pop();
    $("infoPrompt").title = m.prompt || "";
    const parts = [];
    if (m.width) parts.push(`${m.width}×${m.height}`);
    if (m.seed != null) parts.push(`seed ${m.seed}`);
    if (m.preset) parts.push(t(PRESET_KEY[m.preset] || m.preset));
    if (m.cfg && m.cfg !== 1) parts.push(`cfg ${m.cfg}${m.negative ? " · −" : ""}`);
    if (m.seconds) parts.push(fmtSecs(Math.round(m.seconds)));
    if (m.mode === "photos" && m.references?.length) parts.push(`${m.references.length} ${t("refs")}`);
    $("infoMeta").textContent = parts.join(" · ");
    $("aSeed").disabled = m.seed == null;
    $("aCopy").disabled = !m.prompt;
    document.querySelectorAll(".hist").forEach((h) => h.setAttribute("aria-current", String(h.dataset.path === item.path)));
  }
  function renderHistory() {
    const strip = $("history");
    strip.innerHTML = "";
    strip.dataset.empty = t("historyEmpty");
    state.history.slice(0, 60).forEach((item) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hist";
      b.dataset.path = item.path;
      b.title = item.meta?.prompt || "";
      b.setAttribute("aria-current", String(state.current?.path === item.path));
      b.innerHTML = `<img loading="lazy" decoding="async" src="${fileSrc(item.path)}" alt="">`;
      b.addEventListener("click", () => showImage(item));
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showImage(item);
        historyMenu(e, item);
      });
      strip.appendChild(b);
    });
    $("histCount").textContent = String(state.history.length);
  }
  async function loadHistory() {
    try {
      state.history = await invoke("list_outputs", { limit: 60 });
      renderHistory();
      if (state.history[0]) showImage(state.history[0]);
    } catch (e) { notify(String(e)); }
  }

  $("aCopy").addEventListener("click", () => copyText(state.current?.meta?.prompt));
  $("aSeed").addEventListener("click", () => {
    const s = state.current?.meta?.seed;
    if (s == null) return;
    $("seedLock").checked = true;
    $("seed").disabled = false;
    $("seed").value = s;
  });
  $("aEdit").addEventListener("click", async () => {
    if (!state.current) return;
    setMode("photos");
    state.refs = state.refs.filter((r) => r.path !== state.current.path);
    state.refs.unshift({ path: state.current.path, thumb: "" });
    state.refs = state.refs.slice(0, MAX_REFS);
    renderRefs();
    state.refs[0].thumb = await invoke("thumbnail", { path: state.refs[0].path, size: 240 }).catch(() => "");
    renderRefs();
    $("promptPhotos").focus();
    updateGenButton();
  });
  $("aReveal").addEventListener("click", () => state.current && invoke("reveal", { path: state.current.path }));
  $("aOpen").addEventListener("click", () => state.current && invoke("open_path", { path: state.current.path }));
  $("folderBtn").addEventListener("click", async () => invoke("open_path", { path: await invoke("output_dir") }));
  $("ideaToText").addEventListener("click", () => {
    if (!state.lastIdea) return;
    $("promptText").value = state.lastIdea;
    setMode("text");
  });

  // ═════════ Overlays: one modal, one right-click menu ═════════

  const baseName = (p) => String(p).split(/[\\/]/).pop();
  // Commands that only report failures; nothing to do with the value they return.
  const fire = (p) => Promise.resolve(p).catch((e) => notify(String(e)));
  async function copyText(text) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); notify(t("copied"), true); } catch { notify(t("copyFail")); }
  }

  let modalCancel = null;
  function openModal({ title, body, actions }) {
    $("modalTitle").textContent = title || "";
    const box = $("modalBody");
    box.innerHTML = "";
    if (body instanceof Node) box.appendChild(body);
    else if (body) {
      const p = document.createElement("p");
      p.className = "modal-text";
      p.textContent = body;
      box.appendChild(p);
    }
    const bar = $("modalActions");
    bar.innerHTML = "";
    modalCancel = null;
    for (const a of actions) {
      if (a.cancel) modalCancel = a.run || null;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm" + (a.primary ? " btn-primary" : "");
      b.textContent = a.label;
      b.addEventListener("click", () => { if (a.run && a.run() === false) return; closeModal(); });
      bar.appendChild(b);
    }
    // Enter in a text field presses the primary button.
    const input = box.querySelector("input");
    if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bar.querySelector(".btn-primary")?.click(); } });
    $("modal").hidden = false;
    (input || bar.querySelector(".btn:not(.btn-primary)") || bar.lastChild)?.focus();
  }
  function closeModal() { $("modal").hidden = true; modalCancel = null; }
  function cancelModal() { const f = modalCancel; closeModal(); if (f) f(); }
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) cancelModal(); });

  // The window's X button: Rust blocks the close and asks us here instead.
  function askQuit(busy) {
    const lines = [t("quitBody")];
    if (busy) lines.push(t("quitBusy"));
    else if (state.engine === "ready" || state.engine === "starting") lines.push(t("quitEngine"));
    // One line per situation, so the warning never reads as a run-on sentence in CJK.
    const body = document.createElement("div");
    body.className = "modal-form";
    for (const line of lines) {
      const p = document.createElement("p");
      p.className = "modal-text";
      p.textContent = line;
      body.appendChild(p);
    }
    openModal({
      title: t("quitTitle"),
      body,
      actions: [
        { label: t("stay"), cancel: true },
        { label: t("quit"), primary: true, run: () => fire(invoke("app_exit")) },
      ],
    });
  }

  function showMenu(x, y, items) {
    const m = $("ctxmenu");
    m.innerHTML = "";
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      if (it.danger) b.className = "danger";
      b.addEventListener("click", () => { hideMenu(); it.run(); });
      m.appendChild(b);
    }
    m.hidden = false;
    // The history strip sits against the bottom edge: keep the menu inside the window.
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + "px";
    m.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + "px";
  }
  function hideMenu() { $("ctxmenu").hidden = true; }
  document.addEventListener("click", hideMenu);
  window.addEventListener("blur", hideMenu);
  document.addEventListener("contextmenu", (e) => { if (!e.target.closest(".hist, .chip")) hideMenu(); });

  // ── History: right-click for the actions the info bar has, plus delete ──
  function historyMenu(e, item) {
    const path = item.path;
    showMenu(e.clientX, e.clientY, [
      { label: t("menuView"), run: () => openZoom(fileSrc(path)) },
      { label: t("open"), run: () => fire(invoke("open_path", { path })) },
      { label: t("showInFolder"), run: () => fire(invoke("reveal", { path })) },
      { label: t("copyPrompt"), run: () => copyText(item.meta?.prompt) },
      { label: t("menuDelete"), danger: true, run: () => confirmDelete(item) },
    ]);
  }
  function confirmDelete(item) {
    const name = baseName(item.path);
    openModal({
      title: t("deleteTitle"),
      body: t("deleteBody", name),
      actions: [
        { label: t("cancel"), cancel: true },
        {
          label: t("menuDelete"),
          primary: true,
          run: () => {
            invoke("delete_output", { path: item.path })
              .then(() => { dropFromHistory(item); notify(t("deleted", name)); })
              .catch((e) => { notify(String(e)); loadHistory(); });
          },
        },
      ],
    });
  }
  function dropFromHistory(item) {
    const i = state.history.indexOf(item);
    if (i >= 0) state.history.splice(i, 1);
    if (state.current?.path === item.path) {
      state.current = null;
      const next = state.history[0];
      if (next) { renderHistory(); showImage(next); return; }
      $("shot").hidden = true;
      $("info").hidden = true;
      if (!state.busy) $("empty").hidden = false;
    }
    renderHistory();
  }

  // ═════════ Remote access ═════════

  async function loadRemote() {
    try {
      state.remote = await invoke("remote_info");
      renderRemote();
    } catch (e) {
      remoteNote(String(e));
    }
  }
  function remoteNote(msg) {
    $("remoteNote").hidden = false;
    $("remoteNote").textContent = msg;
  }
  function renderRemote() {
    const r = state.remote;
    if (!r) return;
    $("remoteOn").checked = !!r.enabled;
    // Prefer the LAN address; 127.0.0.1 is only useful for testing on the PC itself.
    const url = (r.urls || []).find((u) => !u.includes("127.0.0.1")) || (r.urls || [])[0] || "";
    $("remoteUrl").textContent = url;
    $("remoteUrl").title = url;
    $("remoteToken").textContent = r.token || "—";
    remoteNote(r.enabled ? t("remoteLive", r.port) : t("remoteOffNote"));
  }
  async function saveRemote(patch) {
    try {
      state.remote = await invoke("remote_configure", patch);
      renderRemote();
      notify(t("remoteSaved"), true);
    } catch (e) {
      remoteNote(String(e));
    }
  }
  $("remoteOn").addEventListener("change", (e) => saveRemote({ enabled: e.target.checked }));
  $("remoteCopyUrl").addEventListener("click", () => copyText($("remoteUrl").textContent));
  $("remoteCopyToken").addEventListener("click", () => copyText($("remoteToken").textContent));
  $("remoteNew").addEventListener("click", () => saveRemote({ regenerate: true }));

  // ═════════ Prompt presets ═════════

  const promptEl = (mode) => $(mode === "photos" ? "promptPhotos" : "promptText");
  const presetBox = (mode) => $(mode === "photos" ? "userPhotos" : "userText");
  function presetsOf(mode) {
    try {
      const v = JSON.parse(localGet("presets." + mode, "[]"));
      return Array.isArray(v) ? v.filter((p) => p && p.name && p.prompt) : [];
    } catch { return []; }
  }
  function setPresets(mode, list) { localSet("presets." + mode, JSON.stringify(list.slice(0, 40))); }
  // The first idea in the prompt, short enough to read as a chip. CJK has no spaces,
  // so cut by code point rather than by word.
  const stripEdges = (s) => s.replace(/^["'“‘「《]+|["'”’」》,.;：。…\s]+$/g, "").trim();
  function suggestName(prompt) {
    const clean = prompt.replace(/\s+/g, " ").trim();
    const chars = [...clean];
    if (chars.length <= 18) return stripEdges(clean) || clean.slice(0, 18);
    let head = chars.slice(0, 18).join("");
    const sp = head.lastIndexOf(" ");
    if (sp > 8) head = head.slice(0, sp); // break a Latin word instead of slicing through it
    return stripEdges(head) + "…";
  }
  function renderUserPresets() {
    for (const mode of ["text", "photos"]) {
      const box = presetBox(mode);
      const list = presetsOf(mode);
      box.hidden = list.length === 0;
      box.innerHTML = "";
      for (const p of list) {
        const chip = document.createElement("span");
        chip.className = "chip";
        const name = document.createElement("button");
        name.type = "button";
        name.className = "chip-name";
        name.textContent = p.name;
        name.title = p.prompt;
        name.addEventListener("click", () => { promptEl(mode).value = p.prompt; updateGenButton(); promptEl(mode).focus(); });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "chip-x";
        del.textContent = "×";
        del.title = t("presetDel");
        del.setAttribute("aria-label", t("presetDel"));
        del.addEventListener("click", () => removePreset(mode, p));
        chip.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, [
            { label: t("presetUse"), run: () => { promptEl(mode).value = p.prompt; updateGenButton(); promptEl(mode).focus(); } },
            { label: t("copyPrompt"), run: () => copyText(p.prompt) },
            { label: t("presetDel"), danger: true, run: () => removePreset(mode, p) },
          ]);
        });
        chip.append(name, del);
        box.appendChild(chip);
      }
    }
  }
  function removePreset(mode, p) {
    // presetsOf() re-parses on every call, so identity never matches — compare by value.
    setPresets(mode, presetsOf(mode).filter((x) => !(x.name === p.name && x.prompt === p.prompt)));
    renderUserPresets();
  }
  function savePresetFlow(mode) {
    const prompt = promptEl(mode).value.trim();
    if (!prompt) return notify(t("presetEmpty"));
    const list = presetsOf(mode);
    if (list.some((x) => x.prompt === prompt)) return notify(t("presetDup", list.find((x) => x.prompt === prompt).name));
    const input = document.createElement("input");
    input.type = "text";
    input.className = "modal-input";
    input.placeholder = t("presetName");
    input.value = suggestName(prompt);
    const preview = document.createElement("p");
    preview.className = "modal-text muted";
    preview.textContent = prompt.length > 160 ? prompt.slice(0, 160) + "…" : prompt;
    const body = document.createElement("div");
    body.className = "modal-form";
    body.append(input, preview);
    openModal({
      title: t("presetTitle"),
      body,
      actions: [
        { label: t("cancel"), cancel: true },
        {
          label: t("presetOk"),
          primary: true,
          run: () => {
            const name = input.value.trim();
            if (!name) { notify(t("presetNeedName")); return false; }
            if (list.some((x) => x.name === name)) { notify(t("presetExists", name)); return false; }
            setPresets(mode, [{ name, prompt }, ...list]);
            renderUserPresets();
            notify(t("presetSaved", name), true);
          },
        },
      ],
    });
    input.select();
  }

  $("saveText").addEventListener("click", () => savePresetFlow("text"));
  $("savePhotos").addEventListener("click", () => savePresetFlow("photos"));

  // Zoom — one fullscreen overlay for the result and the reference photos alike.
  function openZoom(src) {
    if (state.busy) return;
    if (document.querySelector(".zoom")) return;
    const z = document.createElement("div");
    z.className = "zoom";
    z.innerHTML = `<img src="${src}" alt="">`;
    z.addEventListener("click", () => z.remove());
    document.body.appendChild(z);
  }
  $("shot").addEventListener("click", () => state.current && openZoom(fileSrc(state.current.path)));

  // Notices
  function notify(msg, ok = false) {
    $("noticeTxt").textContent = msg;
    $("notice").classList.toggle("ok", ok);
    $("notice").hidden = false;
    if (ok) setTimeout(hideNotice, 2600);
  }
  function hideNotice() { $("notice").hidden = true; }
  $("noticeClose").addEventListener("click", hideNotice);

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !$("mainView").hidden) { e.preventDefault(); generate(); }
    if (e.key === "Escape") {
      // Topmost overlay first: menu, then dialog, then zoom, then the generation.
      if (!$("ctxmenu").hidden) { hideMenu(); return; }
      if (!$("modal").hidden) { cancelModal(); return; }
      const z = document.querySelector(".zoom");
      if (z) z.remove();
      else if (state.busy) invoke("cancel");
    }
  });

  // Language
  document.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => window.i18n.set(b.dataset.lang)));
  window.addEventListener("langchange", () => {
    renderModeHint();
    renderQuick();
    renderNegQuick();
    renderGuidance();
    renderRefs();
    renderHistory();
    renderEngine();
    renderSetup();
    renderUserPresets();
    renderDitTags();
    renderDitMain();
    renderSpeedGroup("speeds");
    renderSpeedGroup("speedsMain");
    if (state.current) showImage(state.current);
  });

  // Tauri events (drag & drop events carry real file paths)
  async function wireEvents() {
    try {
      await listen("engine", (e) => renderEngine(e.payload));
      await listen("gen-progress", (e) => { if (state.busy) showWorking(e.payload.stage, e.payload.value, e.payload.max); });
      await listen("setup", (e) => onSetupEvent(e.payload));
      await listen("setup-finished", (e) => onSetupFinished(e.payload));
      await listen("close-requested", (e) => askQuit(!!e.payload?.busy));
      await listen("tauri://drag-enter", () => { if (!$("mainView").hidden) $("dropveil").hidden = false; });
      await listen("tauri://drag-leave", () => { $("dropveil").hidden = true; });
      await listen("tauri://drag-drop", (e) => {
        $("dropveil").hidden = true;
        const paths = e.payload?.paths || [];
        if (!paths.length || $("mainView").hidden) return;
        if (state.mode !== "photos") setMode("photos");
        addRefs(paths);
      });
    } catch (e) {
      notify(t("eventsFail") + e);
    }
  }

  // Boot
  (async () => {
    window.i18n.apply();
    setMode("text");
    renderQuick();
    renderUserPresets();
    renderRefs();
    await wireEvents();
    initGuidance();
    pollGpu();
    setInterval(pollGpu, 2500);
    const s = await loadSetup().catch((e) => { notifySetup(String(e)); return null; });
    if (s && s.status.ready && s.configured) enterApp();
    else $("setupView").hidden = false;
  })();
})();
