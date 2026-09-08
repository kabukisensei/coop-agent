"""Exercise actual ZIP extraction with Windows filename rules on every host."""
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("windows_archive", Path(__file__).resolve().parents[1] / "desktop/src/update-windows-archive.py")
archive_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive_module)


class WindowsArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="coop-windows-archive-")
        self.root = Path(self.temp.name).resolve()
        self.archive, self.output = self.root / "candidate.zip", self.root / "candidate"

    def tearDown(self):
        self.temp.cleanup()

    def make(self, entries):
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_DEFLATED) as target:
            for name, content in entries:
                target.writestr(name, content)

    def test_real_unicode_tree_and_contents(self):
        self.make([("resources/", ""), ("Coop Desktop.exe", b"synthetic executable"),
                   ("resources/space & café/中文.txt", "Unicode ✓\r\nsecond line"),
                   ("resources/empty", "")])
        archive_module.extract(self.archive, self.output)
        self.assertEqual((self.output / "resources/space & café/中文.txt").read_bytes(), "Unicode ✓\r\nsecond line".encode())
        self.assertEqual((self.output / "Coop Desktop.exe").read_bytes(), b"synthetic executable")

    def test_unsafe_paths_rejected_before_creating_destination(self):
        for name in ["../outside", "/absolute", "C:/escape", "\\\\server\\share", "safe/../../escape",
                     "safe/file:stream", "NUL", "con.txt", "COM¹.txt", "LPT9", "name.", "name ", "a//b", "a/./b", "a/*"]:
            with self.subTest(name=name):
                self.make([(name, "payload")])
                with self.assertRaises(ValueError):
                    archive_module.extract(self.archive, self.output)
                self.assertFalse(self.output.exists())

    def test_case_collisions_and_file_directory_conflicts(self):
        for names in [("FILE", "file"), ("file", "file/child"), ("file/child", "file")]:
            with self.subTest(names=names):
                self.make([(name, "payload") for name in names])
                with self.assertRaises(ValueError):
                    archive_module.extract(self.archive, self.output)
                self.assertFalse(self.output.exists())

    def test_links_special_files_and_reparse_attributes(self):
        for mode, attributes in [(stat.S_IFLNK | 0o777, 0), (stat.S_IFIFO | 0o600, 0), (stat.S_IFREG | 0o600, 0x400)]:
            info = zipfile.ZipInfo("entry")
            info.create_system = 3
            info.external_attr = (mode << 16) | attributes
            self.make([(info, "outside")])
            with self.assertRaises(ValueError):
                archive_module.extract(self.archive, self.output)
            self.assertFalse(self.output.exists())

    def test_limits_and_existing_destination_preserve_data(self):
        self.make([("one", "123"), ("two", "456")])
        for options in [dict(max_files=1), dict(max_bytes=5)]:
            with self.assertRaises(ValueError):
                archive_module.extract(self.archive, self.output, **options)
            self.assertFalse(self.output.exists())
        self.output.mkdir()
        sentinel = self.output / "keep"
        sentinel.write_text("unchanged")
        with self.assertRaises(ValueError):
            archive_module.extract(self.archive, self.output)
        self.assertEqual(sentinel.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main(verbosity=2)
