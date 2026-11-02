# Contributing to Sift

Sift is an early local-first workspace for people and their local agents. Small,
focused fixes with tests are welcome. Open an issue before a large feature or
architecture change. For vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Development and tests

See [`docs/BUILDING.md`](../docs/BUILDING.md) for prerequisites, pinned dependencies,
RustFS preparation, frontend builds, and complete verification commands. Build
the frontend before running Go builds/tests; it replaces the embedded directory.
Do not run an npm install/build concurrently with frontend coverage.

Frontend statement, branch, function, and line thresholds are 100%. Backend
statement coverage also has a strict 100% gate. Do not reduce thresholds or exclude application code to make
CI pass. A passing focused test is not a replacement for complete integration
and race testing. Record verification results accurately.

## Safety and review

- Use disposable, clearly labeled test workspaces. Never commit private tasks,
  prompts, credentials, sessions, screenshots, backups, or generated reports.
- Do not run real model jobs without separate explicit authorization; use the
  deterministic Pi fixtures for tests. Do not auto-approve tools or add fallbacks.
- Preserve loopback authentication, revision checks, undo/history, local-only
  images, accessibility, offline icons, and reduced-motion behavior.
- Keep source/dependency licenses and notices. Regenerate required package notices
  using the retained tooling; ignored generated output still belongs in packages.
- Keep PRs focused and explain tests, user-visible behavior, and remaining risks.

The original project code is MIT licensed. Contributions must be yours to share
under that license; third-party code/assets need their own appropriate notices.
