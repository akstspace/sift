#!/bin/sh
# Inspect before running. Requires Python 3 only for installation, not for Sift.
set -eu
command -v python3 >/dev/null 2>&1 || {
  echo 'Sift installation requires Python 3. Alternatively unpack a release archive manually.' >&2
  exit 1
}
python3 - "$@" <<'PY'
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

REPOSITORY = "akstspace/sift"
MAX_ARCHIVE = 200 << 20
MAX_EXPANDED = 500 << 20


def github_url(url, initial=False):
    parsed = urllib.parse.urlsplit(url)
    hosts = {"api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
    if (parsed.scheme != "https" or parsed.hostname not in hosts or parsed.port not in (None, 443)
            or parsed.username is not None or parsed.password is not None):
        raise ValueError("Release downloads require an approved GitHub HTTPS host")
    if initial and not ((parsed.hostname == "api.github.com" and parsed.path.startswith(f"/repos/{REPOSITORY}/"))
                        or (parsed.hostname == "github.com" and parsed.path.startswith(f"/{REPOSITORY}/"))):
        raise ValueError("Only the official HTTPS GitHub repository is supported")


class GitHubRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        # Check BEFORE following every hop, not only after reading its response.
        github_url(url)
        return super().redirect_request(request, response, code, message, headers, url)


def fetch(url, limit):
    github_url(url, initial=True)
    request = urllib.request.Request(url, headers={"User-Agent": "Sift-installer", "Accept": "application/vnd.github+json"})
    with urllib.request.build_opener(GitHubRedirects()).open(request, timeout=120) as response:
        github_url(response.url)
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Release response exceeds the installation limit")
    return data


def stable(version):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("Use a stable version such as 0.1.0 (no v prefix)")
    return version


def unpack(data, destination):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        entries = []
        seen, total = set(), 0
        for entry in archive:
            path = PurePosixPath(entry.name)
            if (not entry.isfile() or path.is_absolute() or ".." in path.parts or "\\" in entry.name
                    or str(path) != entry.name or entry.name in seen or entry.size < 0
                    or "\x00" in entry.name or path == PurePosixPath(".")):
                raise ValueError("Unsafe or duplicate release archive entry")
            seen.add(entry.name)
            entries.append(entry)
            total += entry.size
            if total > MAX_EXPANDED or len(seen) > 10000:
                raise ValueError("Expanded release exceeds installation limits")
        if not {"sift", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/DEPENDENCIES.json"}.issubset(seen):
            raise ValueError("Release is missing its executable or required dependency notices")
        for entry in entries:
            target = destination / entry.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(entry) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755 if entry.name == "sift" else 0o644)


def install(version, bin_dir, data_dir, replace=False):
    os_name = platform.system().lower()
    arch = {"aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine(), platform.machine())
    target = os_name + "_" + arch
    if target not in {"darwin_arm64", "linux_arm64", "linux_amd64"}:
        raise ValueError("Supported targets: macOS arm64, Linux arm64, Linux amd64")
    if version is None:
        release = json.loads(fetch(f"https://api.github.com/repos/{REPOSITORY}/releases/latest", 1 << 20))
        if release.get("draft") or release.get("prerelease"):
            raise ValueError("Refusing a draft or prerelease")
        tag = release.get("tag_name", "")
        if not tag.startswith("v"):
            raise ValueError("Official release must use a stable v-prefixed tag")
        version = tag[1:]
    version = stable(version)
    bin_dir, data_dir = Path(bin_dir).expanduser().resolve(), Path(data_dir).expanduser().resolve()
    link = bin_dir / "sift"
    versions = data_dir / "versions"
    destination = versions / version
    old_link = None
    if os.path.lexists(destination):
        raise ValueError(f"Version directory already exists; inspect it before reinstalling: {destination}")
    if os.path.lexists(link):
        # Replacement is explicit and limited to a symlink created by this installer.
        if not replace or not link.is_symlink():
            raise ValueError(f"Refusing to overwrite {link}; use --replace only for an existing managed symlink")
        old = Path(os.readlink(link))
        if not old.is_absolute() or old.parent.parent != versions or old.name != "sift":
            raise ValueError("Existing sift symlink is not managed by this installation")
        stable(old.parent.name)
        old_link = os.readlink(link)
    base = f"https://github.com/{REPOSITORY}/releases/download/v{version}/"
    filename = f"sift_{target}.tar.gz"
    lines = fetch(base + "checksums.txt", 64 << 10).decode("ascii").splitlines()
    matches = [line.split() for line in lines if len(line.split()) == 2 and line.split()[1] == filename]
    if len(matches) != 1 or not re.fullmatch("[a-fA-F0-9]{64}", matches[0][0]):
        raise ValueError("Release must provide exactly one SHA-256 for this platform")
    archive = fetch(base + filename, MAX_ARCHIVE)
    if hashlib.sha256(archive).hexdigest() != matches[0][0].lower():
        raise ValueError("Release SHA-256 mismatch; nothing installed")
    versions.mkdir(parents=True, exist_ok=True)
    bin_dir.mkdir(parents=True, exist_ok=True)
    published = False
    try:
        with tempfile.TemporaryDirectory(prefix=".sift-install-", dir=versions) as temporary:
            staged = Path(temporary) / "release"
            staged.mkdir()
            unpack(archive, staged)
            # Atomically claim a new version; never replace somebody else's files.
            destination.mkdir()
            published = True
            staged.replace(destination)
        if old_link is None:
            # symlink() atomically refuses any existing path, including dangling links.
            link.symlink_to(destination / "sift")
        else:
            with tempfile.TemporaryDirectory(prefix=".sift-link-", dir=bin_dir) as temporary:
                temporary_link = Path(temporary) / "sift"
                temporary_link.symlink_to(destination / "sift")
                # Recheck the exact link before explicit replacement. Other programs
                # running as this account remain outside the security boundary.
                if not link.is_symlink() or os.readlink(link) != old_link:
                    raise ValueError("Installation target changed; refusing replacement")
                os.replace(temporary_link, link)
    except BaseException:
        if published:
            shutil.rmtree(destination)
        raise
    print(f"Installed Sift {version}: {link}")
    print(f"Dependency notices and documentation: {destination}")
    print(f"Start explicitly: {link} serve")
    print("No service, login item, app/Dock shortcut, agent skill, or Pi changes were made.")
    if str(bin_dir) not in os.environ.get("PATH", "").split(os.pathsep):
        print(f"Add {bin_dir} to PATH yourself if desired; no shell profiles were edited.")
    return destination


def main():
    parser = argparse.ArgumentParser(description="Install a checksum-verified stable release from akstspace/sift without starting it")
    parser.add_argument("--version", help="Exact stable version; default: latest published stable release")
    parser.add_argument("--bin-dir", default="~/.local/bin")
    parser.add_argument("--data-dir", default="~/.local/share/sift")
    parser.add_argument("--replace", action="store_true", help="Replace only a previously managed CLI symlink; retain old version files")
    args = parser.parse_args()
    try:
        install(args.version, args.bin_dir, args.data_dir, args.replace)
    except (ValueError, OSError, tarfile.TarError) as error:
        parser.exit(1, f"Sift installation failed: {error}\n")


if __name__ == "__main__":
    main()
PY
