# Reporting a security issue

Please report a suspected vulnerability through GitHub's private vulnerability
reporting for this repository, rather than opening a public issue:

<https://github.com/akstspace/sift/security/advisories/new>

Include the Sift version or commit, OS/architecture, a minimal reproduction,
expected/actual behavior, and sanitized error text. Never attach workspace
databases, backups, `connection.json`, Pi authentication, prompts, session files,
or private task data. Do not publish an exploit or credentials in a public issue.

Sift is an early source project. There is no supported stable binary release yet
and no response-time or security-support SLA. Verification results are recorded
in `docs/ACCEPTANCE.md`.

For the local trust boundary and verification approach, see
[`docs/SECURITY.md`](../docs/SECURITY.md).
