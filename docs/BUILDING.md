# Build and local release artifacts

## Prerequisites

- Go 1.27.x (see `go.mod`), Node 24/npm, Python 3.13 for CI/tooling.
- Network for npm modules and the checksum-pinned upstream RustFS archives.
- Existing local Pi only for agent discovery/runs, not for compiling Sift.

```sh
python3 scripts/prepare-rustfs.py --platform all
cd web
npm ci
npm run build
npm test
cd ..
go test -race ./...
go build -trimpath -o bin/sift-development ./cmd/sift
```

`web` builds into `internal/sift/public`; Go embeds that directory. Platform
build tags select exactly one RustFS payload. A binary built before a frontend
change still contains the old UI until rebuilt. The Go service requires no
external frontend server or runtime Node install in packaged use.

Keep development executables separate from the installed `sift` command. Run
`bin/sift-development serve --data .cache/development-workspace` for local work;
do not install test builds on PATH or use the personal Sift data directory.

Generated embedded frontend output is ignored by Git; the original project mark
is the only placeholder retained there before a build. Always build `web` before
running or packaging the application. The full build regenerates the UI from
the committed source, lockfile, offline icon catalog, and self-hosted assets.

Run frontend builds **before**, not concurrently with, `go build`, `go test`, or
notice collection. Vite replaces the embedded directory; a concurrent Go compile
can enumerate old chunk filenames and then fail when those files are replaced.

`scripts/package-docs.json` is the shared public-document manifest used by the
builder, archive verifier and publication guard. Ignored local design/research notes are never
globbed into packages; a clean checkout and this working directory use the same
required docs.

## Local packages

```sh
python3 scripts/collect-licenses.py
python3 scripts/release.py --version 0.1.0 --platform all
python3 scripts/release-check.py --version 0.1.0
```

The version must be an explicitly selected stable semantic version. This
creates `dist/VERSION/sift_darwin_arm64.tar.gz`, `sift_linux_arm64.tar.gz`,
`sift_linux_amd64.tar.gz`, and `checksums.txt`. Each archive contains one Sift
executable with its target RustFS, notices, and documentation. Archive timestamps
are normalized; reproducibility still depends on pinned tools and inputs.
The script never creates a Git repository, commits, pushes, or publishes.
`VERSION` is canonical; `scripts/version.py` checks it against both npm manifests
and the Go development version. `scripts/version.py --bump patch|minor|major`
updates those four declarations without committing or publishing. Package builds
refuse mismatched versions and regenerate notices after the frontend build.
Notice collection uses the union of Go dependencies for all three supported
targets with `CGO_ENABLED=0`, so native build hosts produce the same consolidated
notice document without omitting platform-specific licenses. Package preparation
resolves all three verified RustFS payloads for this dependency inventory; each
executable still embeds only its selected target's payload.
Packages select dependency notices from the freshly generated
`licenses/DEPENDENCIES.json`, plus the required RustFS and shadcn notices.
Stale generated notices from removed dependencies are neither packaged nor
deleted from a local working directory. Full source/dependency notices are
consolidated in `THIRD_PARTY_NOTICES.md`; the reviewed upstream exception is
retained there and reconstituted by the collector on a clean build. The generated
`licenses/` directory stays ignored. Required license compliance inputs remain
in the source even though generated directories and local QA scripts are ignored.

`release-check.py` checks every archive checksum, normalized file entries,
executable architecture, dependency notices, the embedded RustFS payload hash,
and exact packaged Markdown/source equality. It starts only the native package in a temporary workspace, verifying
CLI persistence, image bytes, backup, embedded frontend, and clean shutdown.
Its local evidence is `docs/verification/release-check.json`. Generated browser,
coverage and package evidence under `docs/verification/` is ignored local output,
not bundled release documentation. CI uploads its own coverage/security/native
reports as artifacts; reproduce local reports with the commands here.

An optional Linux arm64 smoke check uses an **existing** local arm64 Docker
image with Bun (default `bit-ui-migrator:local`), overrides its entrypoint, and
never pulls an image or runs its application:

```sh
python3 scripts/linux-package-check.py --version 0.1.0
```

That container has no network or published ports, no host credentials, only a
read-only staged package/fixture mount, and a disposable writable tmpfs. It
checks real bundled RustFS, CLI, image bytes, backup/restore, three concurrent
fixture runs, coalescing, actual cron scheduling, restart/session persistence,
and shutdown. It launches no real model work and does not claim physical Linux
hardware or amd64 acceptance. Evidence: `docs/verification/linux-package-check.json`.

Do not label cross-compiled Linux binaries as runtime-tested on macOS. Verify
extraction, startup, CLI, image storage, scheduling, backup/restore, and shutdown
on each actual OS/architecture before a public release. Signing/notarization,
remote updater success, and Safari/Firefox acceptance are separate gates.

## Private browser acceptance

The local, ignored review scripts use an isolated Chrome through Chrome DevTools MCP and do
not change global MCP or agent configuration. Use a dedicated QA workspace:

```sh
python3 scripts/browser-mcp.py start /absolute/private/sift-cdp.sock
python3 scripts/ui-review.py --socket /absolute/private/sift-cdp.sock
python3 scripts/refinement-review.py --socket /absolute/private/sift-cdp.sock --confirm
go build -trimpath -o .cache/sift-acceptance ./cmd/sift
python3 scripts/acceptance.py --socket /absolute/private/sift-cdp.sock
```

These optional browser harnesses and their reports are not part of a public
checkout. The commands above document the owner's local verification, not a
public-checkout test target; the committed frontend interaction tests and Go
integration tests run through the build/CI commands in this document.

Page IDs and ports must match the isolated QA app. Screenshots and audit JSON
are under `docs/verification`. `--resume` continues a partially completed matrix
without recapturing completed views; `--confirm` writes the single correction
confirmation report. Tests must not run billable jobs without authorization.

## GitHub CI and release

`.github/workflows/ci.yml` runs on pull requests, main pushes, manual dispatch,
and as the release workflow's reusable verification gate. Actions are pinned to
commit SHAs; ordinary jobs have read-only contents permission and do not retain
checkout credentials. It runs:

- Frontend production build and 95% statement/branch/function/line gates.
- Hermetic installer/version tests, actionlint, OpenGrep, and Trivy.
- Native macOS arm64, Linux arm64, and Linux amd64 package builds; full uncached
  `SIFT_INTEGRATION=1 go test -race ... ./...`, `go vet`, raw coverage reports,
  architecture/payload/notice/checksum inspection, and real native package smoke.
- Downloadable coverage, security, package, and native smoke artifacts.

Backend coverage has a **95% statement gate**, without application exclusions,
as selected by the owner. `python3 scripts/backend-coverage.py --require 95`
retains the raw, JSON/source-hash and HTML evidence, then fails below the exact
threshold without rounding. The recorded 98.52% local profile passes this gate;
the 41 uncovered statements remain in its reports. `--require 100` remains
available for stricter local checks. Frontend coverage requires 95% on all four
metrics. Native GitHub runner definitions are not evidence of successful execution.

The separate scheduled dependency audit reruns weekly with a fresh vulnerability
database. Dependabot proposes npm, Go, and action updates; scanners and rules are
explicitly checksum-pinned in `scripts/security-tools.lock.json` and must be
reviewed/upgraded there. To run locally:

```sh
python3 scripts/security-tools.py opengrep trivy actionlint rules
.cache/security-tools/actionlint .github/workflows/*.yml
python3 scripts/prepare-rustfs.py --platform all
python3 scripts/security-check.py all
python3 scripts/test-tooling.py
```

OpenGrep retains the full upstream findings, fails on parser/config/timeout errors,
checks that all application/tooling/test source was scanned, and gates every
security/CWE finding at every severity. Translation/style/portability suggestions
remain in the raw report but are not mislabeled as vulnerabilities. Reviewed false
positives must match an exact path/rule/source SHA-256 with a reason and expiry;
changed or stale reviews fail. No broad rule exclusion or inline `nosem` is used.
The shell installer's embedded Python is also scanned as Python, not only shell.

Trivy audits Go and npm, including development dependencies, at **all** severities
including UNKNOWN and unfixed advisories. The OpenPGP module-level advisory is
represented by an explicit OpenVEX not-affected decision, only after each run proves
`golang.org/x/crypto/openpgp` absent from the compiled dependency graph for **all
three targets**. Importing it invalidates the decision and fails the gate. Raw
reports retain suppressed/not-affected evidence; no `.trivyignore` is loaded.

### Publish (owner-controlled)

1. Use the MIT-licensed source repository `akstspace/sift` with Actions enabled.
   The initial `v0.1.0` tag identifies the source snapshot.
   Configure the `release` environment with required reviewers
   and main-branch restrictions; workflow YAML cannot enforce environment rules by itself.
2. Make required branch checks match CI; if main is protected, authorize the release
   actor under your chosen repository rules. The workflow never bypasses protection.
3. Dispatch **Version bump and release** on main, choose patch/minor/major, and type
   `akstspace/sift` as confirmation. No release happens on push or schedule.
4. All verification jobs test the *bumped version* in isolated checkouts. Only after
   they pass does the protected publication job gain contents-write permission.
5. Publication refuses moved main, existing tags, unexpected changes, or missing
   owner license; it commits only four version declarations and atomically pushes
   main plus tag. It uploads the three verified packages and SHA-256 list to a draft,
   verifies server asset sizes/digests, then publishes stable. No forced updates or
   `--clobber`; failures leave a draft/tag for deliberate manual inspection.

The release token is short-lived and process-scoped, not stored in Git config.
No workflow was executed or remote installation demonstrated just by authoring it.
