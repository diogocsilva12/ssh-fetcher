#!/usr/bin/env python3
"""
ssh-fetcher: a local web GUI to browse, search, preview and transfer files on a
remote host over SSH (built for `deucalion`, works with any ~/.ssh/config alias).

Only the Python standard library is used. All remote operations go through the
system `ssh` / `scp` / `rsync` binaries, so your ~/.ssh/config (keys, keychain,
proxies) is honoured. A single multiplexed SSH connection (ControlMaster) is
reused for every request, which keeps things fast.

Usage:
    python3 server.py                 # host "deucalion", port 8765 (or the next free one)
    python3 server.py --host myhost --port 9000 --no-browser
"""
import argparse
import base64
import codecs
import errno
import json
import mimetypes
import os
import posixpath
import re
import secrets
import selectors
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

# Served from /api/raw as attachments only: rendered inline they could run script.
SCRIPTABLE_TYPES = {
    "text/html", "application/xhtml+xml", "image/svg+xml",
    "text/xml", "application/xml", "application/javascript", "text/javascript",
}

# The app page may only run its own bundled scripts, so injected markup cannot execute.
STATIC_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; "
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; "
    "frame-ancestors 'none'"
)

# --------------------------------------------------------------------------- #
# Config / state
# --------------------------------------------------------------------------- #
CFG = {
    "host": "deucalion",
    "download_dir": str(Path.home() / "Downloads" / "deucalion"),
    "custom_dl": False,
    "remote_rsync": None,  # cached per host: True / False / None (unknown)
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


def safe_name(host):
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in host)


# --------------------------------------------------------------------------- #
# Remote helpers (Python 3.6 compatible). They run inside the persistent agent
# ("py" op) or, if the agent is unavailable, through `python3 -c`.
# --------------------------------------------------------------------------- #
HELPERS = r"""
import sys, os, json, stat, subprocess, base64, time, errno, shutil, random

TRASH = os.path.join(os.path.expanduser('~'), '.ssh-fetcher-trash')

def _home():
    return os.path.realpath(os.path.expanduser('~'))

def _resolve(path):
    # Resolve the parent but not the entry itself, so a symlink is handled as the link.
    path = os.path.expanduser(path)
    parent, name = os.path.split(os.path.abspath(path).rstrip('/') or '/')
    return os.path.join(os.path.realpath(parent), name) if name else '/'

def _refusal(path):
    # Return a reason why `path` must never be deleted, or None.
    p = _resolve(path)
    real = p if os.path.islink(p) else os.path.realpath(p)
    home = _home()
    if real == '/' or real.count('/') < 2:
        return 'refusing to delete a top-level folder: ' + real
    if real == home or home.startswith(real.rstrip('/') + '/'):
        return 'refusing to delete your home folder or one of its parents: ' + real
    trash = os.path.realpath(TRASH)
    if real == trash or trash.startswith(real.rstrip('/') + '/'):
        return 'refusing to delete the trash folder itself: ' + real
    if not os.path.lexists(p):
        return 'no such file or folder: ' + p
    return None

def trash(paths):
    out = {'trashed': [], 'cross': [], 'errors': []}
    if not os.path.isdir(TRASH):
        os.makedirs(TRASH, 0o700)
    tdev = os.stat(TRASH).st_dev
    real_trash = os.path.realpath(TRASH)
    for path in paths:
        why = _refusal(path)
        if why:
            out['errors'].append(why); continue
        p = _resolve(path)
        if p.startswith(real_trash + '/'):
            out['errors'].append('already in the trash: ' + p); continue
        if os.lstat(p).st_dev != tdev:
            out['cross'].append(p); continue
        tid = '%d-%06x' % (int(time.time() * 1000), random.getrandbits(24))
        entry = os.path.join(TRASH, tid)
        os.mkdir(entry)
        try:
            os.rename(p, os.path.join(entry, os.path.basename(p)))  # rename only: never copies
        except OSError as ex:
            os.rmdir(entry)
            if ex.errno == errno.EXDEV:
                out['cross'].append(p)
            else:
                out['errors'].append('%s: %s' % (p, ex.strerror))
            continue
        with open(os.path.join(entry, '.sshf-origin'), 'w') as f:
            json.dump({'path': p, 'ts': int(time.time())}, f)
        out['trashed'].append({'id': tid, 'path': p})
    return out

def rm(paths):
    ok, errors = [], []
    for path in paths:
        why = _refusal(path)
        if why:
            errors.append(why); continue
        p = _resolve(path)
        r = subprocess.Popen(['rm', '-rf', '--', p], stderr=subprocess.PIPE)
        _, err = r.communicate()
        if r.returncode:
            errors.append(err.decode('utf-8', 'replace').strip() or ('cannot delete ' + p))
        else:
            ok.append(p)
    return {'deleted': ok, 'errors': errors}

def _entry(tid):
    if not tid or '/' in tid or tid.startswith('.'):
        raise ValueError('bad trash id')
    return os.path.join(TRASH, tid)

def trash_list():
    items = []
    if os.path.isdir(TRASH):
        for tid in sorted(os.listdir(TRASH), reverse=True):
            e = os.path.join(TRASH, tid)
            try:
                with open(os.path.join(e, '.sshf-origin')) as f:
                    meta = json.load(f)
                name = os.path.basename(meta['path'])
                st = os.lstat(os.path.join(e, name))
                items.append({'id': tid, 'path': meta['path'], 'ts': meta.get('ts', 0),
                              'd': stat.S_ISDIR(st.st_mode), 's': st.st_size})
            except (OSError, ValueError, KeyError):
                continue
    return {'items': items, 'root': TRASH}

def restore(ids):
    done, errors = [], []
    for tid in ids:
        e = _entry(tid)
        try:
            with open(os.path.join(e, '.sshf-origin')) as f:
                dest = json.load(f)['path']
            if os.path.lexists(dest):
                errors.append('already exists, not restored: ' + dest); continue
            parent = os.path.dirname(dest)
            if not os.path.isdir(parent):
                os.makedirs(parent)
            os.rename(os.path.join(e, os.path.basename(dest)), dest)
            shutil.rmtree(e, ignore_errors=True)
            done.append(dest)
        except (OSError, ValueError, KeyError) as ex:
            errors.append('%s: %s' % (tid, ex))
    return {'restored': done, 'errors': errors}

def purge(ids=None):
    ids = ids if ids is not None else (os.listdir(TRASH) if os.path.isdir(TRASH) else [])
    for tid in ids:
        e = _entry(tid)
        subprocess.call(['rm', '-rf', '--', e])
    return {'purged': len(ids)}

def save(path, content, expect=None, force=False):
    target = os.path.realpath(os.path.expanduser(path))  # keep symlinks pointing at the edited file
    data = base64.b64decode(content)
    mode = None
    if os.path.exists(target):
        st = os.stat(target)
        mode = stat.S_IMODE(st.st_mode)
        if expect and not force and (int(st.st_mtime) != expect.get('mtime') or st.st_size != expect.get('size')):
            return {'conflict': True, 'mtime': int(st.st_mtime), 'size': st.st_size}
    d, name = os.path.split(target)
    tmp = os.path.join(d, '.%s.sshf-%06x.tmp' % (name, random.getrandbits(24)))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode if mode is not None else 0o644)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.rename(tmp, target)  # atomic: readers see the old or the new file, never half
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise
    st = os.stat(target)
    return {'ok': True, 'mtime': int(st.st_mtime), 'size': st.st_size}

def paste_plan(mode, paths, dest):
    dest = os.path.realpath(os.path.expanduser(dest))
    if not os.path.isdir(dest):
        raise ValueError('not a folder: ' + dest)
    plan, errors = [], []
    for src in paths:
        s = _resolve(src)
        if not os.path.lexists(s):
            errors.append('no longer exists: ' + s); continue
        real = os.path.realpath(s)
        if os.path.isdir(real) and not os.path.islink(s) and (dest == real or dest.startswith(real + '/')):
            errors.append('cannot paste a folder into itself: ' + s); continue
        name = os.path.basename(s)
        target = os.path.join(dest, name)
        if mode == 'move' and os.path.dirname(s) == dest:
            continue  # moving into the folder it is already in: nothing to do
        if os.path.lexists(target):
            if mode == 'copy' and os.path.dirname(s) == dest:
                stem, ext = os.path.splitext(name) if not name.startswith('.') else (name, '')
                i = 1
                while os.path.lexists(target):
                    target = os.path.join(dest, '%s copy%s%s' % (stem, '' if i == 1 else ' %d' % i, ext))
                    i += 1
            else:
                errors.append('already exists in the destination: ' + target); continue
        plan.append([s, target])
    return {'plan': plan, 'errors': errors}

PYFUNCS = {'trash': trash, 'rm': rm, 'trash_list': trash_list, 'restore': restore,
           'purge': purge, 'save': save, 'paste_plan': paste_plan}
"""

# `python3 -c` entry point used when the agent is unavailable.
HELPER_MAIN = r"""
try:
    res = PYFUNCS[sys.argv[1]](**json.load(sys.stdin))
except Exception as ex:
    res = {'error': str(ex)}
sys.stdout.write(json.dumps(res))
"""

# Persistent remote agent (Python 3.6 compatible). Opening a new SSH session on
# Deucalion costs ~1s (PAM + shell init), so instead we keep a small pool of
# long-lived sessions running this tiny JSON-lines RPC loop.
AGENT = HELPERS + r"""
import select, signal
users = {}
budget = [0.0]
def owner(uid):
    if uid not in users:
        if budget[0] > 1.0:  # name-service lookups can be slow (LDAP); cap per listing
            return str(uid)
        t = time.time()
        try:
            import pwd
            users[uid] = pwd.getpwuid(uid).pw_name
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
def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n'); sys.stdout.flush()
def stream(cmd):
    # Stream output as {'o'|'e': base64} lines, heartbeat when idle, {'end': code} last.
    # A 'cancel' line on stdin kills the command's process group.
    p = subprocess.Popen(['/bin/bash', '-c', cmd], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    fds = {p.stdout.fileno(): 'o', p.stderr.fileno(): 'e'}
    listen = True
    while fds:
        watch = list(fds) + ([0] if listen else [])
        ready = select.select(watch, [], [], 2.0)[0]
        if not ready:
            emit({'hb': 1}); continue
        for fd in ready:
            if fd == 0:
                listen = False
                sys.stdin.readline()
                try: os.killpg(p.pid, signal.SIGTERM)
                except Exception: pass
                continue
            data = os.read(fd, 65536)
            if not data:
                del fds[fd]; continue
            emit({fds[fd]: base64.b64encode(data).decode()})
    emit({'end': p.wait()})
os.chdir(os.path.expanduser('~'))
sys.stdout.write('\nREADY\n'); sys.stdout.flush()
while True:
    line = sys.stdin.readline()
    if not line: break
    if line.strip() == 'cancel':
        continue  # late cancel for a stream that already ended
    try:
        req = json.loads(line)
        op = req.pop('op')
        if op == 'stream':
            stream(req['cmd']); continue
        if op == 'ls': res = ls(**req)
        elif op == 'py': res = PYFUNCS[req['fn']](**req.get('args', {}))
        else: res = sh(**req)
    except Exception as ex:
        res = {'error': str(ex), 'code': 1, 'stdout': '', 'stderr': str(ex)}
    emit(res)
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

    def send(self, obj):
        self.p.stdin.write((obj if isinstance(obj, bytes) else (json.dumps(obj) + "\n").encode()))
        self.p.stdin.flush()

    def recv(self):
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("remote agent died")
        return json.loads(line)

    def call(self, req):
        self.send(req)
        return self.recv()

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
            self.total -= len(self.idle)
            self.idle.clear()


POOL = AgentPool()          # short request/response calls
STREAM_POOL = AgentPool(8)  # long-running streams (console, tail, copy jobs) so they never starve POOL


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


def remote_py(fn, **args):
    """Call one of the HELPERS functions on the remote host."""
    try:
        r = POOL.call({"op": "py", "fn": fn, "args": args})
    except Exception:
        code, out, err = run_remote_direct(f"python3 -c {q(HELPERS + HELPER_MAIN)} {q(fn)}",
                                           timeout=300, input_bytes=json.dumps(args).encode())
        if code != 0 or not out.strip():
            raise RuntimeError(err.strip() or "remote helper failed")
        r = json.loads(out)
    if isinstance(r, dict) and "error" in r:  # helpers never return "error" on success
        raise RuntimeError(r["error"])
    return r


def remote_ls(base, target):
    return POOL.call({"op": "ls", "base": base, "target": target})


def stream_remote(cmd, on_out, stop=lambda: False):
    """Run `cmd` remotely, calling on_out(kind, data) for 'o' (stdout), 'e' (stderr) and
    'hb' (heartbeat) as it arrives. If on_out raises or stop() returns True, the remote
    command is killed. Returns the exit code."""
    try:
        a = STREAM_POOL.acquire()
    except Exception:
        return stream_direct(cmd, on_out, stop)
    ok, cancelled = True, False
    try:
        a.send({"op": "stream", "cmd": cmd})
        while True:
            msg = a.recv()
            if "end" in msg:
                return msg["end"]
            if not cancelled and stop():
                a.send(b"cancel\n"); cancelled = True
            if cancelled:
                continue
            try:
                if "o" in msg or "e" in msg:
                    kind = "o" if "o" in msg else "e"
                    on_out(kind, base64.b64decode(msg[kind]))
                else:
                    on_out("hb", b"")
            except Exception:
                a.send(b"cancel\n"); cancelled = True
    except Exception:
        ok = False
        raise
    finally:
        STREAM_POOL.release(a, ok)


def stream_direct(cmd, on_out, stop):
    """Fallback for stream_remote when no agent can be started: a plain ssh process."""
    p = subprocess.Popen(["ssh", *ssh_opts(), CFG["host"], cmd],
                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    sel = selectors.DefaultSelector()
    sel.register(p.stdout, selectors.EVENT_READ, "o")
    sel.register(p.stderr, selectors.EVENT_READ, "e")
    open_ = 2
    try:
        while open_:
            events = sel.select(2.0)
            try:
                if stop():
                    p.kill()
                if not events:
                    on_out("hb", b"")
                for key, _ in events:
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        sel.unregister(key.fileobj); open_ -= 1
                        continue
                    on_out(key.data, data)
            except (BrokenPipeError, ConnectionResetError):
                p.kill()
        return p.wait()
    finally:
        sel.close()
        if p.poll() is None:
            p.kill()


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
# rsync detection
# --------------------------------------------------------------------------- #
_LOCAL_RSYNC = {}


def local_rsync():
    """Return the local rsync version string if it supports --info=progress2 (3.1+), else None.
    macOS ships rsync 2.6.9 or openrsync, which do not; `brew install rsync` provides 3.x."""
    if "v" not in _LOCAL_RSYNC:
        ver = None
        exe = shutil.which("rsync")
        if exe:
            try:
                out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=5).stdout
                m = re.search(r"rsync\s+version\s+v?(\d+)\.(\d+)\.(\d+)", out)
                if m and (int(m.group(1)), int(m.group(2))) >= (3, 1):
                    ver = ".".join(m.groups())
            except Exception:
                pass
        _LOCAL_RSYNC["v"] = ver
    return _LOCAL_RSYNC["v"]


def remote_rsync():
    if CFG["remote_rsync"] is None:
        code, out, _ = run_remote("command -v rsync", timeout=15)
        CFG["remote_rsync"] = code == 0 and bool(out.strip())
    return CFG["remote_rsync"]


def use_rsync():
    return bool(local_rsync() and remote_rsync())


def rsync_info():
    return {"local": local_rsync(), "remote": remote_rsync(), "enabled": use_rsync()}


# --------------------------------------------------------------------------- #
# Transfer jobs
# --------------------------------------------------------------------------- #
JOBS = {}
JOBS_LOCK = threading.Lock()


def new_job(kind, label, total=None, method=""):
    j = {
        "id": uuid.uuid4().hex[:10], "kind": kind, "label": label, "method": method,
        "status": "running", "total": total, "done": 0, "error": "", "warning": "",
        "started": time.time(), "finished": None, "dest": "", "resumable": False,
    }
    with JOBS_LOCK:
        JOBS[j["id"]] = j
    return j


def finish_job(job, ok, err=""):
    job["finished"] = time.time()
    if job["status"] == "cancelled":
        return False
    if ok:
        job["status"] = "done"
        if job["total"]:
            job["done"] = max(job["done"], job["total"])
        return True
    job["status"] = "error"
    job["error"] = err or "failed"
    return False


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


def remote_size(path, timeout=20, is_dir=True):
    # A single stat is cheap; `du` walks the tree, which loads Lustre metadata servers.
    cmd = f"du -sb {q(path)} 2>/dev/null | cut -f1" if is_dir else f"stat -L -c %s -- {q(path)} 2>/dev/null"
    code, out, _ = run_remote(cmd, timeout=timeout)
    try:
        return int(out.strip())
    except ValueError:
        return None


def tar_stream_size(path, timeout=60):
    """Estimate the size of `tar -cf -` for path: 512-byte header per entry plus data padded
    to 512 bytes. One metadata walk, like `du`, done once per download."""
    code, out, _ = run_remote(
        f"find {q(path)} -printf '%s %y\\n' 2>/dev/null | "
        "awk '{t += 512; if ($2 == \"f\") t += int(($1 + 511) / 512) * 512} END {print t + 1024}'",
        timeout=timeout)
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


def drain(pipe, sink):
    """Read a pipe to EOF in a thread (so a chatty stderr can never block the process)."""
    def run():
        for chunk in iter(lambda: pipe.read(65536), b""):
            sink.append(chunk)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def errtext(chunks):
    return b"".join(chunks).decode("utf-8", "replace").strip()


def run_scp(job, args, progress_fn, interval=1.0):
    proc = subprocess.Popen(
        ["scp", *ssh_opts(), "-p", *args],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    job["_procs"] = [proc]
    err = []
    t = drain(proc.stderr, err)
    last = 0.0
    while proc.poll() is None:
        if time.time() - last >= interval:
            last = time.time()
            try:
                v = progress_fn()
                if v is not None:
                    job["done"] = v
            except Exception:
                pass
        time.sleep(0.5)
    t.join(2)
    return finish_job(job, proc.returncode == 0, errtext(err) or f"scp exited with {proc.returncode}")


PROGRESS2 = re.compile(rb"^\s*([\d,.']+)\s+(\d+)%")


def run_rsync(job, src, dst):
    """rsync with --partial (resumable) and --info=progress2 (one overall progress line)."""
    ssh_e = "ssh " + " ".join(q(o) for o in ssh_opts())
    cmd = ["rsync", "-a", "--partial", "--info=progress2", "--no-inc-recursive",
           "--protect-args", "-e", ssh_e, src, dst]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    job["_procs"] = [proc]
    err = []
    t = drain(proc.stderr, err)
    buf = b""
    known_total = bool(job["total"])  # file sizes are exact; only estimate folder totals
    for chunk in iter(lambda: os.read(proc.stdout.fileno(), 4096), b""):
        buf += chunk
        *lines, buf = re.split(rb"[\r\n]", buf)
        for line in reversed(lines):
            m = PROGRESS2.match(line)
            if m:
                done = int(re.sub(rb"\D", b"", m.group(1)) or 0)
                pct = int(m.group(2))
                job["done"] = done
                if pct > 0 and not known_total:
                    job["total"] = max(done, done * 100 // pct)
                break
    proc.wait()
    t.join(2)
    return finish_job(job, proc.returncode == 0, errtext(err) or f"rsync exited with {proc.returncode}")


def run_tar_download(job, rpath, target):
    """Folder download as one tar stream: much faster than scp -r for many small files."""
    parent, name = posixpath.split(rpath.rstrip("/"))
    staging = target.parent / f".sshf-partial-{job['id']}"
    staging.mkdir(parents=True)
    job["_staging"] = str(staging)
    remote = subprocess.Popen(
        ["ssh", *ssh_opts(), CFG["host"], f"tar -C {q(parent or '/')} -cf - -- {q(name)}"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    local = subprocess.Popen(["tar", "-xf", "-", "-C", str(staging)],
                             stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    job["_procs"] = [remote, local]
    rerr, lerr = [], []
    t1, t2 = drain(remote.stderr, rerr), drain(local.stderr, lerr)
    try:
        for chunk in iter(lambda: os.read(remote.stdout.fileno(), 1 << 20), b""):
            local.stdin.write(chunk)
            job["done"] += len(chunk)
    except (BrokenPipeError, OSError):
        pass
    finally:
        try:
            local.stdin.close()
        except OSError:
            pass
    rcode, lcode = remote.wait(), local.wait()
    t1.join(2); t2.join(2)
    # GNU tar exits 1 when files changed while being read: the archive is still complete.
    ok = rcode in (0, 1) and lcode == 0 and (staging / name).exists()
    if ok:
        (staging / name).rename(target)
        shutil.rmtree(staging, ignore_errors=True)
        job.pop("_staging", None)
        if rcode == 1:
            job["warning"] = "some files changed while being read"
    return finish_job(job, ok, errtext(rerr) or errtext(lerr) or f"tar exited with {rcode}/{lcode}")


def run_archive(job, paths, target):
    """Download several remote items as a single .tar.gz file."""
    common = posixpath.commonpath([posixpath.dirname(p.rstrip("/")) or "/" for p in paths])
    rels = [posixpath.relpath(p.rstrip("/"), common) for p in paths]
    part = target.with_name(target.name + ".part")
    remote = subprocess.Popen(
        ["ssh", *ssh_opts(), CFG["host"], f"tar -C {q(common)} -czf - -- " + " ".join(q(r) for r in rels)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    job["_procs"] = [remote]
    err = []
    t = drain(remote.stderr, err)
    with open(part, "wb") as f:
        for chunk in iter(lambda: os.read(remote.stdout.fileno(), 1 << 20), b""):
            f.write(chunk)
            job["done"] += len(chunk)
    code = remote.wait()
    t.join(2)
    ok = code in (0, 1) and job["status"] != "cancelled"
    if ok:
        part.rename(target)
        if code == 1:
            job["warning"] = "some files changed while being read"
    else:
        part.unlink(missing_ok=True)
    return finish_job(job, ok, errtext(err) or f"tar exited with {code}")


def spawn(job, fn, *args):
    def work():
        try:
            fn(job, *args)
        except Exception as ex:  # never leave a job stuck in "running"
            finish_job(job, False, str(ex))
    threading.Thread(target=work, daemon=True).start()


def start_download(items, mode="default"):
    """items: list of {path, isDir, size}. mode: default | sync | archive."""
    dest_dir = Path(CFG["download_dir"]).expanduser()
    dest_dir.mkdir(parents=True, exist_ok=True)
    if mode == "archive":
        paths = [it["path"] for it in items]
        stem = posixpath.basename(paths[0].rstrip("/")) if len(paths) == 1 else (
            posixpath.basename(posixpath.dirname(paths[0].rstrip("/"))) or "selection")
        target = unique_local(dest_dir, f"{stem}-{time.strftime('%Y%m%d-%H%M%S')}.tar.gz")
        job = new_job("download", target.name, None, "tar.gz")
        job["dest"] = str(target)
        spawn(job, run_archive, paths, target)
        return [public_job(job)]
    if mode == "sync" and not use_rsync():
        raise RuntimeError("Sync needs rsync 3.1+ on this computer (brew install rsync) and rsync on the remote")
    jobs = []
    for it in items:
        rpath, is_dir = it["path"], bool(it.get("isDir"))
        name = posixpath.basename(rpath.rstrip("/")) or "root"
        target = dest_dir / name if mode == "sync" else unique_local(dest_dir, name)
        if mode == "sync" or (not is_dir and use_rsync()):
            job = new_job("download", name, None if is_dir else it.get("size"), "rsync")
            job["dest"], job["resumable"] = str(target), True
            src = f"{CFG['host']}:{rpath.rstrip('/')}" + ("/" if is_dir else "")
            spawn(job, run_rsync, src, str(target) + ("/" if is_dir else ""))
        elif is_dir:
            job = new_job("download", name, None, "tar")
            job["dest"], job["resumable"] = str(target), use_rsync()

            def tar_work(job, rpath=rpath, target=target):
                job["total"] = tar_stream_size(rpath)
                run_tar_download(job, rpath, target)
            spawn(job, tar_work)
        else:
            job = new_job("download", name, it.get("size"), "scp")
            job["dest"] = str(target)
            spawn(job, lambda job, rpath=rpath, target=target: run_scp(
                job, [f"{CFG['host']}:{scp_remote_path(rpath)}", str(target)], lambda: local_size(target)))
        job["_rpath"], job["_isdir"] = rpath, is_dir
        jobs.append(job)
    return [public_job(j) for j in jobs]


def resume_download(jid):
    old = JOBS.get(jid)
    if not old or old["kind"] != "download" or not old.get("_rpath"):
        raise RuntimeError("this transfer cannot be resumed")
    if not use_rsync():
        raise RuntimeError("Resume needs rsync 3.1+ on this computer (brew install rsync) and rsync on the remote")
    target, is_dir = Path(old["dest"]), old["_isdir"]
    staging = old.get("_staging")
    if staging:  # keep what an interrupted tar stream already extracted
        partial = Path(staging) / posixpath.basename(old["_rpath"].rstrip("/"))
        if partial.exists() and not target.exists():
            partial.rename(target)
        shutil.rmtree(staging, ignore_errors=True)
    with JOBS_LOCK:
        JOBS.pop(jid, None)
    job = new_job("download", old["label"], old["total"], "rsync")
    job.update(dest=str(target), resumable=True, _rpath=old["_rpath"], _isdir=is_dir)
    src = f"{CFG['host']}:{old['_rpath'].rstrip('/')}" + ("/" if is_dir else "")
    spawn(job, run_rsync, src, str(target) + ("/" if is_dir else ""))
    return public_job(job)


def start_upload(local_paths, remote_dir, cleanup=None, label=None):
    """Upload local files/folders into remote_dir (rsync when available, else scp -r)."""
    jobs = []
    rsync = use_rsync()
    for lp in local_paths:
        lp = str(lp)
        name = os.path.basename(lp.rstrip("/"))
        is_dir = os.path.isdir(lp)
        job = new_job("upload", label or name, local_size(lp), "rsync" if rsync else "scp")
        rtarget = remote_dir.rstrip("/") + "/" + name
        job["dest"] = rtarget
        jobs.append(job)

        def work(job, lp=lp, rtarget=rtarget, is_dir=is_dir):
            try:
                if rsync:
                    sfx = "/" if is_dir else ""
                    run_rsync(job, lp.rstrip("/") + sfx, f"{CFG['host']}:{rtarget}{sfx}")
                else:
                    # Poll the remote size rarely: a `du` per second is heavy on Lustre.
                    run_scp(job, ["-r", lp, f"{CFG['host']}:{scp_remote_path(rtarget)}"],
                            lambda: remote_size(rtarget, timeout=10, is_dir=is_dir),
                            interval=10.0 if is_dir else 5.0)
            finally:
                if cleanup:
                    shutil.rmtree(cleanup, ignore_errors=True)
        spawn(job, work)
    return [public_job(j) for j in jobs]


def start_paste(mode, paths, dest):
    """Copy (cp -a) or move (mv) remote items into dest, entirely on the remote host."""
    if mode not in ("copy", "move"):
        raise RuntimeError("bad paste mode")
    plan = remote_py("paste_plan", mode=mode, paths=paths, dest=dest)
    if not plan["plan"]:
        if plan["errors"]:
            raise RuntimeError("; ".join(plan["errors"]))
        return {"jobs": [], "errors": []}
    pairs = plan["plan"]
    # The plan already checked the targets; re-check right before each step so nothing is overwritten.
    verb = "cp -a --" if mode == "copy" else "mv --"
    cmd = "set -e; " + "; ".join(
        f"if [ -e {q(t)} ] || [ -L {q(t)} ]; then echo {q('already exists: ' + t)} >&2; exit 17; fi; {verb} {q(s)} {q(t)}"
        for s, t in pairs)
    label = posixpath.basename(pairs[0][0]) + (f" +{len(pairs) - 1}" if len(pairs) > 1 else "")
    job = new_job(mode, label, None, "remote")
    job["dest"] = pairs[0][1] if len(pairs) == 1 else dest
    job["_src_dirs"] = sorted({posixpath.dirname(s) for s, _ in pairs})

    def work(job):
        err = []
        code = stream_remote(cmd, lambda k, d: err.append(d) if k == "e" else None,
                             stop=lambda: job["status"] == "cancelled")
        finish_job(job, code == 0, errtext(err) or f"{mode} exited with {code}")
    spawn(job, work)
    return {"jobs": [public_job(job)], "errors": plan["errors"]}


def public_job(j):
    out = {k: v for k, v in j.items() if not k.startswith("_")}
    if j.get("_src_dirs"):
        out["srcDirs"] = j["_src_dirs"]
    return out


# --------------------------------------------------------------------------- #
# HPC helpers: Slurm, quota, billing
# --------------------------------------------------------------------------- #
SQUEUE_FIELDS = ["id", "partition", "state", "time", "limit", "nodes", "reason", "workdir", "account", "name"]
JOBID_RE = re.compile(r"^\d+(_\d+|_\[[\d,\-%]+\])?$")


def slurm_jobs():
    fmt = "%i|%P|%T|%M|%l|%D|%R|%Z|%a|%j"
    code, out, err = run_remote(
        "command -v squeue >/dev/null || { echo 'squeue not found' >&2; exit 127; }; "
        f"squeue --me -h -o {q(fmt)} 2>/dev/null || squeue -u \"$USER\" -h -o {q(fmt)}", timeout=30)
    if code == 127:
        return {"available": False, "error": err.strip()}
    if code != 0:
        return {"available": True, "error": err.strip() or f"squeue exited with {code}", "jobs": []}
    jobs = []
    for line in out.splitlines():
        parts = line.split("|", len(SQUEUE_FIELDS) - 1)
        if len(parts) == len(SQUEUE_FIELDS):
            jobs.append(dict(zip(SQUEUE_FIELDS, parts)))
    return {"available": True, "jobs": jobs}


def expand_slurm_pattern(path, info):
    """Expand sbatch filename patterns (%j job id, %x name, %A/%a array, %u user, %N node)."""
    jid = info.get("JobId", "")
    array_id, task = info.get("ArrayJobId", ""), info.get("ArrayTaskId", "")
    node = (info.get("BatchHost") or info.get("NodeList") or "").split(",")[0]
    vals = {"j": jid, "J": jid, "x": info.get("JobName", ""), "A": array_id or jid,
            "a": task, "u": info.get("UserId", "").split("(")[0], "N": node, "n": "0", "s": "batch", "t": "0"}

    def rep(m):
        pad, key = m.group(1), m.group(2)
        if key == "%":
            return "%"
        v = vals.get(key, m.group(0))
        return v.zfill(int(pad)) if pad and v.isdigit() else v
    return re.sub(r"%(\d*)([AaJjNnstux%])", rep, path)


def slurm_log(jid):
    if not JOBID_RE.match(jid):
        raise RuntimeError("bad job id")
    code, out, err = run_remote(f"scontrol show job -o {q(jid)}", timeout=20)
    if code != 0:
        raise RuntimeError(err.strip() or "scontrol failed")
    info = {}
    for tok in re.findall(r"(\w+)=(\S*)", out.splitlines()[0] if out else ""):
        info.setdefault(tok[0], tok[1])
    workdir = info.get("WorkDir", "")
    res = {"workdir": workdir}
    for key, field in (("stdout", "StdOut"), ("stderr", "StdErr")):
        p = info.get(field) or ""
        if not p and key == "stdout":
            p = "slurm-%A_%a.out" if info.get("ArrayTaskId") else "slurm-%j.out"
        if p:
            p = expand_slurm_pattern(p, info)
            res[key] = p if p.startswith("/") else posixpath.join(workdir or "~", p)
    return res


QUOTA_SCRIPT = r"""
mounts=$(df -P -t lustre 2>/dev/null | awk 'NR>1 {print $6}' | sort -u)
for m in $mounts; do echo "@@LFS $m"; lfs quota -u "$USER" "$m" 2>&1; done
echo "@@DF"; df -Pk "$HOME" 2>&1
"""


def parse_lfs_quota(text, mount):
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if "kbytes" in line and "files" in line:
            toks = " ".join(lines[i + 1:]).split()
            if toks and not toks[0].rstrip("*").isdigit():
                toks = toks[1:]
            nums = []
            for t in toks:
                t = t.rstrip("*")
                nums.append(int(t) if t.isdigit() else None)
            if len(nums) >= 7 and nums[0] is not None:
                lim = nums[2] or nums[1] or 0
                return {"fs": mount, "used": nums[0] * 1024, "limit": lim * 1024,
                        "files": nums[4], "files_limit": nums[6] or nums[5] or 0, "kind": "lfs"}
    return None


def quota_info():
    code, out, err = run_remote(QUOTA_SCRIPT, timeout=60)
    items = []
    raw = re.sub(r"^@@LFS (.*)$", r"== lfs quota: \1", out.strip(), flags=re.M)
    raw = re.sub(r"^@@DF$", "== df $HOME", raw, flags=re.M) or err.strip()
    for block in out.split("@@")[1:]:
        head, _, body = block.partition("\n")
        if head.startswith("LFS "):
            item = parse_lfs_quota(body, head[4:].strip())
            if item:
                items.append(item)
        elif head.startswith("DF") and not items:
            rows = body.strip().splitlines()
            if len(rows) >= 2:
                f = rows[-1].split()
                if len(f) >= 6 and f[1].isdigit():
                    items.append({"fs": f[5], "used": int(f[2]) * 1024, "limit": int(f[1]) * 1024, "kind": "df"})
    return {"items": items, "raw": raw}


ARCH = {"a": "ARM", "x": "x86", "g": "GPU"}


def billing_info(account=None):
    if account is not None:
        if not re.match(r"^[\w.\-]+$", account):
            raise RuntimeError("bad account name")
        code, out, err = run_remote(f"billing -a {q(account)} 2>&1", timeout=60)
        return {"account": account, "output": out.strip(), "code": code}
    code, out, err = run_remote(
        "if command -v billing >/dev/null; then echo @@HAVE; billing 2>&1; fi; echo @@ACCOUNTS; "
        "sacctmgr -nP show assoc user=\"$USER\" format=account 2>/dev/null | sort -u", timeout=60)
    have = "@@HAVE" in out
    bill, _, accts = out.partition("@@ACCOUNTS")
    accounts = []
    for a in accts.split():
        accounts.append({"name": a, "arch": ARCH.get(a[-1:].lower(), "")})
    return {"available": have, "output": bill.replace("@@HAVE", "").strip(), "accounts": accounts}


def folder_sizes(path):
    # Allocated size (what quota counts), one level deep, same filesystem only.
    code, out, _ = run_remote(
        f"timeout 300 du -x -k --max-depth=1 -- {q(path)} 2>/dev/null", timeout=320)
    sizes = {}
    for line in out.splitlines():
        kb, _, p = line.partition("\t")
        if kb.isdigit():
            sizes[p] = int(kb) * 1024
    total = sizes.pop(path.rstrip("/") or "/", None)
    return {"sizes": sizes, "total": total, "timedOut": code == 124}


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
        line = args[0] if args and isinstance(args[0], str) else ""
        if "/api/jobs" not in line and "/api/slurm/jobs" not in line:
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

    def send_raw_security_headers(self, ctype):
        """Remote file content is untrusted: stop it from running script in this origin."""
        self.send_header("X-Content-Type-Options", "nosniff")
        # Browsers refuse to show PDFs in a sandboxed document; their viewers isolate PDF JS.
        if ctype != "application/pdf":
            self.send_header("Content-Security-Policy", "sandbox")

    def err(self, msg, status=400):
        self.send_json({"error": msg}, status)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    @property
    def cookie_name(self):
        return f"sshf{self.server.server_address[1]}"  # cookies ignore ports: one name per instance

    def cookie_token(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == self.cookie_name:
                return v
        return ""

    def authorized(self, allow_cookie=False):
        """API calls carry the token in a header. Only read-only /api/raw (used by <img>,
        <video>, downloads) also accepts the SameSite=Strict cookie, so the token never
        appears in URLs."""
        tok = self.headers.get("X-Token") or (self.cookie_token() if allow_cookie else "")
        return bool(tok) and secrets.compare_digest(tok, TOKEN)

    # ---- routing ----
    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if not u.path.startswith("/api/"):
            return self.serve_static(u.path)
        if not self.authorized(allow_cookie=u.path == "/api/raw"):
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
            if u.path == "/api/trash":
                return self.send_json(remote_py("trash_list"))
            if u.path == "/api/slurm/jobs":
                return self.send_json(slurm_jobs())
            if u.path == "/api/slurm/log":
                return self.send_json(slurm_log(g("id")))
            if u.path == "/api/quota":
                return self.send_json(quota_info())
            if u.path == "/api/billing":
                return self.send_json(billing_info(qs["account"][0] if "account" in qs else None))
            if u.path == "/api/du":
                return self.send_json(folder_sizes(g("path")))
            return self.err("not found", 404)
        except BrokenPipeError:
            pass
        except Exception as ex:  # noqa
            return self.err(str(ex), 500)

    def do_POST(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if not self.authorized():
            return self.err("unauthorized", 401)
        g = lambda k, d="": (qs.get(k) or [d])[0]
        try:
            if u.path == "/api/upload_raw":
                return self.api_upload_raw(g("dir"), g("name"))
            b = self.body_json()
            if u.path == "/api/stream":
                return self.api_stream(b)
            route = {
                "/api/session": lambda: self.api_session(),
                "/api/download": lambda: self.send_json({"jobs": start_download(b["items"], b.get("mode", "default"))}),
                "/api/upload_paths": lambda: self.send_json(
                    {"jobs": start_upload(b["paths"], b["dir"])}),
                "/api/pick": lambda: self.send_json({"paths": mac_pick(b.get("kind", "file"))}),
                "/api/mkdir": lambda: self.simple_remote(f"mkdir -p -- {q(b['path'])}"),
                "/api/touch": lambda: self.simple_remote(
                    f"[ -e {q(b['path'])} ] && echo 'File exists' >&2 && exit 1; touch -- {q(b['path'])}"),
                "/api/rename": lambda: self.simple_remote(
                    f"[ -e {q(b['dst'])} ] && echo 'Target exists' >&2 && exit 1; mv -- {q(b['src'])} {q(b['dst'])}"),
                "/api/delete": lambda: self.send_json(
                    remote_py("rm" if b.get("permanent") else "trash", paths=b["paths"])),
                "/api/trash/restore": lambda: self.send_json(remote_py("restore", ids=b["ids"])),
                "/api/trash/purge": lambda: self.send_json(remote_py("purge", ids=b.get("ids"))),
                "/api/paste": lambda: self.send_json(start_paste(b["mode"], b["paths"], b["dest"])),
                "/api/save": lambda: self.api_save(b),
                "/api/config": lambda: self.api_config(b),
                "/api/host": lambda: self.api_switch_host(b["host"]),
                "/api/reveal": lambda: self.api_reveal(b["path"]),
                "/api/open_terminal": lambda: self.api_open_terminal(b["path"]),
                "/api/open_vscode": lambda: self.api_open_vscode(b["path"], b.get("isDir", True)),
                "/api/jobs/clear": lambda: self.api_jobs_clear(),
                "/api/jobs/cancel": lambda: self.api_jobs_cancel(b["id"]),
                "/api/jobs/resume": lambda: self.send_json({"job": resume_download(b["id"])}),
                "/api/slurm/cancel": lambda: self.api_scancel(b["id"]),
                "/api/slurm/submit": lambda: self.api_sbatch(b["path"]),
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
        self.send_header("Content-Security-Policy", STATIC_CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    # ---- API ----
    def api_session(self):
        """Swap the header token for an HttpOnly cookie used by <img>/<video>/download URLs."""
        data = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Set-Cookie", f"{self.cookie_name}={TOKEN}; HttpOnly; SameSite=Strict; Path=/api/raw")
        self.end_headers()
        self.wfile.write(data)

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
                        "download_dir": CFG["download_dir"], "platform": sys.platform,
                        "rsync": rsync_info()})

    def api_ls(self, base, path):
        res = remote_ls(base, path)
        self.send_json(res, 200 if "entries" in res else 400)

    def api_preview(self, path):
        code, out, err = run_remote(
            f"stat -L -c '%s %Y %F' -- {q(path)} && file -b -L --mime-type -- {q(path)}", timeout=30)
        if code != 0:
            return self.err(err.strip() or "cannot stat file", 500)
        lines = out.strip().splitlines()
        size_s, mtime_s, ftype = (lines[0].split(" ", 2) + ["", ""])[:3]
        size, mtime = int(size_s), int(mtime_s or 0)
        mime = lines[1].strip() if len(lines) > 1 else "application/octet-stream"
        ext = os.path.splitext(path)[1].lower()
        base = {"size": size, "mtime": mtime, "mime": mime}
        if "directory" in ftype:
            return self.send_json({"kind": "dir", **base})
        if ext == ".svg":
            base["mime"] = mime = "image/svg+xml"
        if (mime.startswith(("image/", "video/", "audio/")) or mime == "application/pdf") and (
                ext in MEDIA_EXT or not mime.startswith("image/x-")):
            return self.send_json({"kind": "media", **base})
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
            return self.send_json({"kind": "binary", **base, "content": "\n".join(rows)})
        return self.send_json({
            "kind": "text", **base,
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
        # Types that can run scripts in our origin are never rendered inline.
        disp = "attachment" if as_download or ctype in SCRIPTABLE_TYPES else "inline"
        if size <= 48 * 1024 * 1024:  # small enough: fetch through the fast agent
            code, data, err = run_remote(f"cat -- {q(path)}", timeout=300, binary=True)
            if code != 0:
                return self.err(err.strip() or "cannot read", 500)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", f"{disp}; filename*=UTF-8''{quote(name)}")
            self.send_raw_security_headers(ctype)
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
            self.send_raw_security_headers(ctype)
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

    def api_stream(self, b):
        """Stream a console command or `tail -F` as NDJSON lines: {"o"|"e": text}, {"end": code}."""
        kind = b.get("kind")
        if kind == "exec":
            cmd = f"cd {q(b.get('cwd') or '~')} 2>/dev/null || cd; {b['cmd']}"
        elif kind == "tail":
            lines = max(1, min(int(b.get("lines", 500)), 20000))
            cmd = f"exec tail -n {lines} -F -- {q(b['path'])}"
        else:
            return self.err("bad stream kind")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()  # HTTP/1.0: the body ends when the connection closes
        decoders = {k: codecs.getincrementaldecoder("utf-8")("replace") for k in ("o", "e")}

        def write(obj):
            self.wfile.write((json.dumps(obj) + "\n").encode())
            self.wfile.flush()

        def on_out(k, data):
            if k == "hb":
                write({"hb": 1})  # also detects a closed browser tab, which cancels the command
            else:
                text = decoders[k].decode(data)
                if text:
                    write({k: text})
        try:
            code = stream_remote(cmd, on_out)
            write({"end": code})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as ex:
            try:
                write({"e": str(ex) + "\n"}); write({"end": 1})
            except OSError:
                pass

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

    def api_save(self, b):
        r = remote_py("save", path=b["path"], content=base64.b64encode(b["content"].encode("utf-8")).decode(),
                      expect=b.get("expect"), force=bool(b.get("force")))
        if r.get("conflict"):
            return self.send_json({"error": "changed on the remote since you opened it", **r}, 409)
        self.send_json(r)

    def simple_remote(self, cmd):
        code, out, err = run_remote(cmd, timeout=120)
        if code != 0:
            return self.err(err.strip() or f"command failed ({code})", 500)
        self.send_json({"ok": True, "out": out})

    def api_scancel(self, jid):
        if not JOBID_RE.match(str(jid)):
            return self.err("bad job id")
        return self.simple_remote(f"scancel {q(jid)}")

    def api_sbatch(self, path):
        d, name = posixpath.split(path)
        code, out, err = run_remote(f"cd {q(d or '/')} && sbatch ./{q(name)}", timeout=60)
        if code != 0:
            return self.err(err.strip() or out.strip() or f"sbatch exited with {code}", 500)
        m = re.search(r"(\d+)", out)
        self.send_json({"ok": True, "out": out.strip(), "id": m.group(1) if m else None})

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
        STREAM_POOL.close()
        CFG["host"] = host
        CFG["remote_rsync"] = None
        if not CFG["custom_dl"]:
            CFG["download_dir"] = str(Path.home() / "Downloads" / safe_name(host))
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
        if j and j["status"] == "running":
            j["status"] = "cancelled"
            j["finished"] = time.time()
            for p in j.get("_procs", []):
                try:
                    p.terminate()
                except Exception:
                    pass
        self.send_json({"ok": True})


def bind_server(port, tries=20):
    """Bind the requested port, or the next free one, so several instances can run."""
    for p in range(port, port + tries):
        try:
            return ThreadingHTTPServer(("127.0.0.1", p), Handler)
        except OSError as ex:
            if ex.errno != errno.EADDRINUSE:
                raise
    return ThreadingHTTPServer(("127.0.0.1", 0), Handler)  # let the OS pick


def main():
    ap = argparse.ArgumentParser(description="GUI file browser over SSH")
    ap.add_argument("--host", default=CFG["host"], help="ssh host alias or user@host (default: deucalion)")
    ap.add_argument("--port", type=int, default=8765, help="preferred port; the next free one is used if taken")
    ap.add_argument("--download-dir", default=None, help="local download directory (default: ~/Downloads/<host>)")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    CFG["host"] = a.host
    if a.download_dir:
        CFG["download_dir"] = str(Path(a.download_dir).expanduser())
        CFG["custom_dl"] = True
    else:
        CFG["download_dir"] = str(Path.home() / "Downloads" / safe_name(a.host))

    if not ensure_master():
        print(f"[ssh-fetcher] could not connect to {a.host}", file=sys.stderr)
        sys.exit(1)

    try:
        POOL.warm(2)
    except Exception as ex:
        print(f"[ssh-fetcher] warning: remote agent unavailable ({ex}); using plain ssh", file=sys.stderr)

    srv = bind_server(a.port)
    srv.daemon_threads = True
    port = srv.server_address[1]
    if port != a.port:
        print(f"[ssh-fetcher] port {a.port} is busy, using {port}", flush=True)
    url = f"http://127.0.0.1:{port}/#token={TOKEN}"
    print(f"[ssh-fetcher] {a.host} ready → {url}", flush=True)
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[ssh-fetcher] bye")
    finally:
        POOL.close()
        STREAM_POOL.close()
        subprocess.run(["ssh", *ssh_opts(), "-O", "exit", CFG["host"]], capture_output=True)


if __name__ == "__main__":
    main()
