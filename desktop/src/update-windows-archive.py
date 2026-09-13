"""Extract a verified Windows update ZIP into a new, private directory.

NSIS is the initial installer. Update preparation must not execute an installer
that could uninstall the active app, so activation consumes a signed ZIP tree.
The caller verifies a private snapshot against the signed descriptor first.
"""
import os
from pathlib import Path
import re
import stat
import sys
import zipfile


def real_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("Update extraction requires real directories")
    if os.path.normcase(str(path.resolve())) != os.path.normcase(str(path.absolute())):
        raise ValueError("Update extraction directory contains an alias")


def extract(archive, destination, *, max_files=250000, max_bytes=16 * 1024**3):
    archive, destination = Path(archive), Path(destination)
    if not archive.is_absolute() or not destination.is_absolute():
        raise ValueError("Update archive paths must be absolute")
    real_directory(destination.parent)
    if destination.exists() or destination.is_symlink():
        raise ValueError("Update extraction destination already exists")
    info = archive.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("Update archive must be a regular file")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if not entries or len(entries) > max_files or sum(item.file_size for item in entries) > max_bytes:
            raise ValueError("Update archive exceeds its extraction limits")
        explicit, kinds, planned = set(), {}, []
        for item in entries:
            if item.orig_filename != item.filename:
                raise ValueError("Update archive contains a truncated filename")
            name = item.filename.replace("\\", "/")
            directory = item.is_dir() or name.endswith("/")
            parts = name.removesuffix("/").split("/")
            if len(parts) > 64 or any(not part or part in (".", "..") or part.endswith((" ", "."))
                                      or re.search(r'[<>:"|?*\x00-\x1f]', part)
                                      or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?", part, re.I)
                                      for part in parts):
                raise ValueError("Update archive contains an unsafe Windows path")
            kind = stat.S_IFMT(item.external_attr >> 16)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or item.external_attr & 0x400 or item.flag_bits & 1:
                raise ValueError("Update archive contains links, special files, or encryption")
            if kind == stat.S_IFDIR and not directory:
                raise ValueError("Update archive directory metadata is inconsistent")
            key = "/".join(parts).casefold()
            if key in explicit:
                raise ValueError("Update archive contains duplicate Windows paths")
            explicit.add(key)
            for index in range(1, len(parts) + 1):
                prefix = "/".join(parts[:index]).casefold()
                expected = "directory" if index < len(parts) or directory else "file"
                if prefix in kinds and kinds[prefix] != expected:
                    raise ValueError("Update archive contains conflicting paths")
                kinds[prefix] = expected
            planned.append((item, parts, directory))
        # All names are checked before publishing even an empty destination.
        destination.mkdir()
        real_directory(destination)
        for item, parts, directory in planned:
            parent = destination
            for component in parts if directory else parts[:-1]:
                parent = parent / component
                parent.mkdir(exist_ok=True)
                real_directory(parent)
            if directory:
                continue
            target = parent / parts[-1]
            with source.open(item) as incoming, target.open("xb") as outgoing:
                size = 0
                while chunk := incoming.read(1024 * 1024):
                    size += len(chunk)
                    if size > item.file_size:
                        raise ValueError("Update archive file exceeds its declared size")
                    outgoing.write(chunk)
                if size != item.file_size:
                    raise ValueError("Update archive file is incomplete")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Expected archive and new destination")
        extract(sys.argv[1], sys.argv[2])
    except Exception as error:
        print(f"Windows update extraction failed: {error}", file=sys.stderr)
        sys.exit(1)
