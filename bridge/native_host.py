#!/usr/bin/env python3
"""Native Messaging host that starts the local XHS-Monitor Bridge on demand.

Default mode speaks Chrome's length-prefixed JSON protocol. ``--bridge`` mode
is used by the host as a detached child process and runs the HTTP Bridge.
"""

from __future__ import annotations

import json
import os
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
        "seed_xlsx": "",
    }
    path = config_path()
    if path.exists():
        config.update(json.loads(path.read_text(encoding="utf-8")))
    return config


def bridge_url(config: dict[str, Any]) -> str:
    return f"http://{config.get('host', BRIDGE_HOST)}:{int(config.get('port', BRIDGE_PORT))}"


def bridge_is_healthy(config: dict[str, Any]) -> bool:
    try:
        with urllib.request.urlopen(f"{bridge_url(config)}/api/health", timeout=0.7) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return bool(payload.get("ok") and payload.get("service") == "xhs-monitor-bridge")
    except Exception:
        return False


def start_bridge_process(config: dict[str, Any]) -> dict[str, Any]:
    url = bridge_url(config)
    if bridge_is_healthy(config):
        return {"ok": True, "started": False, "alreadyRunning": True, "bridgeUrl": url}

    if getattr(sys, "frozen", False):
        command = [sys.executable, "--bridge"]
    else:
        command = [sys.executable, str(Path(__file__).resolve()), "--bridge"]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen(
            command,
            cwd=str(base_dir()),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
            close_fds=True,
        )
    except Exception as exc:
        return {"ok": False, "started": False, "error": f"无法启动 Bridge：{exc}"}

    deadline = time.time() + 10
    while time.time() < deadline:
        if bridge_is_healthy(config):
            return {"ok": True, "started": True, "alreadyRunning": False, "bridgeUrl": url}
        time.sleep(0.25)
    return {"ok": False, "started": False, "error": f"Bridge 启动超时：{url}"}


def run_bridge_child() -> None:
    from http.server import ThreadingHTTPServer

    from server import BridgeHandler, _port_already_serves_bridge, create_server

    config = load_config()
    if _port_already_serves_bridge(str(config.get("host", BRIDGE_HOST)), int(config.get("port", BRIDGE_PORT))):
        print("[native-host] a Bridge is already serving this port; exiting to avoid double-bind", file=sys.stderr, flush=True)
        return
    seed_xlsx = Path(config["seed_xlsx"]) if config.get("seed_xlsx") else None
    server, _store, inserted = create_server(
        str(config.get("host", BRIDGE_HOST)),
        int(config.get("port", BRIDGE_PORT)),
        Path(config["db"]),
        Path(config["export_dir"]),
        seed_xlsx,
    )
    assert isinstance(server, ThreadingHTTPServer)
    print(f"[native-host] bridge child running; seeded={inserted}", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


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
