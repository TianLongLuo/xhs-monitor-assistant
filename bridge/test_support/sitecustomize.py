"""Regression-only I/O guard; production modules are copied without edits."""
import atexit
import json
import os
import sys
import weakref
from collections import Counter
from urllib.parse import urlsplit, unquote

ROOT = os.path.normcase(os.path.realpath(os.environ["AUDIT_ROOT"]))
RUNTIME_ROOTS = tuple(os.path.normcase(os.path.realpath(p)) for p in (sys.prefix, sys.base_prefix))
COUNTS = Counter()
DENIED = []
FIXTURE_SOCKETS = weakref.WeakSet()
DATABASES = set()


def normalized(path):
    return os.path.normcase(os.path.realpath(os.fsdecode(path)))


def under(path, root):
    return path == root or path.startswith(root + os.sep)


def deny(event, detail):
    DENIED.append({"event": event, "detail": str(detail)})
    raise PermissionError(f"AUDIT GUARD: {event}: {detail}")


def check_file(path, write=False):
    if isinstance(path, int) or path is None:
        return
    path = normalized(path)
    if path == normalized(os.devnull) or under(path, ROOT):
        return
    if not write and any(under(path, root) for root in RUNTIME_ROOTS):
        return
    deny("file-write" if write else "file-read", path)


def fixture_port(port):
    for sock in tuple(FIXTURE_SOCKETS):
        try:
            if sock.getsockname()[1] == port:
                return True
        except OSError:
            pass
    return False


def hook(event, args):
    if event == "open":
        COUNTS[event] += 1
        path, mode, flags = args
        write = bool((flags or 0) & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        check_file(path, write)
    elif event == "sqlite3.connect":
        path = args[0]
        if path != ":memory:":
            # sqlite3 reports URI filenames verbatim. Validate the decoded
            # filesystem target (including mode=ro) against the SAME fixture
            # root; never interpret file:///C:/... as a relative cwd filename.
            target = os.fsdecode(path)
            if target.startswith("file:"):
                uri = urlsplit(target)
                if uri.netloc:
                    deny("sqlite-network-path", target)
                target = unquote(uri.path)
                if os.name == "nt" and len(target) > 3 and target[0] == "/" and target[2] == ":":
                    target = target[1:]
            check_file(target, True)
        DATABASES.add(str(path))
        COUNTS[event] += 1
    elif event in ("os.mkdir", "os.remove", "os.rmdir", "os.chmod", "os.truncate", "os.utime"):
        check_file(args[0], True)
    elif event in ("os.rename", "os.link", "os.symlink"):
        check_file(args[0], True)
        check_file(args[1], True)
    elif event == "socket.bind":
        sock, address = args
        if len(address) != 2 or address[0] != "127.0.0.1" or address[1] != 0:
            deny(event, address)
        FIXTURE_SOCKETS.add(sock)
        COUNTS[event] += 1
    elif event == "socket.connect":
        _sock, address = args
        if len(address) != 2 or address[0] != "127.0.0.1" or not fixture_port(address[1]):
            deny(event, address)
        COUNTS[event] += 1
    elif event == "socket.getaddrinfo":
        if args[0] != "127.0.0.1" or not fixture_port(int(args[1])):
            deny(event, args[:2])
    elif event == "urllib.Request":
        url = urlsplit(args[0])
        if url.hostname != "127.0.0.1" or not fixture_port(url.port):
            deny(event, args[0])
        COUNTS[event] += 1
    elif event in ("subprocess.Popen", "os.system", "os.startfile", "os.startfile/2", "os.posix_spawn", "os.exec"):
        deny(event, args[:2])


def save_summary():
    result = {
        "guard_installed": True,
        "audit_root": ROOT,
        "runtime_read_roots": RUNTIME_ROOTS,
        "counts": dict(COUNTS),
        "sqlite_database_paths": sorted(DATABASES),
        "denied_attempts": DENIED,
        "live_bridge_started": False,
    }
    target = os.environ.get("AUDIT_GUARD_LOG", os.path.join(ROOT, "guard-summary.json"))
    with open(target, "w", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)


sys.addaudithook(hook)
atexit.register(save_summary)
print("[audit guard] active: snapshot/temp writes only; ephemeral fixture network only; subprocess/GUI denied", file=sys.stderr, flush=True)
