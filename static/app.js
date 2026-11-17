/* ssh-fetcher front-end: vanilla JS, no build step. */
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
    consoleRun: null,     // AbortController of the running console command
    follow: null,         // {ac, path} while tailing a file in the preview
    clip: null,           // {mode: "copy"|"cut", paths, host}
    sizesFor: null,       // folder whose subfolder sizes (du) are loaded
    jobs: [],
  };

  const $ = (id) => document.getElementById(id);
  const ic = (name, cls = "") => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
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
    if (!r.ok || (data && data.error && !data.entries)) {
      const e = new Error((data && data.error) || `HTTP ${r.status}`);
      e.status = r.status; e.data = data;
      throw e;
    }
    return data;
  }
  // The token travels in an HttpOnly cookie for these URLs (set by /api/session), never in the URL.
  const rawUrl = (p, dl) => `/api/raw?path=${encodeURIComponent(p)}${dl ? "&dl=1" : ""}`;

  // NDJSON stream: calls onMsg for each {"o"|"e": text} / {"end": code} line until the server closes.
  async function streamApi(body, onMsg, signal) {
    const r = await fetch("/api/stream", {
      method: "POST", signal, body: JSON.stringify(body),
      headers: { "X-Token": TOKEN, "Content-Type": "application/json" },
    });
    if (!r.ok) { let m; try { m = (await r.json()).error; } catch { } throw new Error(m || `HTTP ${r.status}`); }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line) onMsg(JSON.parse(line));
      }
    }
  }

  function toast(msg, kind = "", action) {
    const el = document.createElement("div");
    el.className = "toast " + kind; el.textContent = msg;
    if (action) {
      const b = document.createElement("button");
      b.className = "mini"; b.textContent = action.label;
      b.onclick = () => { el.remove(); action.fn(); };
      el.appendChild(b);
    }
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), action ? 10000 : kind === "bad" ? 7000 : 3500);
  }
  const busy = (on) => $("loading").classList.toggle("hidden", !on);

  // ------------------------------------------------------------------ icons
  const EXT_ICON = [
    [["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff"], "image", "t-image"],
    [["pdf"], "pdf", "t-pdf"],
    [["mp4", "mov", "webm", "mkv", "avi", "mp3", "wav", "flac", "ogg", "m4a"], "media", ""],
    [["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"], "archive", "t-archive"],
    [["py", "c", "h", "cpp", "hpp", "cu", "f90", "f", "js", "ts", "go", "rs", "java", "jl", "r", "sh", "bash", "slurm", "sbatch", "mk", "cmake", "ipynb"], "file-code", "t-code"],
    [["log", "out", "err"], "log", ""],
    [["csv", "tsv", "json", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf", "h5", "nc"], "file-data", ""],
    [["md", "txt", "rst", "tex"], "file-text", ""],
  ];
  function icon(r) {
    if (r.up) return ic("parent", "fi");
    if (r.d) return ic(r.l ? "link" : "folder", "fi t-dir");
    const ext = (r.name.split(".").pop() || "").toLowerCase();
    for (const [exts, name, cls] of EXT_ICON) if (exts.includes(ext)) return ic(name, "fi " + cls);
    if (r.p && r.p.includes("x")) return ic("exec", "fi");
    return ic("file", "fi");
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
      S.sizesFor = null; S.sizesTotal = null;
      $("searchBanner").classList.add("hidden");
      if (prev !== S.cwd) { $("filterInput").value = ""; S.filter = ""; }
      render();
      // keep the folder we came from highlighted when going up
      const want = select || (prev && parent(prev) === S.cwd ? prev : null);
      const idx = want ? S.rows.findIndex((r) => r.path === want) : -1;
      setCursor(idx >= 0 ? idx : (S.rows.length > 1 ? 1 : 0), { select: idx >= 0, scroll: true, preview: false });
      localStorage.setItem("sshf-last-" + S.info?.host, S.cwd);
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
    document.title = `${base(S.cwd)} · ${S.info?.host || "ssh-fetcher"}`;
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
    const bySize = S.sizesFor === S.cwd && S.sort.key === "s";
    rows.sort((a, b) => {
      if (a.d !== b.d && !bySize) return a.d ? -1 : 1;
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
      let name = `${icon(r)}${esc(r.name)}`;
      if (r.l && r.t) name += `<span class="link">→ ${esc(r.t)}</span>`;
      if (r.hit) name += `<span class="sub">:${r.line}</span><span class="hit-text">${highlightQuery(r.text.trim(), S.search.query)}</span>`;
      tr.innerHTML =
        `<td class="name" title="${esc(r.path)}">${name}</td>` +
        `<td class="size">${(r.d && !r.du) || r.hit ? "" : fmtSize(r.s)}</td>` +
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
    if (S.sizesFor === S.cwd && S.sizesTotal != null && !S.search) txt += `  ·  ${fmtSize(S.sizesTotal)} on disk`;
    if (sel.length) txt += `  ·  ${sel.length} selected${selSize ? ` (${fmtSize(selSize)})` : ""}`;
    if (S.clip && S.clip.host === S.info?.host) txt += `  ·  ${S.clip.paths.length} item(s) ${S.clip.mode === "cut" ? "cut" : "copied"}`;
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
    stopFollow();
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
      $("previewBody").innerHTML = `<div class="placeholder error">${esc(e.message)}</div>`;
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
      body.innerHTML = `<div class="trunc-note">Binary file: showing the first bytes as hex.</div><div class="code"><pre>${esc(d.content)}</pre></div>`;
    } else if (d.kind === "dir") {
      body.innerHTML = `<div class="placeholder">Folder</div>`;
    } else {
      renderText(d, ext, line);
    }
  }

  const canRenderMd = () => !!(window.marked && window.DOMPurify);

  function renderText(d, ext, line, mode) {
    const body = $("previewBody");
    const note = d.truncated ? `<div class="trunc-note">Large file: showing the first ${fmtSize(d.content.length)} of ${fmtSize(d.size)}. Download to see everything.</div>` : "";
    mode = mode || (ext === "md" && canRenderMd() ? "md" : (["csv", "tsv"].includes(ext) ? "table" : "code"));
    if (mode === "md") {
      // Remote files are untrusted (shared filesystem): never render Markdown HTML unsanitised.
      body.innerHTML = note + `<div class="markdown">${window.DOMPurify.sanitize(window.marked.parse(d.content))}</div>`;
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

  // Text buttons for the main actions, icon buttons (with tooltips) for the rest.
  function actionButton(container, label, title, fn, iconName) {
    const b = document.createElement("button");
    if (!label) b.className = "icon";
    b.title = title;
    b.innerHTML = (iconName ? ic(iconName) : "") + (label ? esc(label) : "");
    b.onclick = fn;
    container.appendChild(b);
    return b;
  }
  function setPreviewActions(r, d) {
    const a = $("previewActions"); a.innerHTML = "";
    const btn = (label, title, fn, iconName) => actionButton(a, label, title, fn, iconName);
    if (d && d.kind === "text") {
      const ext = (r.path.split(".").pop() || "").toLowerCase();
      if (!d.truncated) btn("Edit", "Edit and save back to the remote", () => editFile(r, d), "pencil");
      btn("Follow", "Show new lines as the file grows (tail -F)", () => startFollow(r), "play");
      if (ext === "md" && canRenderMd()) {
        let raw = false;
        btn("Source", "Toggle between rendered Markdown and source", () => { raw = !raw; renderText(d, ext, null, raw ? "code" : "md"); });
      }
      if (["csv", "tsv"].includes(ext)) {
        let raw = false;
        btn("Source", "Toggle between table and source", () => { raw = !raw; renderText(d, ext, null, raw ? "code" : "table"); });
      }
      btn("", "Wrap long lines", () => $("previewBody").classList.toggle("wrap"), "wrap");
    }
    if (d && d.kind === "media") btn("", "Open in a new tab", () => window.open(rawUrl(r.path), "_blank"), "external");
    btn("", "Download to this computer (D)", () => download([r]), "download");
    btn("", "Open in VS Code", () => openInVSCode(r.path, false), "code");
    btn("", "Copy remote path", () => copy(r.path), "copy");
  }

  function editFile(r, d) {
    const body = $("previewBody");
    body.innerHTML = `<textarea class="editor" spellcheck="false"></textarea>`;
    const ta = body.querySelector("textarea");
    ta.value = d.content;
    ta.focus();
    const a = $("previewActions"); a.innerHTML = "";
    const save = async (force = false) => {
      try {
        await api("/api/save", { method: "POST", body: { path: r.path, content: ta.value, expect: { mtime: d.mtime, size: d.size }, force } });
        toast("Saved " + base(r.path), "ok");
        showPreview(r);
        if (!S.search) refresh();
      } catch (e) {
        if (e.status === 409) {
          if (confirm(`${base(r.path)} changed on ${S.info.host} since you opened it (now ${fmtSize(e.data.size)}, modified ${fmtDate(e.data.mtime)}).\n\nOverwrite it with your version?`)) save(true);
          return;
        }
        toast(e.message, "bad");
      }
    };
    actionButton(a, "Cancel", "Discard changes (Esc)", () => showPreview(r));
    actionButton(a, "Save", "Save to the remote (⌘S)", () => save()).classList.add("accent");
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
      if (e.key === "Tab") { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText("    ", s, ta.selectionEnd, "end"); }
      if (e.key === "Escape") showPreview(r);
    });
  }

  // ------------------------------------------------------------------ follow (tail -F)
  function stopFollow() {
    if (S.follow) { S.follow.ac.abort(); S.follow = null; }
  }
  function startFollow(r) {
    stopFollow();
    S.previewPath = r.path;
    $("previewTitle").textContent = base(r.path); $("previewTitle").title = r.path;
    $("previewMeta").textContent = "following · tail -F";
    const body = $("previewBody");
    body.classList.add("wrap");
    body.innerHTML = `<div class="trunc-note">Following: new lines appear as the file grows. If it does not exist yet, it is picked up when created.</div><pre class="follow" id="followOut"></pre>`;
    const out = $("followOut");
    const ac = new AbortController();
    S.follow = { ac, path: r.path };
    const a = $("previewActions"); a.innerHTML = "";
    actionButton(a, "Stop", "Stop following", () => showPreview(r), "stop");
    actionButton(a, "", "Copy remote path", () => copy(r.path), "copy");
    streamApi({ kind: "tail", path: r.path, lines: 500 }, (m) => {
      const t = m.o || m.e;
      if (!t) return;
      const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
      out.appendChild(document.createTextNode(t));
      if (out.textContent.length > 2000000) out.textContent = out.textContent.slice(-1000000);
      if (stick) body.scrollTop = body.scrollHeight;
    }, ac.signal).catch((e) => {
      if (e.name !== "AbortError" && S.follow?.ac === ac) out.appendChild(document.createTextNode(`\n[${e.message}]\n`));
    });
  }

  function clearPreview() {
    stopFollow();
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
      $("searchSummary").innerHTML = `${d.results.length}${d.truncated ? "+" : ""} ${what} <b>${esc(s.query)}</b> under <code>${esc(tilde(s.root))}</code>${d.timedOut ? " (timed out, partial results)" : ""}`;
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
  async function download(rows, mode = "default") {
    rows = rows.filter((r) => !r.up);
    if (!rows.length) return toast("Nothing selected");
    try {
      const d = await api("/api/download", { method: "POST", body: { mode, items: rows.map((r) => ({ path: r.path, isDir: r.d, size: r.d ? null : r.s })) } });
      trackJobs(d.jobs);
      const how = mode === "archive" ? "as one .tar.gz" : mode === "sync" ? "with rsync (sync)" : "";
      toast(`Downloading ${rows.length} item(s) ${how} → ${tilde2(S.info.download_dir)}`);
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
    if (S.info.platform !== "darwin") return toast("The file picker only works on macOS. Drag files onto the window instead.", "bad");
    try {
      const { paths } = await api("/api/pick", { method: "POST", body: { kind } });
      if (!paths.length) return;
      if (!confirmOverwrite(paths.map((p) => base(p)))) return;
      const dir = S.cwd;
      trackJobs((await api("/api/upload_paths", { method: "POST", body: { paths, dir } })).jobs);
      toast(`Uploading ${paths.length} item(s) → ${tilde(dir)}`);
      showTab("transfers"); pollJobs(true);
    } catch (e) { toast(e.message, "bad"); }
  }

  // browser drag&drop upload: browser → local server (temp) → scp → remote
  const staging = new Map();
  function uploadBrowserFiles(files) {
    files = [...files].filter((f) => f.size > 0 || f.type !== "");
    if (!files.length) return toast("Folders can't be dropped from the browser. Use Upload › Folder instead.", "bad");
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
        try { trackJobs(JSON.parse(xhr.responseText).jobs); } catch { }
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
  const pathList = (paths) => paths.slice(0, 15).join("\n") + (paths.length > 15 ? `\n…and ${paths.length - 15} more` : "");
  async function deletePermanently(paths) {
    const r = await api("/api/delete", { method: "POST", body: { paths, permanent: true } });
    r.errors.forEach((m) => toast(m, "bad"));
    if (r.deleted.length) toast(`Permanently deleted ${r.deleted.length} item(s)`, "ok");
  }
  async function deleteSel(permanent = false) {
    const rows = targetRows();
    if (!rows.length) return;
    const paths = rows.map((r) => r.path);
    try {
      if (permanent) {
        if (!confirm(`Permanently delete ${rows.length} item(s) on ${S.info.host}?\n\n${pathList(paths)}\n\nThis skips the trash and cannot be undone.`)) return;
        await deletePermanently(paths);
      } else {
        const r = await api("/api/delete", { method: "POST", body: { paths } });
        r.errors.forEach((m) => toast(m, "bad"));
        if (r.trashed.length) toast(`Moved ${r.trashed.length} item(s) to the trash`, "ok", { label: "Undo", fn: () => restoreTrash(r.trashed.map((t) => t.id)) });
        if (r.cross.length && confirm(`${r.cross.length} item(s) are on a different filesystem from your home folder:\n\n${pathList(r.cross)}\n\nMoving them to the trash would copy them into your home quota, so they can only be deleted permanently.\n\nDelete them permanently? This cannot be undone.`)) await deletePermanently(r.cross);
      }
      if (paths.includes(S.previewPath)) clearPreview();
      refresh();
    } catch (e) { toast(e.message, "bad"); }
  }

  // ------------------------------------------------------------------ trash
  async function restoreTrash(ids) {
    try {
      const r = await api("/api/trash/restore", { method: "POST", body: { ids } });
      r.errors.forEach((m) => toast(m, "bad"));
      if (r.restored.length) toast(`Restored ${r.restored.length} item(s)`, "ok");
      refresh(); if (!$("tab-trash").classList.contains("hidden")) loadTrash();
    } catch (e) { toast(e.message, "bad"); }
  }
  async function loadTrash() {
    const el = $("trashList");
    try {
      const { items, root } = await api("/api/trash");
      if (!items.length) { el.innerHTML = `<div class="jobs-empty">The trash is empty. Deleted items go to <code>${esc(tilde(root))}</code> on ${esc(S.info.host)}.</div>`; return; }
      el.innerHTML = `<table class="grid"><thead><tr><th>Original location</th><th>Deleted</th><th></th></tr></thead><tbody>` +
        items.map((it) => `<tr><td class="mono">${ic(it.d ? "folder" : "file", "fi" + (it.d ? " t-dir" : ""))}${esc(tilde(it.path))}</td><td class="mono">${fmtDate(it.ts)}</td>
          <td class="acts"><button data-restore="${esc(it.id)}">Restore</button> <button class="danger" data-purge="${esc(it.id)}">Delete</button></td></tr>`).join("") +
        `</tbody></table>`;
    } catch (e) { el.innerHTML = `<div class="jobs-empty error">${esc(e.message)}</div>`; }
  }
  $("trashList").addEventListener("click", async (e) => {
    const t = e.target;
    if (t.dataset.restore) restoreTrash([t.dataset.restore]);
    if (t.dataset.purge && confirm("Delete this item permanently? This cannot be undone.")) {
      try { await api("/api/trash/purge", { method: "POST", body: { ids: [t.dataset.purge] } }); loadTrash(); } catch (er) { toast(er.message, "bad"); }
    }
  });
  $("btnEmptyTrash").onclick = async () => {
    if (!confirm(`Permanently delete everything in the trash on ${S.info.host}? This cannot be undone.`)) return;
    try { await api("/api/trash/purge", { method: "POST", body: {} }); loadTrash(); toast("Trash emptied", "ok"); } catch (e) { toast(e.message, "bad"); }
  };

  // ------------------------------------------------------------------ clipboard (remote copy / move)
  function clipSel(mode) {
    const rows = targetRows();
    if (!rows.length) return;
    S.clip = { mode, paths: rows.map((r) => r.path), host: S.info.host };
    toast(`${rows.length} item(s) ${mode === "cut" ? "cut" : "copied"}: paste with ⌘V`);
    updatePasteBtn(); renderStatus();
  }
  function updatePasteBtn() {
    const on = S.clip && S.clip.host === S.info?.host;
    $("btnPaste").classList.toggle("hidden", !on);
    if (on) $("pasteLabel").textContent = `Paste ${S.clip.paths.length} ${S.clip.paths.length === 1 ? "item" : "items"}`;
  }
  async function paste(dest = S.cwd) {
    if (!S.clip || S.clip.host !== S.info.host) return toast("Nothing to paste: copy (⌘C) or cut (⌘X) first");
    try {
      const r = await api("/api/paste", { method: "POST", body: { mode: S.clip.mode === "cut" ? "move" : "copy", paths: S.clip.paths, dest } });
      r.errors.forEach((m) => toast(m, "bad"));
      if (!r.jobs.length) return;
      trackJobs(r.jobs);
      if (S.clip.mode === "cut") { S.clip = null; updatePasteBtn(); }
      showTab("transfers"); pollJobs(true);
    } catch (e) { toast(e.message, "bad"); }
  }

  // ------------------------------------------------------------------ folder sizes (du)
  async function measureSizes() {
    const dir = S.cwd;
    busy(true);
    toast("Measuring folder sizes (du can take a while on large trees)…");
    try {
      const d = await api("/api/du", { params: { path: dir } });
      if (S.cwd !== dir) return;
      S.entries.forEach((e) => { if (e.d && d.sizes[e.path] != null) { e.s = d.sizes[e.path]; e.du = true; } });
      S.sizesFor = dir; S.sizesTotal = d.total;
      S.sort = { key: "s", desc: true };
      render(); setCursor(0, { select: false, preview: false });
      if (d.timedOut) toast("du timed out: sizes are partial", "bad");
    } catch (e) { toast(e.message, "bad"); }
    finally { busy(false); }
  }

  // ------------------------------------------------------------------ slurm
  const SCRIPT_EXT = ["sh", "slurm", "sbatch", "job", "batch", "bash"];
  async function submitJob(r) {
    if (!confirm(`Submit ${base(r.path)} with sbatch on ${S.info.host}?\n\nIt runs from ${tilde(parent(r.path))} and uses your allocation.`)) return;
    try {
      const d = await api("/api/slurm/submit", { method: "POST", body: { path: r.path } });
      toast(d.out || "Submitted", "ok");
      showTab("slurm");
    } catch (e) { toast(e.message, "bad"); }
  }
  let slurmTimer = null;
  async function loadSlurm() {
    clearTimeout(slurmTimer);
    const el = $("slurmJobs");
    try {
      const d = await api("/api/slurm/jobs");
      if (!d.available) { el.innerHTML = `<div class="jobs-empty">Slurm (squeue) is not available on ${esc(S.info.host)}.</div>`; return; }
      const jobs = d.jobs || [];
      $("slurmBadge").textContent = jobs.length; $("slurmBadge").classList.toggle("hidden", !jobs.length);
      if (d.error) el.innerHTML = `<div class="jobs-empty error">${esc(d.error)}</div>`;
      else if (!jobs.length) el.innerHTML = `<div class="jobs-empty">No jobs in the queue (squeue --me). Right-click a job script and choose “Submit with sbatch”.</div>`;
      else el.innerHTML = `<table class="grid"><thead><tr><th>Job ID</th><th>Name</th><th>Partition</th><th>State</th><th>Time</th><th>Limit</th><th>Nodes</th><th>Reason / nodes</th><th>Account</th><th></th></tr></thead><tbody>` +
        jobs.map((j) => `<tr><td class="mono">${esc(j.id)}</td><td>${esc(j.name)}</td><td class="mono">${esc(j.partition)}</td>
          <td><span class="state st-${esc(j.state.toLowerCase())}">${esc(j.state)}</span></td><td class="mono">${esc(j.time)}</td><td class="mono">${esc(j.limit)}</td>
          <td class="mono">${esc(j.nodes)}</td><td class="mono">${esc(j.reason)}</td><td class="mono">${esc(j.account)}</td>
          <td class="acts"><button data-log="${esc(j.id)}" title="Follow the job's output file">Log</button> <button data-dir="${esc(j.workdir)}" title="Open the job's working folder">Folder</button> <button class="danger" data-scancel="${esc(j.id)}" data-name="${esc(j.name)}">Cancel</button></td></tr>`).join("") +
        `</tbody></table>`;
    } catch (e) { el.innerHTML = `<div class="jobs-empty error">${esc(e.message)}</div>`; }
    if (!$("tab-slurm").classList.contains("hidden") && !$("bottom").classList.contains("collapsed")) slurmTimer = setTimeout(loadSlurm, 15000);
  }
  $("slurmJobs").addEventListener("click", async (e) => {
    const t = e.target;
    try {
      if (t.dataset.scancel) {
        if (!confirm(`Cancel job ${t.dataset.scancel} (${t.dataset.name})?`)) return;
        await api("/api/slurm/cancel", { method: "POST", body: { id: t.dataset.scancel } });
        toast(`Cancelled job ${t.dataset.scancel}`, "ok"); setTimeout(loadSlurm, 800);
      }
      if (t.dataset.log) {
        const d = await api("/api/slurm/log", { params: { id: t.dataset.log } });
        if (!d.stdout) return toast("No output file recorded for this job", "bad");
        startFollow({ path: d.stdout });
      }
      if (t.dataset.dir) go(t.dataset.dir);
    } catch (er) { toast(er.message, "bad"); }
  });
  $("btnSlurmRefresh").onclick = loadSlurm;

  // ------------------------------------------------------------------ quota / billing
  function quotaBar(q) {
    const pct = q.limit ? Math.min(100, (q.used / q.limit) * 100) : 0;
    const cls = pct >= 95 ? "bad" : pct >= 80 ? "warn" : "";
    return `<div class="q" title="${esc(q.fs)}"><div class="q-top"><span>${esc(tilde(q.fs))}</span><span>${fmtSize(q.used)}${q.limit ? " / " + fmtSize(q.limit) : ""}</span></div>` +
      (q.limit ? `<div class="qbar ${cls}"><div style="width:${pct}%"></div></div>` : "") +
      (q.files_limit ? `<div class="q-files">${q.files.toLocaleString()} / ${q.files_limit.toLocaleString()} files</div>` : "") + `</div>`;
  }
  let lastQuota = null;
  async function loadQuota() {
    try {
      lastQuota = await api("/api/quota");
      $("quota").innerHTML = lastQuota.items.length ? lastQuota.items.map(quotaBar).join("") : `<div class="muted">No quota information.</div>`;
    } catch (e) { $("quota").innerHTML = `<div class="muted error">${esc(e.message)}</div>`; }
  }
  async function loadUsage() {
    const el = $("usage");
    el.innerHTML = `<div class="jobs-empty">Loading…</div>`;
    await loadQuota();
    let bill;
    try { bill = await api("/api/billing"); } catch (e) { bill = { error: e.message, accounts: [] }; }
    const accts = (bill.accounts || []).map((a) => `<button data-acct="${esc(a.name)}" title="billing -a ${esc(a.name)}">${esc(a.name)}${a.arch ? `<span class="arch">${a.arch}</span>` : ""}</button>`).join(" ");
    el.innerHTML = `<div class="usage-col"><h4>Storage quota</h4>${lastQuota && lastQuota.items.length ? lastQuota.items.map(quotaBar).join("") : ""}
        <pre class="raw">${esc(lastQuota?.raw || "")}</pre></div>
      <div class="usage-col"><h4>Compute billing</h4>
        ${bill.error ? `<div class="muted error">${esc(bill.error)}</div>` : bill.available ? `<pre class="raw">${esc(bill.output || "(no output)")}</pre>` : `<div class="muted">The <code>billing</code> command is not available on ${esc(S.info.host)}.</div>`}
        ${accts ? `<div class="acct-row"><span class="muted">Usage per user (account suffix: a = ARM, x = x86, g = GPU):</span> ${accts}</div>` : ""}
        <pre class="raw" id="acctOut"></pre></div>`;
  }
  $("usage").addEventListener("click", async (e) => {
    const a = e.target.dataset.acct;
    if (!a) return;
    $("acctOut").textContent = `billing -a ${a} …`;
    try { const d = await api("/api/billing", { params: { account: a } }); $("acctOut").textContent = d.output || "(no output)"; }
    catch (er) { $("acctOut").textContent = er.message; }
  });
  $("btnQuotaRefresh").onclick = loadQuota;
  $("btnUsage").onclick = () => showTab("usage");

  function renderXferMode() {
    const r = S.info?.rsync || {};
    $("xferMode").innerHTML = r.enabled
      ? `Transfers: rsync ${esc(r.local)}, resumable`
      : `Transfers: scp / tar. ${!r.local ? "For resume and sync install rsync 3.1+ (brew install rsync)." : "rsync is missing on the remote."}`;
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
  const JOB_ICON = { upload: "upload", download: "download", copy: "copy", move: "fwd" };
  const JOB_DONE = { upload: "Uploaded", download: "Downloaded", copy: "Copied", move: "Moved" };
  let pollHandle = null;
  // Register jobs the moment they are created, so one that finishes before the next poll
  // still counts as a running -> done transition (toast + refresh).
  const trackJobs = (jobs) => { if (jobs?.length) S.jobs = [...jobs, ...S.jobs.filter((j) => !jobs.some((n) => n.id === j.id))]; };
  async function pollJobs(fast) {
    clearTimeout(pollHandle);
    try {
      const prev = new Map(S.jobs.map((j) => [j.id, j.status]));
      S.jobs = await api("/api/jobs");
      for (const j of S.jobs) {
        if (prev.get(j.id) === "running" && j.status !== "running") {
          if (j.status === "done") {
            toast(`${JOB_DONE[j.kind] || "Finished"} ${j.label}${j.warning ? ` (${j.warning})` : ""}`, "ok");
            const touched = j.kind === "upload" ? [parent(j.dest)] : (j.kind === "copy" || j.kind === "move") ? [parent(j.dest), j.dest, ...(j.srcDirs || [])] : [];
            if (touched.includes(S.cwd) && !S.search) refresh();
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
        ? `<button data-cancel="${j.id}">Cancel</button>`
        : j.status === "done" && j.kind === "download" ? `<button data-reveal="${esc(j.dest)}">Show</button>`
        : j.status === "done" ? `<button data-goto="${esc(j.dest)}">Go to</button>`
        : (j.status === "error" || j.status === "cancelled") && j.resumable ? `<button data-resume="${j.id}" title="Continue with rsync, keeping what was already transferred">Resume</button>` : "";
      return `<div class="job ${j.status}">
        ${ic(JOB_ICON[j.kind] || "file")}
        <span class="lbl">${esc(j.label)}${j.method ? `<span class="tag">${esc(j.method)}</span>` : ""}<span class="dst">${esc(j.kind === "download" ? tilde2(j.dest) : j.dest)}</span></span>
        <div class="bar ${indet ? "indet" : ""}"><div style="width:${j.status === "done" ? 100 : pct}%"></div></div>
        <span class="stat">${fmtSize(j.done)}${j.total ? " / " + fmtSize(j.total) : ""}<br>${stat}</span>
        <span class="act">${actions}</span>
        ${j.error ? `<span class="err">${esc(j.error)}</span>` : ""}
        ${j.warning ? `<span class="warn">${esc(j.warning)}</span>` : ""}
      </div>`;
    }).join("");
  }

  $("jobs").addEventListener("click", async (e) => {
    const t = e.target;
    if (t.dataset.cancel) { await api("/api/jobs/cancel", { method: "POST", body: { id: t.dataset.cancel } }); pollJobs(true); }
    if (t.dataset.reveal) api("/api/reveal", { method: "POST", body: { path: t.dataset.reveal } });
    if (t.dataset.goto) go(parent(t.dataset.goto), { select: t.dataset.goto });
    if (t.dataset.resume) {
      try { trackJobs([(await api("/api/jobs/resume", { method: "POST", body: { id: t.dataset.resume } })).job]); pollJobs(true); }
      catch (er) { toast(er.message, "bad"); }
    }
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
    const ac = new AbortController();
    S.consoleRun = ac; consoleBusy(true);
    let code = null;
    try {
      await streamApi({ kind: "exec", cwd: S.cwd, cmd }, (m) => {
        if (m.o) consolePrint(esc(m.o));
        if (m.e) consolePrint(`<span class="err">${esc(m.e)}</span>`);
        if ("end" in m) code = m.end;
      }, ac.signal);
      if (code) consolePrint(`<span class="err">[exit ${code}]</span>\n`);
    } catch (e) {
      consolePrint(`<span class="err">${e.name === "AbortError" ? "^C (stopped)" : esc(e.message)}</span>\n`);
    } finally {
      S.consoleRun = null; consoleBusy(false);
    }
    if (!S.search) go(S.cwd, { push: false, select: S.rows[S.cursor]?.path });
  }
  function consoleBusy(on) {
    $("btnConsoleStop").classList.toggle("hidden", !on);
    $("consoleInput").placeholder = on ? "running… (Ctrl+C or Stop to interrupt)" : "run a command in the current folder (cd works too, Ctrl+C stops)";
  }
  const stopConsole = () => S.consoleRun?.abort();
  $("btnConsoleStop").onclick = stopConsole;
  $("consoleForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (S.consoleRun) return toast("A command is still running: Ctrl+C or Stop to interrupt it", "bad");
    const v = $("consoleInput").value; $("consoleInput").value = ""; runConsole(v);
  });
  $("consoleInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && S.consoleIdx > 0) { e.preventDefault(); $("consoleInput").value = S.consoleHist[--S.consoleIdx]; }
    if (e.key === "ArrowDown") { e.preventDefault(); S.consoleIdx = Math.min(S.consoleHist.length, S.consoleIdx + 1); $("consoleInput").value = S.consoleHist[S.consoleIdx] || ""; }
    if (e.key === "Escape") $("consoleInput").blur();
    if (e.ctrlKey && e.key.toLowerCase() === "c" && S.consoleRun && !window.getSelection().toString()) { e.preventDefault(); stopConsole(); }
  });

  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-body").forEach((b) => b.classList.toggle("hidden", b.id !== "tab-" + name));
    $("btnClearJobs").classList.toggle("hidden", name !== "transfers");
    $("btnSlurmRefresh").classList.toggle("hidden", name !== "slurm");
    $("btnEmptyTrash").classList.toggle("hidden", name !== "trash");
    $("bottom").classList.remove("collapsed");
    if (name === "console") $("consoleInput").focus();
    if (name === "slurm") loadSlurm();
    if (name === "usage") loadUsage();
    if (name === "trash") loadTrash();
  }
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
  $("btnToggleBottom").onclick = () => {
    $("bottom").classList.toggle("collapsed");
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
      li.innerHTML = `${ic(bm.path === S.info.home ? "home" : bm.path === "/" ? "server" : "folder")}<span class="bm-name">${esc(bm.name)}</span><button class="x" title="Remove bookmark">${ic("x", "sm")}</button>`;
      li.onclick = (e) => {
        if (e.target.closest(".x")) { b.splice(i, 1); saveBookmarks(b); renderBookmarks(); return; }
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
      items.push([`Download${rows.length > 1 ? " " + rows.length + " items" : ""}`, "D", () => download(rows)]);
      items.push(["Download as one .tar.gz", "", () => download(rows, "archive")]);
      if (S.info.rsync?.enabled) items.push(["Sync to this computer (rsync)", "", () => download(rows, "sync")]);
      if (!r.d) items.push(["Save as… (browser)", "", () => (location.href = rawUrl(r.path, true))]);
      if (!r.d) items.push(["Follow (tail -F)", "", () => startFollow(r)]);
      if (!r.d && SCRIPT_EXT.includes((r.name.split(".").pop() || "").toLowerCase())) items.push(["Submit with sbatch", "", () => submitJob(r)]);
      items.push(null);
      items.push(["Copy", "⌘C", () => clipSel("copy")]);
      items.push(["Cut", "⌘X", () => clipSel("cut")]);
      if (r.d && S.clip && S.clip.host === S.info.host) items.push(["Paste into folder", "", () => paste(r.path)]);
      items.push(["Copy path", "", () => copy(rows.map((x) => x.path).join("\n"))]);
      items.push(["Copy scp command", "", () => copy(`scp ${r.d ? "-r " : ""}${S.info.host}:'${r.path}' .`)]);
      items.push(["Open in Terminal", "T", () => openInTerminal(r.d ? r.path : parent(r.path))]);
      items.push(["Open in VS Code", "V", () => openInVSCode(r.path, r.d)]);
      if (r.d) items.push(["Bookmark", "", () => { const b = loadBookmarks(); b.push({ name: base(r.path), path: r.path }); saveBookmarks(b); renderBookmarks(); }]);
      if (r.d) items.push(["Search in here…", "", () => { $("searchInput").dataset.root = r.path; $("searchInput").placeholder = `Search in ${base(r.path)}…`; $("searchInput").focus(); }]);
      if (!S.search) {
        items.push(null);
        items.push(["Rename", "F2", renameSel]);
        items.push(["Move to trash", "Del", () => deleteSel(), "danger"]);
        items.push(["Delete permanently", "⇧Del", () => deleteSel(true), "danger"]);
      }
    }
    openMenu(items, e.clientX, e.clientY);
  });
  const MENU_ICON = [
    [/^(Open parent|Open$)/, "folder"], [/^Preview/, "file-text"], [/^Show in folder/, "folder"],
    [/^Download as one/, "archive"], [/^Download/, "download"], [/^Sync/, "refresh"], [/^Save as/, "file"],
    [/^Follow/, "play"], [/^Submit/, "server"], [/^Copy path|^Copy scp/, "copy"], [/^Copy$/, "copy"], [/^Cut/, "cut"],
    [/^Paste/, "paste"], [/^Open in Terminal/, "terminal"], [/^Open in VS Code/, "code"], [/^Bookmark/, "bookmark"],
    [/^Search/, "search"], [/^Rename/, "pencil"], [/^Move to trash|^Delete/, "trash"],
    [/^Files/, "upload"], [/^Folder/, "folder"], [/^File$/, "file"],
  ];
  function openMenu(items, x, y) {
    const m = $("ctxMenu"); m.innerHTML = "";
    items.forEach((it) => {
      if (!it) { m.appendChild(document.createElement("hr")); return; }
      const d = document.createElement("div");
      const iconName = (MENU_ICON.find(([re]) => re.test(it[0])) || [])[1];
      d.innerHTML = `${iconName ? ic(iconName) : `<svg class="ic"></svg>`}<span>${esc(it[0])}</span><small>${esc(it[1])}</small>`;
      if (it[3]) d.className = it[3];
      d.onclick = () => { hideCtx(); it[2](); };
      m.appendChild(d);
    });
    m.classList.remove("hidden");
    const { innerWidth: W, innerHeight: H } = window;
    const rect = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, W - rect.width - 8)) + "px";
    m.style.top = Math.max(8, Math.min(y, H - rect.height - 8)) + "px";
  }
  function menuButton(id, items) {
    $(id).onclick = (e) => {
      e.stopPropagation();  // the document click handler would close it again
      const r = $(id).getBoundingClientRect();
      openMenu(typeof items === "function" ? items() : items, r.left, r.bottom + 4);
    };
  }
  const hideCtx = () => $("ctxMenu").classList.add("hidden");
  document.addEventListener("click", (e) => { if (!e.target.closest("#ctxMenu")) hideCtx(); });

  // ------------------------------------------------------------------ keyboard
  const shortcuts = (on) => $("shortcuts").classList.toggle("hidden", !on);
  $("btnShortcuts").onclick = () => shortcuts(true);
  $("btnCloseShortcuts").onclick = () => shortcuts(false);
  $("shortcuts").addEventListener("click", (e) => { if (e.target.id === "shortcuts") shortcuts(false); });
  const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"); };
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") { e.preventDefault(); editPath(); return; }
    if (e.key === "Escape") { hideCtx(); shortcuts(false); }
    if (!$("shortcuts").classList.contains("hidden")) return;
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
      case "Delete": e.preventDefault(); deleteSel(e.shiftKey); break;
      case "`": e.preventDefault(); showTab("console"); break;
      case "~": e.preventDefault(); go(S.info.home); break;
      case "?": e.preventDefault(); shortcuts(true); break;
      default:
        if (e.metaKey || e.ctrlKey) {
          if (e.key.toLowerCase() === "a") { e.preventDefault(); S.rows.forEach((x) => !x.up && S.sel.add(x.path)); paintRows(); }
          if (e.key === "Backspace") { e.preventDefault(); deleteSel(e.shiftKey); }
          if (e.key.toLowerCase() === "c" && !e.shiftKey) { e.preventDefault(); clipSel("copy"); }
          if (e.key.toLowerCase() === "x") { e.preventDefault(); clipSel("cut"); }
          if (e.key.toLowerCase() === "v") { e.preventDefault(); paste(); }
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
  menuButton("btnUploadMenu", [["Files…", "", () => pickAndUpload("file")], ["Folder…", "", () => pickAndUpload("dir")]]);
  menuButton("btnDownloadMenu", () => [
    ["Download", "D", () => download(targetRows())],
    ["Download as one .tar.gz", "", () => download(targetRows(), "archive")],
    ...(S.info?.rsync?.enabled ? [["Sync to this computer (rsync)", "", () => download(targetRows(), "sync")]] : []),
  ]);
  menuButton("btnNewMenu", [["Folder", "", newFolder], ["File", "", newFile]]);
  $("btnRename").onclick = renameSel;
  $("btnDelete").onclick = (e) => deleteSel(e.shiftKey);
  $("btnPaste").onclick = () => paste();
  $("btnSizes").onclick = measureSizes;
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
        toast("Folders can't be dropped from the browser. Use Upload › Folder instead.", "bad");
      }
      const files = items.filter((it) => !(it.webkitGetAsEntry && it.webkitGetAsEntry()?.isDirectory)).map((it) => it.getAsFile()).filter(Boolean);
      if (files.length) uploadBrowserFiles(files);
    });
  })();

  // ------------------------------------------------------------------ boot
  async function applyInfo(info) {
    S.info = info;
    if (!info.connected) {
      $("hostText").textContent = `${info.host}: ${info.error || "disconnected"}`;
      $("connDot").className = "dot bad";
      return;
    }
    $("connDot").className = "dot ok";
    $("hostText").textContent = `${info.user}@${info.host}`;
    $("hostLabel").title = `${info.hostname}: click to switch SSH host`;
    $("dlDir").textContent = tilde2(info.download_dir);
    renderXferMode();
    if (S.clip && S.clip.host !== info.host) S.clip = null;
    updatePasteBtn();
    loadQuota();
    S.back = []; S.fwd = [];
    S.cwd = info.home;
    clearPreview();
    renderBookmarks();
    const last = localStorage.getItem("sshf-last-" + info.host);
    if (!(last && (await go(last, { push: false })))) await go(info.home, { push: false });
    $("tableWrap").focus();
  }

  $("hostLabel").onclick = async () => {
    const hosts = (S.info?.hosts || []).join(", ");
    const next = prompt(`Switch SSH host (from ~/.ssh/config: ${hosts}):`, S.info?.host || "deucalion");
    if (!next || next.trim() === S.info?.host) return;
    $("hostText").textContent = `connecting to ${next.trim()}…`;
    $("connDot").className = "dot";
    busy(true);
    try {
      const info = await api("/api/host", { method: "POST", body: { host: next.trim() } });
      await applyInfo(info);
    } catch (e) {
      toast(e.message, "bad");
      if (S.info) await applyInfo(S.info);
    } finally {
      busy(false);
    }
  };

  async function boot() {
    if (!TOKEN) { document.body.innerHTML = `<div class="placeholder" style="padding:60px;text-align:center">Missing access token. Open the URL printed by <code>server.py</code>.</div>`; return; }
    try {
      await api("/api/session", { method: "POST", body: {} });  // cookie for <img>/<video>/download URLs
      const info = await api("/api/info");
      await applyInfo(info);
    } catch (e) {
      $("hostText").textContent = "error: " + e.message; $("connDot").className = "dot bad"; return;
    }
    pollJobs();
  }
  boot();
})();
