import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import native_host


class NativeHostRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config_file = self.root / "native_host_config.json"
        self.config_file.write_text("{}", encoding="utf-8")
        self.config = {
            "host": "127.0.0.1", "port": 18991,
            "db": str(self.root / "monitor.db"),
            "export_dir": str(self.root / "exports"),
            "seed_xlsx": "",
        }
        self.config_patch = patch.object(native_host, "config_path", return_value=self.config_file)
        self.config_patch.start()

    def tearDown(self):
        self.config_patch.stop()
        self.tmp.cleanup()

    def test_existing_start_lock_waits_instead_of_spawning_duplicate(self):
        lock = self.root / ".bridge-starting-18991.lock"
        lock.write_text("123 0", encoding="ascii")
        with patch.object(native_host, "bridge_is_healthy", return_value=False),              patch.object(native_host, "wait_for_bridge", return_value=True),              patch.object(native_host.subprocess, "Popen") as popen:
            result = native_host.start_bridge_process(self.config)
        self.assertTrue(result["ok"])
        self.assertTrue(result["alreadyRunning"])
        popen.assert_not_called()

    def test_spawn_is_detached_and_waits_until_healthy(self):
        process = Mock(pid=4321)
        with patch.object(native_host, "bridge_is_healthy", return_value=False),              patch.object(native_host, "port_is_open", return_value=False),              patch.object(native_host, "wait_for_bridge", return_value=True),              patch.object(native_host.subprocess, "Popen", return_value=process) as popen:
            result = native_host.start_bridge_process(self.config)
        self.assertTrue(result["ok"])
        self.assertTrue(result["started"])
        flags = popen.call_args.kwargs["creationflags"]
        self.assertEqual(flags & getattr(native_host.subprocess, "DETACHED_PROCESS", 0),
                         getattr(native_host.subprocess, "DETACHED_PROCESS", 0))
        self.assertFalse((self.root / ".bridge-starting-18991.lock").exists())

    def test_log_file_records_startup_diagnostics(self):
        native_host.log_event("bridge diagnostic")
        content = (self.root / "native_host.log").read_text(encoding="utf-8")
        self.assertIn("bridge diagnostic", content)


if __name__ == "__main__":
    unittest.main()

