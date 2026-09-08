"""Run release regressions from a source-only snapshot, never production data.

Usage: python -B bridge/verify_release.py [--output PATH]
Requires Python dependencies from requirements.txt and Node.js on PATH.
The output contains logs, guarded test evidence and source SHA-256 hashes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="xhs-release-check-"))
    for protected in (repo / "data", repo / "bridge" / "data", repo / "bridge" / "exports"):
        if output == protected or output.is_relative_to(protected):
            parser.error("Test output must not be inside a business data directory")
    node = shutil.which("node")
    if not node:
        parser.error("Node.js is required to run extension regressions")
    output.mkdir(parents=True, exist_ok=True)
    snapshot = output / "snapshot"
    if snapshot.exists():
        parser.error("Choose a new output directory; an existing snapshot will not be overwritten")
    (output / "tmp").mkdir()
    (output / "guard").mkdir()
    shutil.copy2(repo / "bridge" / "test_support" / "sitecustomize.py", output / "guard" / "sitecustomize.py")
    sources = list((repo / "bridge").glob("*.py"))
    sources += [p for p in (repo / "extension").iterdir() if p.is_file() and p.suffix in {".js", ".html", ".css", ".json"}]
    sources += [p for p in (repo / "extension" / "tests").iterdir() if p.is_file() and p.suffix in {".js", ".cjs", ".html"}]
    hashes = {}
    for source in sources:
        relative = source.relative_to(repo)
        body = source.read_bytes()
        target = snapshot / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        hashes[str(relative)] = hashlib.sha256(body).hexdigest()
    (output / "source-hashes.json").write_text(json.dumps(hashes, ensure_ascii=False, indent=2), encoding="utf-8")
    environment = dict(os.environ)
    for key in tuple(environment):
        if key.lower() in {"http_proxy", "https_proxy", "all_proxy", "pythonpath"}:
            environment.pop(key)
    environment.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1",
                       PYTHONPATH=str(output / "guard"), TEMP=str(output / "tmp"), TMP=str(output / "tmp"),
                       AUDIT_ROOT=str(output), AUDIT_GUARD_LOG=str(output / "python-guard.json"),
                       NO_PROXY="127.0.0.1,localhost")
    # A transient Windows scanner lock on a fixture CSV must not probe the
    # user's live Excel/WPS process. Mock just that external-app boundary;
    # dedicated recovery tests can still override these mocks themselves.
    python_runner = (
        "import unittest, server\nfrom unittest.mock import patch\n"
        "with patch.object(server, '_reopen_saved_office_workbook_read_only', return_value=False), "
        "patch.object(server, '_close_saved_office_workbook', return_value=False):\n"
        "    unittest.main(module=None, argv=['unittest','discover','-s','.','-p','test_*.py'])\n"
    )
    commands = [
        ("python", [sys.executable, "-B", "-c", python_runner], snapshot / "bridge"),
        ("node", [node, "--test", *[str(p) for p in sorted((snapshot / "extension" / "tests").glob("*.test.cjs"))]], snapshot),
    ]
    reports = []
    for name, command, cwd in commands:
        started = time.perf_counter()
        with (output / f"{name}-tests.txt").open("w", encoding="utf-8") as stream:
            process = subprocess.run(command, cwd=cwd, env=environment, stdout=stream, stderr=subprocess.STDOUT)
        log = (output / f"{name}-tests.txt").read_text(encoding="utf-8")
        match = re.search(r"Ran (\d+) tests", log) if name == "python" else re.search(r"(?:#|ℹ) tests (\d+)", log)
        result = {"suite": name, "exit_code": process.returncode,
                  "tests": int(match[1]) if match else None, "seconds": round(time.perf_counter() - started, 3)}
        reports.append(result)
        print(json.dumps(result), flush=True)
    changed = [str(p.relative_to(repo)) for p in sources
               if not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest() != hashes[str(p.relative_to(repo))]]
    guard = json.loads((output / "python-guard.json").read_text(encoding="utf-8")) if (output / "python-guard.json").exists() else {}
    passed = all(item["exit_code"] == 0 and item["tests"] for item in reports) and not changed
    passed = bool(passed and guard.get("guard_installed") and not guard.get("denied_attempts"))
    summary = {"ok": passed, "suites": reports, "source_changed_during_tests": changed,
               "python_io_guard_verified": bool(guard.get("guard_installed") and not guard.get("denied_attempts")),
               "business_data_copied": False, "live_bridge_restarted": False, "output": str(output)}
    (output / "result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
