#!/usr/bin/env python3
"""Fetch checksum-pinned scanners/rules into this checkout, never global PATH."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import platform
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "scripts/security-tools.lock.json").read_text())


def download(url, checksum, cached):
    if cached.is_file() and hashlib.sha256(cached.read_bytes()).hexdigest() == checksum:
        return cached.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": "Sift-security-tools"})
    with urllib.request.urlopen(request, timeout=180) as response:
        data = response.read(200 << 20)
    if hashlib.sha256(data).hexdigest() != checksum:
        raise SystemExit(f"Scanner/rules checksum mismatch: {url}")
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(data)
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("tools", nargs="*", choices=["opengrep", "trivy", "actionlint", "rules"])
    args = parser.parse_args()
    host = platform.system().lower() + "-" + {"aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine(), platform.machine())
    dest = ROOT / ".cache/security-tools"
    dest.mkdir(parents=True, exist_ok=True)
    for name in args.tools or ["opengrep", "trivy", "actionlint", "rules"]:
        item = LOCK[name]
        if name == "rules":
            data = download(f"https://api.github.com/repos/{item['repository']}/tarball/{item['revision']}", item["sha256"], ROOT / ".cache/downloads" / f"opengrep-rules-{item['revision'][:8]}.tar.gz")
            rules = dest / ("rules-" + item["revision"])
            rules.mkdir(exist_ok=True)
            count = 0
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                for entry in archive.getmembers():
                    parts = PurePosixPath(entry.name).parts[1:]
                    if not parts or ".." in parts or entry.size > 2 << 20 or not entry.isfile():
                        continue
                    if parts[0] == "LICENSE" or (parts[0] in item["languages"] and parts[-1].endswith((".yaml", ".yml"))):
                        path = rules.joinpath(*parts)
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(archive.extractfile(entry).read())
                        count += 1
            print(f"Verified {count} upstream rule/license files: {rules}")
            continue
        if host not in item["platforms"]:
            raise SystemExit(f"Unsupported scanner platform: {host}")
        asset, checksum = item["platforms"][host]
        data = download(f"https://github.com/{item['repository']}/releases/download/v{item['version']}/{asset}", checksum, ROOT / ".cache/downloads" / asset)
        if asset.endswith(".tar.gz"):
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                entries = [e for e in archive if e.isfile() and e.name == name]
                if len(entries) != 1:
                    raise SystemExit("Expected one scanner executable")
                data = archive.extractfile(entries[0]).read()
        executable = dest / name
        executable.write_bytes(data)
        executable.chmod(0o700)
        print(f"Verified {name} {item['version']}: {executable}")


if __name__ == "__main__":
    main()
