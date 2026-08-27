#!/usr/bin/env python3
"""Native Messaging host that starts the local XHS-Monitor Bridge on demand.

Default mode speaks Chrome's length-prefixed JSON protocol. ``--bridge`` mode
is used by the host as a detached child process and runs the HTTP Bridge.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


HOST_NAME = "com.xhsmonitor.bridge"
BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 17881


def base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def config_path() -> Path:
    primary = base_dir() / "native_host_config.json"
    if primary.exists() or not getattr(sys, "frozen", False):
        return primary

    # The installer keeps the generated config beside the bridge folder so it
    # can be inspected and reused by the source-mode host.  The bundled exe
    # lives one level deeper in bridge/dist, so accept that parent config too.
    parent_config = base_dir().parent / "native_host_config.json"
    return parent_config if parent_config.exists() else primary


def load_config() -> dict[str, Any]:
    default_root = base_dir()
    config: dict[str, Any] = {
        "host": BRIDGE_HOST,
        "port": BRIDGE_PORT,
        "db": str(default_root / "data" / "xhs_monitor.db"),
        "export_dir": str(default_root / "exports"),
        "seed_csv": "",
        "comments_csv": "",
        "seed_xlsx": "",  # legacy migration input
    }
    path = config_path()
    if path.exists():
        config.update(json.loads(path.read_text(encoding="utf-8")))
    return config


def bridge_url(config: dict[str, Any]) -> str:
    return f"http://{config.get('host', BRIDGE_HOST)}:{int(config.get('port', BRIDGE_PORT))}"


def bridge_is_healthy(config: dict[str, Any]) -> bool:
    try:
        with urllib.request.urlopen(f"{bridge_url(config)}/api/health", timeout=1.2) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return bool(payload.get("ok") and payload.get("service") == "xhs-monitor-bridge")
    except Exception:
        return False


def runtime_log_path() -> Path:
    return config_path().parent / "native_host.log"


def log_event(message: str) -> None:
    path = runtime_log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > 512 * 1024:
            backup = path.with_suffix(".log.1")
            backup.unlink(missing_ok=True)
            path.replace(backup)
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with path.open("a", encoding="utf-8") as stream:
            stream.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass


def log_tail(limit: int = 1200) -> str:
    try:
        value = runtime_log_path().read_text(encoding="utf-8", errors="replace")
        return value[-max(100, limit):]
    except Exception:
        return ""


def port_is_open(config: dict[str, Any]) -> bool:
    try:
        with socket.create_connection(
            (str(config.get("host", BRIDGE_HOST)), int(config.get("port", BRIDGE_PORT))),
            timeout=0.7,
        ):
            return True
    except OSError:
        return False


def wait_for_bridge(config: dict[str, Any], timeout_seconds: float) -> bool:
    deadline = time.time() + max(1.0, timeout_seconds)
    while time.time() < deadline:
        if bridge_is_healthy(config):
            return True
        time.sleep(0.35)
    return False


def start_bridge_process(config: dict[str, Any]) -> dict[str, Any]:
    url = bridge_url(config)
    if bridge_is_healthy(config):
        return {"ok": True, "started": False, "alreadyRunning": True, "bridgeUrl": url}

    lock_path = config_path().parent / f".bridge-starting-{int(config.get('port', BRIDGE_PORT))}.lock"
    lock_fd: int | None = None
    try:
        try:
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(lock_fd, f"{os.getpid()} {time.time()}".encode("ascii"))
        except FileExistsError:
            # Another Native Messaging invocation is already starting the same
            # Bridge. Wait for it instead of spawning a competing server.
            if wait_for_bridge(config, 30):
                return {"ok": True, "started": False, "alreadyRunning": True, "bridgeUrl": url}
            try:
                age = time.time() - lock_path.stat().st_mtime
            except OSError:
                age = 0
            if age > 40:
                lock_path.unlink(missing_ok=True)
                return start_bridge_process(config)
            return {
                "ok": False, "started": False, "bridgeUrl": url,
                "error": f"Bridge 启动进程未在预期时间内就绪：{url}",
                "diagnostic": log_tail(),
            }

        # A listening non-Bridge process must not be hidden behind a generic
        # timeout. Give an in-flight Bridge a short grace period, then report
        # the real port conflict.
        if port_is_open(config) and not wait_for_bridge(config, 4):
            return {
                "ok": False, "started": False, "bridgeUrl": url,
                "error": f"端口 {int(config.get('port', BRIDGE_PORT))} 已被其他程序占用",
                "diagnostic": log_tail(),
            }

        if getattr(sys, "frozen", False):
            command = [sys.executable, "--bridge"]
        else:
            command = [sys.executable, str(Path(__file__).resolve()), "--bridge"]
        creationflags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
        log_stream = None
        try:
            log_stream = runtime_log_path().open("ab", buffering=0)
            process = subprocess.Popen(
                command,
                cwd=str(base_dir()),
                stdin=subprocess.DEVNULL,
                stdout=log_stream,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
                close_fds=True,
            )
            log_event(f"spawned Bridge pid={process.pid} command={command!r}")
        except Exception as exc:
            log_event(f"Bridge spawn failed: {exc!r}")
            return {"ok": False, "started": False, "error": f"无法启动 Bridge：{exc}", "diagnostic": log_tail()}
        finally:
            if log_stream is not None:
                log_stream.close()

        if wait_for_bridge(config, 30):
            log_event(f"Bridge healthy at {url}")
            return {"ok": True, "started": True, "alreadyRunning": False, "bridgeUrl": url}
        log_event(f"Bridge startup timeout at {url}")
        return {
            "ok": False, "started": False, "error": f"Bridge 启动超时：{url}",
            "diagnostic": log_tail(),
        }
    finally:
        if lock_fd is not None:
            try:
                os.close(lock_fd)
            except OSError:
                pass
            lock_path.unlink(missing_ok=True)


def run_bridge_child() -> None:
    from http.server import ThreadingHTTPServer

    from server import BridgeHandler, _port_already_serves_bridge, create_server

    config = load_config()
    if _port_already_serves_bridge(str(config.get("host", BRIDGE_HOST)), int(config.get("port", BRIDGE_PORT))):
        print("[native-host] a Bridge is already serving this port; exiting to avoid double-bind", file=sys.stderr, flush=True)
        return
    configured_master = config.get("seed_csv") or config.get("seed_xlsx") or ""
    seed_xlsx = Path(configured_master) if configured_master else None
    try:
        server, _store, inserted = create_server(
            str(config.get("host", BRIDGE_HOST)),
            int(config.get("port", BRIDGE_PORT)),
            Path(config["db"]),
            Path(config["export_dir"]),
            seed_xlsx,
        )
        assert isinstance(server, ThreadingHTTPServer)
        # Persist the completed XLSX -> CSV migration so every later launch
        # goes directly to the lightweight tables.
        if _store.seed_xlsx_path:
            config["seed_csv"] = str(_store.seed_xlsx_path)
            config["comments_csv"] = str(_store.comments_csv_path or "")
            config["seed_xlsx"] = ""
            target = config_path()
            temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temporary, target)
        log_event(f"bridge child running; seeded={inserted}")
        print(f"[native-host] bridge child running; seeded={inserted}", file=sys.stderr, flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
    except Exception as exc:
        log_event(f"bridge child failed: {exc!r}")
        raise


def read_exact(stream, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("native messaging pipe closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message() -> dict[str, Any] | None:
    header = sys.stdin.buffer.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise EOFError("invalid native messaging header")
    length = struct.unpack("<I", header)[0]
    if length > 1024 * 1024:
        raise ValueError("native messaging request too large")
    return json.loads(read_exact(sys.stdin.buffer, length).decode("utf-8"))


def write_message(payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > 1024 * 1024:
        raise ValueError("native messaging response too large")
    sys.stdout.buffer.write(struct.pack("<I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def native_loop() -> None:
    while True:
        try:
            message = read_message()
        except EOFError:
            return
        if message is None:
            return
        if message.get("type") == "ensure_bridge":
            write_message(start_bridge_process(load_config()))
        elif message.get("type") == "health":
            config = load_config()
            write_message({"ok": bridge_is_healthy(config), "bridgeUrl": bridge_url(config)})
        else:
            write_message({"ok": False, "error": f"unknown message type: {message.get('type')}"})


def main() -> None:
    if "--bridge" in sys.argv[1:]:
        run_bridge_child()
    else:
        native_loop()


if __name__ == "__main__":
    main()
