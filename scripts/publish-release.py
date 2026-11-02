#!/usr/bin/env python3
"""Release-only GitHub writer. Never called by builds, tests, or installation."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / ".cache/release-assets"
REPOSITORY = "akstspace/sift"
VERSION_FILES = ["VERSION", "web/package.json", "web/package-lock.json", "internal/sift/model.go"]


def command(*args, **kwargs):
    return subprocess.check_output(list(args), cwd=ROOT, text=True, **kwargs).strip()


def prepare():
    version = command("python3", "scripts/version.py")
    expected = {f"sift_{target}.tar.gz" for target in ["darwin_arm64", "linux_arm64", "linux_amd64"]}
    if {p.name for p in ASSETS.glob("*.tar.gz")} != expected:
        raise ValueError("Exactly three CI-verified native packages are required")
    checks = []
    documentation = json.loads((ROOT / "scripts/package-docs.json").read_text())
    for name in sorted(expected):
        path = ASSETS / name
        with tarfile.open(path, "r:gz") as archive:
            for source in documentation:
                try:
                    entry = archive.getmember(source)
                except KeyError as error:
                    raise ValueError(f"Release artifact {name} is missing required documentation: {source}") from error
                if not entry.isfile() or archive.extractfile(entry).read() != (ROOT / source).read_bytes():
                    raise ValueError(f"Release artifacts do not match this source checkout: {name}: {source}")
        checks.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {name}")
    (ASSETS / "checksums.txt").write_text("\n".join(checks) + "\n")
    notes = f"""Sift {version}

Native packages: macOS Apple silicon, Linux arm64, and Linux amd64.
All packages passed CI race/integration, security, and native package smoke gates.
Verify checksums.txt before unpacking; keep THIRD_PARTY_NOTICES.md and licenses/.
Installation adds the bin directory to shell PATH unless --no-modify-path is used.
The installer starts Sift and configures login startup unless --no-startup is used.
It does not install, update, or change your Pi configuration.
See README.md and docs/BUILDING.md for build and installation instructions.
"""
    (ASSETS / "release-notes.md").write_text(notes)
    return version


def publish():
    if (os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or os.environ.get("GITHUB_REF") != "refs/heads/main"):
        raise ValueError("Publication is restricted to an explicitly dispatched official main-branch release")
    if not os.environ.get("GH_TOKEN"):
        raise ValueError("Missing short-lived release token")
    if not (ROOT / "LICENSE").is_file():
        raise ValueError("Owner must select and add the original-code LICENSE before publication")
    version = prepare()
    tag = "v" + version
    source = os.environ["GITHUB_SHA"]
    if command("git", "rev-parse", "HEAD") != source:
        raise ValueError("Checkout moved since verification")
    latest = command("gh", "api", f"repos/{REPOSITORY}/git/ref/heads/main", "--jq", ".object.sha")
    if latest != source:
        raise ValueError("main changed during verification; dispatch a new release")
    changed = set(command("git", "diff", "--name-only").splitlines())
    if changed != set(VERSION_FILES):
        raise ValueError("Unexpected release changes; only version declarations may change")
    refs = command("git", "ls-remote", "--tags", "origin", "refs/tags/" + tag)
    if refs:
        raise ValueError("Release tag already exists; never overwrite a release")
    command("git", "-c", "user.name=Sift release", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
            "commit", "-m", "release: " + tag, "--", *VERSION_FILES)
    command("git", "tag", tag)
    # Process-scoped HTTPS credentials: not persisted, printed, or put in argv.
    auth = base64.b64encode(("x-access-token:" + os.environ["GH_TOKEN"]).encode()).decode()
    env = dict(os.environ, GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="http.https://github.com/.extraheader",
               GIT_CONFIG_VALUE_0="AUTHORIZATION: basic " + auth)
    command("git", "push", "--atomic", "origin", "HEAD:refs/heads/main", "refs/tags/" + tag, env=env)
    assets = [str(p) for p in sorted(ASSETS.glob("*.tar.gz"))] + [str(ASSETS / "checksums.txt")]
    command("gh", "release", "create", tag, *assets, "--repo", REPOSITORY, "--draft", "--verify-tag", "--title", "Sift " + version,
            "--notes-file", str(ASSETS / "release-notes.md"))
    # The REST by-tag endpoint can return 404 for an unpublished draft.
    # gh release view resolves drafts through the authenticated release list.
    release = json.loads(command("gh", "release", "view", tag, "--repo", REPOSITORY,
                                 "--json", "tagName,isDraft,isPrerelease,assets"))
    if release["tagName"] != tag or not release["isDraft"] or release["isPrerelease"]:
        raise ValueError("Unexpected release identity or state; publication stopped")
    uploaded = {a["name"]: a for a in release["assets"]}
    for path in map(Path, assets):
        asset = uploaded.get(path.name)
        if not asset or asset["size"] != path.stat().st_size or asset.get("digest") != "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest():
            raise ValueError("Uploaded asset verification failed; release remains draft for manual review")
    if len(uploaded) != len(assets):
        raise ValueError("Unexpected draft assets; publication stopped")
    command("gh", "release", "edit", tag, "--repo", REPOSITORY, "--draft=false", "--latest")
    print(f"Published https://github.com/{REPOSITORY}/releases/tag/{tag}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "publish"])
    args = parser.parse_args()
    try:
        {"prepare": prepare, "publish": publish}[args.action]()
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError) as error:
        parser.exit(1, f"Release stopped safely: {error}\n")
