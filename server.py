#!/usr/bin/env python3
"""
ssh-fetcher — a local web GUI to browse, search, preview and transfer files on a
remote host over SSH (built for `deucalion`, works with any ~/.ssh/config alias).

Only the Python standard library is used. All remote operations go through the
system `ssh` / `scp` binaries, so your ~/.ssh/config (keys, keychain, proxies)
is honoured. A single multiplexed SSH connection (ControlMaster) is reused for
every request, which keeps things fast.

Usage:
    python3 server.py                 # host "deucalion", port 8765
    python3 server.py --host myhost --port 9000 --no-browser
"""
import argparse
import base64
import json
import mimetypes
import os
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

STATIC_DIR = Path(__file__).resolve().parent / "static"
TEXT_PREVIEW_BYTES = 512 * 1024
HEX_PREVIEW_BYTES = 4096
MEDIA_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico",
    ".pdf", ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".ogg", ".flac", ".m4a",
}

# --------------------------------------------------------------------------- #
# Config / state
# --------------------------------------------------------------------------- #
CFG = {
    "host": "deucalion",
    "download_dir": str(Path.home() / "Downloads" / "deucalion"),
    "custom_dl": False,
}
TOKEN = secrets.token_urlsafe(24)
CONTROL_PATH = f"/tmp/sshfetch-{os.getuid()}-%C"


def list_ssh_hosts():
    hosts = []
    cfg_path = Path.home() / ".ssh" / "config"
    if cfg_path.is_file():
        for raw in cfg_path.read_text("utf-8", "replace").splitlines():
            line = raw.split("#", 1)[0].strip()
            if line.lower().startswith("host "):
                for tok in line.split()[1:]:
                    if any(c in tok for c in "*?!") or tok.lower() in ("github", "github.com", "gitlab", "gitlab.com", "bitbucket.org"):
                        continue
                    if tok not in hosts:
                        hosts.append(tok)
    if CFG["host"] not in hosts:
        hosts.insert(0, CFG["host"])
    return hosts


def ssh_opts(batch=True):
    o = [
        "-o", "ControlMaster=auto",
        "-o", f"ControlPath={CONTROL_PATH}",
        "-o", "ControlPersist=900",
        "-o", "ServerAliveInterval=30",
    ]
    if batch:
        o += ["-o", "BatchMode=yes"]
    return o


def q(s):
    return shlex.quote(str(s))


def scp_remote_path(p):
    """scp (SFTP mode, OpenSSH >= 9) glob-expands remote paths; escape metachars."""
    out = []
    for ch in str(p):
        if ch in "*?[]\\":
            out.append("\\")
        out.append(ch)
    return "".join(out)


# Persistent remote agent (Python 3.6 compatible). Opening a new SSH session on
# Deucalion costs ~1s (PAM + shell init), so instead we keep a small pool of
# long-lived sessions running this tiny JSON-lines RPC loop.
AGENT = r"""
import sys, os, json, stat, pwd, subprocess, base64, signal
import time
users = {}
budget = [0.0]
def owner(uid):
    if uid not in users:
        if budget[0] > 1.0:  # name-service lookups can be slow (LDAP); cap per listing
            return str(uid)
        t = time.time()
        try: users[uid] = pwd.getpwuid(uid).pw_name
        except Exception: users[uid] = str(uid)
        budget[0] += time.time() - t
    return users[uid]
def ls(base='', target=''):
    budget[0] = 0.0
    p = os.path.expanduser(target or '~')
    if not os.path.isabs(p):
        p = os.path.join(os.path.expanduser(base or '~'), p)
    p = os.path.abspath(p)
    if not os.path.isdir(p):
        return {'error': 'Not a directory: ' + p, 'path': p}
    out = []
    for e in os.scandir(p):
        broken = False
        try:
            st = e.stat(follow_symlinks=True)
        except OSError:
            st = e.stat(follow_symlinks=False); broken = True
        d = {'n': e.name, 'd': stat.S_ISDIR(st.st_mode), 's': st.st_size,
             'm': int(st.st_mtime), 'p': stat.filemode(st.st_mode),
             'o': owner(st.st_uid), 'l': e.is_symlink(), 'b': broken}
        if d['l']:
            try: d['t'] = os.readlink(e.path)
            except OSError: pass
        out.append(d)
    return {'path': p, 'entries': out}
def sh(cmd, timeout=60, binary=False, input=None):
    p = subprocess.Popen(['/bin/bash', '-c', cmd],
        stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = p.communicate(base64.b64decode(input) if input is not None else None, timeout=timeout)
        code = p.returncode
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid, signal.SIGKILL)
        except Exception: pass
        out, err = p.communicate()
        code = 124
    r = {'code': code, 'stderr': err.decode('utf-8', 'replace')}
    if binary: r['b64'] = base64.b64encode(out).decode()
    else: r['stdout'] = out.decode('utf-8', 'replace')
    return r
os.chdir(os.path.expanduser('~'))
sys.stdout.write('\nREADY\n'); sys.stdout.flush()
while True:
    line = sys.stdin.readline()
    if not line: break
    try:
        req = json.loads(line)
        op = req.pop('op')
        res = ls(**req) if op == 'ls' else sh(**req)
    except Exception as ex:
        res = {'error': str(ex), 'code': 1, 'stdout': '', 'stderr': str(ex)}
    sys.stdout.write(json.dumps(res) + '\n'); sys.stdout.flush()
"""


class Agent:
    def __init__(self):
        self.p = subprocess.Popen(
            ["ssh", *ssh_opts(), CFG["host"], f"python3 -u -c {q(AGENT)}"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        while True:  # skip anything the remote shell init prints
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("remote agent failed to start")
            if line.strip() == b"READY":
                break

    def alive(self):
        return self.p.poll() is None

    def call(self, req):
        self.p.stdin.write((json.dumps(req) + "\n").encode())
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("remote agent died")
        return json.loads(line)

    def kill(self):
        try:
            self.p.kill()
        except Exception:
            pass


class AgentPool:
    def __init__(self, size=6):
        self.size, self.idle, self.total = size, [], 0
        self.cv = threading.Condition()

    def acquire(self):
        with self.cv:
            while True:
                while self.idle:
                    a = self.idle.pop()
                    if a.alive():
                        return a
                    self.total -= 1
                if self.total < self.size:
                    self.total += 1
                    break
                self.cv.wait()
        try:
            return Agent()
        except Exception:
            with self.cv:
                self.total -= 1
                self.cv.notify()
            raise

    def release(self, a, ok=True):
        with self.cv:
            if ok and a.alive():
                self.idle.append(a)
            else:
                self.total -= 1
                a.kill()
            self.cv.notify()

    def call(self, req):
        a = self.acquire()
        try:
            r = a.call(req)
        except Exception:
            self.release(a, ok=False)
            raise
        self.release(a)
        return r

    def warm(self, n=2):
        agents = [self.acquire() for _ in range(n)]
        for a in agents:
            self.release(a)

    def close(self):
        with self.cv:
            for a in self.idle:
                a.kill()
            self.idle.clear()


POOL = AgentPool()


def run_remote_direct(cmd, timeout=60, binary=False, input_bytes=None):
    try:
        r = subprocess.run(["ssh", *ssh_opts(), CFG["host"], cmd],
                           input=input_bytes, capture_output=True, timeout=timeout + 15)
    except subprocess.TimeoutExpired:
        return 124, (b"" if binary else ""), "Timed out"
    out = r.stdout if binary else r.stdout.decode("utf-8", "replace")
    return r.returncode, out, r.stderr.decode("utf-8", "replace")


def run_remote(cmd, timeout=60, binary=False, input_bytes=None):
    """Run a shell command on the remote host. Returns (code, stdout, stderr)."""
    req = {"op": "sh", "cmd": cmd, "timeout": timeout, "binary": binary}
    if input_bytes is not None:
        req["input"] = base64.b64encode(input_bytes).decode()
    try:
        r = POOL.call(req)
    except Exception:
        return run_remote_direct(cmd, timeout, binary, input_bytes)
    out = base64.b64decode(r.get("b64", "")) if binary else r.get("stdout", "")
    return r.get("code", 1), out, r.get("stderr", "")


def remote_ls(base, target):
    return POOL.call({"op": "ls", "base": base, "target": target})


def ensure_master():
    """Open the multiplexed master connection (may prompt for passphrase / 2FA)."""
    chk = subprocess.run(
        ["ssh", *ssh_opts(), "-O", "check", CFG["host"]], capture_output=True
    )
    if chk.returncode == 0:
        return True
    print(f"[ssh-fetcher] connecting to {CFG['host']} ...", flush=True)
    r = subprocess.run(["ssh", *ssh_opts(batch=False), "-MNf", CFG["host"]])
    return r.returncode == 0


# --------------------------------------------------------------------------- #
# Transfer jobs
# --------------------------------------------------------------------------- #
JOBS = {}
JOBS_LOCK = threading.Lock()


def new_job(kind, label, total=None):
    j = {
        "id": uuid.uuid4().hex[:10], "kind": kind, "label": label,
        "status": "running", "total": total, "done": 0, "error": "",
        "started": time.time(), "finished": None, "dest": "",
    }
    with JOBS_LOCK:
        JOBS[j["id"]] = j
    return j


def local_size(path):
    p = Path(path)
    if not p.exists():
        return 0
    if p.is_file():
        return p.stat().st_size
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def remote_size(path, timeout=20):
    code, out, _ = run_remote(f"du -sb {q(path)} 2>/dev/null | cut -f1", timeout=timeout)
    try:
        return int(out.strip())
    except ValueError:
        return None


def unique_local(dest_dir, name):
    target = Path(dest_dir) / name
    if not target.exists():
        return target
    stem, suf = (name, "") if Path(name).name.startswith(".") else (Path(name).stem, Path(name).suffix)
    i = 1
    while True:
        cand = Path(dest_dir) / f"{stem} ({i}){suf}"
        if not cand.exists():
            return cand
        i += 1


def run_scp(job, args, progress_fn):
    proc = subprocess.Popen(
        ["scp", *ssh_opts(), "-p", *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    job["_proc"] = proc
    while proc.poll() is None:
        try:
            v = progress_fn()
            if v is not None:
                job["done"] = v
        except Exception:
            pass
        time.sleep(1.0)
    err = proc.stderr.read().decode("utf-8", "replace").strip()
    job["finished"] = time.time()
    if job["status"] == "cancelled":
        return False
    if proc.returncode == 0:
        job["status"] = "done"
        if job["total"]:
            job["done"] = job["total"]
        return True
    job["status"] = "error"
    job["error"] = err or f"scp exited with {proc.returncode}"
    return False


def start_download(items):
    """items: list of {path, isDir, size}"""
    dest_dir = Path(CFG["download_dir"]).expanduser()
    dest_dir.mkdir(parents=True, exist_ok=True)
    jobs = []
    for it in items:
        rpath = it["path"]
        name = os.path.basename(rpath.rstrip("/")) or "root"
        job = new_job("download", name, it.get("size") if not it.get("isDir") else None)
        target = unique_local(dest_dir, name)
        job["dest"] = str(target)
        jobs.append(job)

        def work(job=job, rpath=rpath, target=target, is_dir=it.get("isDir")):
            if is_dir:
                job["total"] = remote_size(rpath)
            args = (["-r"] if is_dir else []) + [
                f"{CFG['host']}:{scp_remote_path(rpath)}", str(target)]
            run_scp(job, args, lambda: local_size(target))

        threading.Thread(target=work, daemon=True).start()
    return [public_job(j) for j in jobs]


def start_upload(local_paths, remote_dir, cleanup=None, label=None):
    """Upload local files/folders to remote_dir with scp -r."""
    jobs = []
    for lp in local_paths:
        lp = str(lp)
        name = os.path.basename(lp.rstrip("/"))
        job = new_job("upload", label or name, local_size(lp))
        rtarget = remote_dir.rstrip("/") + "/" + name
        job["dest"] = rtarget
        jobs.append(job)

        def work(job=job, lp=lp, rtarget=rtarget):
            try:
                run_scp(
                    job,
                    ["-r", lp, f"{CFG['host']}:{scp_remote_path(rtarget)}"],
                    lambda: remote_size(rtarget, timeout=5),
                )
            finally:
                if cleanup:
                    shutil.rmtree(cleanup, ignore_errors=True)

        threading.Thread(target=work, daemon=True).start()
    return [public_job(j) for j in jobs]


def public_job(j):
    return {k: v for k, v in j.items() if not k.startswith("_")}


# --------------------------------------------------------------------------- #
# macOS helpers
# --------------------------------------------------------------------------- #
def mac_pick(kind):
    if sys.platform != "darwin":
        raise RuntimeError("Native picker only available on macOS")
    if kind == "dir":
        chooser = 'choose folder with prompt "Choose folder(s)" with multiple selections allowed'
    elif kind == "dest":
        chooser = 'choose folder with prompt "Choose download destination"'
    else:
        chooser = 'choose file with prompt "Choose file(s) to upload" with multiple selections allowed'
    script = f"""
    set picked to ({chooser})
    if class of picked is not list then set picked to {{picked}}
    set out to ""
    repeat with x in picked
        set out to out & POSIX path of x & linefeed
    end repeat
    return out
    """
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode != 0:
        return []
    return [l for l in r.stdout.splitlines() if l.strip()]


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "ssh-fetcher/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        if "/api/jobs" not in (args[0] if args else ""):
            sys.stderr.write("[http] " + (fmt % args) + "\n")

    # ---- helpers ----
    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def err(self, msg, status=400):
        self.send_json({"error": msg}, status)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def authorized(self, qs):
        tok = self.headers.get("X-Token") or (qs.get("token") or [""])[0]
        return secrets.compare_digest(tok, TOKEN)

    # ---- routing ----
    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if not u.path.startswith("/api/"):
            return self.serve_static(u.path)
        if not self.authorized(qs):
            return self.err("unauthorized", 401)
        g = lambda k, d="": (qs.get(k) or [d])[0]
        try:
            if u.path == "/api/info":
                return self.api_info()
            if u.path == "/api/ls":
                return self.api_ls(g("base"), g("path"))
            if u.path == "/api/preview":
                return self.api_preview(g("path"))
            if u.path == "/api/raw":
                return self.api_raw(g("path"), g("dl") == "1")
            if u.path == "/api/search":
                return self.api_search(g("path"), g("q"), g("mode", "name"),
                                       g("hidden") == "1", g("regex") == "1",
                                       g("case") == "1")
            if u.path == "/api/jobs":
                with JOBS_LOCK:
                    js = [public_job(j) for j in JOBS.values()]
                return self.send_json(sorted(js, key=lambda j: -j["started"]))
            return self.err("not found", 404)
        except BrokenPipeError:
            pass
        except Exception as ex:  # noqa
            return self.err(str(ex), 500)

    def do_POST(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if not self.authorized(qs):
            return self.err("unauthorized", 401)
        g = lambda k, d="": (qs.get(k) or [d])[0]
        try:
            if u.path == "/api/upload_raw":
                return self.api_upload_raw(g("dir"), g("name"))
            b = self.body_json()
            route = {
                "/api/download": lambda: self.send_json({"jobs": start_download(b["items"])}),
                "/api/upload_paths": lambda: self.send_json(
                    {"jobs": start_upload(b["paths"], b["dir"])}),
                "/api/pick": lambda: self.send_json({"paths": mac_pick(b.get("kind", "file"))}),
                "/api/mkdir": lambda: self.simple_remote(f"mkdir -p -- {q(b['path'])}"),
                "/api/touch": lambda: self.simple_remote(
                    f"[ -e {q(b['path'])} ] && echo 'File exists' >&2 && exit 1; touch -- {q(b['path'])}"),
                "/api/rename": lambda: self.simple_remote(
                    f"[ -e {q(b['dst'])} ] && echo 'Target exists' >&2 && exit 1; mv -- {q(b['src'])} {q(b['dst'])}"),
                "/api/delete": lambda: self.simple_remote(
                    "rm -rf -- " + " ".join(q(p) for p in b["paths"] if p not in ("/", "", "~"))),
                "/api/save": lambda: self.api_save(b["path"], b["content"]),
                "/api/exec": lambda: self.api_exec(b.get("cwd", "~"), b["cmd"]),
                "/api/config": lambda: self.api_config(b),
                "/api/host": lambda: self.api_switch_host(b["host"]),
                "/api/reveal": lambda: self.api_reveal(b["path"]),
                "/api/open_terminal": lambda: self.api_open_terminal(b["path"]),
                "/api/open_vscode": lambda: self.api_open_vscode(b["path"], b.get("isDir", True)),
                "/api/jobs/clear": lambda: self.api_jobs_clear(),
                "/api/jobs/cancel": lambda: self.api_jobs_cancel(b["id"]),
            }.get(u.path)
            if not route:
                return self.err("not found", 404)
            return route()
        except KeyError as ex:
            return self.err(f"missing field {ex}")
        except Exception as ex:  # noqa
            return self.err(str(ex), 500)

    # ---- static ----
    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        f = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR not in f.parents or not f.is_file():
            return self.err("not found", 404)
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(f))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---- API ----
    def api_info(self):
        code, out, err = run_remote('echo "$HOME"; hostname; whoami', timeout=20)
        if code != 0:
            return self.send_json({"connected": False, "error": err.strip(), "host": CFG["host"], "hosts": list_ssh_hosts()})
        home, hostname, user = (out.strip().splitlines() + ["", "", ""])[:3]
        # turn `alias foo='cd /some/dir'` lines from ~/.bashrc into bookmarks
        aliases = []
        _, aout, _ = run_remote(
            r"""grep -hE "^\s*alias [A-Za-z0-9_.-]+=['\"]cd " ~/.bashrc ~/.bash_aliases 2>/dev/null""",
            timeout=10)
        for line in aout.splitlines():
            try:
                name, _, rhs = line.strip()[6:].partition("=")
                target = rhs.strip().strip("'\"")[3:].strip()
                if target and ";" not in target and "&" not in target:
                    aliases.append({"name": name, "path": target.replace("~", home, 1) if target.startswith("~") else target})
            except Exception:
                pass
        self.send_json({"connected": True, "host": CFG["host"], "hosts": list_ssh_hosts(),
                        "home": home, "aliases": aliases,
                        "hostname": hostname, "user": user,
                        "download_dir": CFG["download_dir"], "platform": sys.platform})

    def api_ls(self, base, path):
        res = remote_ls(base, path)
        self.send_json(res, 200 if "entries" in res else 400)

    def api_preview(self, path):
        code, out, err = run_remote(
            f"stat -L -c '%s %F' -- {q(path)} && file -b -L --mime-type -- {q(path)}", timeout=30)
        if code != 0:
            return self.err(err.strip() or "cannot stat file", 500)
        lines = out.strip().splitlines()
        size_s, _, ftype = lines[0].partition(" ")
        size = int(size_s)
        mime = lines[1].strip() if len(lines) > 1 else "application/octet-stream"
        ext = os.path.splitext(path)[1].lower()
        if "directory" in ftype:
            return self.send_json({"kind": "dir", "size": size, "mime": mime})
        if ext == ".svg":
            mime = "image/svg+xml"
        if (mime.startswith(("image/", "video/", "audio/")) or mime == "application/pdf") and (
                ext in MEDIA_EXT or not mime.startswith("image/x-")):
            return self.send_json({"kind": "media", "size": size, "mime": mime})
        code, data, err = run_remote(f"head -c {TEXT_PREVIEW_BYTES} -- {q(path)}",
                                     timeout=60, binary=True)
        if code != 0:
            return self.err(err.strip() or "cannot read file", 500)
        if b"\x00" in data[:8192] and not mime.startswith("text/"):
            chunk = data[:HEX_PREVIEW_BYTES]
            rows = []
            for i in range(0, len(chunk), 16):
                row = chunk[i:i + 16]
                hexs = " ".join(f"{c:02x}" for c in row)
                asc = "".join(chr(c) if 32 <= c < 127 else "." for c in row)
                rows.append(f"{i:08x}  {hexs:<47}  {asc}")
            return self.send_json({"kind": "binary", "size": size, "mime": mime,
                                   "content": "\n".join(rows)})
        return self.send_json({
            "kind": "text", "size": size, "mime": mime,
            "content": data.decode("utf-8", "replace"),
            "truncated": size > len(data),
        })

    def api_raw(self, path, as_download):
        code, out, err = run_remote(f"stat -L -c %s -- {q(path)}", timeout=20)
        if code != 0:
            return self.err(err.strip() or "cannot stat", 500)
        size = int(out.strip())
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        name = os.path.basename(path)
        disp = "attachment" if as_download else "inline"
        if size <= 48 * 1024 * 1024:  # small enough: fetch through the fast agent
            code, data, err = run_remote(f"cat -- {q(path)}", timeout=300, binary=True)
            if code != 0:
                return self.err(err.strip() or "cannot read", 500)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", f"{disp}; filename*=UTF-8''{quote(name)}")
            self.end_headers()
            self.wfile.write(data)
            return
        proc = subprocess.Popen(["ssh", *ssh_opts(), CFG["host"], f"cat -- {q(path)}"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f"{disp}; filename*=UTF-8''{quote(name)}")
            self.end_headers()
            while True:
                chunk = proc.stdout.read(256 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            proc.kill()

    def api_search(self, path, query, mode, hidden, regex, case):
        if not query:
            return self.err("empty query")
        limit = 1000
        if mode == "content":
            flags = "-rInH" + ("" if case else "i") + ("E" if regex else "F")
            excl = "" if hidden else "--exclude-dir='.*' --exclude='.*'"
            cmd = (f"timeout 90 grep {flags} -m 20 {excl} -- {q(query)} {q(path)} "
                   f"2>/dev/null | cut -c1-500 | head -n {limit}")
        else:
            test = ("-regex" if case else "-iregex") if regex else ("-name" if case else "-iname")
            pat = f".*{query}.*" if regex else f"*{query}*"
            hid = "" if hidden else r"-not -path '*/.*'"
            cmd = (f"timeout 90 find {q(path)} -mindepth 1 {hid} {test} {q(pat)} "
                   f"-printf '%y\\t%s\\t%T@\\t%p\\n' 2>/dev/null | head -n {limit}")
        code, out, err = run_remote(cmd, timeout=120)
        results = []
        for line in out.splitlines():
            if mode == "content":
                fp, _, rest = line.partition(":")
                ln, _, text = rest.partition(":")
                if not ln.isdigit():
                    continue
                results.append({"path": fp, "line": int(ln), "text": text})
            else:
                parts = line.split("\t", 3)
                if len(parts) != 4:
                    continue
                t, s, m, p = parts
                results.append({"path": p, "d": t == "d", "s": int(s or 0),
                                "m": int(float(m or 0))})
        self.send_json({"results": results, "truncated": len(results) >= limit,
                        "timedOut": code == 124})

    def api_upload_raw(self, remote_dir, name):
        name = os.path.basename(name)
        if not name or not remote_dir:
            return self.err("missing dir/name")
        n = int(self.headers.get("Content-Length") or 0)
        tmpd = tempfile.mkdtemp(prefix="sshfetch-")
        lp = os.path.join(tmpd, name)
        with open(lp, "wb") as f:
            remaining = n
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        jobs = start_upload([lp], remote_dir, cleanup=tmpd)
        self.send_json({"jobs": jobs})

    def api_save(self, path, content):
        code, _, err = run_remote(f"cat > {q(path)}", timeout=120,
                                  input_bytes=content.encode("utf-8"))
        if code != 0:
            return self.err(err.strip() or "save failed", 500)
        self.send_json({"ok": True})

    def simple_remote(self, cmd):
        code, out, err = run_remote(cmd, timeout=120)
        if code != 0:
            return self.err(err.strip() or f"command failed ({code})", 500)
        self.send_json({"ok": True, "out": out})

    def api_exec(self, cwd, cmd):
        full = f"cd {q(cwd)} 2>/dev/null || cd; {cmd}"
        code, out, err = run_remote(full, timeout=300)
        self.send_json({"code": code, "stdout": out, "stderr": err})

    def api_config(self, b):
        if b.get("download_dir"):
            d = Path(b["download_dir"]).expanduser()
            d.mkdir(parents=True, exist_ok=True)
            CFG["download_dir"] = str(d)
            CFG["custom_dl"] = True
        self.send_json({"download_dir": CFG["download_dir"]})

    def api_switch_host(self, host):
        host = host.strip()
        if not host:
            return self.err("empty host")
        POOL.close()
        CFG["host"] = host
        if not CFG["custom_dl"]:
            safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in host)
            CFG["download_dir"] = str(Path.home() / "Downloads" / safe)
        ensure_master()
        try:
            POOL.warm(1)
        except Exception:
            pass
        return self.api_info()

    def api_reveal(self, path):
        p = Path(path).expanduser()
        if sys.platform == "darwin":
            subprocess.run(["open", "-R", str(p)] if p.exists() else ["open", str(p.parent)])
        else:
            subprocess.run(["xdg-open", str(p if p.is_dir() else p.parent)])
        self.send_json({"ok": True})

    def api_open_terminal(self, path):
        remote_cmd = f"cd -- {q(path)} && exec $SHELL -l"
        ssh_cmd = f"ssh -t {q(CFG['host'])} {q(remote_cmd)}"
        if sys.platform == "darwin":
            if Path("/Applications/iTerm.app").exists():
                script = """
                on run argv
                    set sshCmd to item 1 of argv
                    tell application "iTerm"
                        activate
                        if (count of windows) = 0 then
                            create window with default profile command sshCmd
                        else
                            tell current window
                                create tab with default profile command sshCmd
                            end tell
                        end if
                    end tell
                end run
                """
                app_name = "iTerm"
            else:
                script = """
                on run argv
                    set sshCmd to item 1 of argv
                    tell application "Terminal"
                        activate
                        do script sshCmd
                    end tell
                end run
                """
                app_name = "Terminal"
            r = subprocess.run(["osascript", "-e", script, "--", ssh_cmd],
                               capture_output=True, text=True)
            if r.returncode != 0:
                return self.err(r.stderr.strip() or f"Failed to open {app_name}", 500)
            return self.send_json({"ok": True, "app": app_name})
        for term in ("x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"):
            if shutil.which(term):
                subprocess.Popen([term, "-e", "sh", "-c", ssh_cmd])
                return self.send_json({"ok": True, "app": term})
        return self.err("No supported terminal emulator found", 500)

    def api_open_vscode(self, path, is_dir=True):
        if not path.startswith("/"):
            path = "/" + path
        uri = f"vscode-remote://ssh-remote+{quote(CFG['host'])}{quote(path, safe='/')}"
        flag = "--folder-uri" if is_dir else "--file-uri"
        code_bin = (
            shutil.which("code")
            or ("/usr/local/bin/code" if Path("/usr/local/bin/code").exists() else None)
            or (
                "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
                if Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code").exists()
                else None
            )
        )
        if code_bin:
            r = subprocess.run([code_bin, flag, uri], capture_output=True, text=True)
            if r.returncode != 0:
                return self.err(r.stderr.strip() or "Failed to launch VS Code", 500)
            return self.send_json({"ok": True})
        if sys.platform == "darwin":
            url = f"vscode://vscode-remote/ssh-remote+{quote(CFG['host'])}{quote(path, safe='/')}"
            subprocess.run(["open", url])
            return self.send_json({"ok": True})
        return self.err("VS Code CLI ('code') not found in PATH", 500)

    def api_jobs_clear(self):
        with JOBS_LOCK:
            for k in [k for k, j in JOBS.items() if j["status"] != "running"]:
                del JOBS[k]
        self.send_json({"ok": True})

    def api_jobs_cancel(self, jid):
        j = JOBS.get(jid)
        if j and j["status"] == "running" and j.get("_proc"):
            j["status"] = "cancelled"
            j["_proc"].terminate()
        self.send_json({"ok": True})


def main():
    ap = argparse.ArgumentParser(description="GUI file browser over SSH")
    ap.add_argument("--host", default=CFG["host"], help="ssh host alias or user@host (default: deucalion)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--download-dir", default=None, help="local download directory (default: ~/Downloads/<host>)")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    CFG["host"] = a.host
    if a.download_dir:
        CFG["download_dir"] = str(Path(a.download_dir).expanduser())
        CFG["custom_dl"] = True
    else:
        safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in a.host)
        CFG["download_dir"] = str(Path.home() / "Downloads" / safe)

    if not ensure_master():
        print(f"[ssh-fetcher] could not connect to {a.host}", file=sys.stderr)
        sys.exit(1)

    try:
        POOL.warm(2)
    except Exception as ex:
        print(f"[ssh-fetcher] warning: remote agent unavailable ({ex}); using plain ssh", file=sys.stderr)

    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    srv.daemon_threads = True
    url = f"http://127.0.0.1:{a.port}/#token={TOKEN}"
    print(f"[ssh-fetcher] {a.host} ready → {url}", flush=True)
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[ssh-fetcher] bye")
    finally:
        POOL.close()
        subprocess.run(["ssh", *ssh_opts(), "-O", "exit", CFG["host"]], capture_output=True)


if __name__ == "__main__":
    main()
