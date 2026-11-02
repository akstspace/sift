#!/bin/sh
# Inspect before running. Requires Python 3 only for installation, not for Sift.
set -eu
command -v python3 >/dev/null 2>&1 || {
  echo 'Sift installation requires Python 3. Alternatively unpack a release archive manually.' >&2
  exit 1
}
python3 - "$@" <<'PY'
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import shutil
import stat
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


def path_configuration(bin_dir):
    directory = str(bin_dir)
    if any(character in directory for character in ("\n", "\r", "\x00", os.pathsep)):
        raise ValueError("The bin directory cannot contain line breaks or PATH separators")
    home = Path.home()
    shell = Path(os.environ.get("SHELL") or "/bin/sh").name
    quoted = shlex.quote(directory)
    if shell == "fish":
        config = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config").expanduser()
        profiles = [config / "fish/conf.d/sift-path.fish"]
        # Fish single quotes escape only backslashes and single quotes.
        quoted = "'" + directory.replace("\\", "\\\\").replace("'", "\\'") + "'"
        command = f"if not contains -- {quoted} $PATH\n    set -gx PATH $PATH {quoted}\nend"
    else:
        if shell == "zsh":
            config = Path(os.environ.get("ZDOTDIR") or home).expanduser()
            profiles = [config / ".zshrc"]
        elif shell == "bash":
            # Bash reads a different file for login and non-login terminals.
            login = next((home / name for name in [".bash_profile", ".bash_login", ".profile"]
                          if os.path.lexists(home / name)), home / ".profile")
            profiles = [home / ".bashrc", login]
        elif shell in {"sh", "dash", "ksh"}:
            profiles = [home / ".profile"]
        else:
            raise ValueError(f"Automatic PATH setup is not supported for shell {shell}; add {quoted} manually")
        # Append rather than shadow existing commands; guard every new shell.
        command = f'case ":${{PATH-}}:" in\n    *:{quoted}:*) ;;\n    *) export PATH="${{PATH:+${{PATH}}:}}"{quoted} ;;\nesac'
    if any(not profile.is_absolute() for profile in profiles):
        raise ValueError("Shell configuration directories must be absolute")
    marker = "Sift PATH " + hashlib.sha256(directory.encode()).hexdigest()[:16]
    block = f"# >>> {marker} >>>\n{command}\n# <<< {marker} <<<\n"
    return profiles, block, command


def append_path_configuration(profile, block):
    profile.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Never follow a profile symlink or block on a special file. Existing content
    # and permissions are preserved; only this directory's guarded block is added.
    flags = os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
    descriptor = os.open(profile, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o022 or metadata.st_size > 1 << 20):
            raise ValueError(f"Refusing to edit unsafe or oversized shell configuration: {profile}")
        output = os.fdopen(descriptor, "a+b")
    except BaseException:
        os.close(descriptor)
        raise
    with output:
        fcntl.flock(output.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        output.seek(0)
        original = output.read((1 << 20) + 1)
        if len(original) > 1 << 20:
            raise ValueError(f"Refusing to edit oversized shell configuration: {profile}")
        encoded = block.encode()
        if encoded in original:
            return False
        if block.splitlines()[0].encode() in original:
            raise ValueError(f"Sift PATH block was edited; review it manually: {profile}")
        separator = b"\n" if original.endswith(b"\n") or not original else b"\n\n"
        output.write(separator + encoded)
        output.flush()
        os.fsync(output.fileno())
    return True


def configure_path(bin_dir):
    profiles, block, command = path_configuration(bin_dir)
    failures = []
    for profile in profiles:
        try:
            changed = append_path_configuration(profile, block)
            print(f"PATH {'updated in' if changed else 'already configured in'}: {profile}")
        except (ValueError, OSError) as error:
            failures.append(str(error))
    for error in failures:
        print(f"Warning: Sift is installed, but PATH setup was skipped: {error}", file=sys.stderr)
    print("Open a new terminal, or apply this to the current shell:")
    print(command)


def install(version, bin_dir, data_dir, replace=False, modify_path=True):
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
    if modify_path:
        try:
            configure_path(bin_dir)
        except (ValueError, OSError) as error:
            print(f"Warning: Sift is installed, but automatic PATH setup was skipped: {error}", file=sys.stderr)
    else:
        print("PATH setup skipped (--no-modify-path); no shell profiles were edited.")
    return destination


def main():
    parser = argparse.ArgumentParser(description="Install a checksum-verified stable release from akstspace/sift without starting it")
    parser.add_argument("--version", help="Exact stable version; default: latest published stable release")
    parser.add_argument("--bin-dir", default="~/.local/bin")
    parser.add_argument("--data-dir", default="~/.local/share/sift")
    parser.add_argument("--replace", action="store_true", help="Replace only a previously managed CLI symlink; retain old version files")
    parser.add_argument("--no-modify-path", action="store_true", help="Do not add the bin directory to shell configuration")
    args = parser.parse_args()
    try:
        install(args.version, args.bin_dir, args.data_dir, args.replace, not args.no_modify_path)
    except (ValueError, OSError, tarfile.TarError) as error:
        parser.exit(1, f"Sift installation failed: {error}\n")


if __name__ == "__main__":
    main()
PY
