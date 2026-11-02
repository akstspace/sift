# Operations

## Data and processes

Sift owns one local data directory and one loopback listener. An advisory lock
prevents two services opening the same workspace. The printed URL is the source
of truth; `connection.json` contains the private CLI token and process ID.
Never paste that file into reports. The default is `~/Library/Application Support/Sift`
on macOS and `$XDG_CONFIG_HOME/Sift` (normally `~/.config/Sift`) on Linux.
`SIFT_DATA` overrides the default; `--data` takes precedence over both.

SQLite stores records, revisions, history, idempotency keys, and run evidence.
RustFS is extracted into the workspace as needed and runs as a managed child
on loopback with private generated credentials. Image-store failure is reported
separately; it must not be presented as a healthy image service.
The executable embeds only the target-specific RustFS payload and built UI.
Shutdown cancels jobs, waits for workers, and closes storage/database.

CLI clients must use the same data directory. The service does not silently
autostart when a CLI command cannot connect. `sift help` documents commands;
`sift schema` provides live fields/rules. Agent attribution is not proof of
identity: local programs with the token can submit attributed changes.

## Scheduler and Pi

The local Pi executable is discovered through `SIFT_PI` or PATH. Sift does not
replace Pi auth or extensions. Model/thinking choices are discovered by RPC.
Choosing Pi's configured default delegates selection to that configuration;
choosing an explicit model never authorizes a silent fallback.

- Maximum concurrent jobs defaults to 3. The same job never overlaps itself.
- At most one trigger waits while a job is active. Repeated triggers coalesce.
- Default timeout is 30 minutes; cancellation is scoped to the exact active run.
- A missed schedule creates at most one catch-up, not a replay of every slot.
- After a crash, running/queued runs are marked interrupted. Inspect effects
  before explicitly rerunning. Interrupted work is not immediately replayed.
- Authentication/model/approval problems pause the affected job for action.
- Each job resumes only its own exact Pi session. Prompt/model edits keep memory.
  Reset memory starts a new session; it does not undo earlier task/tool effects.
- No automatic whole-job retries, auto-approval, model fallback, or Pi updates.

Daily and selected-weekday schedules use HH:MM. Intervals accept durations
such as `30m` or `2h` (minimum one minute). Cron has five fields, minute through
weekday. All wall-clock schedules require an IANA timezone. A repeated local
minute during the autumn DST transition fires once; a missing spring minute
maps to the next valid local instant. Intervals use elapsed durations.

## Updates and installation

An update check reads only the stable release endpoint for `akstspace/sift`
over GitHub HTTPS. Applying is explicit, verifies the platform archive's SHA-256,
checks the executable version, creates a backup under maintenance lock, and
atomically replaces the executable. Restart is required. A missing repository,
release, asset, checksum, or failed validation is an actionable error, not success.
No remote update success is claimed until a real release exists and is tested.

Settings' setup actions are opt-in. CLI installation makes a symlink in
`~/.local/bin` and refuses an existing unrelated file. Skill installation writes
only `~/.agents/skills/sift/SKILL.md`, asking before replacing different content.
Settings' Startup action writes a macOS LaunchAgent or Linux user-systemd unit;
it does not edit shell profiles. The download installer now configures a per-user
login service and starts it immediately at `127.0.0.1:57431`. It uses the managed
CLI link, an explicit workspace and address, and preserves the executable search
path for local Pi discovery without copying authentication secrets. A running
matching service is not restarted during installation; a newly installed version
takes effect after a deliberate restart.

`--no-startup` skips registration and startup without disabling any existing
service. `--workspace-dir` selects a task workspace, otherwise `SIFT_DATA` or the
platform default is used. Installer `--data-dir` remains package storage, not
the task workspace. `--no-modify-path` independently opts out of shell PATH setup.
Linux requires a systemd user session; no system-wide unit, sudo, or lingering is
configured. Startup failures warn without undoing a checksum-verified installation.
Conflicting ports and different existing units are never replaced automatically.

On macOS, service output is in the install directory's `service.log`. Inspect
`launchctl print gui/$(id -u)/space.akst.sift`; stop with
`launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/space.akst.sift.plist"`.
For a deliberate restart, use `launchctl kickstart -k gui/$(id -u)/space.akst.sift`.
On Linux use `systemctl --user status sift.service`, `journalctl --user -u sift.service`,
and `systemctl --user stop` or `restart sift.service`. To disable future logins,
use `launchctl disable gui/$(id -u)/space.akst.sift` on macOS or
`systemctl --user disable --now sift.service` on Linux.

RustFS runs with a relative `objects` volume inside the unchanged workspace.
This avoids RustFS 1.0.4 splitting whitespace in paths such as macOS's
`Application Support`. Startup failures are reported in health and onboarding;
inspect the workspace's `rustfs.log` before restarting. Task data does not need
to be moved or reset.

## Development workspaces

Development uses `http://127.0.0.1:57432`, separate from the installed app's
default port 57431. `make dev` uses the isolated `.sift-dev` workspace. The optional
Vite UI uses port 57433 and proxies API calls to 57432 by default; `SIFT_PORT` and
`SIFT_DEV_PORT` override the backend and frontend ports respectively. Existing
QA workspaces may already occupy 57432; stop the intended service explicitly
before starting another, without changing or reusing its data directory.
Do not use QA scripts against a personal workspace. Vite preserves exact-origin
and loopback restrictions and forwards the backend HttpOnly cookie; bearer
tokens are not embedded in the frontend. Visit the backend URL first to obtain
the local browser cookie. Frontend source hot-reloads; compiled service assets
change only after a deliberate build and restart.

Demo content is explicitly labeled **Sift demo**, tagged **Demo · removable**,
and attributed to `sift-demo`. To remove only its manifest-listed records into
recoverable Trash:

```sh
python3 scripts/demo-data.py --workspace .cache/preview-workspace --remove
```
