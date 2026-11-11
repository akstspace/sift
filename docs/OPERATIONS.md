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

## CLI progress and following runs

Commands keep their final JSON on stdout. `--progress auto|always|never` controls
append-only progress on stderr: `auto` (the default) enables it only when stderr
is a terminal, `always` also works in captured logs, and `never` disables it.
`--quiet` suppresses progress regardless of the mode; results and errors remain.
Backups, update checks/downloads/installation, model discovery, and image uploads
report real stages, image counts, or transferred bytes when available. Upload
counts describe the multipart request, not proof that an image has been saved.
Elapsed waiting continues while an operation is busy; no percentage or ETA is
invented. Discovery does not execute an AI task.

```sh
sift backup --progress=always > backup.json
sift runs watch RUN_ID --progress=always > run.json
sift jobs run JOB_ID --wait --progress=always > run.json
```

`runs watch` is read-only. `jobs run --wait` submits once, then follows the exact
returned run. Status changes and new transcript entries appear on stderr; the
final run record goes to stdout. Activity is read in cursor-based pages of up to
500 entries, without the transcript endpoint's 20,000-entry cap or duplicate
printing between polls. Individual requests are bounded, but following is not
limited to a short request timeout. Unsuccessful terminal states (including
action-needed and interrupted) return the final JSON and a nonzero exit status.
Ctrl+C stops following, not the run. To stop the job deliberately, use
`sift runs cancel RUN_ID`. You can resume following with `runs watch`.

Progress-enabled operations negotiate `application/x-ndjson` on the same
authenticated request, with progress frames and one final result/error frame.
Ordinary UI/API clients and older services retain JSON responses. Broken or
unknown streams are errors, never permission to replay a mutation. Cancellation
is propagated to long operations, but effects already committed are not undone.
After a lost submission response or failed stream/output, inspect history or
backups before an explicit retry. There are no automatic whole-operation retries.

## Projects navigation

The sidebar has one **Projects** destination, not individual project shortcuts.
Open it to create or manage projects, or select a project to open its scoped
Kanban board; the project's name carries into the board heading. **All
projects** returns to the project list. Projects are listed by name. Archived
projects remain available through **Show archived**; archiving a project does
not delete or unassign its tasks.

Tags are labels and filters, not a destination. Add a tag from any task's Tags
field (typing an existing name reuses that tag), filter any board by tag from
**Filters**, and rename, merge, or archive tags under **Settings → Tags**.
Agents keep using `sift tags ...` and `--tag` as before.

Project selection clears task search and filters and starts in Board view,
even when All tasks uses List view. Switching a project to List is
local to that visit and does not change the saved workspace preference. New
tasks on a project board start assigned to that project.

## Due dates and completed-task archive

All tasks replaces the Backlog label. Due dates are optional civil dates in
YYYY-MM-DD format, editable in task details with the calendar or date entry,
and through `sift tasks add/update --due-date YYYY-MM-DD` (use `--due-date=`
to clear one). Overdue and due-today filters use the workspace timezone.

Maintenance runs at startup and every minute, including with the browser closed.
By default a Done task moves to Archive after seven elapsed 24-hour days from
completion. Change **Archive completed tasks after (days)** in Settings; 0
disables it. Completion timestamps are server-owned: edits do not reset them,
and reopening/recompleting starts a fresh clock. Older tasks use their last
recorded edit as a conservative baseline; missing preferences default to 7.

Archive is separate from Trash. Archived records, attachments and history are
kept indefinitely and included in backups. Open an archived task and choose
**Reopen task** to return it to All tasks, clearing any old snooze. Reopening a child also reopens its
completed parent, with linked undo history. A completed parent waits until its
remaining visible children are eligible before archiving. Archive changes are
revision-checked and undoable; undoing only the archive leaves the original
completion time, so an eligible Done task can archive again on maintenance.

## Comments, completion reasons, and transcripts

Open a saved task and use **Add a comment** in Activity, then **Post comment**
(or Cmd/Ctrl+Enter in the comment field). Comments are plain text, limited to
10,000 characters, and retain their author and time in task history and backups.
Posting is independent of task edits: it does not change the task's revision or
overwrite a draft, and it does not invalidate Undo for a task change. Unposted
comments are protected when navigating away. Restore deleted tasks or open the
survivor of a merge before commenting. Comments are not editable or undoable.

Agents can read the same comments with `sift tasks comments TASK_ID`, and post
with `sift tasks comment TASK_ID --text "Update" --actor "agent-name"
--request-id "unique-operation-id"`. Comment text is returned in the event's
`reason` field, with `actor`, `at`, and `kind: "comment"`. The read command returns
up to 1,000 comments in ascending event-ID order; continue with `--after LAST_ID`
until an empty page. `sift tasks get` and `sift history` also include comment
activity. Posting needs no task revision and never changes one. The schema,
scheduled-job guidance, and shipped skill document this workflow. Comments are
context, not permission for unrelated actions; agent attribution cannot claim
to be `user`.

Activity lists a task's history newest first. Each entry names who acted: *You*,
*Sift* for the chat, a scheduled job by its name, or the agent's own label.
Comments sit in a note under a **Comment** pill and render as Markdown, with
long pasted addresses shortened (the link and its tooltip keep the full
address). Changes show as short pills such as *Moved to Done*, *High priority*,
or *Due 14 Nov*, followed by the reason given. Times read as *Just now*,
*12 min ago*, or *Yesterday, 09:10*; hover for the exact time. On a pointer
device, a change's Undo appears when you hover its entry.

Scheduled jobs and the chat keep task status current. When what Pi finds shows
a task is finished, has started, or is waiting on someone, it moves the task to
the matching column itself with a reason citing the evidence (a link, commit,
message, or run), instead of only commenting. It comments when the evidence is
partial, doesn't reverse a status you set after the evidence it relies on, and
still needs your instruction to merge or delete. Every such change is in
Activity and can be undone.

A task whose status an agent changed carries a small **AI** badge on its card,
list row, or subtask row, until you review it. Its details open with one quiet
line, for example *Morning planning moved this to Done: CI passed at dc2ea74*,
with **Looks good** to clear the badge and, while it is still the latest change,
**Undo**. Any change you make to the task yourself also counts as reviewing it.
Reviewing doesn't create a new task revision, so it never conflicts with an
open draft, and Activity records it as *Reviewed Morning planning's change*.
Only you can review; the task's `agentChange` field (read-only to agents) names
the agent.

Marking a task Done offers an optional **Done reason**: leave it blank to just
complete the task. This applies to board completion buttons, subtasks, list
status menus, drag-and-drop into Done, task-detail status changes, and tasks
created directly in Done. Cancelling leaves the task unchanged; failed saves
retain the reason for correction or retry. A reason is recorded with the
completion in history, and existing task Undo still applies. Agents must still
give a reason (`--reason "What was addressed"`) when they complete or reopen a
task or revise a person's decision.

Run history keeps the run header and controls visible while the transcript
scrolls independently. Focus the transcript and use Page Up/Down or the arrow
keys to scroll. Polling preserves reading position rather than auto-following;
selecting a different run starts at the top.

Scheduled-agent guidance selects icons for the work itself, not the app where
it was discovered. Brand icons are only appropriate for tasks about that service;
uncertain choices should omit the icon or use `circle-check`. This does not
rewrite existing icons or silently replace an installed skill.

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

A job has one to 20 schedules and runs at whichever comes next. Schedules due
in the same minute start one run. Daily and selected-weekday schedules use HH:MM.
Intervals accept durations such as `30m` or `2h` (minimum one minute), counted
from the job's last run or save. Cron has five fields, minute through weekday. All
wall-clock schedules use the job's IANA timezone. A repeated local minute during
the autumn DST transition fires once; a missing spring minute maps to the next
valid local instant. Intervals use elapsed durations.

From the CLI, repeat `--schedule` to set a job's schedules, for example
`sift jobs update ID --revision N --schedule "daily 09:00" --schedule
"weekdays 17:30 mon-fri"`. With only `--schedule` and `--revision`, an update
changes nothing else. Only the person can delete a job, from its editor. Deleting
removes the job and its remembered session; its runs stay in Run history, and a
running job must be cancelled first.

## Ask Sift (chat)

The **Ask Sift** pill at the bottom of the workspace (or Cmd/Ctrl+J), marked with
Sift's one-colour logo, opens a chat. Sift uses your local Pi to read and
change your tasks and to use your usual tools. Escape or the chevron closes it; the panel reopens where you
left it. Pi starts the first time the panel opens, in your home folder, with
your usual Pi tools, extensions, and login, and stops after 15 minutes without a
reply or question. The next message starts it again in the same conversation.

- **One conversation.** The chat keeps a single Pi session in
  `sessions/chat` inside the data directory. `/new` (or the new-chat button)
  starts a fresh session with no earlier context; the old one stays on disk. If
  Pi cannot open the saved session, Sift starts a new one, says so, and keeps
  the old file, so a broken session never blocks the chat.
- **What Pi sees.** Each message carries the page you are on, the open task or
  run, and the search, unless you switch the view chip off for that message.
  Slash commands never carry it. Pi is told to use the Sift CLI as `--actor chat`,
  to check for duplicates before adding, to ask before merging or deleting, and
  to move a task's status itself when it finds clear evidence (see Activity).
- **What you see.** Sift commands appear as cards: the task (opening it on
  click, with its live status, or *In Trash*, *Merged*, *Archived*), what
  changed, the reason given, and the command and output on demand. In task
  Activity, the chat's changes are attributed to *Sift*. Reads stay
  quiet one-line rows. Other tools show as collapsible rows (shell commands,
  reads, edits as diffs, writes), and thinking collapses to *Thought*. Run
  history uses the same view for scheduled jobs.
- **Steering and stopping.** A message sent while Pi works is queued and read
  after the current step; **Stop** cancels the reply and the queue.
- **Questions.** When Pi or an extension asks something (choose, confirm, type),
  the question appears in the conversation; the pill shows *Sift has a question*
  while the panel is closed. Extension notes appear as notifications and their
  status lines under the message box.
- **Model and thinking.** The model menu under the title lists Pi's models and
  thinking levels; *Pi's default* follows your Pi configuration. The choice is
  saved in `chat.json`. If a chosen model disappears from Pi, sending is paused
  with an option to return to Pi's default. Change it between replies.
- **Images.** Paste, drop, or attach up to four PNG, JPEG, WebP, or GIF images
  of up to 5 MB each per message. They are sent to your configured provider.
- **Provider failures.** When the model's provider refuses a reply (an expired
  sign-in, a rate limit, an outage), the chat and Run history say so in plain
  words and what to do; the provider's own response is under **Details**.

Only the person using Sift can use the chat; the CLI token, scheduled jobs, and
the chat's own Pi are refused. While Pi is replying or waiting on a question,
backups, restores, and updates ask you to wait for the reply and try again;
otherwise they stop the idle chat Pi first. The daily backup is deferred until
the chat is idle. The chat conversation is in backups with
job memory. A conversation file over 64 MB, for example after many pasted
images, is left out of backups and noted in the log; `/new` starts a smaller one.

## My activity

**My activity** is a timeline of what you worked on, written by your local Pi
from the tools it can reach on this computer: commits, pull requests and
reviews, messages, meetings, documents, shell history, and Sift itself.

- **Setting it up.** The first visit to My activity (or the optional *Your day*
  step during setup) shows the prompt Pi will follow, prefilled with Sift's
  default. Edit it to add or rule out sources; *Restore default* brings the
  original back. Checks run at 12:30, 17:30 and 22:00 in your Sift timezone by
  default, up to six times a day. *Fill in today so far* makes the first check
  cover today from midnight; otherwise tracking starts now. Change any of this,
  pause it, or turn it off later from the settings button on My activity; you
  can also ask Sift, or use `sift activity tracker`, to change or pause it.
- **What a check covers.** The tracker is one scheduled Pi job, listed on
  Agents and changed from My activity or `sift activity tracker`. Each run
  covers the time since tracking started that no earlier check has covered,
  reaching back at most seven days; stretches under a minute are ignored. Pi
  records work sessions (grouped blocks, not single events) with `sift
  activity add`, links them to your tasks when it is clear, and moves a task's
  status when it finds clear evidence, with a reason. When the run succeeds,
  Sift marks its windows checked. A failed, cancelled or interrupted run marks
  nothing, so the next check covers that time again. *Check now* runs straight
  away.
- **Older days.** Days before tracking began, or more than a week ago, are left
  alone by scheduled checks. Open the day and choose *Check this day* (or
  *Check now* beside an unchecked stretch) to look back, at most a week at a
  time. Time that was already checked is not checked again.
- **Your corrections stay.** You can add sessions, edit them, link or unlink a
  task, or remove them. Checks never change or remove a session you added or
  edited. Agents and Ask Sift change tracking only when you ask, and only you
  can turn it off.
- **In a task.** A task's details show *Worked on*: its total time and latest
  sessions, each opening its day.
- **Privacy.** Pi reads these sources with your computer account's permissions
  and sends what it finds to your model provider, which may incur charges.
  Sessions are stored in Sift on this computer and included in backups. Turning
  tracking off removes the tracker job and keeps what was recorded.

From the CLI: `sift activity list --from DATE --to DATE` (or `--task ID`),
`sift activity add --start TIME --end TIME --title TEXT`, `sift activity update
ID --revision N`, `sift activity delete ID --revision N`, and `sift activity
check`. Times are RFC 3339 or local `YYYY-MM-DDTHH:MM` in your Sift timezone.
`sift activity tracker` shows tracking; with `--prompt TEXT` (or `--prompt-file
PATH`, `--default-prompt`), `--schedule "daily 12:30"` (repeatable), `--model
PROVIDER/MODEL` (or `--default-model`), `--timezone`, `--pause` or `--resume`
it sets tracking up (`--fill-today` covers today so far) or, with `--revision
N`, changes it, keeping whatever you leave out.

## Updates and installation

An update check reads only the stable release endpoint for `akstspace/sift`
over GitHub HTTPS. Applying is explicit, verifies the platform archive's SHA-256,
checks the executable version, creates a backup under maintenance lock, and
atomically replaces the executable. Downloads retry a dropped connection or a
brief GitHub fault twice; a GitHub failure is reported as such (HTTP 502), and
every server-side failure is also written to the service log with its cause.

Opening or reloading the workspace checks for a release when update checks are
on, reusing a result under two minutes old so reloads never repeat the request;
open pages check again every 30 minutes. When a newer stable release is known,
an **Update available** control appears to the left of search. Installing (there, in Settings, or with `sift update`)
requires that no agent is running, and then **restarts Sift automatically**:
it shuts down gracefully (live streams, storage, data lock) and re-executes the
installed binary in place with the same arguments and process ID, so a
LaunchAgent or systemd unit keeps supervising it. No run or maintenance starts
in between. The open page reloads when the new process answers. A Sift started
from a terminal restarts the same way. If Sift cannot restart itself (it is not
serving), the control offers **Restart now** instead. An update already written
over the executable, for example by an older Sift, is recognized on the next
check and only needs the restart; it is not downloaded again. A missing
repository, release, asset, checksum, or failed validation is an actionable
error, not success.
No remote update success is claimed until a real release exists and is tested.
This uses SHA-256 verification over GitHub HTTPS, not an independent signed-release
trust system; it does not protect against compromise of the release account.
The app keeps update guidance focused on user actions and backup/restart
consequences. Connection paths and technical task metadata are available on demand.

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
