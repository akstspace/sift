#!/usr/bin/env python3
"""Verify local archives/checksums and smoke-test only the native executable.

Does not publish, install, run Pi prompts, or open a persistent workspace.
Linux archives are inspected, never described as runtime-tested on macOS.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import mmap
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import struct
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from local_api import open_local

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--version", required=True)
parser.add_argument("--platform", choices=["all", "darwin-arm64", "linux-arm64", "linux-amd64"], default="all")
parser.add_argument("--output", default="docs/verification/release-check.json")
args = parser.parse_args()
if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
    raise SystemExit("Use an explicit stable semantic version")
dist = ROOT / "dist" / args.version
records = {}
for line in (dist / "checksums.txt").read_text().splitlines():
    checksum, name = line.split()
    if Path(name).name != name or name in records:
        raise SystemExit("Unsafe or repeated checksum entry")
    records[name] = checksum
expected = {f"sift_{os}_{arch}.tar.gz" for os, arch in [("darwin", "arm64"), ("linux", "arm64"), ("linux", "amd64")]}
if args.platform != "all":
    expected = {"sift_" + args.platform.replace("-", "_") + ".tar.gz"}
if records.keys() != expected:
    raise SystemExit("Expected checksums for all three local platform archives")
host = ("darwin" if platform.system() == "Darwin" else "linux") + "-" + {"aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine(), platform.machine())
if args.platform != "all" and args.platform != host:
    raise SystemExit("A single-platform check must run on its native host")
(ROOT / ".cache").mkdir(exist_ok=True)
report = {"version": args.version, "host": host, "generatedAt": datetime.now(timezone.utc).isoformat(), "archives": [], "nativeSmoke": None}


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


for name, checksum in sorted(records.items()):
    archive = dist / name
    if digest(archive) != checksum:
        raise SystemExit(f"Checksum mismatch: {name}")
    target = name.removeprefix("sift_").removesuffix(".tar.gz").replace("_", "-")
    with tempfile.TemporaryDirectory(prefix="release-check-", dir=ROOT / ".cache") as temp:
        temp = Path(temp)
        executable = temp / "sift"
        with tarfile.open(archive, "r:gz") as tar:
            entries = tar.getmembers()
            names = [entry.name for entry in entries]
            if len(names) != len(set(names)) or names.count("sift") != 1:
                raise SystemExit(f"Repeated archive entry: {name}")
            for entry in entries:
                path = PurePosixPath(entry.name)
                if not entry.isfile() or path.is_absolute() or ".." in path.parts or entry.mtime != 0:
                    raise SystemExit(f"Unsafe or non-normalized entry: {entry.name}")
                if entry.mode != (0o755 if entry.name == "sift" else 0o644):
                    raise SystemExit(f"Unexpected archive mode: {entry.name}")
            for required in ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/DEPENDENCIES.json", "docs/ACCEPTANCE.md", "docs/OPERATIONS.md"]:
                if required not in names:
                    raise SystemExit(f"Missing {required} in {name}")
            documentation = [ROOT / name for name in json.loads((ROOT / "scripts/package-docs.json").read_text())]
            for source in documentation:
                relative = str(source.relative_to(ROOT))
                if relative not in names or tar.extractfile(relative).read() != source.read_bytes():
                    raise SystemExit(f"Packaged documentation differs from source: {relative} in {name}")
            notices = json.load(tar.extractfile("licenses/DEPENDENCIES.json"))
            with tar.extractfile("sift") as source, executable.open("wb") as dest:
                shutil.copyfileobj(source, dest)
        executable.chmod(0o700)
        with executable.open("rb") as source:
            header = source.read(32)
        if target == "darwin-arm64":
            if header[:4] != b"\xcf\xfa\xed\xfe" or struct.unpack("<I", header[4:8])[0] != 0x100000C:
                raise SystemExit("Expected arm64 Mach-O")
        else:
            machine = 183 if target.endswith("arm64") else 62
            if header[:6] != b"\x7fELF\x02\x01" or struct.unpack("<H", header[18:20])[0] != machine:
                raise SystemExit(f"Unexpected ELF architecture: {target}")
        payload = ROOT / "internal/sift/payload" / ("rustfs-" + target)
        payload_meta = json.loads(payload.with_name(target + ".json").read_text())
        payload_size = payload.stat().st_size
        with payload.open("rb") as source:
            marker = source.read(4096)
        with executable.open("rb") as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as binary:
            offset = binary.find(marker)
            if offset < 0 or offset + payload_size > len(binary):
                raise SystemExit(f"Bundled RustFS not found: {target}")
            view = memoryview(binary)[offset:offset + payload_size]
            try:
                payload_hash = hashlib.sha256(view).hexdigest()
            finally:
                view.release()
            if payload_hash != payload_meta["executable_sha256"]:
                raise SystemExit(f"Embedded RustFS checksum mismatch: {target}")
            for other in ["darwin-arm64", "linux-arm64", "linux-amd64"]:
                if other != target and binary.find(("payload/rustfs-" + other).encode()) >= 0:
                    raise SystemExit(f"Unexpected second-platform payload: {other}")
        report["archives"].append({"name": name, "sha256": checksum, "bytes": archive.stat().st_size, "executableBytes": executable.stat().st_size,
                                   "target": target, "entries": len(names), "npmNotices": len(notices["npm"]), "goNotices": len(notices["go"]),
                                   "embeddedRustfsSha256": payload_hash, "nativeSmokeTested": target == host,
                                   "documentationFilesMatchSource": len(documentation)})
        if target != host:
            continue
        if subprocess.check_output([str(executable), "version"], text=True).strip() != args.version:
            raise SystemExit("Native executable reported the wrong version")
        workspace = temp / "workspace"
        with (temp / "stdout.log").open("w") as stdout, (temp / "stderr.log").open("w") as stderr:
            proc = subprocess.Popen([str(executable), "serve", "--data", str(workspace), "--port", "0"], stdout=stdout, stderr=stderr)
            try:
                deadline = time.monotonic() + 60
                connection = None
                while time.monotonic() < deadline and proc.poll() is None:
                    path = workspace / "connection.json"
                    if path.exists():
                        connection = json.loads(path.read_text())
                        break
                    time.sleep(0.05)
                if connection is None:
                    raise SystemExit("Native service did not publish a connection")

                def request(path):
                    with open_local(connection, path, timeout=10) as response:
                        return response.read()

                while time.monotonic() < deadline:
                    health = json.loads(request("/api/health"))
                    if health["storage"]["ready"]:
                        break
                    time.sleep(0.1)
                else:
                    raise SystemExit("Native bundled RustFS did not become ready")
                if health["version"] != args.version or health["platform"] != platform.system().lower():
                    raise SystemExit("Native health mismatch")

                def cli(*args):
                    return json.loads(subprocess.check_output([str(executable), "--data", str(workspace), *args], text=True, timeout=30))

                task = cli("tasks", "add", "--title", "Native package smoke", "--actor", "package-smoke")["task"]
                if cli("tasks", "get", task["id"])["task"]["title"] != task["title"]:
                    raise SystemExit("Native CLI persistence failed")
                image = cli("images", "upload", str(ROOT / "web/public/icon-192.png"))
                if request(image["url"]) != (ROOT / "web/public/icon-192.png").read_bytes():
                    raise SystemExit("Native RustFS image bytes changed")
                backup = cli("backup")
                html = request("/")
                if b"/assets/" not in html:
                    raise SystemExit("Native frontend is missing")
                if cli("runs"):
                    raise SystemExit("Smoke test unexpectedly launched model work")
                report["nativeSmoke"] = {"version": args.version, "platform": health["platform"], "rustfsReady": True, "cliPersistence": True,
                                         "imageBytesMatch": True, "backupCreated": bool(backup), "frontendEmbedded": True, "modelRuns": 0}
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    proc.kill(); proc.wait()
                    raise SystemExit("Native service required forced shutdown")
            if proc.returncode != 0:
                raise SystemExit(f"Native service shutdown status {proc.returncode}")
            report["nativeSmoke"]["cleanShutdown"] = True
    print(f"Verified {name}", flush=True)
output = ROOT / args.output
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2) + "\n")
print(f"Local package evidence: {output}. Nothing installed or published.")
