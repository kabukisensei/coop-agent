#!/usr/bin/env python3
"""Build development wheels from committed snapshots, without changing checkouts."""
import argparse
import email
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repositories", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pins", type=Path, help="Override development commit pins for a Windows validation branch")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    pins = json.loads((args.pins or repo / "config/development-companions.json").read_text())
    expected = json.loads((repo / "config/release-manifest.json").read_text())["python_tools"]
    names = {"coop-data-doc", "coop-sql-review", "coop-dax-review"}
    if set(pins) != names or any(len(sha) != 40 or any(c not in "0123456789abcdef" for c in sha) for sha in pins.values()):
        raise ValueError("Development pins must name all three companions with full commit IDs")
    output = args.output.resolve()
    output.mkdir(parents=False, exist_ok=False)
    wheels = []
    for name, revision in sorted(pins.items()):
        checkout = (args.repositories / f"{name}-desktop").resolve()
        actual = run("git", "-C", str(checkout), "rev-parse", f"{revision}^{{commit}}")
        if actual != revision:
            raise ValueError(f"Commit mismatch for {name}")
        source = output / f"source-{name}"
        source.mkdir()
        archive = output / f"{name}.tar"
        run("git", "-C", str(checkout), "archive", "--format=tar", "--output", str(archive), revision)
        run("tar", "-xf", str(archive), "-C", str(source))
        epoch = run("git", "-C", str(checkout), "show", "-s", "--format=%ct", revision)
        run(sys.executable, "-m", "pip", "wheel", "--no-deps", "--no-cache-dir", "--disable-pip-version-check",
            "--wheel-dir", str(output), str(source), env={**os.environ, "SOURCE_DATE_EPOCH": epoch})
        filename = f"{name.replace('-', '_')}-{expected[name]}-py3-none-any.whl"
        wheel = output / filename
        with zipfile.ZipFile(wheel) as package:
            entries = [path for path in package.namelist() if path.endswith(".dist-info/METADATA")]
            if len(entries) != 1:
                raise ValueError(f"Ambiguous metadata in {filename}")
            metadata = email.message_from_bytes(package.read(entries[0]))
            if metadata["Name"] != name or metadata["Version"] != expected[name]:
                raise ValueError(f"Package metadata does not match the release pin: {name}")
        wheels.append({"name": name, "version": expected[name], "file": filename,
                       "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
                       "repository": f"https://github.com/kabukisensei/{name}.git", "revision": revision})
        print(f"Built {filename} from {revision}", flush=True)
    manifest = output / "development-wheels.json"
    manifest.write_text(json.dumps({"schemaVersion": 1, "wheels": wheels}, indent=2) + "\n", encoding="utf-8")
    print(f"Development wheel manifest: {manifest}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(f"Development wheel build failed: {(error.stderr or error.stdout or str(error))[-3000:]}", file=sys.stderr)
        sys.exit(1)
