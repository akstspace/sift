#!/usr/bin/env python3
"""Build deterministic local release archives. Never publishes or calls GitHub write APIs."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--version", required=True, help="Explicit stable version, e.g. 0.1.0")
parser.add_argument("--platform", choices=["all", "darwin-arm64", "linux-arm64", "linux-amd64"], default="all")
args = parser.parse_args()
if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
    raise SystemExit("Use an explicit stable semantic version")
declared = subprocess.check_output(["python3", "scripts/version.py"], cwd=ROOT, text=True).strip()
if args.version != declared:
    raise SystemExit("Release version must match VERSION, Go, and npm manifests")
targets = ["darwin-arm64", "linux-arm64", "linux-amd64"] if args.platform == "all" else [args.platform]
documentation = json.loads((ROOT / "scripts/package-docs.json").read_text())
for required in documentation:
    if not (ROOT / required).is_file():
        raise SystemExit(f"Missing {required}; prepare documentation and run scripts/collect-licenses.py first")
# All target payloads must exist for the collector's cross-platform go list.
# Build tags still embed only the selected target's payload in each executable.
subprocess.run(["python3", "scripts/prepare-rustfs.py", "--platform", "all"], cwd=ROOT, check=True)
subprocess.run(["npm", "ci"], cwd=ROOT / "web", check=True)
subprocess.run(["npm", "run", "build"], cwd=ROOT / "web", check=True)
subprocess.run(["python3", "scripts/collect-licenses.py"], cwd=ROOT, check=True)
# Local generated notice directories may contain files from removed dependencies.
# Ship only the current collector's explicit inventory, never stale local files.
index = json.loads((ROOT / "licenses/DEPENDENCIES.json").read_text())
notice_names = {"DEPENDENCIES.json", "RustFS-1.0.4-APACHE-2.0.txt", "shadcn-ui-MIT.txt", *index["assets"]}
for group in ["npm", "go"]:
    for dependency in index[group]:
        notice_names.update(dependency["files"])
notices = []
for name in sorted(notice_names):
    relative = PurePosixPath(name)
    path = ROOT / "licenses" / relative
    if (relative.is_absolute() or ".." in relative.parts or "\\" in name
            or path.is_symlink() or not path.is_file()
            or not path.resolve().is_relative_to((ROOT / "licenses").resolve())):
        raise SystemExit(f"Invalid or missing indexed dependency notice: {name}")
    notices.append(("licenses/" + name, path))
dest = ROOT / "dist" / args.version
dest.mkdir(parents=True, exist_ok=True)
for target in targets:
    goos, arch = target.split("-")
    binary = dest / f"sift_{goos}_{arch}"
    subprocess.run(["go", "build", "-trimpath", "-buildvcs=false", "-ldflags", f"-s -w -X github.com/akstspace/sift/internal/sift.Version={args.version}", "-o", str(binary), "./cmd/sift"], cwd=ROOT, env=dict(os.environ, GOOS=goos, GOARCH=arch, CGO_ENABLED="0"), check=True)
    archive = dest / f"sift_{goos}_{arch}.tar.gz"
    with archive.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w") as tar:
        files = [("sift", binary)] + notices
        # Only public operational docs, never ignored local design/research files.
        files += [(name, ROOT / name) for name in documentation]
        for name, path in files:
            data = path.read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o755 if name == "sift" else 0o644, 0
            tar.addfile(info, io.BytesIO(data))
    binary.unlink()
checks = []
for file in sorted(dest.glob("*.tar.gz")):
    checks.append(f"{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}")
(dest / "checksums.txt").write_text("\n".join(checks) + "\n")
print(f"Local artifacts: {dest}. Nothing was published.")
