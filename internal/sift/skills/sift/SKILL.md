---
name: sift
description: Manage the user's local Sift tasks, subtasks, daily work, observations, projects, tags, images, icons, duplicates, and scheduled Pi jobs using the sift CLI. Use when the user asks to add, inspect, organize, complete, or update their Sift work, or when reporting actionable observations from your own context.
metadata:
  version: 0.1.0
---

# Sift local task workspace

Use the installed `sift` executable from any working directory. Start with `sift help` and `sift schema`. Commands return structured JSON. If the local service is stopped, report the error and the suggested `sift serve` command; never pretend a queued or failed mutation succeeded.

## Safe task workflow

1. `sift tasks list` or `sift tasks search "query"` to inspect current work.
2. `sift tasks duplicates --title "Proposed task"` before creating a task. Inspect IDs, statuses, and match reasons. Similarity is a suggestion, not authorization to merge.
3. `sift columns list`, `sift projects list`, `sift tags list`, and `sift icons search "gmail"` discover stable IDs. Do not create or change columns; only the human can do that in the UI. Icons come from the catalog, not custom uploads.
4. `sift tasks add --title "..." --today --actor "your-agent-name" --source-key "stable-source-id" --request-id "unique-operation-id"` creates work. Stable source keys identify the same observation; if one exists, read and update it instead of creating another. Reuse a request ID only for a retry with identical content.
5. Before editing, `sift tasks get TASK_ID`. Use `--revision N` with the latest revision. On conflict, re-read and reconsider; never blindly overwrite human work.
6. `sift tasks update TASK_ID --revision N --status done --reason "What was addressed and why" --actor "your-agent-name"`. Completion/reopening and reversing a user's decision require reasons. Evidence is optional, but attach useful file/commit/URL references in the description. Do not claim verification you did not perform.
7. Create one-level subtasks with `--parent TASK_ID`. They are full tasks. Parent completion is blocked by unfinished children. Reopening a child reopens its completed parent. `sift tasks tree` exposes hierarchy. Checklist items are separate lightweight steps.
8. `sift tasks merge SOURCE --into SURVIVOR --revision N --target-revision M --reason "..."` is explicit and reversible; inspect both revisions and histories first. Never merge just because a detector suggests it.

## Images and icons

`sift images upload /absolute/path/image.png` uploads PNG/JPEG/WebP/GIF up to 20 MB into private local RustFS and returns an attachment ID/URL. Add its ID through `--attachment ID`; embed the returned relative image URL in Markdown when useful. No remote image imports or active SVG uploads. `sift icons search QUERY` searches the complete offline Tabler catalog, ranked by names, IDs, aliases, and categories with typo/transposition tolerance. For example, `sift icons search gmial` finds `brand-gmail`, and `sift icons search slcak` finds `brand-slack`. Assign returned IDs with `--icon ID`; outline IDs use Tabler's native names, filled variants append `-filled`. Never fabricate an icon ID. Brand marks identify services, not an integration or endorsement.

## Jobs

`sift jobs list`, `sift jobs run ID`, `sift runs list`, `sift runs get ID`, `sift models list`, and `sift jobs reset ID` manage existing scheduled work. Creating/editing a job uses `sift jobs add --file job.json` / `sift jobs update ID --file job.json`; read the schema first. Models and thinking levels come from local Pi RPC, not a hard-coded provider list. No automatic model fallback, external integration setup, or global Pi updates without explicit user instruction.

Use `sift history TASK_ID` to inspect attribution and `sift undo EVENT_ID` only after checking no newer work would be overwritten. Don't access Sift's private database, credentials, object files, or another agent's configuration directly.
