# Backup and recovery

## Routine backup

Use Settings → Backups → Create backup, or `sift backup` against the running
workspace. Download/export a copy from Settings to a separate protected disk.
Automatic daily backups retain 14 by default. They are local copies, not an
off-machine disaster-recovery service. Trash and verbose logs retain 30 days
by default. Task attribution/history and run summaries are retained; attachment
bytes referenced by history are retained so undo does not silently lose images.

Backups use integrity-indexed format 2. They coordinate database records,
history, idempotency keys, run logs, all referenced images, and exact job Pi
sessions. Pi login/auth files and the service connection token are not exported.
Backups reject incomplete legacy format 1. Archive compressed/expanded limits
are 800 MB and individual session files are limited to 64 MB. If your workspace
exceeds those bounds, do not assume a partial backup is usable.

An export that reports a write, rename, or durability error has **not** completed,
even if a file is present. Sift normally removes its `.partial` file on failure;
filesystem permission problems can also prevent that cleanup. Preserve failed
export evidence, fix the reported filesystem problem, and explicitly create a
new backup. Do not rename a `.partial` file to make it appear complete. A failed
export must not advance the recorded last-successful-backup time.

## Restore

1. Keep the original backup and workspace; do not manually replace SQLite or
   object files while the service is running.
2. Open Settings, select the backup, and confirm replacement.
3. Sift enters maintenance, creates a current-state safety backup, validates
   paths, sizes, integrity, and data relationships, then stages the replacement.
4. A restore journal supports recovery if interrupted. On startup Sift finishes
   or rolls back the journal before normal scheduling.
5. Jobs are paused after restore. Review task state, run evidence, provider
   access, and remembered sessions before explicitly enabling or rerunning jobs.
6. Connected interfaces receive an SSE reset and reload workspace state.

An unsuccessful integrity check must leave the current workspace intact.
Keep the safety backup until you have inspected tasks, history, images, logs,
and job memory. Restore is not a selective merge and can replace newer work.

## If Sift will not start

- **Port in use:** stop the intended existing instance or choose `--port N`.
  Sift never silently picks a different port except explicit `--port 0`.
- **Workspace locked:** check whether the owning service is still running.
  Never run a second process over the same live SQLite/object directory.
- **Image storage unavailable:** inspect the displayed storage error and disk
  availability. Task records can remain available while images need attention.
- **Newer schema:** use a matching/newer executable. Sift refuses to open a
  newer schema rather than trying a destructive downgrade.
- **Interrupted agent run:** inspect actual side effects and evidence before
  Run now. A crash is not evidence that no task/tool changes occurred.

For a forensic copy, stop Sift gracefully and copy the **entire** data directory
to a protected destination. Preserve the original until recovery is verified.
Do not copy only the SQLite file from a running WAL database. No manual file
deletion, token replacement, or database repair is performed automatically.
