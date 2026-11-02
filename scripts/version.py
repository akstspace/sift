#!/usr/bin/env python3
"""Validate or bump every version declaration; never commit, tag, or publish."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PATTERN = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"


def current():
    value = (ROOT / "VERSION").read_text().strip()
    if not re.fullmatch(PATTERN, value):
        raise ValueError("VERSION must contain a stable semantic version")
    package = json.loads((ROOT / "web/package.json").read_text())
    lock = json.loads((ROOT / "web/package-lock.json").read_text())
    model = (ROOT / "internal/sift/model.go").read_text()
    if (package["version"] != value or lock["version"] != value or lock["packages"][""]["version"] != value
            or f'var Version = "{value}-dev"' not in model):
        raise ValueError("VERSION, npm manifests, and Go development version disagree")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bump", choices=["patch", "minor", "major"])
    args = parser.parse_args()
    value = current()
    if args.bump:
        major, minor, patch = map(int, value.split("."))
        target = {"patch": (major, minor, patch + 1), "minor": (major, minor + 1, 0), "major": (major + 1, 0, 0)}[args.bump]
        next_value = ".".join(map(str, target))
        model = ROOT / "internal/sift/model.go"
        model.write_text(model.read_text().replace(f'var Version = "{value}-dev"', f'var Version = "{next_value}-dev"', 1))
        for name in ["package.json", "package-lock.json"]:
            path = ROOT / "web" / name
            data = json.loads(path.read_text())
            data["version"] = next_value
            if name == "package-lock.json":
                data["packages"][""]["version"] = next_value
            path.write_text(json.dumps(data, indent=2) + "\n")
        (ROOT / "VERSION").write_text(next_value + "\n")
        value = current()
    print(value)


if __name__ == "__main__":
    main()
