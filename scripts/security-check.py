#!/usr/bin/env python3
"""Fail-closed local/CI security gates; retain raw reports and reviewed evidence."""
import argparse
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".cache/security"
TOOLS = ROOT / ".cache/security-tools"


def run(argv, **kwargs):
    return subprocess.run(argv, cwd=ROOT, check=False, **kwargs)


def preserve_previous_report(raw):
    # A failed scanner must never pass by reusing a previous successful report.
    # Retain that previous report separately for diagnosis instead of deleting it.
    if raw.exists():
        raw.replace(raw.with_suffix(".previous.json"))


def opengrep():
    lock = json.loads((ROOT / "scripts/security-tools.lock.json").read_text())
    raw = OUT / "opengrep.json"
    shell = (ROOT / "scripts/install.sh").read_text()
    embedded = OUT / "installer.py"
    embedded.write_text(shell.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0])
    compile(embedded.read_text(), "scripts/install.sh:python", "exec")
    # Explicit files bypass upstream default test ignores. Enumerate from the
    # repository, not scanner output, so a missed source file fails closed.
    targets = {str(p.relative_to(ROOT)) for folder in ["cmd", "internal", "web", "scripts", ".github"]
               for p in (ROOT / folder).rglob("*")
               if p.is_file() and p.suffix in {".go", ".ts", ".tsx", ".js", ".py", ".sh", ".yml", ".yaml", ".json", ".html"}
               and not {"node_modules", "__pycache__", "payload"}.intersection(p.relative_to(ROOT).parts)
               and not p.is_relative_to(ROOT / "internal/sift/public")
               and not p.is_relative_to(ROOT / "web/dist")}
    targets.add(str(embedded.relative_to(ROOT)))
    command = [str(TOOLS / "opengrep"), "scan", "--config", str(TOOLS / ("rules-" + lock["rules"]["revision"])),
               "--disable-version-check", "--disable-nosem", "--strict", "--error", "--jobs", "4", "--timeout", "60",
               "--max-target-bytes", "0", "--no-git-ignore", "--experimental", "--project-root", str(ROOT),
               "--x-ignore-semgrepignore-files", "--json", "--output", str(raw), *sorted(targets)]
    preserve_previous_report(raw)
    result = run(command)
    if result.returncode not in (0, 1) or not raw.exists():
        raise ValueError("OpenGrep did not complete successfully")
    report = json.loads(raw.read_text())
    if report.get("errors"):
        raise ValueError("OpenGrep reported parse/config/timeout errors: " + json.dumps(report["errors"]))
    scanned = set(report["paths"]["scanned"])
    required = targets
    if required - scanned:
        raise ValueError("OpenGrep skipped source files: " + ", ".join(sorted(required - scanned)))
    reviews = json.loads((ROOT / "scripts/security-reviews.json").read_text())
    # Ignored QA helpers may exist locally but are absent from a clean checkout.
    # Keep their exact-source dispositions local, without weakening stale-review
    # checks for either inventory or allowing local entries to replace CI reviews.
    local_reviews = ROOT / "scripts/security-reviews.local.json"
    if local_reviews.exists():
        local = json.loads(local_reviews.read_text())
        if reviews.keys() & local.keys():
            raise ValueError("Local security reviews must not override shipped reviews")
        reviews.update(local)
    used, unresolved, reviewed, nonsecurity = set(), [], [], []
    for finding in report["results"]:
        metadata = finding["extra"].get("metadata", {})
        # The upstream corpus also contains style, translation, and portability
        # checks. Keep them in the raw evidence, not a vulnerability gate.
        if metadata.get("category") != "security" and not metadata.get("cwe"):
            nonsecurity.append(finding)
            continue
        rule = finding["check_id"].split(".rules-" + lock["rules"]["revision"] + ".")[-1]
        source = (ROOT / finding["path"]).read_text().splitlines(keepends=True)
        code = "".join(source[finding["start"]["line"] - 1:finding["end"]["line"]])
        fingerprint = hashlib.sha256(code.encode()).hexdigest()
        key = f"{finding['path']}:{rule}:{fingerprint}"
        review = reviews.get(key)
        record = {"key": key, "line": finding["start"]["line"], "message": finding["extra"]["message"]}
        if (not review or not review.get("reason") or review.get("disposition") != "not-a-vulnerability"
                or date.fromisoformat(review["reviewBefore"]) < date.today()):
            unresolved.append(record)
        else:
            used.add(key)
            reviewed.append({**record, **review})
    stale = sorted(set(reviews) - used)
    summary = {"scanner": lock["opengrep"]["version"], "rulesRevision": lock["rules"]["revision"],
               "scannedFiles": len(scanned), "unresolved": unresolved, "reviewed": reviewed,
               "nonSecurityFindings": len(nonsecurity), "staleReviews": stale}
    (OUT / "opengrep-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"OpenGrep: {len(scanned)} files; {len(unresolved)} unresolved security findings; {len(reviewed)} exact reviewed matches; {len(nonsecurity)} non-security suggestions")
    if unresolved or stale:
        raise ValueError("OpenGrep has unresolved findings or stale reviews; inspect .cache/security/opengrep-summary.json")


def trivy():
    # Trivy's module-level OpenPGP advisory has no fixed x/crypto version.
    # It is not ignored: prove the vulnerable package absent for EVERY target,
    # then express that exact package/advisory decision as OpenVEX.
    for system, arch in [("darwin", "arm64"), ("linux", "arm64"), ("linux", "amd64")]:
        result = subprocess.check_output(["go", "list", "-deps", "./..."], cwd=ROOT, text=True,
                                         env=dict(os.environ, GOOS=system, GOARCH=arch, CGO_ENABLED="0"))
        if any(p.startswith("golang.org/x/crypto/openpgp") for p in result.splitlines()):
            raise ValueError("OpenPGP is now compiled; its not-affected decision is invalid")
    module = subprocess.check_output(["go", "list", "-m", "-f", "{{.Version}}", "golang.org/x/crypto"], cwd=ROOT, text=True).strip()
    vex = {"@context": "https://openvex.dev/ns/v0.2.0", "@id": "https://github.com/akstspace/sift/security/openpgp-not-compiled",
           "author": "Sift build-time dependency verification", "timestamp": "2026-11-02T00:00:00Z", "version": 1,
           "statements": [{"vulnerability": {"name": "GO-2026-5932"},
                           "products": [{"@id": f"pkg:golang/golang.org/x/crypto@{module}"}],
                           "status": "not_affected", "justification": "vulnerable_code_not_present",
                           "impact_statement": "go list -deps ./... verifies no golang.org/x/crypto/openpgp package for all three release targets before each scan."}]}
    vex_path = OUT / "openpgp.vex.json"
    vex_path.write_text(json.dumps(vex, indent=2) + "\n")
    raw = OUT / "trivy.json"
    command = [str(TOOLS / "trivy"), "fs", "--config", "", "--scanners", "vuln", "--include-dev-deps", "--ignorefile", "",
               "--severity", "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL", "--exit-code", "1", "--disable-telemetry", "--skip-version-check",
               "--no-progress", "--cache-dir", ".cache/trivy", "--skip-dirs", ".cache", "--skip-dirs", "dist",
               "--skip-dirs", "web/node_modules", "--skip-dirs", "internal/sift/public", "--vex", str(vex_path),
               "--show-suppressed", "--format", "json", "--output", str(raw), "."]
    preserve_previous_report(raw)
    result = run(command)
    if not raw.exists():
        raise ValueError("Trivy did not produce a report")
    report = json.loads(raw.read_text())
    targets = {r["Target"] for r in report.get("Results", [])}
    if not {"go.mod", "web/package-lock.json"}.issubset(targets):
        raise ValueError("Trivy did not analyze both Go and npm dependencies")
    findings = [v for r in report["Results"] for v in r.get("Vulnerabilities", [])]
    if result.returncode or findings:
        raise ValueError("Trivy failed or found unresolved dependency vulnerabilities")
    print("Trivy: no unresolved vulnerabilities at any severity; development dependencies included; OpenPGP absence verified on all release targets")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("scanner", choices=["opengrep", "trivy", "all"], default="all", nargs="?")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    scanners = {"opengrep": opengrep, "trivy": trivy}
    for name in ["opengrep", "trivy"] if args.scanner == "all" else [args.scanner]:
        try:
            scanners[name]()
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            print(f"Security gate failed: {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
