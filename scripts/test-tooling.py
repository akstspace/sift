#!/usr/bin/env python3
"""Hermetic installer/version tests: no network, real install, service, or prompts."""
import hashlib
import ast
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tarfile
import tempfile
import unittest
from datetime import date, timedelta
from unittest.mock import Mock, patch
import local_api

ROOT = Path(__file__).resolve().parents[1]
SHELL = (ROOT / "scripts/install.sh").read_text()
INSTALLER = SHELL.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
NS = {"__name__": "sift_installer_test"}
exec(compile(INSTALLER, "scripts/install.sh:python", "exec"), NS)


def archive(extra=(), omit=()):
    files = [("sift", b"fixture-not-executable"), ("LICENSE", b"MIT fixture"), ("THIRD_PARTY_NOTICES.md", b"Notices"),
             ("licenses/DEPENDENCIES.json", b"{}"), ("licenses/example.txt", b"License")]
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name, value in files + list(extra):
            if name in omit:
                continue
            info = tarfile.TarInfo(name)
            if isinstance(value, bytes) and value not in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.DIRTYPE]:
                info.size = len(value)
                tar.addfile(info, io.BytesIO(value))
            else:
                info.type, info.linkname = value, "../../outside"
                tar.addfile(info)
    return out.getvalue()


class LocalConnectionTests(unittest.TestCase):
    def test_rejects_nonlocal_and_ambiguous_connections_before_network(self):
        for url in ["https://127.0.0.1:1234", "http://localhost:1234", "http://evil.test:1234",
                    "http://127.0.0.1", "http://user@127.0.0.1:1234", "http://127.0.0.1:1234/",
                    "http://127.0.0.1:1234?x", "http://127.0.0.1:1234#x", "file:///etc/passwd"]:
            with self.subTest(url=url), patch.object(local_api.urllib.request, "build_opener") as opener, self.assertRaises(ValueError):
                local_api.open_local({"url": url, "token": "fixture"}, "/api/health")
            opener.assert_not_called()
        for token in [None, "", 4]:
            with self.subTest(token=token), self.assertRaises(ValueError):
                local_api.validate_connection({"url": "http://127.0.0.1:1234", "token": token})

    def test_authenticated_request_and_no_redirect_policy(self):
        connection = {"url": "http://127.0.0.1:1234", "token": "fixture"}
        with patch.object(local_api.urllib.request, "build_opener") as factory:
            local_api.open_local(connection, "/api/task", method="POST", data=b"{}", headers={"Content-Type": "application/json"})
            request = factory.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, connection["url"] + "/api/task")
            self.assertEqual(request.get_header("Authorization"), "Bearer fixture")
            self.assertEqual(request.get_header("X-sift-request"), "1")
            self.assertEqual(request.data, b"{}")
            handler = factory.call_args.args[0]
            with self.assertRaisesRegex(ValueError, "redirects"):
                handler.redirect_request(request, None, 302, "Found", {}, "http://evil.test/")
            local_api.open_local(connection, "/api/health", auth=False)
            self.assertIsNone(factory.return_value.open.call_args.args[0].get_header("Authorization"))
        for path in ["https://evil.test", "//evil.test", "api/health"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                local_api.open_local(connection, path)

    def test_package_doc_manifest_matches_public_checkout(self):
        docs = json.loads((ROOT / "scripts/package-docs.json").read_text())
        self.assertEqual(len(docs), len(set(docs)))
        self.assertIn("LICENSE", docs)
        self.assertIn("docs/ACCEPTANCE.md", docs)
        for name in docs:
            self.assertTrue((ROOT / name).is_file(), name)
            self.assertNotIn(name, ["docs/DIRECTION.md", "docs/UI-REVISION.md"])
        for script in ["release.py", "release-check.py"]:
            self.assertIn("scripts/package-docs.json", (ROOT / "scripts" / script).read_text())


class LocalReleaseNoticeTests(unittest.TestCase):
    def go_module_functions(self, root):
        source = ast.parse((ROOT / "scripts/collect-licenses.py").read_text())
        selected = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in {"records", "collect_go_modules"}]
        namespace = {"json": json, "os": os, "subprocess": subprocess, "ROOT": root}
        exec(compile(ast.Module(body=selected, type_ignores=[]), "collect-licenses.py:functions", "exec"), namespace)
        return namespace

    def test_go_notices_use_union_of_all_release_targets_not_host_defaults(self):
        root = Path("/fixture/sift")
        ns = self.go_module_functions(root)
        common = {"Path": "example/common", "Version": "v1.2.3", "Dir": "/fixture/modules/common"}
        platform_modules = {
            ("darwin", "arm64"): {"Path": "example/mac-only", "Version": "v2.0.0", "Dir": "/fixture/modules/mac"},
            ("linux", "arm64"): {"Path": "example/arm-only", "Version": "v3.0.0", "Dir": "/fixture/modules/arm"},
            ("linux", "amd64"): {"Path": "example/amd-only", "Version": "v4.0.0", "Dir": "/fixture/modules/amd"},
        }
        def deps(command, **kwargs):
            self.assertEqual(command, ["go", "list", "-deps", "-json", "./cmd/sift"])
            self.assertEqual(kwargs["cwd"], root)
            self.assertTrue(kwargs["text"])
            env = kwargs["env"]
            self.assertEqual(env["CGO_ENABLED"], "0")
            target = env["GOOS"], env["GOARCH"]
            return "\n".join(json.dumps(pkg) for pkg in [{"Standard": True}, {"Module": {"Main": True}},
                            {"Module": common}, {"Module": common}, {"Module": platform_modules[target]}])
        results = []
        for host in [{"GOOS": "windows", "GOARCH": "386", "CGO_ENABLED": "1"}, {"GOOS": "linux", "GOARCH": "amd64"}]:
            with patch.dict(os.environ, host, clear=True), patch.object(subprocess, "check_output", side_effect=deps) as command:
                results.append(ns["collect_go_modules"]())
                self.assertEqual(command.call_count, 3)
        self.assertEqual(results[0], results[1])
        self.assertEqual(set(results[0]), {common["Path"], *(mod["Path"] for mod in platform_modules.values())})

    def test_go_notice_target_failures_and_conflicting_modules_are_not_ignored(self):
        ns = self.go_module_functions(Path("/fixture/sift"))
        with patch.object(subprocess, "check_output", side_effect=subprocess.CalledProcessError(1, ["go", "list"])):
            with self.assertRaises(subprocess.CalledProcessError):
                ns["collect_go_modules"]()
        first = {"Module": {"Path": "example/common", "Version": "v1.0.0", "Dir": "/fixture/first"}}
        for field, value in [("Version", "v2.0.0"), ("Dir", "/fixture/second")]:
            second = {"Module": dict(first["Module"], **{field: value})}
            with self.subTest(field=field), patch.object(subprocess, "check_output", side_effect=[json.dumps(first), json.dumps(second)]):
                with self.assertRaisesRegex(ValueError, "Inconsistent Go module"):
                    ns["collect_go_modules"]()

    def notice_functions(self, root):
        source = ast.parse((ROOT / "scripts/collect-licenses.py").read_text())
        selected = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in {"retained_scroll_bar_notice", "consolidate"}]
        namespace = {"hashlib": hashlib, "re": __import__("re"), "NOTICES": root / "THIRD_PARTY_NOTICES.md", "DEST": root / "licenses",
                     "GENERATED_MARKER": "<!-- sift-generated-notices:start -->",
                     "RETAINED_START": "<!-- sift-retained-notice:react-remove-scroll-bar-2.3.8:start -->\n```text\n",
                     "RETAINED_END": "```\n<!-- sift-retained-notice:react-remove-scroll-bar-2.3.8:end -->"}
        exec(compile(ast.Module(body=selected, type_ignores=[]), "collect-licenses.py:functions", "exec"), namespace)
        return namespace

    def test_consolidated_notices_preserve_every_exact_text_and_group_identical_licenses(self):
        with tempfile.TemporaryDirectory(prefix="sift-consolidated-notices-") as temporary:
            root = Path(temporary)
            ns = self.notice_functions(root)
            retained = "reviewed upstream declaration\n"
            prefix = "# Notices\n\n" + ns["RETAINED_START"] + retained + ns["RETAINED_END"] + "\n\n"
            ns["NOTICES"].write_text(prefix + ns["GENERATED_MARKER"] + "\nstale generated text\n")
            self.assertEqual(ns["retained_scroll_bar_notice"](), retained)
            texts = {"npm/one/LICENSE": "Exact MIT text\n", "npm/two/LICENSE": "Exact MIT text\n",
                     "font.txt": "Exact font license without trailing newline", "RustFS-1.0.4-APACHE-2.0.txt": "Apache\n",
                     "shadcn-ui-MIT.txt": "Contains ``` fence\n", "go/lib/NOTICE": "Exact copyright NOTICE\n"}
            for name, text in texts.items():
                path = ns["DEST"] / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            index = {"assets": ["font.txt"], "npm": [{"name": "one", "version": "1", "files": ["npm/one/LICENSE"]},
                     {"name": "two", "version": "2", "files": ["npm/two/LICENSE"]},
                     {"name": "react-remove-scroll-bar", "version": "2.3.8", "files": ["npm/react-remove-scroll-bar/MIT-DECLARATION.txt"]}],
                     "go": [{"name": "lib", "version": "v1", "files": ["go/lib/NOTICE"]}]}
            ns["consolidate"](index)
            result = ns["NOTICES"].read_text()
            self.assertTrue(result.startswith(prefix))
            self.assertNotIn("stale generated text", result)
            for text in texts.values():self.assertIn(text, result)
            for package in ["npm: one 1", "npm: two 2", "go: lib v1"]:self.assertIn(package, result)
            self.assertEqual(result.count("Exact MIT text"), 1)
            self.assertIn("````text\nContains ``` fence\n````", result)
            self.assertEqual(ns["retained_scroll_bar_notice"](), retained)
            ns["consolidate"](index)
            self.assertEqual(ns["NOTICES"].read_text(), result)

    def test_consolidated_notices_refuse_missing_or_ambiguous_retained_boundaries(self):
        with tempfile.TemporaryDirectory(prefix="sift-consolidated-notices-") as temporary:
            root = Path(temporary)
            ns = self.notice_functions(root)
            for text in ["# Missing", ns["RETAINED_START"] * 2 + ns["RETAINED_END"], ns["RETAINED_START"]]:
                ns["NOTICES"].write_text(text)
                with self.assertRaisesRegex(ValueError, "reviewed"):
                    ns["retained_scroll_bar_notice"]()
            for text in ["# Missing", ns["GENERATED_MARKER"] * 2]:
                ns["NOTICES"].write_text(text)
                with self.assertRaisesRegex(ValueError, "boundary"):
                    ns["consolidate"]({"npm": [], "go": [], "assets": []})

    def test_only_freshly_indexed_notices_ship_and_stale_local_files_are_untouched(self):
        with tempfile.TemporaryDirectory(prefix="sift-release-notices-") as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            script = root / "scripts/release.py"
            script.write_bytes((ROOT / "scripts/release.py").read_bytes())
            (root / "scripts/package-docs.json").write_text(json.dumps(["LICENSE"]))
            (root / "LICENSE").write_text("MIT fixture")
            notices = root / "licenses"
            (notices / "npm/current").mkdir(parents=True)
            for name in ["RustFS-1.0.4-APACHE-2.0.txt", "shadcn-ui-MIT.txt", "font.txt", "npm/current/LICENSE", "stale.txt"]:
                (notices / name).write_text("Fixture " + name)
            index = {"assets": ["font.txt"], "npm": [{"files": ["npm/current/LICENSE"]}], "go": []}
            commands = []
            def build(command, **kwargs):
                commands.append(command)
                if command[:2] == ["go", "build"]:
                    Path(command[command.index("-o") + 1]).write_bytes(b"fixture executable")
                if command == ["python3", "scripts/collect-licenses.py"]:
                    (notices / "DEPENDENCIES.json").write_text(json.dumps(index))
            def run_release():
                with patch("sys.argv", [str(script), "--version", "0.1.0", "--platform", "darwin-arm64"]), patch.object(subprocess, "check_output", return_value="0.1.0\n"), patch.object(subprocess, "run", side_effect=build), redirect_stdout(io.StringIO()):
                    runpy.run_path(str(script), run_name="__main__")
            run_release()
            self.assertEqual(commands[0], ["python3", "scripts/prepare-rustfs.py", "--platform", "all"])
            self.assertLess(commands.index(["python3", "scripts/prepare-rustfs.py", "--platform", "all"]),
                            commands.index(["python3", "scripts/collect-licenses.py"]))
            archive = root / "dist/0.1.0/sift_darwin_arm64.tar.gz"
            first = archive.read_bytes()
            with tarfile.open(archive) as tar:
                self.assertEqual(set(tar.getnames()), {"sift", "LICENSE", "licenses/DEPENDENCIES.json", "licenses/RustFS-1.0.4-APACHE-2.0.txt", "licenses/shadcn-ui-MIT.txt", "licenses/font.txt", "licenses/npm/current/LICENSE"})
            self.assertEqual((notices / "stale.txt").read_text(), "Fixture stale.txt")
            run_release()
            self.assertEqual(archive.read_bytes(), first)
            for invalid in ["../LICENSE", "/absolute", "missing.txt", "npm\\escape"]:
                index["assets"] = [invalid]
                with self.subTest(invalid=invalid), self.assertRaisesRegex(SystemExit, "Invalid or missing indexed"):
                    run_release()


class BackendCoverageGateTests(unittest.TestCase):
    def run_gate(self, counts, require=100):
        with tempfile.TemporaryDirectory(prefix="sift-coverage-gate-") as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            script = root / "scripts/backend-coverage.py"
            script.write_bytes((ROOT / "scripts/backend-coverage.py").read_bytes())
            (root / ".cache").mkdir()
            (root / "go.mod").write_text("module example/sift\n")
            profile = ["mode: atomic"]
            for name, count in counts.items():
                source = root / name
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text("package fixture\nfunc run() {}\n")
                statements, executions = count if isinstance(count, tuple) else (1, count)
                profile.append(f"example/sift/{name}:2.1,2.14 {statements} {executions}")
            (root / ".cache/go-coverage.out").write_text("\n".join(profile) + "\n")
            args = [str(script)] + (["--require", str(require)] if require is not None else [])
            error = None
            with patch("sys.argv", args), patch.object(subprocess, "check_output", side_effect=["go version fixture", "darwin\narm64\n"]), patch.object(subprocess, "run") as cover, redirect_stdout(io.StringIO()):
                try:
                    runpy.run_path(str(script), run_name="__main__")
                except SystemExit as failure:
                    error = str(failure)
            self.assertEqual(cover.call_args.args[0][:3], ["go", "tool", "cover"])
            report = json.loads((root / "docs/verification/backend-coverage.json").read_text())
            self.assertEqual((root / "docs/verification/backend-coverage.out").read_bytes(), (root / ".cache/go-coverage.out").read_bytes())
            self.assertEqual(set(report["files"]), set(counts))
            for name, record in report["files"].items():
                self.assertEqual(record["sha256"], hashlib.sha256((root / name).read_bytes()).hexdigest())
            return report, error

    def test_full_application_coverage_passes_strict_gate(self):
        report, error = self.run_gate({"cmd/sift/main.go": 1, "internal/sift/service.go": 4})
        self.assertIsNone(error)
        self.assertEqual(report["total"], {"covered": 2, "total": 2, "percent": 100})

    def test_uncovered_application_statement_fails_and_keeps_evidence(self):
        report, error = self.run_gate({"cmd/sift/main.go": 1, "internal/sift/service.go": 0})
        self.assertIn("1 application statements remain uncovered", error)
        self.assertEqual(report["total"]["percent"], 50)
        self.assertEqual(len(report["files"]["internal/sift/service.go"]["uncovered"]), 1)

    def test_report_only_mode_does_not_claim_strict_gate_passed(self):
        report, error = self.run_gate({"internal/sift/service.go": 0}, require=None)
        self.assertIsNone(error)
        self.assertEqual(report["total"]["percent"], 0)
        self.assertIsNone(report["gate"])

    def test_95_percent_gate_passes_at_and_above_exact_boundary(self):
        for covered in [19, 20]:
            with self.subTest(covered=covered):
                report, error = self.run_gate({"cmd/sift/main.go": (covered, 1), "internal/sift/service.go": (1, 0)}, require=95)
                self.assertIsNone(error)
                self.assertEqual(report["gate"], {"requiredPercent": 95, "passed": True})
                self.assertEqual(report["total"]["covered"], covered)
                self.assertEqual(len(report["files"]["internal/sift/service.go"]["uncovered"]), 1)

    def test_95_percent_gate_fails_without_rounding_or_excluding_uncovered_statements(self):
        report, error = self.run_gate({"cmd/sift/main.go": (18999, 1), "internal/sift/service.go": (1000, 0)}, require=95)
        self.assertIn("Backend 95% coverage gate failed", error)
        self.assertEqual(f"{report['total']['percent']:.2f}", "95.00")
        self.assertLess(report["total"]["percent"], 95)
        self.assertEqual(report["gate"], {"requiredPercent": 95, "passed": False})
        self.assertEqual(report["files"]["internal/sift/service.go"]["uncovered"][0]["statements"], 1000)

    def test_empty_profile_cannot_pass_strict_gate(self):
        with tempfile.TemporaryDirectory(prefix="sift-empty-coverage-") as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            script = root / "scripts/backend-coverage.py"
            script.write_bytes((ROOT / "scripts/backend-coverage.py").read_bytes())
            (root / "go.mod").write_text("module example/sift\n")
            (root / ".cache").mkdir()
            (root / ".cache/go-coverage.out").write_text("mode: atomic\n")
            with patch("sys.argv", [str(script), "--require", "100"]), self.assertRaisesRegex(SystemExit, "Empty application coverage profile"):
                runpy.run_path(str(script), run_name="__main__")


class SecurityGateTests(unittest.TestCase):
    """Exercise fail-closed report/review handling without launching a scanner."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sift-security-gate-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for folder in ["cmd", "internal", "web", "scripts", ".github", ".cache/security"]:
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root / "scripts/install.sh").write_text("python3 <<'PY'\nvalue = 1\nPY\n")
        (self.root / "cmd/main.go").write_text("package main\nfunc main() {}\n")
        self.lock = {"rules": {"revision": "fixture"}, "opengrep": {"version": "fixture"}}
        (self.root / "scripts/security-tools.lock.json").write_text(json.dumps(self.lock))
        self.reviews = {}
        self.report = {"results": [], "errors": [], "paths": {"scanned": ["cmd/main.go", "scripts/install.sh", "scripts/security-tools.lock.json", "scripts/security-reviews.json", ".cache/security/installer.py"]}}
        self.ns = runpy.run_path(str(ROOT / "scripts/security-check.py"))
        self.globals = self.ns["opengrep"].__globals__
        self.addCleanup(patch.stopall)
        patch.dict(self.globals, {"ROOT": self.root, "OUT": self.root / ".cache/security", "TOOLS": self.root / ".cache/tools", "run": self.run_scanner}).start()

    def run_scanner(self, command):
        (self.root / ".cache/security/opengrep.json").write_text(json.dumps(self.report))
        return Mock(returncode=1 if self.report["results"] else 0)

    def scan(self):
        (self.root / "scripts/security-reviews.json").write_text(json.dumps(self.reviews))
        with redirect_stdout(io.StringIO()):
            self.ns["opengrep"]()

    def finding(self, security=True):
        return {"path": "cmd/main.go", "check_id": "/rules/.rules-fixture.fixture.rule", "start": {"line": 2}, "end": {"line": 2},
                "extra": {"message": "fixture finding", "metadata": {"category": "security" if security else "style"}}}

    def test_no_findings_and_nonsecurity_preserved(self):
        self.scan()
        self.report["results"] = [self.finding(False)]
        self.scan()
        summary = json.loads((self.root / ".cache/security/opengrep-summary.json").read_text())
        self.assertEqual(summary["nonSecurityFindings"], 1)
        self.assertEqual(summary["unresolved"], [])
        self.assertEqual(json.loads((self.root / ".cache/security/opengrep.json").read_text()), self.report)

    def test_missing_source_and_parser_errors_fail(self):
        self.report["paths"]["scanned"].remove("cmd/main.go")
        with self.assertRaisesRegex(ValueError, "skipped source"):
            self.scan()
        self.report["paths"]["scanned"].append("cmd/main.go")
        self.report["errors"] = [{"message": "fixture parser error"}]
        with self.assertRaisesRegex(ValueError, "parse/config/timeout"):
            self.scan()

    def test_scanner_failure_cannot_reuse_previous_success(self):
        self.scan()
        raw = self.root / ".cache/security/opengrep.json"
        previous = raw.read_bytes()
        with patch.dict(self.globals, {"run": Mock(return_value=Mock(returncode=0))}):
            with self.assertRaisesRegex(ValueError, "did not complete"):
                self.scan()
        self.assertFalse(raw.exists())
        self.assertEqual(raw.with_suffix(".previous.json").read_bytes(), previous)
        with patch.dict(self.globals, {"run": Mock(return_value=Mock(returncode=2))}):
            with self.assertRaisesRegex(ValueError, "did not complete"):
                self.scan()

    def test_cwe_findings_gate_without_security_category(self):
        finding = self.finding(False)
        finding["extra"]["metadata"]["cwe"] = ["CWE-78"]
        self.report["results"] = [finding]
        with self.assertRaisesRegex(ValueError, "unresolved"):
            self.scan()

    def trivy_scan(self, report, returncode=0, dependencies="github.com/akstspace/sift\n"):
        def scanner(command):
            (self.root / ".cache/security/trivy.json").write_text(json.dumps(report))
            self.assertIn("--include-dev-deps", command)
            self.assertIn("UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL", command)
            return Mock(returncode=returncode)
        with patch.dict(self.globals, {"run": scanner}), patch.object(self.globals["subprocess"], "check_output", side_effect=[dependencies, dependencies, dependencies, "v0.58.0"]) as graph:
            with redirect_stdout(io.StringIO()):
                self.ns["trivy"]()
        targets = [call.kwargs["env"] for call in graph.call_args_list[:3]]
        self.assertEqual([(env["GOOS"], env["GOARCH"]) for env in targets], [("darwin", "arm64"), ("linux", "arm64"), ("linux", "amd64")])
        self.assertTrue(all(env["CGO_ENABLED"] == "0" for env in targets))

    def test_trivy_proves_absence_on_every_release_target(self):
        self.trivy_scan({"Results": [{"Target": "go.mod"}, {"Target": "web/package-lock.json"}]})
        vex = json.loads((self.root / ".cache/security/openpgp.vex.json").read_text())
        statement = vex["statements"][0]
        self.assertEqual(statement["vulnerability"]["name"], "GO-2026-5932")
        self.assertEqual(statement["justification"], "vulnerable_code_not_present")
        self.assertEqual(statement["products"][0]["@id"], "pkg:golang/golang.org/x/crypto@v0.58.0")

    def test_trivy_rejects_compiled_openpgp_before_running_scanner(self):
        for target in range(3):
            with self.subTest(target=target):
                deps = ["safe.package\n"] * target + ["golang.org/x/crypto/openpgp/packet\n"]
                scanner = Mock()
                with patch.dict(self.globals, {"run": scanner}), patch.object(self.globals["subprocess"], "check_output", side_effect=deps):
                    with self.assertRaisesRegex(ValueError, "OpenPGP is now compiled"):
                        self.ns["trivy"]()
                scanner.assert_not_called()

    def test_trivy_incomplete_reports_failures_and_vulnerabilities_gate(self):
        for report, code, message in [
            ({"Results": [{"Target": "go.mod"}]}, 0, "both Go and npm"),
            ({"Results": [{"Target": "go.mod"}, {"Target": "web/package-lock.json"}]}, 2, "failed or found"),
            ({"Results": [{"Target": "go.mod", "Vulnerabilities": [{"VulnerabilityID": "fixture", "Severity": "LOW"}]}, {"Target": "web/package-lock.json"}]}, 0, "failed or found"),
        ]:
            with self.subTest(report=report, code=code), self.assertRaisesRegex(ValueError, message):
                self.trivy_scan(report, code)

    def test_trivy_does_not_reuse_old_success_when_scanner_produces_nothing(self):
        raw = self.root / ".cache/security/trivy.json"
        previous = b'{"Results":[{"Target":"go.mod"},{"Target":"web/package-lock.json"}]}'
        raw.write_bytes(previous)
        with patch.dict(self.globals, {"run": Mock(return_value=Mock(returncode=0))}), patch.object(self.globals["subprocess"], "check_output", side_effect=["safe\n", "safe\n", "safe\n", "v0.58.0"]):
            with self.assertRaisesRegex(ValueError, "did not produce a report"):
                self.ns["trivy"]()
        self.assertFalse(raw.exists())
        self.assertEqual(raw.with_suffix(".previous.json").read_bytes(), previous)

    def test_security_review_requires_exact_live_unexpired_source(self):
        self.report["results"] = [self.finding()]
        with self.assertRaisesRegex(ValueError, "unresolved"):
            self.scan()
        key = "cmd/main.go:fixture.rule:" + hashlib.sha256(b"func main() {}\n").hexdigest()
        review = {"reason": "Fixture-only reviewed call", "disposition": "not-a-vulnerability", "reviewBefore": (date.today() + timedelta(days=1)).isoformat()}
        self.reviews = {key: review}
        self.scan()
        for field, value in [("reason", ""), ("disposition", "ignore"), ("reviewBefore", "2000-01-01")]:
            with self.subTest(field=field):
                self.reviews = {key: {**review, field: value}}
                with self.assertRaisesRegex(ValueError, "unresolved"):
                    self.scan()
        self.reviews = {key: review}
        (self.root / "cmd/main.go").write_text("package main\nfunc changed() {}\n")
        with self.assertRaisesRegex(ValueError, "stale reviews"):
            self.scan()
        self.report["results"] = []
        with self.assertRaisesRegex(ValueError, "stale reviews"):
            self.scan()

    def test_local_reviews_remain_exact_expiring_and_optional_for_clean_checkouts(self):
        self.report["results"] = [self.finding()]
        key = "cmd/main.go:fixture.rule:" + hashlib.sha256(b"func main() {}\n").hexdigest()
        review = {"reason": "Local fixture call", "disposition": "not-a-vulnerability", "reviewBefore": (date.today() + timedelta(days=1)).isoformat()}
        path = self.root / "scripts/security-reviews.local.json"
        self.report["paths"]["scanned"].append("scripts/security-reviews.local.json")
        path.write_text(json.dumps({key: review}))
        self.scan()
        path.write_text(json.dumps({key: {**review, "reviewBefore": "2000-01-01"}}))
        with self.assertRaisesRegex(ValueError, "unresolved"):
            self.scan()
        path.write_text(json.dumps({key: review}))
        self.report["results"] = []
        with self.assertRaisesRegex(ValueError, "stale reviews"):
            self.scan()
        path.unlink()
        self.report["paths"]["scanned"].remove("scripts/security-reviews.local.json")
        self.scan()

    def test_local_reviews_cannot_replace_shipped_dispositions(self):
        key = "cmd/main.go:fixture.rule:" + hashlib.sha256(b"func main() {}\n").hexdigest()
        review = {"reason": "Shipped fixture call", "disposition": "not-a-vulnerability", "reviewBefore": (date.today() + timedelta(days=1)).isoformat()}
        self.reviews = {key: review}
        path = self.root / "scripts/security-reviews.local.json"
        path.write_text(json.dumps({key: {**review, "reason": "Local replacement"}}))
        self.report["paths"]["scanned"].append("scripts/security-reviews.local.json")
        with self.assertRaisesRegex(ValueError, "must not override shipped"):
            self.scan()


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sift-installer-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin, self.data = self.root / "bin", self.root / "data"
        self.blob, self.requests = archive(), []
        self.checksum = None
        self.release = {"tag_name": "v0.1.0", "draft": False, "prerelease": False}
        self.addCleanup(patch.stopall)
        patch.object(NS["platform"], "system", return_value="Darwin").start()
        patch.object(NS["platform"], "machine", return_value="arm64").start()
        patch.dict(NS, {"fetch": self.fetch}).start()
        # Existing archive/install tests opt out; PATH behavior is exercised in
        # disposable HOME directories below, never the developer's shell profile.
        output = redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def fetch(self, url, limit):
        self.requests.append(url)
        self.assertTrue(url.startswith(("https://github.com/akstspace/sift/", "https://api.github.com/repos/akstspace/sift/")))
        if url.endswith("/latest"):
            return json.dumps(self.release).encode()
        if url.endswith("checksums.txt"):
            return (self.checksum or f"{hashlib.sha256(self.blob).hexdigest()}  sift_darwin_arm64.tar.gz\n").encode()
        return self.blob

    def install(self, version="0.1.0", replace=False):
        return NS["install"](version, self.bin, self.data, replace, modify_path=False)

    def test_install_and_notices_no_execution(self):
        destination = self.install()
        self.assertEqual((self.bin / "sift").resolve(), (destination / "sift").resolve())
        self.assertEqual((destination / "sift").stat().st_mode & 0o777, 0o755)
        self.assertEqual((destination / "licenses/example.txt").read_text(), "License")
        self.assertEqual(set(self.root.iterdir()), {self.bin, self.data})

    def test_latest_stable(self):
        self.install(None)
        self.assertEqual(len(self.requests), 3)

    def test_explicit_replacement_retains_old(self):
        first = self.install()
        second = self.install("0.1.1", True)
        self.assertTrue(first.is_dir())
        self.assertEqual((self.bin / "sift").resolve(), (second / "sift").resolve())

    def test_replace_first_install(self):
        self.install(replace=True)
        self.assertTrue((self.bin / "sift").is_symlink())

    def test_same_version_refused(self):
        self.install()
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.install(replace=True)

    def test_unmanaged_targets_preserved(self):
        for kind in ["file", "directory", "symlink", "dangling"]:
            with self.subTest(kind=kind):
                self.bin.mkdir(exist_ok=True)
                link = self.bin / "sift"
                if kind == "file":
                    link.write_text("keep")
                elif kind == "directory":
                    link.mkdir()
                else:
                    link.symlink_to(self.root / ("bin" if kind == "symlink" else "missing"))
                with self.assertRaises(ValueError):
                    self.install(replace=True)
                self.assertTrue(os.path.lexists(link))
                link.rmdir() if kind == "directory" else link.unlink()

    def test_no_implicit_replacement(self):
        self.install()
        with self.assertRaisesRegex(ValueError, "Refusing to overwrite"):
            self.install("0.1.1")

    def test_bad_versions_before_download(self):
        for version in ["v1.2.3", "1.2.3-dev", "01.2.3", "../../bad", "1.2", "1.2.3\n"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.install(version)
        self.assertEqual(self.requests, [])

    def test_unsupported_platform(self):
        for system, machine in [("Windows", "x86_64"), ("Darwin", "x86_64"), ("Linux", "riscv64")]:
            with self.subTest(system=system, machine=machine):
                with patch.object(NS["platform"], "system", return_value=system), patch.object(NS["platform"], "machine", return_value=machine):
                    with self.assertRaises(ValueError):
                        self.install()
        self.assertEqual(self.requests, [])

    def test_linux_architecture_aliases(self):
        for machine, target in [("aarch64", "arm64"), ("x86_64", "amd64")]:
            with self.subTest(machine=machine), tempfile.TemporaryDirectory() as temporary:
                with patch.object(NS["platform"], "system", return_value="Linux"), patch.object(NS["platform"], "machine", return_value=machine):
                    self.checksum = f"{hashlib.sha256(self.blob).hexdigest()}  sift_linux_{target}.tar.gz\n"
                    NS["install"]("0.1.0", Path(temporary) / "bin", Path(temporary) / "data", modify_path=False)
                    self.assertTrue(self.requests[-1].endswith(f"sift_linux_{target}.tar.gz"))

    def test_prerelease_draft_and_invalid_latest(self):
        for update in [{"draft": True}, {"prerelease": True}, {"tag_name": "v1.0.0-beta"}, {"tag_name": "main"}]:
            with self.subTest(update=update):
                self.release = {"tag_name": "v0.1.0", **update}
                with self.assertRaises(ValueError):
                    self.install(None)

    def test_checksum_failures_do_not_install(self):
        for content in ["", "x  sift_darwin_arm64.tar.gz", "0" * 64 + "  sift_darwin_arm64.tar.gz", ("0" * 64 + "  sift_darwin_arm64.tar.gz\n") * 2]:
            with self.subTest(content=content):
                self.checksum = content or "\n"
                with self.assertRaises(ValueError):
                    self.install()
                self.assertFalse(self.bin.exists())
                self.assertFalse(self.data.exists())

    def test_unsafe_archives(self):
        cases = [("../escape", b"bad"), ("/absolute", b"bad"), ("x/../../escape", b"bad"),
                 ("x\\escape", b"bad"), ("a//b", b"bad"), ("sift", b"duplicate"),
                 ("link", tarfile.SYMTYPE), ("hard", tarfile.LNKTYPE), ("fifo", tarfile.FIFOTYPE), ("dir", tarfile.DIRTYPE)]
        for entry in cases:
            with self.subTest(entry=entry):
                self.blob = archive([entry])
                with self.assertRaises(ValueError):
                    self.install()
                self.assertFalse((self.data / "versions/0.1.0").exists())

    def test_missing_notices_and_oversize(self):
        for name in ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/DEPENDENCIES.json"]:
            with self.subTest(name=name):
                self.blob = archive(omit=[name])
                with self.assertRaisesRegex(ValueError, "notices"):
                    self.install()
        self.blob = archive()
        with patch.dict(NS, {"MAX_EXPANDED": 1}), self.assertRaisesRegex(ValueError, "limits"):
            self.install()

    def test_link_failure_rolls_back_version(self):
        with patch.object(Path, "symlink_to", side_effect=OSError("fixture link failure")):
            with self.assertRaisesRegex(OSError, "fixture"):
                self.install()
        self.assertFalse((self.data / "versions/0.1.0").exists())

    def test_shell_help(self):
        result = subprocess.run(["sh", str(ROOT / "scripts/install.sh"), "--help"], capture_output=True, text=True, check=True)
        self.assertIn("akstspace/sift", result.stdout)
        self.assertIn("--replace", result.stdout)
        self.assertIn("--no-modify-path", result.stdout)

    def test_default_install_adds_path_only_after_success_and_supports_opt_out(self):
        home = self.root / "home"
        home.mkdir()
        with patch.dict(os.environ, {"HOME": str(home), "SHELL": "/bin/zsh", "ZDOTDIR": str(home)}, clear=False):
            self.checksum = "0" * 64 + "  sift_darwin_arm64.tar.gz"
            with self.assertRaisesRegex(ValueError, "mismatch"):
                NS["install"]("0.1.0", self.bin, self.data)
            self.assertEqual(list(home.iterdir()), [])
            self.checksum = None
            NS["install"]("0.1.0", self.bin, self.data, modify_path=False)
            self.assertEqual(list(home.iterdir()), [])
            NS["install"]("0.1.1", self.bin, self.data, replace=True)
            profile = home / ".zshrc"
            self.assertIn(str(self.bin), profile.read_text())
            before = profile.read_bytes()
            NS["install"]("0.1.2", self.bin, self.data, replace=True)
            self.assertEqual(profile.read_bytes(), before)

    def test_path_setup_failure_keeps_successful_install_and_warns(self):
        with patch.dict(NS, {"configure_path": Mock(side_effect=OSError("fixture profile refusal"))}), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as errors:
            destination = NS["install"]("0.1.0", self.bin, self.data)
        self.assertTrue((destination / "sift").is_file())
        self.assertTrue((self.bin / "sift").is_symlink())
        self.assertIn("installed", errors.getvalue())
        self.assertIn("fixture profile refusal", errors.getvalue())


class InstallerPathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sift-path-test-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home / "bin with spaces"
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"HOME": str(self.home), "SHELL": "/bin/zsh"}, clear=True).start()

    def test_shell_profiles_and_overrides(self):
        cases = [("zsh", [self.home / ".zshrc"]), ("bash", [self.home / ".bashrc", self.home / ".profile"]),
                 ("sh", [self.home / ".profile"]), ("dash", [self.home / ".profile"]),
                 ("ksh", [self.home / ".profile"]), ("fish", [self.home / ".config/fish/conf.d/sift-path.fish"])]
        for shell, expected in cases:
            with self.subTest(shell=shell), patch.dict(os.environ, {"SHELL": "/bin/" + shell}):
                self.assertEqual(NS["path_configuration"](self.bin)[0], expected)
        with patch.dict(os.environ, {"ZDOTDIR": str(self.home / "zsh-config")}):
            self.assertEqual(NS["path_configuration"](self.bin)[0], [self.home / "zsh-config/.zshrc"])
        with patch.dict(os.environ, {"SHELL": "/bin/fish", "XDG_CONFIG_HOME": str(self.home / "fish-config")}):
            profiles, block, command = NS["path_configuration"](self.bin)
            self.assertEqual(profiles, [self.home / "fish-config/fish/conf.d/sift-path.fish"])
            self.assertIn("set -gx PATH $PATH", command)
            self.assertIn("if not contains --", block)
        for name in [".bash_login", ".bash_profile"]:
            (self.home / name).write_text("# existing login profile\n")
            with patch.dict(os.environ, {"SHELL": "/bin/bash"}):
                self.assertEqual(NS["path_configuration"](self.bin)[0][-1], self.home / name)

    def test_path_block_preserves_content_permissions_and_is_idempotent(self):
        profile = self.home / ".zshrc"
        original = b"# existing configuration without newline"
        profile.write_bytes(original)
        profile.chmod(0o640)
        block = NS["path_configuration"](self.bin)[1]
        self.assertTrue(NS["append_path_configuration"](profile, block))
        before = profile.read_bytes()
        self.assertTrue(before.startswith(original + b"\n\n"))
        self.assertEqual(profile.stat().st_mode & 0o777, 0o640)
        self.assertFalse(NS["append_path_configuration"](profile, block))
        self.assertEqual(profile.read_bytes(), before)
        profile.write_text(block.replace("export PATH", "# manually changed export PATH"))
        changed = profile.read_bytes()
        with self.assertRaisesRegex(ValueError, "edited"):
            NS["append_path_configuration"](profile, block)
        self.assertEqual(profile.read_bytes(), changed)

    def test_new_profile_has_private_permissions_and_fish_uses_managed_file(self):
        with patch.dict(os.environ, {"SHELL": "/bin/fish"}), redirect_stdout(io.StringIO()):
            NS["configure_path"](self.bin)
            NS["configure_path"](self.bin)
        profile = self.home / ".config/fish/conf.d/sift-path.fish"
        self.assertEqual(profile.stat().st_mode & 0o777, 0o600)
        self.assertEqual(profile.read_text().count("# >>> Sift PATH"), 1)
        self.assertFalse((self.home / ".config/fish/config.fish").exists())

    def test_refuses_unsafe_profiles_without_touching_targets(self):
        target = self.home / "target"
        target.write_bytes(b"keep exact bytes")
        symlink = self.home / "symlink"
        symlink.symlink_to(target)
        block = NS["path_configuration"](self.bin)[1]
        with self.assertRaises(OSError):NS["append_path_configuration"](symlink, block)
        self.assertEqual(target.read_bytes(), b"keep exact bytes")
        target.chmod(0o666)
        with self.assertRaisesRegex(ValueError, "unsafe"):NS["append_path_configuration"](target, block)
        self.assertEqual(target.read_bytes(), b"keep exact bytes")
        target.chmod(0o600)
        target.write_bytes(b"x" * ((1 << 20) + 1))
        with self.assertRaisesRegex(ValueError, "oversized"):NS["append_path_configuration"](target, block)
        directory = self.home / "directory"
        directory.mkdir()
        with self.assertRaises(OSError):NS["append_path_configuration"](directory, block)
        fifo = self.home / "fifo"
        os.mkfifo(fifo)
        with self.assertRaisesRegex(ValueError, "unsafe"):NS["append_path_configuration"](fifo, block)

    def test_posix_block_quotes_shell_metacharacters_and_does_not_duplicate_path(self):
        shells = ["/bin/sh", "/bin/bash"] + (["/bin/zsh"] if Path("/bin/zsh").is_file() else [])
        for name in ["bin with spaces", "bin'quote", "$(touch INJECTED);`touch INJECTED`$HOME*\\bin"]:
            directory = self.home / name
            block = NS["path_configuration"](directory)[1]
            for shell in shells:
                for path in ["/usr/bin:/bin", "", str(directory), "/usr/bin:" + str(directory) + ":/bin"]:
                    with self.subTest(name=name, shell=shell, path=path):
                        command = block + "\n" + block + '\nprintf "%s" "$PATH"'
                        result = subprocess.run([shell, "-c", command], env={"PATH": path, "HOME": str(self.home)}, cwd=self.home,
                                                capture_output=True, text=True, check=True)
                        self.assertEqual(result.stdout.split(":"), (path.split(":") if path else []) + ([] if str(directory) in path.split(":") else [str(directory)]))
            self.assertFalse((self.home / "INJECTED").exists())

    def test_invalid_paths_unsupported_shells_and_relative_configuration_are_refused(self):
        for name in ["bin:other", "bin\nother", "bin\rother", "bin\x00other"]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "PATH separators"):
                NS["path_configuration"](self.home / name)
        with patch.dict(os.environ, {"SHELL": "/bin/tcsh"}), self.assertRaisesRegex(ValueError, "not supported"):
            NS["path_configuration"](self.bin)
        for shell, key in [("zsh", "ZDOTDIR"), ("fish", "XDG_CONFIG_HOME")]:
            with patch.dict(os.environ, {"SHELL": "/bin/" + shell, key: "relative"}), self.assertRaisesRegex(ValueError, "absolute"):
                NS["path_configuration"](self.bin)

    def test_configuration_failure_warns_and_retains_other_bash_profile(self):
        (self.home / ".bashrc").symlink_to(self.home / "missing")
        with patch.dict(os.environ, {"SHELL": "/bin/bash"}), redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()) as errors:
            NS["configure_path"](self.bin)
        self.assertIn("skipped", errors.getvalue())
        self.assertIn("current shell", output.getvalue())
        self.assertTrue((self.home / ".profile").is_file())
        self.assertTrue((self.home / ".bashrc").is_symlink())

    def test_new_interactive_terminals_find_installed_command(self):
        self.bin.mkdir()
        executable = self.bin / "sift"
        executable.write_text("#!/bin/sh\nprintf 'SIFT_PATH_OK'\n")
        executable.chmod(0o700)
        for shell, arguments in [("bash", ["--noprofile", "--rcfile", str(self.home / ".bashrc"), "-i"]),
                                 ("zsh", ["-d", "-i"])]:
            path = Path("/bin") / shell
            if not path.is_file():continue
            with self.subTest(shell=shell), patch.dict(os.environ, {"SHELL": str(path)}), redirect_stdout(io.StringIO()):
                NS["configure_path"](self.bin)
                result = subprocess.run([str(path), *arguments, "-c", "sift"],
                                        env={"HOME": str(self.home), "ZDOTDIR": str(self.home), "PATH": "/usr/bin:/bin", "TERM": "dumb"},
                                        stdin=subprocess.DEVNULL, capture_output=True, text=True, check=True)
                self.assertEqual(result.stdout, "SIFT_PATH_OK")

    def test_profile_locked_by_another_process_is_left_untouched(self):
        profile = self.home / ".zshrc"
        profile.write_text("# keep\n")
        with profile.open("rb") as owner:
            NS["fcntl"].flock(owner.fileno(), NS["fcntl"].LOCK_EX | NS["fcntl"].LOCK_NB)
            with self.assertRaises(OSError):
                NS["append_path_configuration"](profile, NS["path_configuration"](self.bin)[1])
        self.assertEqual(profile.read_text(), "# keep\n")


class FetchTests(unittest.TestCase):
    def test_origin_restriction(self):
        for url in ["http://github.com/akstspace/sift", "https://evil.test/", "file:///etc/passwd",
                    "https://github.com/another/repo/a", "https://github.com:8443/akstspace/sift/a",
                    "https://user:password@github.com/akstspace/sift/a", "https://release-assets.githubusercontent.com/a"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                NS["fetch"](url, 10)

    def test_redirect_and_size_restriction(self):
        for final, data, fails in [("http://github.com/a", b"ok", True), ("https://evil.test/a", b"ok", True),
                                   ("https://release-assets.githubusercontent.com/a", b"ok", False),
                                   ("https://objects.githubusercontent.com/a", b"too long", True)]:
            response = io.BytesIO(data)
            response.url = final
            opener = Mock()
            opener.open.return_value = response
            with self.subTest(final=final), patch.object(NS["urllib"].request, "build_opener", return_value=opener):
                if fails:
                    with self.assertRaises(ValueError):
                        NS["fetch"]("https://github.com/akstspace/sift/releases/download/v0.1.0/a", 3)
                else:
                    self.assertEqual(NS["fetch"]("https://github.com/akstspace/sift/a", 3), b"ok")

    def test_every_redirect_is_checked_before_following(self):
        handler = NS["GitHubRedirects"]()
        request = NS["urllib"].request.Request("https://github.com/akstspace/sift/a")
        for url in ["http://github.com/a", "https://evil.test/a", "file:///etc/passwd",
                    "https://github.com:8443/a", "https://user@github.com/a"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                handler.redirect_request(request, None, 302, "Found", {}, url)
        redirected = handler.redirect_request(request, None, 302, "Found", {}, "https://release-assets.githubusercontent.com/a?signature=fixture")
        self.assertEqual(redirected.full_url, "https://release-assets.githubusercontent.com/a?signature=fixture")


class VersionTests(unittest.TestCase):
    def test_bumps_and_consistency(self):
        for bump, expected in [("patch", "1.2.4"), ("minor", "1.3.0"), ("major", "2.0.0")]:
            with self.subTest(bump=bump), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "web").mkdir()
                (root / "internal/sift").mkdir(parents=True)
                (root / "VERSION").write_text("1.2.3\n")
                (root / "internal/sift/model.go").write_text('package sift\nvar Version = "1.2.3-dev"\n')
                (root / "web/package.json").write_text('{"version":"1.2.3"}')
                (root / "web/package-lock.json").write_text('{"version":"1.2.3","packages":{"":{"version":"1.2.3"},"dependency":{"version":"9.8.7"}}}')
                ns = runpy.run_path(str(ROOT / "scripts/version.py"))
                with patch.dict(ns["main"].__globals__, {"ROOT": root}), patch("sys.argv", ["version.py", "--bump", bump]):
                    ns["main"]()
                    self.assertEqual(ns["current"](), expected)
                    lock = json.loads((root / "web/package-lock.json").read_text())
                    self.assertEqual(lock["packages"]["dependency"]["version"], "9.8.7")
                    (root / "VERSION").write_text("0.0.0\n")
                    with self.assertRaisesRegex(ValueError, "disagree"):
                        ns["current"]()


class PublicationTests(unittest.TestCase):
    """All git/gh commands are recorded fixtures; no remote writer is executed."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="sift-release-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "LICENSE").write_text("MIT fixture")
        self.assets = self.root / "assets"
        self.assets.mkdir()
        self.ns = runpy.run_path(str(ROOT / "scripts/publish-release.py"))
        self.globals = self.ns["publish"].__globals__
        self.calls, self.changed, self.head, self.latest = [], set(self.ns["VERSION_FILES"]), "a" * 40, "a" * 40
        self.tag, self.asset_fault = "", None
        self.addCleanup(patch.stopall)
        patch.dict(self.globals, {"ROOT": self.root, "ASSETS": self.assets, "command": self.command}).start()
        patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch",
                               "GITHUB_REPOSITORY": "akstspace/sift", "GITHUB_REF": "refs/heads/main",
                               "GITHUB_SHA": self.head, "GH_TOKEN": "fixture-not-a-real-token"}, clear=True).start()
        self.documentation = json.loads((ROOT / "scripts/package-docs.json").read_text())
        (self.root / "scripts").mkdir()
        (self.root / "scripts/package-docs.json").write_text(json.dumps(self.documentation))
        for name in self.documentation:
            path = self.root / name
            path.parent.mkdir(exist_ok=True)
            path.write_text(name + " fixture")
        self.packages()

    def packages(self, omit=(), changed=False, changed_source=None):
        for target in ["darwin_arm64", "linux_arm64", "linux_amd64"]:
            with tarfile.open(self.assets / f"sift_{target}.tar.gz", "w:gz") as archive:
                for name in self.documentation:
                    if name in omit:
                        continue
                    data = b"changed" if changed or name == changed_source else (self.root / name).read_bytes()
                    entry = tarfile.TarInfo(name)
                    entry.size = len(data)
                    archive.addfile(entry, io.BytesIO(data))

    def command(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[0] == "python3": return "0.1.1"
        if args[:3] == ("git", "rev-parse", "HEAD"): return self.head
        if args[:3] == ("git", "diff", "--name-only"): return "\n".join(sorted(self.changed))
        if args[:2] == ("git", "ls-remote"): return self.tag
        if args[:2] == ("gh", "api"):
            if "/git/ref/" in args[2]: return self.latest
            assets = [{"name": p.name, "size": p.stat().st_size, "digest": "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest()}
                      for p in sorted(self.assets.iterdir()) if p.name.endswith(".tar.gz") or p.name == "checksums.txt"]
            if self.asset_fault == "missing": assets.pop()
            if self.asset_fault == "size": assets[0]["size"] += 1
            if self.asset_fault == "digest": assets[0]["digest"] = "sha256:" + "0" * 64
            if self.asset_fault == "extra": assets.append({"name": "unexpected.txt"})
            return json.dumps({"assets": assets})
        return ""

    def test_prepare_requires_exact_packages_and_matching_documents(self):
        self.assertEqual(self.ns["prepare"](), "0.1.1")
        self.assertEqual(len((self.assets / "checksums.txt").read_text().splitlines()), 3)
        (self.assets / "sift_linux_amd64.tar.gz").unlink()
        with self.assertRaisesRegex(ValueError, "Exactly three"):
            self.ns["prepare"]()
        for source in self.documentation:
            with self.subTest(source=source):
                self.packages(omit=[source])
                with self.assertRaisesRegex(ValueError, "missing required") as failure:
                    self.ns["prepare"]()
                self.assertIn(source, str(failure.exception))
                self.packages(changed_source=source)
                with self.assertRaisesRegex(ValueError, "do not match") as failure:
                    self.ns["prepare"]()
                self.assertIn(source, str(failure.exception))
        self.packages(changed=True)
        with self.assertRaisesRegex(ValueError, "do not match"):
            self.ns["prepare"]()

    def test_guards_prevent_remote_writes(self):
        for key, value in [("GITHUB_ACTIONS", "false"), ("GITHUB_EVENT_NAME", "push"),
                           ("GITHUB_REPOSITORY", "fork/sift"), ("GITHUB_REF", "refs/heads/other"), ("GH_TOKEN", "")]:
            with self.subTest(key=key), patch.dict(os.environ, {key: value}), self.assertRaises(ValueError):
                self.ns["publish"]()
        self.assertEqual(self.calls, [])
        (self.root / "LICENSE").unlink()
        with self.assertRaisesRegex(ValueError, "LICENSE"):
            self.ns["publish"]()
        self.assertEqual(self.calls, [])

    def test_moved_checkout_main_changes_and_existing_tag_stop_before_commit(self):
        for kind in ["checkout", "main", "changes", "tag"]:
            with self.subTest(kind=kind):
                self.calls.clear()
                self.head, self.latest, self.changed, self.tag = "a" * 40, "a" * 40, set(self.ns["VERSION_FILES"]), ""
                if kind == "checkout": self.head = "b" * 40
                if kind == "main": self.latest = "b" * 40
                if kind == "changes": self.changed.add("other.txt")
                if kind == "tag": self.tag = "existing"
                with self.assertRaises(ValueError): self.ns["publish"]()
                self.assertFalse(any("commit" in args or "push" in args or "create" in args for args, _ in self.calls))

    def test_upload_failures_leave_release_draft(self):
        for kind in ["missing", "size", "digest", "extra"]:
            with self.subTest(kind=kind):
                self.asset_fault, self.calls = kind, []
                with self.assertRaisesRegex(ValueError, "asset"):
                    self.ns["publish"]()
                self.assertTrue(any(args[:3] == ("gh", "release", "create") and "--draft" in args for args, _ in self.calls))
                self.assertFalse(any("--draft=false" in args for args, _ in self.calls))

    def test_only_verified_assets_published_with_atomic_nonpersistent_credentials(self):
        with redirect_stdout(io.StringIO()): self.ns["publish"]()
        push = next((args, kwargs) for args, kwargs in self.calls if args[:2] == ("git", "push"))
        self.assertIn("--atomic", push[0])
        self.assertNotIn("fixture-not-a-real-token", " ".join(push[0]))
        self.assertEqual(push[1]["env"]["GIT_CONFIG_COUNT"], "1")
        self.assertTrue(any("--draft=false" in args for args, _ in self.calls))
        self.assertFalse(any("--force" in args or "--clobber" in args for args, _ in self.calls))


if __name__ == "__main__":
    unittest.main()
