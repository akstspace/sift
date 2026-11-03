# Acceptance and release readiness

This is a local verification record, not a claim of a public release or perfect
software. UI evidence was collected on macOS arm64 with Chromium; the Linux
arm64 package was also exercised in an isolated container in a local Colima VM.
Personal data, QA data, and newly created acceptance workspaces remain separate.
One explicitly authorized real GPT-6.1 Sol prompt was run in an isolated QA
workspace; other job evidence uses fixtures. Global installation was not performed.
This record describes local verification before the initial source publication
and `v0.1.0` source tag.
GitHub Actions results are separate from the local results below.

Raw reports, screenshots, personal/QA workspaces, and browser harnesses remain
private, ignored local artifacts. Paths under `docs/verification/` below identify
those local artifacts, not files downloadable from the public repository. CI
generates its own evidence artifacts from the retained build and test inputs.

## Frontend verification

The latest strict frontend run passes **375 tests in 29 test files**, covering
all **65 application TypeScript/TSX files**:

| Metric | Covered / total | Result |
| --- | ---: | ---: |
| Statements | 3082 / 3095 | 99.57% |
| Branches | 3002 / 3071 | 97.75% |
| Functions | 1055 / 1067 | 98.87% |
| Lines | 2279 / 2282 | 99.86% |

Scope is `web/src/**/*.{ts,tsx}` excluding tests, test setup/fixtures, and type
declarations, not a hand-picked subset of components. The strict command sets
all four thresholds to 95%, as selected by the owner. Coverage is execution
evidence, not proof that every possible user action is correct.

```sh
cd web
npm run test:coverage:check -- --reporter=dot
npm run build
```

The production TypeScript/Vite build passes. Local reports are
`docs/verification/frontend-coverage/coverage-summary.json`, `lcov.info`, and
`index.html` in that directory. The public CI uploads its own coverage artifact.

The normal `npm run test:coverage:check` command also passed without additional
options. Direct dependency versions are pinned to their already-resolved
lockfile versions; these pins did not upgrade packages.

## UX, UI, accessibility, and motion

The earlier broad correction-confirmation pass records **112 passing checks across
37 views**, with **zero axe violations**. It includes light/dark themes and
390/768/1100/1440-pixel widths, desktop/mobile task sheets, calendar and choice
menus, project colors, Today, settings, focus, keyboard drag, reduced motion,
draft handling, and board geometry/scroll preservation. The mechanical
Impeccable source scan also returned no findings (`[]`).

Existing tasks open read-first, with an explicit title-edit action and Markdown
Preview/Edit controls. Escape cancels a title rename without dismissing the
sheet. Whole-card targeting does not swallow independent completion, subtask,
status, or drag controls. Confirmation screenshots and measurements are in
`docs/verification/refinement-confirm.json` and adjacent
`refinement-confirm-*.png` files. Earlier review reports are historical and may
contain the defects corrected by this final confirmation pass.

Drag overlays are portaled to `document.body`, outside the page transition's
filtered containing block. The latest correction keeps the source stationary
and lifts one full-size, inert, accessibility-hidden card above the board and
below dialogs, preserving metadata and expanded/collapsed subtasks. It removes
the translated source that could pass underneath neighboring cards and the
separate rotated title-only preview. Regressions cover pointer drop, keyboard
lift/movement/cancel, viewport geometry, and independent controls. Pointer tests wait
for the sensor's real document-listener teardown to avoid leaking click
suppression into subsequent tests. The review script exits nonzero on failed
checks or axe violations.

The latest built-app confirmation covers **six views** (1440×900, 1280×560,
the reported 539×831 width, 390×667 light/dark, and 844×390 landscape).
It verifies dialog containment, a complete focused prompt and focus ring,
reachable bottom fields, visible footer controls, no horizontal overflow, and
zero axe violations in every view. Explicit viewport gutters replace the
dialog's conflicting full-width/max-width rule. A non-fieldset scroll wrapper
allows the form to shrink, and a viewport-bounded prompt keeps short windows
usable. Mobile inputs use 16px text to prevent focus zoom. Screenshots and
measured pointer/keyboard drag geometry are in
`docs/verification/ui-fixed-confirm.json` and `ui-fixed-*.png`.

### Job and offline-icon acceptance

The deterministic fixture lifecycle report
`docs/verification/tabler-jobs-lifecycle.json` covers create,
discovery, exact-model persistence, run/transcript, explicit rerun/session reuse,
confirmed memory reset/history retention, hanging-run cancellation, invalid cron
refusal, paused schedules, and draft discard. This is not real-model evidence.

At the user's explicit request, a separate real job was created and configured
through the production UI with **provider `tokenplex`, model `gpt-6.1-sol`**,
minimal thinking, a two-minute timeout, an isolated working directory, images
excluded, and schedule paused. One explicit Run now succeeded, returning exactly
`SIFT_REAL_MODEL_QA_OK`; transcript evidence records no tool calls and no task
changes. History, model identity, and session were inspected in the UI and
persisted records. No fallback or second real run occurred. See
`docs/verification/real-model-job.json`. This bounded request
tests the real provider path, not arbitrary autonomous tool use.

The pinned Tabler 3.50.0 catalog includes **6,257 native outline/filled IDs** and a
sanitized same-origin sprite. The offline picker bounds rendering to 60 results,
fuzzy-matches `gmial`/`slcak` to Brand Gmail/Brand Slack, and persists mobile
selection. Shared Go/TypeScript search vectors and all-icon generation checks
pass; no custom SVG upload, runtime remote fetch, legacy mapping, or migration
was introduced.

### Chat acceptance

Automated tests cover the chat's backend (session start, resume and replacement,
steering, stop, questions, model choice, maintenance, event relay, idle stop)
under the race detector, and its UI (pill states, Cmd/Ctrl+J and Escape, focus,
streaming, queued messages, questions of every kind, model and thinking choice,
slash commands, images, view sharing, provider errors). Sift commands are parsed
without a shell and described from the CLI's own JSON.

A local Chrome run against a scripted Pi that drives the real Sift CLI checks the
pill-to-panel morph in both directions, keyboard focus on open and close, task
chips opening task details, Cmd+J being held while a dialog is open, an inline
question, a provider refusal, `/new`, and the phone sheet, with **zero axe
violations** in nine light, dark, and phone states. Run history's transcript
check passes at six sizes with zero axe violations. Opening a long conversation
on a phone-sized view measured no long tasks after task icons stopped using the
icon sprite for the default icon.

At the person's request, the chat was also run with their real local Pi on
**provider `tokenplex`, model `gpt-6.1-sol`**, low thinking, in a throwaway
workspace: Pi read the CLI help, checked for duplicates before adding a task,
pointed out a likely duplicate and asked before merging, and completed a task
with the person's reason. Every Sift command appeared as a card with the live
task. Screenshots are in `docs/verification/chat/`. This is bounded evidence of
the real path, not of every model or tool.

This is bounded review evidence, not a claim that Chromium testing proves
Safari/Firefox or all assistive-technology behavior.

## Production and scale acceptance

`scripts/acceptance.py` starts an isolated production executable and real bundled
RustFS, seeds 10,000 persistent tasks while that fixture service is stopped,
and drives its own isolated Chromium page. It does not change personal/QA
records. It closes only its own page/service when finished.

The recorded checks cover actual listener security, private cookies/headers,
agent workflow restrictions, idempotency, hierarchy, optimistic conflicts,
read-first single-modal opening, keyboard paths, outage/reconnect, local images
through picker/paste/drop/CLI, duplicate suggestions, reversible merge/history,
paused job creation and memory reset, project/tag discovery, coordinated
backup/restore, local PWA assets, and service-worker privacy. Creation Undo has
an explicit production regression check in addition to backend tests.

The current authoritative pass count and measurements are in
`docs/verification/acceptance.json`. `ready` is measured from page
navigation until the real UI has loaded and finite animations/fonts have
settled; search-tool roundtrip is not an isolated JavaScript execution time.
The target is board ready in under five seconds, bounded card rendering,
virtualized list rendering, and exact 10,000-task search.

The refreshed run passes **56 checks**, including opening a local image from
the Markdown preview. A deterministic interaction regression additionally
delivers history between pointer-down and release and verifies that the same
Markdown image button survives and opens the full-size viewer. Stable renderer
identities prevent asynchronous history/duplicate updates from losing a click.

The current 10,000-task measurements are **813.8 ms** to board-ready with
**210 cards / 4,242 DOM nodes**, **17 rendered rows / 28.5 ms** for the list
end-scroll, and **711.64 ms** for the exact-search browser-tool roundtrip.
Reconnect interruption feedback appears after a **4,050.8 ms** grace period.

```sh
# Build frontend first. Do not replace embedded files during Go compilation.
go build -trimpath -o .cache/sift-acceptance ./cmd/sift
python3 scripts/acceptance.py --socket /absolute/private/sift-cdp.sock
```

See [BUILDING.md](BUILDING.md) for the private browser harness. Do not run
multiple harness clients concurrently or repurpose a person's browser pages.

## Backend safety and coverage

The complete suite uses the race detector and real bundled RustFS integration:

```sh
SIFT_INTEGRATION=1 go test -race -count=1 -coverprofile=.cache/go-coverage.out ./...
go tool cover -func=.cache/go-coverage.out
python3 scripts/backend-coverage.py
```

The latest complete passing macOS arm64 run records:

| Package | Covered / total statements | Result |
| --- | ---: | ---: |
| CLI entry point (`cmd/sift`) | 5 / 5 | 100% |
| Application backend (`internal/sift`) | 3,934 / 4,024 | 97.76% |
| Combined Go application | 3,939 / 4,029 | 97.77% |

The owner selected **95%** as the backend statement coverage gate; this recorded
**97.77%** passes that threshold. It is not 100% coverage. Go reports statements, not frontend branch or
function coverage. The unmodified local raw profile
`docs/verification/backend-coverage.out`, `backend-coverage.json` source hashes,
and `backend-coverage.html` preserve the measured scope. No
application files/blocks are excluded and subprocess/runtime profiles are not
silently added. Platform-specific Linux startup code is not executed by this
macOS suite.

The remaining **90 backend statements** are listed exactly in the raw/JSON/HTML
reports. They include filesystem write/sync/rename failures, low-level SQLite
initialization failures, Pi process-pipe failures, updater replacement in a child
process, and platform-specific startup paths. Some guard failures are unreachable with the statically embedded
payloads or valid configurations. These gaps remain visible rather than being
removed merely to improve the percentage.

The CI command `python3 scripts/backend-coverage.py --require 95` passes this
profile and retains its uncovered statements. The optional stricter local
`--require 100` command still returns nonzero after writing its evidence.
The complete race/integration suite itself passes.

Tests include concurrent revision winners, source-key and request replay,
hierarchy/linked undo, merge validation, history preservation, SQL write
failure rollback, malformed and checksum-invalid archives, backup partial-file
cleanup, maintenance exclusion, restore preflight refusal, SQL-failed restore
with session rollback, crash journals, retention, startup security, SSE,
interrupted-run recovery, scheduler coalescing/catch-up, Pi configuration and
shutdown, and update verification. Update replacement success uses a disposable
copy of the test executable, never the person's running executable. Pi fixtures
are deterministic local peers, not paid model calls or approval grants.

The expanded suite also exercises a real minute maintenance tick, the 45-second
storage readiness deadline and eight-second forced shutdown, multipart backing-file
read failure, non-durable device writes, image restore refusal before session swap,
SQLite authorizer failures, transaction-begin refusal with complete session rollback,
and recovery-journal retention/retry after actual filesystem permission failures.
The latest additions verify that an expired configuration deadline is terminal,
creates an actionable notification, and neither replays nor silently pauses the
job; a real SQLite schema-read denial during initialization closes the failed
connection and allows explicit retry; and a committed restore whose cleanup is
denied preserves restored records/session bytes plus its journal until an explicit
cleanup retry succeeds. The SQLite connection policy applies only to the exact
disposable database registered by the test, never a user's workspace.
Additional backup regressions revoke actual filesystem search/write/read
permissions at the session-metadata, archive-publication, and directory-durability
boundaries. Each verifies unchanged tasks/history/session bytes, no false success
in backup settings, and a successful explicit retry after restoring permissions.
When directory writes prevent both rename and deferred unlink, the `.partial`
file remains evidence of a failed export, never a completed backup. The regression
passed ten repeated race runs as well as the complete uncached integration suite.
Pi configuration-cancellation tests wait for the peer's command receipt rather
than relying on a fixed timeout to hit a particular RPC. Graph validation sorts
task IDs so the same broken merge chain has deterministic diagnostics; the
insertion-order regression passed ten repeated race runs.

The final uncached run also verifies impossible schedules return no occurrence,
minute-by-minute cron skips the repeated DST hour, malformed/read-only database
startup preserves the original records, a runtime extraction rename failure is
reported, and a session larger than 64 MB cannot replace current memory or tasks.

Safety tests found and fixed failed Pi RPC writes retaining pending requests,
creation Undo misreading nullable grouped history blobs, and RustFS shutdown
waiting after startup had consumed the child's exit result. Startup now refuses
views in place of required SQLite tables, closes failed initialization handles,
and propagates default-workflow persistence errors. Failed notification
acknowledgements report storage errors rather than false success. Only the person
can clear notifications, one at a time or all at once. A clear removes exactly the
notifications that were shown, so one arriving mid-click survives. It skips any
already cleared in another window and records a single history group. A storage
failure leaves every notification in place.
CLI connections now validate an exact loopback URL/port and require a token;
truncated upload responses propagate errors rather than appearing successful.
Malformed release-asset requests are refused without panicking. Health reports
the actual runtime OS, not an optional build-environment variable.

## Distribution and preview evidence

Local release archives target macOS arm64 and Linux arm64/amd64. Each contains
one executable embedding the frontend and exactly its platform RustFS, along
with operational documentation and preserved dependency notices. See
[BUILDING.md](BUILDING.md), [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md),
and `licenses/DEPENDENCIES.json`. Checksums identify the locally built bytes;
they are not signatures or notarization.

The local **0.1.0** build produced three archives in `dist/0.1.0/` plus
`checksums.txt`. Local `docs/verification/release-check.json` identifies
the exact checked archive bytes. All three passed checksum, normalized-entry,
architecture, notice-presence, and target-specific embedded RustFS hash checks.
The explicit public-document manifest excludes ignored local design/research
notes. The JSON records archive entry and dependency-notice counts for the
exact checked bytes; those counts are not release invariants.

The macOS arm64 archive passed a native disposable-workspace smoke test:
packaged version and runtime health, real RustFS readiness, CLI persistence,
byte-identical image readback, backup creation, embedded frontend, zero model
runs, and clean shutdown. These checks do not install or replace a user's app.

The Linux arm64 archive passed **14 runtime checks** using an existing arm64
image in the local Colima VM. The checker runs as a nonroot user, overrides the
image's application entrypoint, has no network or published ports, receives only
read-only staged package/fixture inputs, and writes to disposable tmpfs. Evidence
in local `docs/verification/linux-package-check.json` records the
archive SHA-256, immutable image ID, architecture, and kernel. It covers real
RustFS, private listener security, embedded frontend, CLI idempotency, image
bytes, complete backup/restore, three concurrent accepted Pi fixture prompts,
one pending trigger per job, actual cron scheduling, retained sessions/records
after restart, no replay of finished work, and clean shutdown. No real model
prompts or host credentials are involved. This establishes native-arm64
container execution, **not physical Linux hardware or Linux amd64 acceptance**.

The two existing preview services were previously refreshed to the earlier packaged executable
only after full backups and process-identity checks. Both retained **10 tasks,
zero jobs, and ready RustFS**, with unchanged task, column, project, tag,
attachment, job, and run records. The previous executable is retained at
`.cache/sift.before-0.1.0`.
See local `docs/verification/preview-refresh.json`. The existing
frontend tab was then reauthenticated using the service's HttpOnly cookie;
health, snapshot, and a live SSE tick returned **200**, Today remained visible,
and the bearer token was not exposed to JavaScript. See
local `docs/verification/preview-session-recovery.json`.
The main preview has now also been refreshed to the latest UI executable after
a new verified backup and process/no-active-run checks; all **10 task records,
zero jobs/runs**, and related entity records were preserved. The original
recovery executable was not replaced. See
local `docs/verification/preview-workspace-ui-refresh.json`.

These JSON/HTML/raw profiles are local verification artifacts; the local
archives bundle the operational Markdown documentation, not the full browser
evidence or test harness. Reproduction commands are in [BUILDING.md](BUILDING.md).

## Security and release tooling

The latest complete local security check passed **1,030 OpenGrep rules over 166
source files**, with **zero unresolved security/CWE findings**, **102 exact-source
reviewed matches**, and **390 retained non-security suggestions**. Reviews have
call-site-specific reasons and expire on **2027-02-01**; a changed source or stale
review fails the gate. No blanket exclusions or inline suppressions were added.
Trivy passed with zero unresolved vulnerabilities at **every severity**, including
development dependencies. Its OpenPGP not-affected decision is conditional on
proving the vulnerable package absent on all three compiled release targets.
Raw and summary reports remain in `.cache/security` and are CI artifacts.

The retained-source checkout was separately tested with all ignored QA scripts
and local reviews absent: **232 required files**, **44 passing tooling tests**,
**154 scanned sources**, **87 exact reviewed matches**, **383 retained
non-security suggestions**, zero unresolved/stale reviews, and passing all-severity
Trivy/all-target OpenPGP checks. Ignored QA-script dispositions now live in
`scripts/security-reviews.local.json`, not the shipped inventory. Local reviews
must also be exact/unexpired/live and cannot override shipped dispositions;
this prevents clean checkouts from failing on absent QA helpers without weakening
stale-review checks. See
local `docs/verification/clean-source-security.json`.

The hermetic Python suite passes **59 tests** covering installer safety/versioning,
loopback credentials, release guards/draft-upload verification, scanner failure
handling, exact/unexpired/stale reviews, scan completeness, dependency-report
completeness, and all-target OpenPGP presence checks. Scanner wrappers preserve a
previous report separately and require newly produced evidence. The latest
release regression proves freshly indexed notices ship while stale local files
are preserved but excluded; deterministic archive bytes and invalid notice paths
are also checked. All three workflow
files pass actionlint; Go vet and Python parsing pass locally. Workflow definitions
and mocked publication tests are not proof of a real GitHub run or remote install.

CI invokes the owner-selected backend **95% statement gate** and 95%
frontend gates. A below-target backend profile fails CI/release after preserving
its evidence. Tooling tests verify the exact 95% boundary, refusal just below it
even when display rounding reads 95.00%, the optional stricter 100% gate, empty
profile refusal, and report-only mode without an implied gate pass.

## Verification scope

The following checks are separate from the completed local verification above:

- Backend coverage is measured at 98.52%; the selected CI threshold is 95%.
- Official media-kit artwork and brand-owner trademark approval are not supplied
  or claimed. At the owner's direction, the app now uses MIT-licensed Tabler
  representations instead, including `brand-slack` and `brand-gmail`, with
  third-party notices and no integration/endorsement claims. This completes the
  revised icon-library implementation, not a legal trademark-clearance gate.
  Local provenance is recorded in `docs/verification/brand-artwork-review.md`.
- Physical Linux arm64 hardware acceptance and Linux amd64 runtime acceptance.
  The isolated Linux arm64 VM/container check above has passed.
- Actual Safari and Firefox acceptance; Chromium is the tested browser.
- Successful update from a published `akstspace/sift` release. Local fixtures
  exercise validation/replacement, but no remote release is published here.
- macOS distribution signing/notarization.
- Successful GitHub Actions verification and protected binary release publication.
  A source push or `v0.1.0` source tag does not satisfy these gates.

The owner selected **MIT** for original code; `LICENSE` is present and required
in packages/installer input. Third-party notices remain separately required.
This license choice is complete, not an unresolved owner decision.

The user retains control over publication. Installing an app/Dock shortcut,
starting a service, installing a CLI/skill, enabling login startup, updating Pi,
and enabling a potentially billable job are separate explicit actions.
