#!/usr/bin/env python3
"""Preserve installed dependency notices for local distribution. Never publishes."""
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "licenses"
DEST.mkdir(exist_ok=True)
NOTICES = ROOT / "THIRD_PARTY_NOTICES.md"
GENERATED_MARKER = "<!-- sift-generated-notices:start -->"
RETAINED_START = "<!-- sift-retained-notice:react-remove-scroll-bar-2.3.8:start -->\n```text\n"
RETAINED_END = "```\n<!-- sift-retained-notice:react-remove-scroll-bar-2.3.8:end -->"


def retained_scroll_bar_notice():
    # Keep the reviewed upstream exception in the consolidated source notice,
    # not in an otherwise generated/ignored directory needed by clean builds.
    source = NOTICES.read_text()
    if source.count(RETAINED_START) != 1 or source.count(RETAINED_END) != 1:
        raise ValueError("Missing or ambiguous reviewed react-remove-scroll-bar notice")
    return source.split(RETAINED_START, 1)[1].split(RETAINED_END, 1)[0]


def consolidate(index):
    source = NOTICES.read_text()
    if source.count(GENERATED_MARKER) != 1:
        raise ValueError("Missing or ambiguous consolidated-notice boundary")
    groups = {}
    entries = [(name, name) for name in index["assets"]]
    entries += [("RustFS 1.0.4", "RustFS-1.0.4-APACHE-2.0.txt"), ("shadcn/ui", "shadcn-ui-MIT.txt")]
    for kind in ["npm", "go"]:
        for package in index[kind]:
            entries += [(f"{kind}: {package['name']} {package['version']}", name) for name in package["files"]]
    for label, name in entries:
        if name == "npm/react-remove-scroll-bar/MIT-DECLARATION.txt":
            continue  # Already retained verbatim above the generated boundary.
        text = (DEST / name).read_text()
        key = hashlib.sha256(text.encode()).hexdigest()
        group = groups.setdefault(key, {"text": text, "labels": []})
        group["labels"].append(f"{label} — {name}")
    sections = [source.split(GENERATED_MARKER, 1)[0].rstrip(), GENERATED_MARKER,
                "## Dependency license texts\n\nIdentical full texts are grouped; each applicable package and version is listed."]
    for number, group in enumerate(groups.values(), 1):
        fence = "`" * max(3, max((len(m.group()) + 1 for m in re.finditer(r"`+", group["text"])), default=3))
        sections += [f"### Notice {number}\n\n" + "\n".join("- " + label for label in group["labels"]),
                     fence + "text\n" + group["text"] + ("" if group["text"].endswith("\n") else "\n") + fence]
    NOTICES.write_text("\n\n".join(sections) + "\n")

def records(text):
    decoder = json.JSONDecoder()
    while text.strip():
        value, end = decoder.raw_decode(text.lstrip())
        yield value
        text = text.lstrip()[end:]

def collect_go_modules():
    # Every package carries the same full notice set, independent of the host.
    # Match release.py's supported targets and its pure-Go build configuration.
    modules = {}
    for goos, arch in [("darwin", "arm64"), ("linux", "arm64"), ("linux", "amd64")]:
        deps = subprocess.check_output(["go", "list", "-deps", "-json", "./cmd/sift"], cwd=ROOT, text=True,
                                       env=dict(os.environ, GOOS=goos, GOARCH=arch, CGO_ENABLED="0"))
        for pkg in records(deps):
            mod = pkg.get("Module")
            if mod and not mod.get("Main"):
                previous = modules.get(mod["Path"])
                if previous and (previous["Version"], previous["Dir"]) != (mod["Version"], mod["Dir"]):
                    raise ValueError("Inconsistent Go module across release targets: " + mod["Path"])
                modules[mod["Path"]] = mod
    return modules

def preserve(source, folder):
    copied = []
    for file in sorted(source.iterdir()):
        if file.is_file() and re.match(r"^(licen[cs]e|copying|copyright|notice|unlicense|ofl)([.\-_]|$)", file.name, re.I):
            target = folder / file.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(file.read_bytes())
            copied.append(str(target.relative_to(DEST)))
    return copied

index = {"npm": [], "go": [], "assets": []}
# Include all installed production packages, including transitive dependencies.
tree = json.loads(subprocess.check_output(["npm", "ls", "--omit=dev", "--all", "--json"], cwd=ROOT / "web"))
names = set()
def walk(node):
    for name, child in node.get("dependencies", {}).items():
        # npm includes empty records for optional peers that are not installed.
        if child.get("version"): names.add(name)
        walk(child)
walk(tree)
for name in sorted(names):
    source = ROOT / "web/node_modules" / name
    if not (source / "package.json").exists():
        raise SystemExit(f"Cannot locate installed package {name}")
    pkg = json.loads((source / "package.json").read_text())
    files = preserve(source, DEST / "npm" / name.replace("/", "__"))
    if name == "react-remove-scroll-bar" and pkg["version"] == "2.3.8" and not files:
        # This published package and its repository omit a LICENSE file.
        # Preserve its actual MIT declaration/author metadata, alongside the
        # standard permission text, without inventing an upstream copyright year.
        notice = DEST / "npm/react-remove-scroll-bar/MIT-DECLARATION.txt"
        notice.parent.mkdir(parents=True, exist_ok=True)
        notice.write_text(retained_scroll_bar_notice())
        files = [str(notice.relative_to(DEST))]
    index["npm"].append({"name": name, "version": pkg.get("version"), "license": pkg.get("license"), "repository": pkg.get("repository"), "files": files})

for name, mod in sorted(collect_go_modules().items()):
    source = Path(mod["Dir"])
    files = preserve(source, DEST / "go" / name.replace("/", "__"))
    index["go"].append({"name": name, "version": mod["Version"], "files": files})

for source in sorted((ROOT / "web/public/fonts").glob("*.txt")):
    (DEST / source.name).write_bytes(source.read_bytes())
    index["assets"].append(source.name)
url = "https://raw.githubusercontent.com/rustfs/rustfs/1.0.4/LICENSE"
with urllib.request.urlopen(url, timeout=60) as response:
    (DEST / "RustFS-1.0.4-APACHE-2.0.txt").write_bytes(response.read())
# Component source was copied/adapted from the official MIT-licensed registry.
with urllib.request.urlopen("https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md", timeout=60) as response:
    (DEST / "shadcn-ui-MIT.txt").write_bytes(response.read())
(DEST / "DEPENDENCIES.json").write_text(json.dumps(index, indent=2)+"\n")
missing = [p["name"] for group in ["npm", "go"] for p in index[group] if not p["files"]]
print(f"Preserved notices for {len(index['npm'])} npm packages and {len(index['go'])} Go modules.")
if missing:
    raise SystemExit("Manual notice review required for packages with no top-level license file: " + ", ".join(missing))
consolidate(index)
