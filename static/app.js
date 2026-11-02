/* ssh-fetcher front-end — vanilla JS, no build step. */
(() => {
  "use strict";

  // ------------------------------------------------------------------ state
  const TOKEN = new URLSearchParams(location.hash.slice(1)).get("token") || sessionStorage.getItem("sshf-token") || "";
  if (TOKEN) sessionStorage.setItem("sshf-token", TOKEN);
  history.replaceState(null, "", location.pathname);

  const S = {
    info: null,
    cwd: "",
    entries: [],
    rows: [],
    sel: new Set(),       // selected row paths
    cursor: -1,
    anchor: -1,
    sort: { key: "n", desc: false },
    filter: "",
    hidden: localStorage.getItem("sshf-hidden") === "1",
    back: [], fwd: [],
    search: null,         // {query, mode, root, results}
    previewPath: null,
    previewData: null,
    consoleHist: [], consoleIdx: -1,
    jobs: [],
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const join = (a, b) => (a === "/" ? "" : a.replace(/\/+$/, "")) + "/" + b;
  const parent = (p) => { const i = p.replace(/\/+$/, "").lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
  const base = (p) => p.replace(/\/+$/, "").split("/").pop() || "/";
  const fmtSize = (n) => {
    if (n == null) return "";
    const u = ["B", "K", "M", "G", "T"]; let i = 0; n = Number(n);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + (i ? u[i] : " B");
  };
  const fmtDate = (t) => {
    if (!t) return "";
    const d = new Date(t * 1000), p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const tilde = (p) => (S.info && S.info.home && (p === S.info.home || p.startsWith(S.info.home + "/")) ? "~" + p.slice(S.info.home.length) : p);

  // ------------------------------------------------------------------ api
  async function api(path, { method = "GET", body, params } = {}) {
    const url = new URL(path, location.origin);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url, {
      method,
      headers: { "X-Token": TOKEN, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data; try { data = await r.json(); } catch { data = {}; }
    if (!r.ok || (data && data.error && !data.entries)) throw new Error((data && data.error) || `HTTP ${r.status}`);
    return data;
  }
  const rawUrl = (p, dl) => `/api/raw?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(p)}${dl ? "&dl=1" : ""}`;

  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind; el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "bad" ? 7000 : 3500);
  }
  const busy = (on) => $("loading").classList.toggle("hidden", !on);

  // ------------------------------------------------------------------ icons
  function icon(r) {
    if (r.up) return "↩";
    if (r.d) return r.l ? "🔗" : "📁";
    const ext = (r.name.split(".").pop() || "").toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "🖼";
    if (["pdf"].includes(ext)) return "📕";
    if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "🎞";
    if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) return "🎵";
    if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"].includes(ext)) return "📦";
    if (["py", "c", "h", "cpp", "hpp", "cu", "f90", "f", "js", "ts", "go", "rs", "java", "jl", "r", "sh", "bash", "slurm", "sbatch", "mk", "cmake"].includes(ext)) return "📜";
    if (["log", "out", "err"].includes(ext)) return "🧾";
    if (["csv", "tsv", "json", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf"].includes(ext)) return "🗂";
    if (r.p && r.p.includes("x")) return "⚙";
    return "📄";
  }

  // ------------------------------------------------------------------ navigation
  async function go(path, { push = true, baseDir, select } = {}) {
    busy(true);
    try {
      const data = await api("/api/ls", { params: { base: baseDir ?? S.cwd, path } });
      if (data.error) throw new Error(data.error);
      if (push && S.cwd && S.cwd !== data.path) { S.back.push(S.cwd); S.fwd = []; }
      const prev = S.cwd;
      S.cwd = data.path;
      S.entries = data.entries.map((e) => ({ name: e.n, path: join(data.path, e.n), d: e.d, s: e.s, m: e.m, p: e.p, o: e.o, l: e.l, t: e.t, b: e.b }));
      S.search = null; S.sel.clear(); S.cursor = -1;
      $("searchBanner").classList.add("hidden");
      if (prev !== S.cwd) { $("filterInput").value = ""; S.filter = ""; }
      render();
      // keep the folder we came from highlighted when going up
      const want = select || (prev && parent(prev) === S.cwd ? prev : null);
      const idx = want ? S.rows.findIndex((r) => r.path === want) : -1;
      setCursor(idx >= 0 ? idx : (S.rows.length > 1 ? 1 : 0), { select: idx >= 0, scroll: true, preview: false });
      localStorage.setItem("sshf-last", S.cwd);
      return true;
    } catch (e) {
      toast(e.message, "bad");
      return false;
    } finally {
      busy(false);
      updateChrome();
    }
  }
  const refresh = () => (S.search ? runSearch(S.search) : go(S.cwd, { push: false, select: S.rows[S.cursor]?.path }));

  function updateChrome() {
    // breadcrumbs
    const c = $("crumbs"); c.innerHTML = "";
    const parts = S.cwd.split("/").filter(Boolean);
    const add = (label, path) => {
      const s = document.createElement("span"); s.className = "c"; s.textContent = label;
      s.onclick = (ev) => { ev.stopPropagation(); go(path); };
      c.appendChild(s);
    };
    add("/", "/");
    let acc = "";
    parts.forEach((p, i) => {
      acc += "/" + p;
      add(p, acc);
      if (i < parts.length - 1) { const sep = document.createElement("span"); sep.className = "s"; sep.textContent = "/"; c.appendChild(sep); }
    });
    c.scrollLeft = c.scrollWidth;
    $("btnBack").disabled = !S.back.length;
    $("btnFwd").disabled = !S.fwd.length;
    $("btnUp").disabled = S.cwd === "/";
    $("consolePrompt").textContent = `${S.info?.user || ""}@${S.info?.hostname?.split(".")[0] || ""}:${tilde(S.cwd)}$`;
    $("dropTarget").textContent = S.cwd;
    document.title = `${base(S.cwd)} — ${S.info?.host || "ssh-fetcher"}`;
    document.querySelectorAll("#bookmarks li").forEach((li) => li.classList.toggle("active", li.dataset.path === S.cwd));
    renderStatus();
  }

  // ------------------------------------------------------------------ table
  function computeRows() {
    if (S.search) {
      return S.search.results.map((r) => {
        const rel = r.path.startsWith(S.search.root + "/") ? r.path.slice(S.search.root.length + 1) : r.path;
        return S.search.mode === "content"
          ? { name: rel, path: r.path, d: false, line: r.line, text: r.text, hit: true }
          : { name: rel, path: r.path, d: r.d, s: r.s, m: r.m, hit: false };
      });
    }
    let rows = S.entries.filter((e) => S.hidden || !e.name.startsWith("."));
    if (S.filter) {
      const f = S.filter.toLowerCase();
      rows = rows.filter((e) => e.name.toLowerCase().includes(f));
    }
    const { desc } = S.sort;
    const key = S.sort.key === "n" ? "name" : S.sort.key;
    rows.sort((a, b) => {
      if (a.d !== b.d) return a.d ? -1 : 1;
      let x = a[key], y = b[key];
      let c = typeof x === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true, sensitivity: "base" });
      return desc ? -c : c;
    });
    if (S.cwd !== "/") rows.unshift({ name: "..", path: parent(S.cwd), d: true, up: true });
    return rows;
  }

  function highlightQuery(text, q) {
    const t = esc(text);
    if (!q || S.search?.regex) return t;
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), S.search?.case ? "g" : "gi");
    return t.replace(re, (m) => `<mark>${m}</mark>`);
  }

  function render() {
    S.rows = computeRows();
    const body = $("fileBody");
    const frag = document.createDocumentFragment();
    S.rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.dataset.i = i;
      tr.className = [r.d ? "dir" : "", r.b ? "broken" : "", r.hit ? "hit" : "", S.sel.has(r.path) ? "sel" : "", i === S.cursor ? "cursor" : ""].join(" ");
      let name = `<span class="ico">${icon(r)}</span>${esc(r.name)}`;
      if (r.l && r.t) name += `<span class="link">→ ${esc(r.t)}</span>`;
      if (r.hit) name += `<span class="sub">:${r.line}</span><span class="hit-text">${highlightQuery(r.text.trim(), S.search.query)}</span>`;
      tr.innerHTML =
        `<td class="name" title="${esc(r.path)}">${name}</td>` +
        `<td class="size">${r.d || r.hit ? "" : fmtSize(r.s)}</td>` +
        `<td class="date">${fmtDate(r.m)}</td>` +
        `<td class="perm">${esc(r.p || "")}</td>` +
        `<td class="owner">${esc(r.o || "")}</td>`;
      frag.appendChild(tr);
    });
    body.replaceChildren(frag);
    const empty = $("emptyMsg");
    const real = S.rows.filter((r) => !r.up).length;
    empty.classList.toggle("hidden", real > 0);
    empty.textContent = S.search ? "No matches." : S.filter ? "Nothing matches the filter." : "Empty folder.";
    document.querySelectorAll("thead th").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === S.sort.key);
      th.classList.toggle("desc", th.dataset.sort === S.sort.key && S.sort.desc);
    });
    renderStatus();
  }

  function renderStatus() {
    const real = S.rows.filter((r) => !r.up);
    const sel = selectedRows();
    const selSize = sel.filter((r) => !r.d).reduce((a, r) => a + (r.s || 0), 0);
    let txt = S.search
      ? `${real.length} result${real.length === 1 ? "" : "s"}`
      : `${real.filter((r) => r.d).length} folders, ${real.filter((r) => !r.d).length} files`;
    if (sel.length) txt += `  ·  ${sel.length} selected${selSize ? ` (${fmtSize(selSize)})` : ""}`;
    $("statusbar").textContent = txt;
  }

  const selectedRows = () => S.rows.filter((r) => S.sel.has(r.path) && !r.up);
  const targetRows = () => { const s = selectedRows(); if (s.length) return s; const c = S.rows[S.cursor]; return c && !c.up ? [c] : []; };

  function paintRows() {
    const trs = $("fileBody").children;
    for (let i = 0; i < trs.length; i++) {
      const r = S.rows[i];
      trs[i].classList.toggle("sel", S.sel.has(r.path));
      trs[i].classList.toggle("cursor", i === S.cursor);
    }
    renderStatus();
  }

  let previewTimer = null;
  function setCursor(i, { select = true, extend = false, scroll = true, preview = true } = {}) {
    if (!S.rows.length) { S.cursor = -1; return; }
    i = Math.max(0, Math.min(S.rows.length - 1, i));
    S.cursor = i;
    if (extend && S.anchor >= 0) {
      S.sel.clear();
      const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)];
      for (let k = a; k <= b; k++) if (!S.rows[k].up) S.sel.add(S.rows[k].path);
    } else if (select) {
      S.sel.clear();
      if (!S.rows[i].up) S.sel.add(S.rows[i].path);
      S.anchor = i;
    }
    paintRows();
    if (scroll) $("fileBody").children[i]?.scrollIntoView({ block: "nearest" });
    if (preview) {
      clearTimeout(previewTimer);
      const r = S.rows[i];
      if (r && !r.d) previewTimer = setTimeout(() => showPreview(r), 180);
    }
  }

  function openRow(r) {
    if (!r) return;
    if (r.d) return go(r.path);
    showPreview(r);
  }

  // ------------------------------------------------------------------ preview
  const TEXT_EXT_LANG = { py: "python", sh: "bash", bash: "bash", slurm: "bash", sbatch: "bash", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cu: "cpp", js: "javascript", ts: "typescript", json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", md: "markdown", f90: "fortran", f: "fortran", rs: "rust", go: "go", java: "java", jl: "julia", r: "r", xml: "xml", html: "xml", css: "css", mk: "makefile", cmake: "cmake", tex: "latex", sql: "sql", dockerfile: "dockerfile" };

  async function showPreview(r, { line } = {}) {
    S.previewPath = r.path;
    S.previewData = null;
    $("previewTitle").textContent = base(r.path);
    $("previewTitle").title = r.path;
    $("previewMeta").textContent = "";
    $("previewBody").classList.remove("wrap");
    $("previewBody").innerHTML = `<div class="placeholder"><div class="spinner" style="margin:auto"></div></div>`;
    setPreviewActions(r, null);
    let d;
    try { d = await api("/api/preview", { params: { path: r.path } }); }
    catch (e) {
      if (S.previewPath !== r.path) return;
      $("previewBody").innerHTML = `<div class="placeholder">⚠ ${esc(e.message)}</div>`;
      return;
    }
    if (S.previewPath !== r.path) return; // user moved on
    S.previewData = d;
    $("previewMeta").textContent = `${fmtSize(d.size)} · ${d.mime}${r.p ? " · " + r.p : ""}${r.m ? " · " + fmtDate(r.m) : ""}`;
    setPreviewActions(r, d);
    const body = $("previewBody");
    const ext = (r.path.split(".").pop() || "").toLowerCase();
    if (d.kind === "media") {
      const src = rawUrl(r.path);
      if (d.mime.startsWith("image/")) body.innerHTML = `<img src="${src}" alt="">`;
      else if (d.mime === "application/pdf") body.innerHTML = `<iframe src="${src}"></iframe>`;
      else if (d.mime.startsWith("video/")) body.innerHTML = `<video src="${src}" controls></video>`;
      else body.innerHTML = `<audio src="${src}" controls></audio>`;
    } else if (d.kind === "binary") {
      body.innerHTML = `<div class="trunc-note">Binary file — showing the first bytes as hex.</div><div class="code"><pre>${esc(d.content)}</pre></div>`;
    } else if (d.kind === "dir") {
      body.innerHTML = `<div class="placeholder">Folder</div>`;
    } else {
      renderText(d, ext, line);
    }
  }

  function renderText(d, ext, line, mode) {
    const body = $("previewBody");
    const note = d.truncated ? `<div class="trunc-note">Large file — showing the first ${fmtSize(d.content.length)} of ${fmtSize(d.size)}. Download to see everything.</div>` : "";
    mode = mode || (ext === "md" && window.marked ? "md" : (["csv", "tsv"].includes(ext) ? "table" : "code"));
    if (mode === "md") {
      body.innerHTML = note + `<div class="markdown">${window.marked.parse(d.content)}</div>`;
      return;
    }
    if (mode === "table") {
      const sep = ext === "tsv" ? "\t" : ",";
      const lines = d.content.split(/\r?\n/).filter((l) => l.length).slice(0, 2000);
      const cells = (l) => l.split(sep);
      const head = cells(lines[0] || "");
      body.innerHTML = note + `<table class="csv"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>` +
        lines.slice(1).map((l) => `<tr>${cells(l).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") + `</tbody></table>`;
      return;
    }
    const text = d.content;
    const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0) || 1;
    const lns = Array.from({ length: n }, (_, i) => i + 1).join("\n");
    let html = esc(text);
    const lang = TEXT_EXT_LANG[ext] || (base(S.previewPath).toLowerCase() === "makefile" ? "makefile" : null);
    if (window.hljs && text.length < 300000) {
      try {
        html = lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
          : text.length < 100000 ? hljs.highlightAuto(text).value : html;
      } catch { /* keep plain */ }
    }
    if (line) {
      // wrap the target line for highlighting
      const parts = html.split("\n");
      if (parts[line - 1] !== undefined) parts[line - 1] = `<span class="hl-line" id="hlLine">${parts[line - 1] || " "}</span>`;
      html = parts.join("\n");
    }
    body.innerHTML = note + `<div class="code"><div class="ln">${lns}</div><pre><code class="hljs">${html}</code></pre></div>`;
    if (line) setTimeout(() => $("hlLine")?.scrollIntoView({ block: "center" }), 0);
  }

  function setPreviewActions(r, d) {
    const a = $("previewActions"); a.innerHTML = "";
    const btn = (label, title, fn) => { const b = document.createElement("button"); b.className = "mini"; b.textContent = label; b.title = title; b.onclick = fn; a.appendChild(b); };
    btn("⬇ scp", "Download to your Mac via scp", () => download([r]));
    btn("Save as…", "Download through the browser", () => { location.href = rawUrl(r.path, true); });
    if (d && (d.kind === "media")) btn("↗", "Open in new tab", () => window.open(rawUrl(r.path), "_blank"));
    if (d && d.kind === "text") {
      const ext = (r.path.split(".").pop() || "").toLowerCase();
      if (ext === "md" && window.marked) {
        let raw = false;
        btn("Raw/MD", "Toggle markdown rendering", () => { raw = !raw; renderText(d, ext, null, raw ? "code" : "md"); });
      }
      if (["csv", "tsv"].includes(ext)) {
        let raw = false;
        btn("Raw/Table", "Toggle table view", () => { raw = !raw; renderText(d, ext, null, raw ? "code" : "table"); });
      }
      btn("Wrap", "Toggle line wrap", () => $("previewBody").classList.toggle("wrap"));
      if (!d.truncated) btn("✎ Edit", "Edit and save back to the remote", () => editFile(r, d));
    }
    btn("VS Code", "Open file in VS Code Remote-SSH", () => openInVSCode(r.path, false));
    btn("⧉", "Copy remote path", () => copy(r.path));
  }

  function editFile(r, d) {
    const body = $("previewBody");
    body.innerHTML = `<textarea class="editor" spellcheck="false"></textarea>`;
    const ta = body.querySelector("textarea");
    ta.value = d.content;
    ta.focus();
    const a = $("previewActions"); a.innerHTML = "";
    const save = async () => {
      try {
        await api("/api/save", { method: "POST", body: { path: r.path, content: ta.value } });
        toast("Saved " + base(r.path), "ok");
        showPreview(r);
        if (!S.search) refresh();
      } catch (e) { toast(e.message, "bad"); }
    };
    const mk = (label, fn) => { const b = document.createElement("button"); b.className = "mini"; b.textContent = label; b.onclick = fn; a.appendChild(b); };
    mk("💾 Save (⌘S)", save);
    mk("Cancel", () => showPreview(r));
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
      if (e.key === "Tab") { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText("    ", s, ta.selectionEnd, "end"); }
      if (e.key === "Escape") showPreview(r);
    });
  }

  function clearPreview() {
    S.previewPath = null;
    $("previewTitle").textContent = "Preview";
    $("previewMeta").textContent = "";
    $("previewActions").innerHTML = "";
    $("previewBody").innerHTML = `<div class="placeholder">Select a file to preview it.</div>`;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied: " + text); } catch { prompt("Copy:", text); }
  }

  // ------------------------------------------------------------------ search
  async function runSearch(s) {
    busy(true);
    try {
      const d = await api("/api/search", {
        params: { path: s.root, q: s.query, mode: s.mode, hidden: S.hidden ? 1 : 0, regex: s.regex ? 1 : 0, case: s.case ? 1 : 0 },
      });
      S.search = { ...s, results: d.results };
      S.sel.clear(); S.cursor = -1;
      render();
      const what = s.mode === "content" ? "lines containing" : "names matching";
      $("searchSummary").innerHTML = `${d.results.length}${d.truncated ? "+" : ""} ${what} <b>${esc(s.query)}</b> under <code>${esc(tilde(s.root))}</code>${d.timedOut ? " — <i>timed out, partial results</i>" : ""}`;
      $("searchBanner").classList.remove("hidden");
      if (S.rows.length) setCursor(0, { preview: false });
    } catch (e) { toast(e.message, "bad"); }
    finally { busy(false); }
  }

  function closeSearch() {
    S.search = null;
    $("searchBanner").classList.add("hidden");
    render();
    setCursor(0, { select: false, preview: false });
  }

  // ------------------------------------------------------------------ file ops
  async function download(rows) {
    rows = rows.filter((r) => !r.up);
    if (!rows.length) return toast("Nothing selected");
    try {
      const d = await api("/api/download", { method: "POST", body: { items: rows.map((r) => ({ path: r.path, isDir: r.d, size: r.s })) } });
      toast(`Downloading ${rows.length} item(s) via scp → ${tilde2(S.info.download_dir)}`);
      showTab("transfers"); pollJobs(true);
      return d;
    } catch (e) { toast(e.message, "bad"); }
  }
  const tilde2 = (p) => p.replace(/^\/Users\/[^/]+/, "~");

  function confirmOverwrite(names) {
    const existing = new Set(S.entries.map((e) => e.name));
    const clash = names.filter((n) => existing.has(n));
    return !clash.length || confirm(`These already exist in ${S.cwd} and will be overwritten:\n\n${clash.join("\n")}\n\nContinue?`);
  }

  async function pickAndUpload(kind) {
    if (S.info.platform !== "darwin") return toast("Native picker is macOS-only — drag & drop files instead", "bad");
    try {
      const { paths } = await api("/api/pick", { method: "POST", body: { kind } });
      if (!paths.length) return;
      if (!confirmOverwrite(paths.map((p) => base(p)))) return;
      const dir = S.cwd;
      await api("/api/upload_paths", { method: "POST", body: { paths, dir } });
      toast(`Uploading ${paths.length} item(s) → ${tilde(dir)}`);
      showTab("transfers"); pollJobs(true);
    } catch (e) { toast(e.message, "bad"); }
  }

  // browser drag&drop upload: browser → local server (temp) → scp → remote
  const staging = new Map();
  function uploadBrowserFiles(files) {
    files = [...files].filter((f) => f.size > 0 || f.type !== "");
    if (!files.length) return toast("Folders can't be dropped from the browser — use “Upload folder”.", "bad");
    if (!confirmOverwrite(files.map((f) => f.name))) return;
    const dir = S.cwd;
    showTab("transfers");
    files.forEach((f) => {
      const id = "stg-" + Math.random().toString(36).slice(2);
      staging.set(id, { id, kind: "upload", label: f.name + " (staging)", status: "running", total: f.size, done: 0, dest: join(dir, f.name), started: Date.now() / 1000 });
      renderJobs();
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/upload_raw?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`);
      xhr.setRequestHeader("X-Token", TOKEN);
      xhr.upload.onprogress = (e) => { const j = staging.get(id); if (j) { j.done = e.loaded; renderJobs(); } };
      xhr.onload = () => {
        staging.delete(id);
        if (xhr.status >= 300) toast(`Upload of ${f.name} failed`, "bad");
        pollJobs(true);
      };
      xhr.onerror = () => { staging.delete(id); toast(`Upload of ${f.name} failed`, "bad"); renderJobs(); };
      xhr.send(f);
    });
  }

  async function newFolder() {
    const name = prompt("New folder name:");
    if (!name) return;
    try { await api("/api/mkdir", { method: "POST", body: { path: join(S.cwd, name) } }); await go(S.cwd, { push: false, select: join(S.cwd, name) }); }
    catch (e) { toast(e.message, "bad"); }
  }
  async function newFile() {
    const name = prompt("New file name:");
    if (!name) return;
    const p = join(S.cwd, name);
    try {
      await api("/api/touch", { method: "POST", body: { path: p } });
      await go(S.cwd, { push: false, select: p });
      const r = S.rows.find((x) => x.path === p);
      if (r) { await showPreview(r); if (S.previewData?.kind === "text") editFile(r, S.previewData); }
    } catch (e) { toast(e.message, "bad"); }
  }
  async function renameSel() {
    const r = targetRows()[0];
    if (!r) return;
    const name = prompt("Rename to:", base(r.path));
    if (!name || name === base(r.path)) return;
    const dst = name.startsWith("/") ? name : join(parent(r.path), name);
    try { await api("/api/rename", { method: "POST", body: { src: r.path, dst } }); refresh(); }
    catch (e) { toast(e.message, "bad"); }
  }
  async function deleteSel() {
    const rows = targetRows();
    if (!rows.length) return;
    const list = rows.slice(0, 15).map((r) => (r.d ? "📁 " : "") + r.path).join("\n") + (rows.length > 15 ? `\n…and ${rows.length - 15} more` : "");
    if (!confirm(`Permanently delete ${rows.length} item(s) on ${S.info.host}?\n\n${list}\n\nThis cannot be undone.`)) return;
    try {
      await api("/api/delete", { method: "POST", body: { paths: rows.map((r) => r.path) } });
      toast(`Deleted ${rows.length} item(s)`, "ok");
      if (rows.some((r) => r.path === S.previewPath)) clearPreview();
      refresh();
    } catch (e) { toast(e.message, "bad"); }
  }
  async function openInTerminal(path = S.cwd) {
    try {
      const r = await api("/api/open_terminal", { method: "POST", body: { path } });
      toast(`Opened ${tilde(path)} in ${r.app || "Terminal"}`, "ok");
    } catch (e) { toast(e.message, "bad"); }
  }
  async function openInVSCode(path = S.cwd, isDir = true) {
    try {
      await api("/api/open_vscode", { method: "POST", body: { path, isDir } });
      toast(`Opening ${tilde(path)} in VS Code…`, "ok");
    } catch (e) { toast(e.message, "bad"); }
  }

  // ------------------------------------------------------------------ jobs
  let pollHandle = null;
  async function pollJobs(fast) {
    clearTimeout(pollHandle);
    try {
      const prev = new Map(S.jobs.map((j) => [j.id, j.status]));
      S.jobs = await api("/api/jobs");
      for (const j of S.jobs) {
        if (prev.get(j.id) === "running" && j.status !== "running") {
          if (j.status === "done") {
            toast(`${j.kind === "upload" ? "Uploaded" : "Downloaded"} ${j.label}`, "ok");
            if (j.kind === "upload" && parent(j.dest) === S.cwd && !S.search) refresh();
          } else if (j.status === "error") toast(`${j.label}: ${j.error}`, "bad");
        }
      }
      renderJobs();
    } catch { /* server gone? */ }
    const running = S.jobs.some((j) => j.status === "running") || staging.size;
    pollHandle = setTimeout(pollJobs, running || fast ? 1000 : 5000);
  }

  function renderJobs() {
    const all = [...staging.values(), ...S.jobs];
    const running = all.filter((j) => j.status === "running").length;
    $("jobBadge").textContent = running; $("jobBadge").classList.toggle("hidden", !running);
    if (!all.length) { $("jobs").innerHTML = `<div class="jobs-empty">No transfers yet. Downloads land in <code>${esc(tilde2(S.info?.download_dir || ""))}</code>.</div>`; return; }
    $("jobs").innerHTML = all.map((j) => {
      const pct = j.total ? Math.min(100, (j.done / j.total) * 100) : 0;
      const indet = j.status === "running" && !j.total;
      const elapsed = ((j.finished || Date.now() / 1000) - j.started);
      const rate = elapsed > 0 && j.done ? fmtSize(j.done / elapsed) + "/s" : "";
      const stat = j.status === "running" ? (j.total ? `${pct.toFixed(0)}% · ${rate}` : rate || "…") : j.status;
      const actions = j.status === "running" && !String(j.id).startsWith("stg-")
        ? `<button class="mini" data-cancel="${j.id}">Cancel</button>`
        : j.status === "done" && j.kind === "download" ? `<button class="mini" data-reveal="${esc(j.dest)}">Show</button>`
        : j.status === "done" && j.kind === "upload" ? `<button class="mini" data-goto="${esc(j.dest)}">Go to</button>` : "";
      return `<div class="job ${j.status}">
        <span>${j.kind === "upload" ? "⬆" : "⬇"}</span>
        <span class="lbl">${esc(j.label)}<span class="dst">${esc(j.kind === "download" ? tilde2(j.dest) : j.dest)}</span></span>
        <div class="bar ${indet ? "indet" : ""}"><div style="width:${j.status === "done" ? 100 : pct}%"></div></div>
        <span class="stat">${fmtSize(j.done)}${j.total ? " / " + fmtSize(j.total) : ""}<br>${stat}</span>
        <span>${actions}</span>
        ${j.error ? `<span class="err">${esc(j.error)}</span>` : ""}
      </div>`;
    }).join("");
  }

  $("jobs").addEventListener("click", async (e) => {
    const t = e.target;
    if (t.dataset.cancel) { await api("/api/jobs/cancel", { method: "POST", body: { id: t.dataset.cancel } }); pollJobs(true); }
    if (t.dataset.reveal) api("/api/reveal", { method: "POST", body: { path: t.dataset.reveal } });
    if (t.dataset.goto) go(parent(t.dataset.goto), { select: t.dataset.goto });
  });

  // ------------------------------------------------------------------ console
  function consolePrint(html) {
    const o = $("consoleOut");
    o.insertAdjacentHTML("beforeend", html);
    o.scrollTop = o.scrollHeight;
  }
  async function runConsole(cmd) {
    cmd = cmd.trim();
    if (!cmd) return;
    S.consoleHist.push(cmd); S.consoleIdx = S.consoleHist.length;
    consolePrint(`<span class="cmd">${esc($("consolePrompt").textContent)} ${esc(cmd)}</span>\n`);
    const m = cmd.match(/^cd(?:\s+(.*))?$/);
    if (m) {
      let target = (m[1] || "~").trim().replace(/^["']|["']$/g, "");
      if (target === "-") target = S.back[S.back.length - 1] || S.cwd;
      await go(target, { baseDir: S.cwd });
      return;
    }
    if (cmd === "clear") { $("consoleOut").innerHTML = ""; return; }
    try {
      const r = await api("/api/exec", { method: "POST", body: { cwd: S.cwd, cmd } });
      if (r.stdout) consolePrint(esc(r.stdout));
      if (r.stderr) consolePrint(`<span class="err">${esc(r.stderr)}</span>`);
      if (r.code) consolePrint(`<span class="err">[exit ${r.code}]</span>\n`);
      if (!S.search) go(S.cwd, { push: false, select: S.rows[S.cursor]?.path });
    } catch (e) { consolePrint(`<span class="err">${esc(e.message)}</span>\n`); }
  }
  $("consoleForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("consoleInput").value; $("consoleInput").value = ""; runConsole(v); });
  $("consoleInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && S.consoleIdx > 0) { e.preventDefault(); $("consoleInput").value = S.consoleHist[--S.consoleIdx]; }
    if (e.key === "ArrowDown") { e.preventDefault(); S.consoleIdx = Math.min(S.consoleHist.length, S.consoleIdx + 1); $("consoleInput").value = S.consoleHist[S.consoleIdx] || ""; }
    if (e.key === "Escape") $("consoleInput").blur();
  });

  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $("tab-transfers").classList.toggle("hidden", name !== "transfers");
    $("tab-console").classList.toggle("hidden", name !== "console");
    $("bottom").classList.remove("collapsed");
    $("btnToggleBottom").textContent = "▾";
    if (name === "console") $("consoleInput").focus();
  }
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
  $("btnToggleBottom").onclick = () => {
    const c = $("bottom").classList.toggle("collapsed");
    $("btnToggleBottom").textContent = c ? "▴" : "▾";
  };
  $("btnClearJobs").onclick = async () => { await api("/api/jobs/clear", { method: "POST", body: {} }); pollJobs(); };

  // ------------------------------------------------------------------ bookmarks
  function loadBookmarks() {
    try { const b = JSON.parse(localStorage.getItem("sshf-bm-" + S.info.host)); if (Array.isArray(b)) return b; } catch { }
    return [
      { name: "Home", path: S.info.home },
      ...(S.info.aliases || []).map((a) => ({ name: a.name, path: a.path })),
      { name: "projects", path: "/projects" },
      { name: "/", path: "/" },
    ];
  }
  function saveBookmarks(b) { localStorage.setItem("sshf-bm-" + S.info.host, JSON.stringify(b)); }
  function renderBookmarks() {
    const b = loadBookmarks();
    const ul = $("bookmarks"); ul.innerHTML = "";
    b.forEach((bm, i) => {
      const li = document.createElement("li");
      li.dataset.path = bm.path; li.title = bm.path;
      li.innerHTML = `<span>${bm.path === S.info.home ? "🏠" : "📁"}</span><span class="bm-name">${esc(bm.name)}</span><span class="x" title="Remove">✕</span>`;
      li.onclick = (e) => {
        if (e.target.classList.contains("x")) { b.splice(i, 1); saveBookmarks(b); renderBookmarks(); return; }
        go(bm.path);
      };
      ul.appendChild(li);
    });
    updateChrome();
  }
  $("btnAddBookmark").onclick = () => {
    const b = loadBookmarks();
    if (b.some((x) => x.path === S.cwd)) return toast("Already bookmarked");
    const name = prompt("Bookmark name:", base(S.cwd));
    if (!name) return;
    b.push({ name, path: S.cwd }); saveBookmarks(b); renderBookmarks();
  };

  // ------------------------------------------------------------------ path editing
  const pathBox = $("pathBox"), pathInput = $("pathInput");
  function editPath() {
    pathBox.classList.add("editing");
    pathInput.value = S.cwd;
    pathInput.focus(); pathInput.select();
  }
  pathBox.addEventListener("click", (e) => { if (e.target === pathBox || e.target.id === "crumbs") editPath(); });
  pathInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") { e.preventDefault(); const v = pathInput.value.trim(); pathBox.classList.remove("editing"); if (v) await go(v, { baseDir: S.cwd }); $("tableWrap").focus(); }
    if (e.key === "Escape") { pathBox.classList.remove("editing"); $("tableWrap").focus(); }
  });
  pathInput.addEventListener("blur", () => pathBox.classList.remove("editing"));

  // ------------------------------------------------------------------ table events
  const fileBody = $("fileBody");
  const rowFromEvent = (e) => { const tr = e.target.closest("tr"); return tr ? Number(tr.dataset.i) : -1; };

  fileBody.addEventListener("click", (e) => {
    const i = rowFromEvent(e); if (i < 0) return;
    const r = S.rows[i];
    if (e.metaKey || e.ctrlKey) {
      if (!r.up) S.sel.has(r.path) ? S.sel.delete(r.path) : S.sel.add(r.path);
      S.cursor = i; S.anchor = i; paintRows();
    } else if (e.shiftKey) {
      setCursor(i, { extend: true, preview: false });
    } else {
      setCursor(i, { scroll: false, preview: false });
      if (r.hit) showPreview(r, { line: r.line });
      else if (!r.d) showPreview(r);
    }
    $("tableWrap").focus();
  });
  fileBody.addEventListener("dblclick", (e) => {
    const i = rowFromEvent(e); if (i < 0) return;
    const r = S.rows[i];
    if (S.search && !r.d) { go(parent(r.path), { select: r.path }); return; }
    openRow(r);
  });
  document.querySelectorAll("thead th").forEach((th) => (th.onclick = () => {
    const k = th.dataset.sort;
    S.sort = { key: k, desc: S.sort.key === k ? !S.sort.desc : false };
    const cur = S.rows[S.cursor]?.path;
    render();
    const idx = S.rows.findIndex((r) => r.path === cur);
    if (idx >= 0) setCursor(idx, { select: false, preview: false });
  }));

  // context menu
  fileBody.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const i = rowFromEvent(e); if (i < 0) return;
    const r = S.rows[i];
    if (!S.sel.has(r.path)) setCursor(i, { scroll: false, preview: false });
    const rows = targetRows();
    const items = [];
    if (r.up) items.push(["Open parent", "⌫", () => go(r.path)]);
    else {
      if (r.d) items.push(["Open", "↵", () => go(r.path)]);
      else items.push(["Preview", "Space", () => showPreview(r, { line: r.line })]);
      if (S.search) items.push(["Show in folder", "", () => go(parent(r.path), { select: r.path })]);
      items.push(null);
      items.push([`Download ${rows.length > 1 ? rows.length + " items " : ""}to Mac (scp)`, "D", () => download(rows)]);
      if (!r.d) items.push(["Save as… (browser)", "", () => (location.href = rawUrl(r.path, true))]);
      items.push(["Copy path", "", () => copy(rows.map((x) => x.path).join("\n"))]);
      items.push(["Copy scp command", "", () => copy(`scp ${r.d ? "-r " : ""}${S.info.host}:'${r.path}' .`)]);
      items.push(["Open in Terminal", "T", () => openInTerminal(r.d ? r.path : parent(r.path))]);
      items.push(["Open in VS Code", "V", () => openInVSCode(r.path, r.d)]);
      if (r.d) items.push(["Bookmark", "", () => { const b = loadBookmarks(); b.push({ name: base(r.path), path: r.path }); saveBookmarks(b); renderBookmarks(); }]);
      if (r.d) items.push(["Search in here…", "", () => { $("searchInput").dataset.root = r.path; $("searchInput").placeholder = `Search in ${base(r.path)}…`; $("searchInput").focus(); }]);
      if (!S.search) {
        items.push(null);
        items.push(["Rename", "F2", renameSel]);
        items.push(["Delete", "Del", deleteSel, "danger"]);
      }
    }
    const m = $("ctxMenu"); m.innerHTML = "";
    items.forEach((it) => {
      if (!it) { m.appendChild(document.createElement("hr")); return; }
      const d = document.createElement("div");
      d.innerHTML = `<span>${esc(it[0])}</span><small>${esc(it[1])}</small>`;
      if (it[3]) d.className = it[3];
      d.onclick = () => { hideCtx(); it[2](); };
      m.appendChild(d);
    });
    m.classList.remove("hidden");
    const { innerWidth: W, innerHeight: H } = window;
    const rect = m.getBoundingClientRect();
    m.style.left = Math.min(e.clientX, W - rect.width - 8) + "px";
    m.style.top = Math.min(e.clientY, H - rect.height - 8) + "px";
  });
  const hideCtx = () => $("ctxMenu").classList.add("hidden");
  document.addEventListener("click", (e) => { if (!e.target.closest("#ctxMenu")) hideCtx(); });

  // ------------------------------------------------------------------ keyboard
  const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"); };
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") { e.preventDefault(); editPath(); return; }
    if (e.key === "Escape") hideCtx();
    if (typing()) {
      if (e.key === "Escape" && document.activeElement === $("filterInput")) { $("filterInput").blur(); $("tableWrap").focus(); }
      if ((e.key === "ArrowDown" || e.key === "Enter") && document.activeElement === $("filterInput")) { e.preventDefault(); $("tableWrap").focus(); if (e.key === "Enter" && S.rows.length) setCursor(S.rows[0]?.up && S.rows.length > 1 ? 1 : 0); }
      return;
    }
    const r = S.rows[S.cursor];
    const page = Math.max(1, Math.floor($("tableWrap").clientHeight / 28) - 1);
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setCursor(S.cursor + 1, { extend: e.shiftKey }); break;
      case "ArrowUp": e.preventDefault(); setCursor(S.cursor - 1, { extend: e.shiftKey }); break;
      case "PageDown": e.preventDefault(); setCursor(S.cursor + page); break;
      case "PageUp": e.preventDefault(); setCursor(S.cursor - page); break;
      case "Home": e.preventDefault(); setCursor(0); break;
      case "End": e.preventDefault(); setCursor(S.rows.length - 1); break;
      case "ArrowRight": if (e.altKey) { e.preventDefault(); goFwd(); } else if (r?.d) { e.preventDefault(); go(r.path); } break;
      case "ArrowLeft": if (e.altKey) { e.preventDefault(); goBack(); } else { e.preventDefault(); if (S.search) closeSearch(); else if (S.cwd !== "/") go(parent(S.cwd)); } break;
      case "Enter": e.preventDefault(); if (r) { if (S.search && !r.d && !(e.metaKey || e.ctrlKey)) showPreview(r, { line: r.line }); else if (S.search && !r.d) go(parent(r.path), { select: r.path }); else openRow(r); } break;
      case "Backspace": e.preventDefault(); if (S.search) closeSearch(); else if (S.cwd !== "/") go(parent(S.cwd)); break;
      case " ": e.preventDefault(); if (r && !r.d) showPreview(r, { line: r.line }); break;
      case "/": e.preventDefault(); $("filterInput").focus(); break;
      case "F2": e.preventDefault(); renameSel(); break;
      case "Delete": e.preventDefault(); deleteSel(); break;
      case "`": e.preventDefault(); showTab("console"); break;
      case "~": e.preventDefault(); go(S.info.home); break;
      default:
        if (e.metaKey || e.ctrlKey) {
          if (e.key.toLowerCase() === "a") { e.preventDefault(); S.rows.forEach((x) => !x.up && S.sel.add(x.path)); paintRows(); }
          if (e.key === "Backspace") { e.preventDefault(); deleteSel(); }
          if (e.key.toLowerCase() === "f") { e.preventDefault(); $("searchInput").focus(); }
          return;
        }
        if (e.key === "d" || e.key === "D") { e.preventDefault(); download(targetRows()); }
        else if (e.key === "r" || e.key === "R") { e.preventDefault(); refresh(); }
        else if (e.key === "t" || e.key === "T") { e.preventDefault(); openInTerminal(S.cwd); }
        else if (e.key === "v" || e.key === "V") { e.preventDefault(); openInVSCode(S.cwd, true); }
        else if (e.key === "h" && !e.altKey) { $("showHidden").click(); }
        else if (e.key === "Escape" && S.search) closeSearch();
        else if (e.key.length === 1 && /\S/.test(e.key) && !e.altKey) typeAhead(e.key);
    }
  });

  // type-to-jump like Finder
  let ta = "", taTimer = null;
  function typeAhead(ch) {
    ta += ch.toLowerCase(); clearTimeout(taTimer); taTimer = setTimeout(() => (ta = ""), 700);
    const idx = S.rows.findIndex((r) => !r.up && r.name.toLowerCase().startsWith(ta));
    if (idx >= 0) setCursor(idx);
  }

  function goBack() { if (!S.back.length) return; const p = S.back.pop(); S.fwd.push(S.cwd); go(p, { push: false }); }
  function goFwd() { if (!S.fwd.length) return; const p = S.fwd.pop(); S.back.push(S.cwd); go(p, { push: false }); }

  // ------------------------------------------------------------------ buttons
  $("btnBack").onclick = goBack;
  $("btnFwd").onclick = goFwd;
  $("btnUp").onclick = () => go(parent(S.cwd));
  $("btnHome").onclick = () => go(S.info.home);
  $("btnRefresh").onclick = refresh;
  $("btnUploadFiles").onclick = () => pickAndUpload("file");
  $("btnUploadDir").onclick = () => pickAndUpload("dir");
  $("btnDownload").onclick = () => download(targetRows());
  $("btnNewFolder").onclick = newFolder;
  $("btnNewFile").onclick = newFile;
  $("btnRename").onclick = renameSel;
  $("btnDelete").onclick = deleteSel;
  $("btnOpenTerm").onclick = () => openInTerminal(S.cwd);
  $("btnOpenCode").onclick = () => openInVSCode(S.cwd, true);
  $("btnCloseSearch").onclick = closeSearch;
  $("showHidden").checked = S.hidden;
  $("showHidden").onchange = (e) => { S.hidden = e.target.checked; localStorage.setItem("sshf-hidden", S.hidden ? "1" : "0"); render(); setCursor(0, { select: false, preview: false }); };
  $("filterInput").addEventListener("input", (e) => { S.filter = e.target.value; render(); S.cursor = -1; });
  $("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const query = $("searchInput").value.trim();
    if (!query) return;
    const root = $("searchInput").dataset.root || (S.search ? S.search.root : S.cwd);
    delete $("searchInput").dataset.root; $("searchInput").placeholder = "Search in this folder (recursive)…";
    runSearch({ query, root, mode: $("searchMode").value, regex: $("searchRegex").checked, case: $("searchCase").checked });
    $("tableWrap").focus();
  });
  $("btnChangeDl").onclick = async () => {
    let dir;
    if (S.info.platform === "darwin") {
      const { paths } = await api("/api/pick", { method: "POST", body: { kind: "dest" } });
      dir = paths[0];
    } else dir = prompt("Download folder:", S.info.download_dir);
    if (!dir) return;
    const r = await api("/api/config", { method: "POST", body: { download_dir: dir } });
    S.info.download_dir = r.download_dir; $("dlDir").textContent = tilde2(r.download_dir);
  };
  $("btnOpenDl").onclick = () => api("/api/reveal", { method: "POST", body: { path: S.info.download_dir + "/." } });

  // resizer
  (() => {
    const rz = $("resizer"); let drag = false;
    const saved = localStorage.getItem("sshf-pw"); if (saved) document.documentElement.style.setProperty("--preview-w", saved);
    rz.addEventListener("mousedown", (e) => { drag = true; rz.classList.add("drag"); e.preventDefault(); });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const w = Math.max(240, Math.min(window.innerWidth - 520, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty("--preview-w", w + "px");
    });
    window.addEventListener("mouseup", () => { if (drag) { drag = false; rz.classList.remove("drag"); localStorage.setItem("sshf-pw", getComputedStyle(document.documentElement).getPropertyValue("--preview-w")); } });
  })();

  // drag & drop upload
  (() => {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $("dropOverlay").classList.remove("hidden"); });
    window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) $("dropOverlay").classList.add("hidden"); });
    window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; $("dropOverlay").classList.add("hidden");
      const items = [...(e.dataTransfer.items || [])];
      if (items.some((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()?.isDirectory)) {
        toast("Folders can't be dropped from the browser — use “⬆ Upload folder” (native picker, scp -r).", "bad");
      }
      const files = items.filter((it) => !(it.webkitGetAsEntry && it.webkitGetAsEntry()?.isDirectory)).map((it) => it.getAsFile()).filter(Boolean);
      if (files.length) uploadBrowserFiles(files);
    });
  })();

  // ------------------------------------------------------------------ boot
  async function boot() {
    if (!TOKEN) { document.body.innerHTML = `<div class="placeholder" style="padding:60px;text-align:center">Missing access token — open the URL printed by <code>server.py</code>.</div>`; return; }
    try {
      S.info = await api("/api/info");
    } catch (e) {
      $("hostLabel").textContent = "error: " + e.message; $("connDot").className = "dot bad"; return;
    }
    if (!S.info.connected) { $("hostLabel").textContent = `${S.info.host}: ${S.info.error}`; $("connDot").className = "dot bad"; return; }
    $("connDot").className = "dot ok";
    $("hostLabel").textContent = `${S.info.user}@${S.info.host}`;
    $("hostLabel").title = S.info.hostname;
    $("dlDir").textContent = tilde2(S.info.download_dir);
    S.cwd = S.info.home;
    renderBookmarks();
    const last = localStorage.getItem("sshf-last");
    if (!(last && (await go(last, { push: false })))) await go(S.info.home, { push: false });
    $("tableWrap").focus();
    pollJobs();
  }
  boot();
})();
