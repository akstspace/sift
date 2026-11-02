# Local security boundary

Sift is a single-user local application, not an Internet-facing multi-user
service. It binds to `127.0.0.1` only; exact Host/Origin checks and cross-site
request rejection protect the listener from ordinary browser cross-origin and
DNS-rebinding requests. Mutations require authentication and `X-Sift-Request`.
Browser auth is an HttpOnly SameSite=Strict cookie; CLI auth is a private bearer
token in `connection.json`. Tokens are not placed in URLs or bundled JS.

The service sets CSP, no-sniff, frame-denial, and no-referrer headers. Private
API responses are no-store. The service worker does not cache task data,
attachments, or workspace HTML; its offline page explains how to start Sift.
Markdown does not enable raw HTML and remote image imports are disallowed.
Uploads validate decoded image type/dimensions/size; SVG and arbitrary files
are rejected. RustFS is private and reached through Sift, not a public bucket.

## What this does not protect against

- Other programs running as your account can read files or use local tokens.
- There is no encryption at rest, user-account separation, or cloud sync.
- Pi runs with your local permissions, extensions, and provider configuration.
  An authorized job can execute tools or send prompt context to a configured
  provider. Enabling image inclusion explicitly allows attached images too.
- Backups contain sensitive job memory and tool output. Pi login credentials
  are excluded, but credentials accidentally written into a prompt/log may be
  included. Review and protect backups before sharing.
- Update SHA-256 protects integrity relative to the published checksum file,
  not against compromise of the upstream GitHub release account.

Do not reverse-proxy Sift, bind RustFS to external interfaces, share the data
directory across machines, or treat the actor label as cryptographic identity.
Keep OS permissions and full-disk encryption appropriate to your data.

## Automated release checks

`python3 scripts/security-check.py all` runs project-local checksum-pinned
OpenGrep and Trivy. OpenGrep enumerates application, test, tooling and workflow
sources independently, including the Python embedded in the installer; skipped
sources, parser errors and stale reviews fail closed. All security/CWE findings
gate the build. Style/translation/portability suggestions remain in raw reports
but are not represented as vulnerabilities.

`scripts/security-reviews.json` records each justified non-vulnerability by exact
path, rule and source SHA-256, with its rationale and review expiry. There are no
blanket rule exclusions or inline suppressions. Directory 0700 (owner traversal),
intentional local argv-based process launches, HTTP-only loopback cookies and
typed image/SSE responses are reviewed in their actual call-site context.
Ignored local QA helpers keep their dispositions in the also-ignored
`scripts/security-reviews.local.json`, when present. That inventory has the same
exact-source, expiry, and stale-entry checks and cannot override a shipped review.
A clean checkout therefore requires no ignored QA files or local dispositions.

Trivy includes npm development dependencies and every severity. Its OpenPGP
GO-2026-5932 module-level finding is represented with OpenVEX only after verifying
the vulnerable package is absent from compiled dependencies on all three release
targets; adding that package invalidates the decision. Reports are retained under
`.cache/security` and uploaded by CI.

Installer and application updates restrict every redirect before following it to
approved GitHub HTTPS delivery hosts, disallow credentials/nonstandard ports,
and verify the official release SHA-256 before execution or installation. Local
Python acceptance/demo/package tools validate exact 127.0.0.1 connections and
refuse redirects so connection credentials cannot be forwarded off-loopback.

## Reports

Include Sift/OS/Pi versions, a minimal reproduction, sanitized error text, and
whether the issue affects UI, CLI, storage, or jobs. Exclude `connection.json`,
RustFS credentials, Pi auth files, prompts, sessions, and private task data.
No report or repository publication is sent automatically.
