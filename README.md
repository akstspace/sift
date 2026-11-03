<img src="web/public/sift.svg" alt="Sift logo" width="80" height="80">

# Sift

A private, local-first task workspace for a person and their local agents.
One executable serves the interface, CLI, scheduler, SQLite records, and a
bundled, platform-specific RustFS image store. Sift uses your existing Pi
installation; it does not install Pi or change its authentication/extensions.

## Install

Install the latest stable release with one command:

```sh
curl -fsSL https://raw.githubusercontent.com/akstspace/sift/main/scripts/install.sh | sh
```

**Recommended:** [Inspect the installer](https://github.com/akstspace/sift/blob/main/scripts/install.sh)
before running it, as with any script downloaded from the internet.

The installer starts Sift automatically and configures it to start at login.
Open **http://127.0.0.1:57431**. Development stays separate on port `57432`.
To install without starting or registering a service, pass `--no-startup`:

```sh
curl -fsSL https://raw.githubusercontent.com/akstspace/sift/main/scripts/install.sh | sh -s -- --no-startup
```

The installer needs Python 3, downloads only official GitHub HTTPS release assets,
checks SHA-256 before extraction, and retains documentation and dependency notices.
It supports macOS arm64 and Linux arm64/amd64. The installed app does **not** need
Python, Node, npm, or a separate RustFS installation. Manual archive extraction is
also supported; verify `checksums.txt` and keep the accompanying `licenses/` folder.

Optional installer arguments:

```sh
# Install a specific version:
curl -fsSL https://raw.githubusercontent.com/akstspace/sift/main/scripts/install.sh | sh -s -- --version 0.1.1
# Install the latest stable release, replacing only an installer-managed CLI link:
curl -fsSL https://raw.githubusercontent.com/akstspace/sift/main/scripts/install.sh | sh -s -- --replace
```

Defaults: executable link `~/.local/bin/sift`, versioned packages
`~/.local/share/sift/versions/VERSION/`. `--bin-dir` and `--data-dir` customize
those **installation** paths; the latter is not your task workspace directory.
Existing version directories, regular files, and unrelated links are not overwritten.
Older version files are retained for manual recovery. Automatic startup uses a
per-user macOS LaunchAgent or Linux systemd unit, with no sudo. Linux needs a
running systemd user session; unsupported sessions or port conflicts produce a
warning and manual start instructions, without stopping another process or
silently changing ports. Existing different startup files are never overwritten.
No app/Dock shortcut or agent skill is installed, and no Pi configuration is changed.
Use `--workspace-dir DIRECTORY` to select the service's task workspace; otherwise
it uses `SIFT_DATA` or the platform's normal Sift directory. This is separate from
the installer's `--data-dir` package storage.
The installer adds the bin directory to your shell configuration for new terminals
(zsh, bash, fish, or POSIX sh). Existing content is preserved and repeated installs
do not add duplicate entries. Open a new terminal afterward, or use the command
printed by the installer in your current shell. Pass `--no-modify-path` to leave
shell configuration untouched. Unsupported or unsafe profile files produce a
warning without undoing a successful installation.

Checksums protect integrity relative to the release account, not against compromise
of that account.

## Run locally

Unpack the archive for your computer, then run the executable in a terminal:

```sh
./sift serve
```

Open the loopback URL printed by the service (normally
`http://127.0.0.1:57431`). Keep the service running. Stop it with Control-C;
tasks persist on disk. A port conflict is an error, not a silent port change.

```sh
./sift serve --data /absolute/path/to/workspace --port 57431
./sift help
./sift --data /absolute/path/to/workspace tasks list
```

`--port` overrides `SIFT_PORT`; `--port 0` chooses an available port.
`--address 127.0.0.1:PORT` is an alternative, not an additional flag.
The service never binds to the LAN. Do not expose it through a reverse proxy.

The default data directory is platform-specific (see [operations](docs/OPERATIONS.md)).
Use the same `--data` directory for CLI commands and the running service.

## Your work

- Today is a focused selection over **All tasks**, not a daily reset. Set or clear a due date in task details using the calendar or YYYY-MM-DD entry; deadlines also work through `--due-date` in the CLI.
- Done tasks automatically move to **Archive** seven days after completion by default. Settings → Recovery & retention lets you change the delay (0 disables it). Archived tasks, attachments, and history are kept indefinitely; open one and choose **Reopen task** to return it to All tasks. Edits do not reset completion time. Reopening an archived subtask also reopens its completed parent.
- Board and virtualized list views share search and priority, tag, project,
  and status filters. Task details overlay the board without resizing it.
- Tasks support priorities, due dates, snooze, Markdown, local images,
  checklists, projects, tags, attribution, history, and guarded undo.
- Subtasks have the same features as tasks, with exactly one nesting level.
  Unfinished children block completion; reopening a child reopens its parent.
- Open, In progress, and Done are the default columns. Done is the single
  completion status. Only the person manages columns in Settings.
- Duplicate matches are suggestions. Stable source keys and request IDs
  prevent repeated observations; merging is explicit and reversible.
- Images are PNG, JPEG, WebP, or GIF, up to 20 MB. No remote imports or SVG
  uploads. Sending images to a model requires a separate per-job opt-in.
- All interface icons use Tabler. The offline catalog includes all 6,257 Tabler
  3.50.0 outline/filled icons, including Slack and Gmail. The picker and
  `sift icons search` share ranked, typo-tolerant name/keyword/category search.
  Brand icons identify services, not an integration or endorsement. No custom uploads.

## Local agents and scheduled jobs

Start with `sift schema`, `sift columns list`, and `sift tasks get TASK_ID`.
Updates require the current revision; conflicts must be reviewed, not blindly
retried. Use a meaningful `--actor` and reasons for completion/reopening.

```sh
./sift tasks duplicates --title "Review the release notes"
./sift tasks add --title "Review the release notes" --today \
  --actor release-review --source-key release-notes --request-id review-001
./sift icons search email
./sift models list
```

Settings can explicitly install the shared `sift` skill, CLI symlink, or login
startup configuration when using a manually unpacked build. These actions do not
edit shell profiles or unrelated agent configurations. The download installer
already sets up the CLI, PATH, and login startup unless opted out.

**Ask Sift** (Cmd/Ctrl+J) opens a chat. Sift uses your local Pi to read and
change your tasks and to use your usual tools. Changes it makes in Sift appear
as cards you can open; other tools keep Pi's usual view, and Run history shows
scheduled jobs the same way. The chat keeps one conversation; `/new` starts over
without the earlier context. See
[operations](docs/OPERATIONS.md#ask-sift-chat).

Each scheduled Pi job has its own exact persistent session, discovered models
and thinking levels, IANA timezone, and one or more daily/weekday/interval/cron
schedules; it runs at whichever comes next. Deleting a job (from its editor)
removes its memory but keeps its runs in Run history.
Defaults are three concurrent jobs, no same-job overlap, one pending trigger,
a 30-minute timeout, and at most one missed-run catch-up. No automatic whole-job
retry, model fallback, approval, or Pi update. A job can incur model charges
and act with the permissions of your local Pi setup; review its prompt first.
See [operations](docs/OPERATIONS.md) for failure and daylight-saving behavior.

## Backups, privacy, and recovery

Create/download full backups and restore them in Settings. Restore makes a
safety backup and pauses jobs for review. Backups include task history, images,
run logs, and job memory, but exclude Pi login credentials. They may contain
sensitive prompts or tool output: store them privately.

Daily backups retain 14 by default; Trash and verbose logs retain 30 days.
See [recovery](docs/RECOVERY.md) and [security](docs/SECURITY.md). Local-first
does not mean encrypted at rest or isolated from other programs on your account.

## Install as a web app (optional)

Chrome/Edge: use the browser's Install app action when available. On macOS
Safari, open Sift and choose **File → Add to Dock** on supported Safari/macOS
versions. Installation is optional and may be unavailable in some browsers.
**Installing the web app does not install or start the Sift service.**

## Build and verification

See [building/releasing](docs/BUILDING.md), [acceptance record](docs/ACCEPTANCE.md),
and [third-party notices](THIRD_PARTY_NOTICES.md). Development uses Go 1.27,
Node/npm, and Python 3; the packaged app does not require Node/npm/Python.
Supported package targets are macOS arm64 and Linux arm64/amd64. Cross-building
is not proof of runtime acceptance on a platform. A public source repository and
source tag do not imply that local binary artifacts passed every release gate.

GitHub checks include 95% frontend and backend statement coverage gates, the complete Go race/integration
suite, native package smoke checks, checksum-pinned OpenGrep and Trivy, and workflow
linting. See [CI, security, and release operation](docs/BUILDING.md#github-ci-and-release).
Only an explicitly dispatched release workflow bumps the version and publishes
verified binary packages. Measured results are recorded in
[ACCEPTANCE.md](docs/ACCEPTANCE.md).

## License and attribution

Keep [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and packaged `licenses/` with redistributed
packages. A README attribution link alone does not replace dependency license or
NOTICE text that must accompany distribution. The consolidated notices contain the
full dependency license texts; the generated `licenses/` tree is not committed.
These notices do not have to appear
inside the application UI. Sift's original code is [MIT licensed](LICENSE), as
selected by its owner; third-party components retain their own licenses.
Dependency attribution is not blanket legal clearance.
