// Image editor overlay — annotations painted on the RGB layer, which is exactly how
// Qwen-Image-2.1 takes local edits (colored circles / brush marks on the reference image).
// Uses vendored Fabric.js 5 (UMD global `fabric`). Plain JS, no bundler.
(() => {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const t = (...a) => window.i18n.t(...a);
  const $ = (id) => document.getElementById(id);

  const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#007aff", "#af52de", "#ffffff", "#111111"];
  const WIDTHS = [4, 8, 16];

  let canvas = null, baseImage = null, scale = 1;
  let tool = "brush", color = COLORS[0], width = WIDTHS[1];
  let crop = null, drawing = null, origin = null;
  let notify = () => {}, onSave = () => {};
  let history = [], hIndex = -1;

  // ── open / close ──
  async function open(opts) {
    notify = opts.notify || (() => {});
    onSave = opts.onSave || (() => {});
    $("editor").hidden = false;
    try {
      const dataUrl = await invoke("read_image", { path: opts.path });
      await buildCanvas(dataUrl);
    } catch (e) {
      close();
      notify(String(e));
    }
  }

  function close() {
    $("editor").hidden = true;
    if (canvas) { canvas.dispose(); canvas = null; }
    baseImage = null; history = []; hIndex = -1; crop = null; drawing = null; origin = null;
  }

  function buildCanvas(dataUrl) {
    return new Promise((resolve, reject) => {
      const wrap = $("edWrap");
      const availW = Math.max(120, wrap.clientWidth - 24);
      const availH = Math.max(120, wrap.clientHeight - 24);
      fabric.Image.fromURL(dataUrl, (img, isBroken) => {
        if (isBroken || !img.width || !img.height) { reject(new Error(t("edLoadFail"))); return; }
        scale = Math.min(availW / img.width, availH / img.height, 1);
        if (canvas) canvas.dispose();
        canvas = new fabric.Canvas("edCanvas", { preserveObjectStacking: true });
        canvas.setWidth(Math.round(img.width * scale));
        canvas.setHeight(Math.round(img.height * scale));
        img.set({ left: 0, top: 0, scaleX: scale, scaleY: scale, selectable: false, evented: false });
        baseImage = img;
        canvas.add(baseImage);
        crop = null; history = []; hIndex = -1;
        canvas.on("mouse:down", onDown);
        canvas.on("mouse:move", onMove);
        canvas.on("mouse:up", onUp);
        canvas.on("path:created", (o) => { o.path.selectable = false; push(); });
        canvas.on("object:modified", push);
        wireZoom();
        setTool("brush");
        syncPalette();
        push();
        resolve();
      }, { crossOrigin: "anonymous" });
    });
  }

  // ── history: annotations only; the base image transform is stored separately ──
  function snap() {
    return {
      ann: canvas.getObjects().filter((o) => o !== baseImage && !o.qilGuide).map((o) => o.toJSON()),
      base: { angle: baseImage.angle, left: baseImage.left, top: baseImage.top, scaleX: baseImage.scaleX, scaleY: baseImage.scaleY },
      w: canvas.getWidth(), h: canvas.getHeight(), crop,
    };
  }
  // The crop guide lives on the canvas so the user can see the region, but it is
  // never exported and never part of the annotation history.
  function syncGuide() {
    canvas.getObjects().filter((o) => o.qilGuide).forEach((o) => canvas.remove(o));
    if (crop) {
      const g = new fabric.Rect({ left: crop.left, top: crop.top, width: crop.width, height: crop.height, fill: "rgba(255,255,255,0.10)", stroke: "#fff", strokeWidth: 1.5, strokeDashArray: [6, 4], selectable: false, evented: false });
      g.qilGuide = true;
      canvas.add(g);
    }
    canvas.requestRenderAll();
  }
  function push() {
    history = history.slice(0, hIndex + 1);
    history.push(snap());
    if (history.length > 40) history.shift();
    hIndex = history.length - 1;
    updateActions();
  }
  function apply(entry) {
    canvas.getObjects().filter((o) => o !== baseImage).forEach((o) => canvas.remove(o));
    baseImage.set(entry.base);
    canvas.setWidth(entry.w);
    canvas.setHeight(entry.h);
    crop = entry.crop;
    fabric.util.enlivenObjects(entry.ann, (objs) => {
      objs.forEach((o) => { o.selectable = tool === "select"; canvas.add(o); });
      syncGuide();
      updateActions();
    });
  }
  function undo() { if (hIndex > 0) { hIndex--; apply(history[hIndex]); } }
  function redo() { if (hIndex < history.length - 1) { hIndex++; apply(history[hIndex]); } }
  function updateActions() {
    if (!canvas) return;
    $("edUndo").disabled = hIndex <= 0;
    $("edRedo").disabled = hIndex >= history.length - 1;
    $("edCropClear").hidden = !crop;
  }

  // ── tools ──
  function setTool(name) {
    tool = name;
    document.querySelectorAll(".ed-tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
    if (!canvas) return;
    canvas.isDrawingMode = name === "brush";
    canvas.selection = name === "select";
    canvas.forEachObject((o) => { if (o !== baseImage && !o.qilGuide) o.selectable = name === "select"; });
    canvas.defaultCursor = name === "select" ? "default" : name === "eraser" ? "pointer" : "crosshair";
    if (name === "brush") {
      canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
      canvas.freeDrawingBrush.color = color;
      canvas.freeDrawingBrush.width = width;
    }
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }
  function setColor(c) {
    color = c;
    document.querySelectorAll(".ed-sw").forEach((s) => s.classList.toggle("active", s.dataset.color === c));
    if (/^#[0-9a-f]{6}$/i.test(c)) $("edColor").value = c;
    if (canvas && canvas.freeDrawingBrush) canvas.freeDrawingBrush.color = c;
  }
  function setWidth(w) {
    width = w;
    document.querySelectorAll(".ed-w").forEach((s) => s.classList.toggle("active", Number(s.dataset.w) === w));
    if (canvas && canvas.freeDrawingBrush) canvas.freeDrawingBrush.width = w;
  }
  function syncPalette() {
    const pal = $("edPalette");
    if (!pal.childElementCount) {
      for (const c of COLORS) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "ed-sw"; b.dataset.color = c; b.style.background = c; b.title = c;
        b.addEventListener("click", () => setColor(c));
        pal.appendChild(b);
      }
      for (const w of WIDTHS) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "ed-w"; b.dataset.w = w;
        b.innerHTML = `<i style="width:${Math.min(w, 16)}px;height:${Math.min(w, 16)}px"></i>`;
        b.title = `${w}px`; b.addEventListener("click", () => setWidth(w));
        $("edWidths").appendChild(b);
      }
    }
    setColor(COLORS[0]);
    setWidth(WIDTHS[1]);
  }

  // ── pointer: shapes, arrow, crop, eraser ──
  function onDown(opt) {
    if (!canvas) return;
    if (tool === "select" || tool === "brush") return;
    const p = canvas.getPointer(opt.e);
    if (tool === "eraser") {
      const tgt = opt.target;
      if (tgt && tgt !== baseImage && !tgt.qilGuide) { canvas.remove(tgt); canvas.requestRenderAll(); push(); }
      return;
    }
    origin = p;
    const common = { stroke: color, strokeWidth: width, fill: "", strokeUniform: true, selectable: false };
    if (tool === "rect") drawing = new fabric.Rect({ ...common, left: p.x, top: p.y, width: 0, height: 0 });
    else if (tool === "circle") drawing = new fabric.Ellipse({ ...common, left: p.x, top: p.y, rx: 0, ry: 0 });
    else if (tool === "arrow") drawing = new fabric.Line([p.x, p.y, p.x, p.y], { ...common, strokeLineCap: "round" });
    else if (tool === "crop") drawing = new fabric.Rect({ left: p.x, top: p.y, width: 0, height: 0, fill: "rgba(255,255,255,0.12)", stroke: "#fff", strokeWidth: 1.5, strokeDashArray: [6, 4], selectable: false, evented: false });
    canvas.add(drawing);
  }
  function onMove(opt) {
    if (!drawing || !origin) return;
    const p = canvas.getPointer(opt.e);
    const x = Math.min(p.x, origin.x), y = Math.min(p.y, origin.y);
    const w = Math.abs(p.x - origin.x), h = Math.abs(p.y - origin.y);
    if (tool === "circle") drawing.set({ left: x, top: y, rx: w / 2, ry: h / 2 });
    else if (tool === "arrow") drawing.set({ x2: p.x, y2: p.y });
    else drawing.set({ left: x, top: y, width: w, height: h });
    canvas.requestRenderAll();
  }
  function onUp(opt) {
    if (!drawing || !origin) return;
    const p = canvas.getPointer(opt.e);
    const d = drawing; drawing = null;
    const ox = origin.x, oy = origin.y;
    const x = Math.min(p.x, ox), y = Math.min(p.y, oy);
    const w = Math.abs(p.x - ox), h = Math.abs(p.y - oy);
    origin = null;
    canvas.remove(d);
    if (w < 6 && h < 6) { canvas.requestRenderAll(); return; }
    if (tool === "crop") { crop = { left: x, top: y, width: w, height: h }; syncGuide(); updateActions(); return; }
    if (tool === "arrow") { canvas.add(buildArrow(p.x, p.y, ox, oy)); push(); return; }
    d.set({ left: x, top: y });
    d.selectable = false;
    canvas.add(d);
    push();
  }
  // Arrow from head (hx,hy) to tail (tx,ty): shaft plus two barbs at the head, one Path.
  function buildArrow(hx, hy, tx, ty) {
    const ang = Math.atan2(hy - ty, hx - tx);
    const hl = Math.max(14, width * 3);
    const b1x = hx - hl * Math.cos(ang - 0.45), b1y = hy - hl * Math.sin(ang - 0.45);
    const b2x = hx - hl * Math.cos(ang + 0.45), b2y = hy - hl * Math.sin(ang + 0.45);
    return new fabric.Path(`M ${tx} ${ty} L ${hx} ${hy} M ${b1x} ${b1y} L ${hx} ${hy} L ${b2x} ${b2y}`, {
      stroke: color, strokeWidth: width, fill: "", strokeLineCap: "round", strokeLineJoin: "round", selectable: false,
    });
  }

  // ── rotate the whole composition 90° clockwise ──
  function rotate() {
    if (!canvas) return;
    const W = canvas.getWidth(), H = canvas.getHeight();
    canvas.discardActiveObject();
    canvas.forEachObject((o) => {
      const c = o.getCenterPoint();
      // CW 90° in screen coords: (x, y) → (H − y, x). Set the angle first,
      // then pin the rotated center — left/top would shift with the angle otherwise.
      o.angle += 90;
      o.setPositionByOrigin(new fabric.Point(H - c.y, c.x), "center", "center");
      o.setCoords();
    });
    canvas.setWidth(H);
    canvas.setHeight(W);
    crop = null;
    syncGuide();
    push();
  }

  // Ctrl/Cmd + wheel zooms the view around the cursor (0.25×–8×). Purely a viewport
  // transform: annotations keep their scene coordinates and the export ignores it.
  function wireZoom() {
    canvas.upperCanvasEl.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const z = (canvas.viewportTransform[0] || 1) * Math.exp(-e.deltaY * 0.0015);
      canvas.zoomToPoint(new fabric.Point(e.offsetX, e.offsetY), Math.min(8, Math.max(0.25, z)));
      canvas.requestRenderAll();
    }, { passive: false });
  }

  // ── save: export at native resolution, cropped if a crop rect was drawn ──
  function save() {
    if (!canvas) return;
    canvas.discardActiveObject();
    canvas.getObjects().filter((o) => o.qilGuide).forEach((o) => canvas.remove(o));
    // The export always renders the scene at 1:1, regardless of the view zoom.
    const vpt = canvas.viewportTransform;
    canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    canvas.requestRenderAll();
    const opts = { format: "png", multiplier: 1 / scale };
    if (crop) Object.assign(opts, { left: crop.left, top: crop.top, width: crop.width, height: crop.height });
    const url = canvas.toDataURL(opts);
    canvas.viewportTransform = vpt;
    syncGuide();
    $("edSave").disabled = true;
    invoke("save_edited", { dataUrl: url })
      .then((path) => { close(); onSave(path); })
      .catch((e) => { $("edSave").disabled = false; notify(String(e)); });
  }

  // ── wiring ──
  $("edClose").addEventListener("click", close);
  $("edCancel").addEventListener("click", close);
  $("edSave").addEventListener("click", save);
  $("edUndo").addEventListener("click", undo);
  $("edRedo").addEventListener("click", redo);
  $("edRotate").addEventListener("click", rotate);
  $("edCropClear").addEventListener("click", () => { crop = null; syncGuide(); updateActions(); });
  document.querySelectorAll(".ed-tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("edColor").addEventListener("input", (e) => setColor(e.target.value));

  document.addEventListener("keydown", (e) => {
    if ($("editor").hidden) return;
    if (e.key === "Escape") { close(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && tool === "select" && canvas) {
      const a = canvas.getActiveObject();
      if (a && a !== baseImage && !a.qilGuide) { canvas.remove(a); canvas.requestRenderAll(); push(); e.preventDefault(); }
    }
  });

  window.qilEditor = { open };
})();
