#!/usr/bin/env python3
"""Summarize an unmodified Go coverage profile, including source provenance.

Run after the complete passing race/integration suite. No blocks or files are
excluded, and no runtime profile is silently merged into the test evidence.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--profile", default=".cache/go-coverage.out")
parser.add_argument("--output", default="docs/verification/backend-coverage.json")
parser.add_argument("--require", type=float, choices=[95.0, 100.0], help="Minimum application statement coverage percentage; reports are retained")
args = parser.parse_args()
profile = ROOT / args.profile
module = next(line.split()[1] for line in (ROOT / "go.mod").read_text().splitlines() if line.startswith("module "))
files = {}
lines = profile.read_text().splitlines()
if not lines or not lines[0].startswith("mode: "):
    raise SystemExit("Not a Go coverage profile")
for line in lines[1:]:
    position, statements, count = line.split()
    source, span = position.rsplit(":", 1)
    if not source.startswith(module + "/"):
        raise SystemExit(f"Unexpected profile source: {source}")
    relative = source[len(module) + 1:]
    record = files.setdefault(relative, {"covered": 0, "total": 0, "uncovered": []})
    record["total"] += int(statements)
    if int(count):
        record["covered"] += int(statements)
    elif int(statements):
        record["uncovered"].append({"span": span, "statements": int(statements)})


def finish(record):
    record["percent"] = 100 * record["covered"] / record["total"] if record["total"] else 100


packages = {}
for relative, record in sorted(files.items()):
    record["sha256"] = hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()
    finish(record)
    package = packages.setdefault(str(Path(relative).parent), {"covered": 0, "total": 0})
    package["covered"] += record["covered"]
    package["total"] += record["total"]
for package in packages.values():
    finish(package)
total = {key: sum(p[key] for p in packages.values()) for key in ["covered", "total"]}
if not files or total["total"] == 0:
    raise SystemExit("Empty application coverage profile cannot satisfy the coverage gate")
finish(total)
report = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "command": "SIFT_INTEGRATION=1 go test -race -count=1 -coverprofile=.cache/go-coverage.out ./...",
    "metric": "Go statements (not branch/function coverage)",
    "scope": "All application packages selected by this platform's build tags; standard Go test-file exclusion only",
    "mode": lines[0][6:],
    "profileSha256": hashlib.sha256(profile.read_bytes()).hexdigest(),
    "goVersion": subprocess.check_output(["go", "version"], cwd=ROOT, text=True).strip(),
    "platform": subprocess.check_output(["go", "env", "GOOS", "GOARCH"], cwd=ROOT, text=True).split(),
    "total": total,
    "gate": {"requiredPercent": args.require, "passed": total["covered"] * 100 >= args.require * total["total"]} if args.require is not None else None,
    "packages": packages,
    "files": dict(sorted(files.items())),
}
output = ROOT / args.output
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2) + "\n")
output.with_suffix(".out").write_bytes(profile.read_bytes())
subprocess.run(["go", "tool", "cover", "-html=" + str(profile), "-o", str(output.with_suffix(".html"))], cwd=ROOT, check=True)
for name, record in packages.items():
    print(f"{name}: {record['covered']}/{record['total']} statements ({record['percent']:.2f}%)")
print(f"Reports: {output} and {output.with_suffix('.html')}")
if args.require is not None and not report["gate"]["passed"]:
    raise SystemExit(f"Backend {args.require:g}% coverage gate failed: {total['percent']:.2f}% covered; {total['total'] - total['covered']} application statements remain uncovered")
