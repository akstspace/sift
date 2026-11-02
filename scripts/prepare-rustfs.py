#!/usr/bin/env python3
"""Freeze verified upstream RustFS payloads. No executable installer is run."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "scripts/rustfs.lock.json").read_text())

def prepare(target):
    item = LOCK["platforms"][target]
    url = f'https://github.com/rustfs/rustfs/releases/download/{LOCK["version"]}/{item["asset"]}'
    cache = ROOT / ".cache/downloads" / item["asset"]
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not cache.exists() or hashlib.sha256(cache.read_bytes()).hexdigest() != item["sha256"]:
        print(f"Downloading {target}: {url}", flush=True)
        request = urllib.request.Request(url, headers={"User-Agent": "Sift-build"})
        with urllib.request.urlopen(request, timeout=120) as response:
            blob = response.read(500 << 20)
        if hashlib.sha256(blob).hexdigest() != item["sha256"]:
            raise SystemExit(f"SHA-256 verification FAILED for {target}")
        cache.write_bytes(blob)
    blob = cache.read_bytes()
    if hashlib.sha256(blob).hexdigest() != item["sha256"]:
        raise SystemExit("Cached archive checksum mismatch")
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        candidates = [f for f in archive.infolist() if Path(f.filename).name == "rustfs" and not f.is_dir()]
        if len(candidates) != 1 or candidates[0].file_size > 800 << 20:
            raise SystemExit("Expected exactly one bounded RustFS executable")
        executable = archive.read(candidates[0])
    dest = ROOT / "internal/sift/payload" / f"rustfs-{target}"
    temporary = dest.with_suffix(".new")
    temporary.write_bytes(executable)
    temporary.chmod(0o700)
    temporary.replace(dest)
    record = dict(item, version=LOCK["version"], source=url,
                  executable_sha256=hashlib.sha256(executable).hexdigest())
    (dest.parent / f"{target}.json").write_text(json.dumps(record, indent=2) + "\n")
    print(f"Verified {dest.name}", flush=True)

if __name__ == "__main__":
    host = ("darwin" if platform.system() == "Darwin" else "linux") + "-" + {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine(), platform.machine())
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", choices=[*LOCK["platforms"], "all"], default=host)
    args = parser.parse_args()
    for target in LOCK["platforms"] if args.platform == "all" else [args.platform]:
        prepare(target)
