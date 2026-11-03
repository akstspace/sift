// Recognizes a Sift CLI call in a bash tool call, so a transcript can show
// what changed in the workspace instead of a command and a page of JSON.
// Only one plain invocation is recognized: anything piped, chained, or
// redirected stays an ordinary command, exactly as Pi ran it.
import type { Column, Entity, Task } from "../types";

export interface SiftCall {
  pos: string[];
  flags: Record<string, string>;
  lists: Record<string, string[]>;
}

const BOOLS = new Set(["today", "enabled", "json", "check", "yes", "quiet", "wait"]);

/** Splits a shell command into words. Returns null for anything beyond one simple command. */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "", quoted = false, i = 0;
  const push = () => { if (word || quoted) words.push(word); word = ""; quoted = false; };
  const s = command.trim();
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      word += s.slice(i + 1, end); quoted = true; i = end + 1;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) { word += s[i + 1]; i += 2; continue; }
        if (s[i] === "$" || s[i] === "`") return null;
        word += s[i++];
      }
      if (i >= s.length) return null;
      quoted = true; i++;
    } else if (c === "\\" && i + 1 < s.length) {
      if (s[i + 1] !== "\n") word += s[i + 1];
      i += 2;
    } else if (c === " " || c === "\t" || c === "\n") {
      push(); i++;
    } else if ("|&;<>()$`*?{}".includes(c) || (c === "#" && !word)) {
      // Allow a trailing `2>&1`: it only merges the error message into the output.
      if (c === ">" && word === "2" && !quoted && s.slice(i, i + 3) === ">&1" && !s.slice(i + 3).trim()) { word = ""; i = s.length; continue; }
      return null;
    } else {
      word += c; i++;
    }
  }
  push();
  return words;
}

/** The Sift invocation in a bash command, if that is all the command is. */
export function parseSiftCommand(command: unknown): SiftCall | null {
  if (typeof command !== "string") return null;
  const words = shellWords(command);
  if (!words?.length) return null;
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at++;
  const exe = words[at]?.split("/").pop() || "";
  if (!/^sift(?:[-.][\w.-]*)?$/.test(exe)) return null;
  const call: SiftCall = { pos: [], flags: {}, lists: {} };
  const args = words.slice(at + 1);
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    if (v.startsWith("--")) {
      const key = v.slice(2), eq = key.indexOf("=");
      let name = key, value = "true";
      if (eq >= 0) { name = key.slice(0, eq); value = key.slice(eq + 1); }
      else if (!BOOLS.has(key) && i + 1 < args.length && !args[i + 1].startsWith("--")) value = args[++i];
      call.flags[name] = value;
      (call.lists[name] ||= []).push(value);
    } else call.pos.push(v);
  }
  return call.pos.length ? call : null;
}

export type SiftResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Sift prints JSON on success and `sift: message` on failure. */
export function parseSiftOutput(output: string | undefined, isError: boolean): SiftResult | null {
  if (output === undefined) return null;
  const text = output.replace(/\n*(?:Command exited with code \d+|\(exit code \d+\))\s*$/, "").trim();
  const failure = text.match(/(?:^|\n)sift: ([\s\S]+)$/);
  if (failure) return { ok: false, error: failure[1].trim() };
  try { return { ok: true, data: JSON.parse(text) }; }
  catch { return isError ? { ok: false, error: text || "The command failed" } : { ok: true, data: undefined }; }
}

export interface Lookups {
  tasks: Task[];
  columns: Column[];
  projects: Entity[];
  tags: Entity[];
}

/** One task the card shows. Live data from the workspace wins over what the command printed. */
export interface TaskRef { id: string; title: string; snapshot?: Partial<Task> }

export interface SiftOp {
  /** What happened, or is happening while the command runs. */
  verb: string;
  /** Changes deserve a card; reads are quiet rows. */
  emphasis: "change" | "read";
  icon: "task" | "comment" | "merge" | "project" | "tag" | "job" | "run" | "undo" | "read" | "search" | "image" | "sift";
  tasks: TaskRef[];
  changes: string[];
  detail?: string;
  quote?: string;
  entity?: { name: string; color?: string };
  error?: string;
  runId?: string;
}

const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const taskOf = (v: unknown): Partial<Task> | undefined => {
  const t = asObject(v);
  return t && typeof t.id === "string" ? t as Partial<Task> : undefined;
};
const ref = (t: Partial<Task> | undefined, fallbackID = ""): TaskRef[] =>
  t?.id || fallbackID ? [{ id: t?.id || fallbackID, title: t?.title || "", snapshot: t }] : [];
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function formatDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value + "T12:00:00");
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(d);
}

/** Readable descriptions of the fields a `tasks add/update` call set. */
function taskChanges(call: SiftCall, lookups: Lookups, adding: boolean): string[] {
  const f = call.flags, out: string[] = [];
  const name = (list: Entity[], id: string) => list.find(e => e.id === id)?.name || id;
  if (!adding && "title" in f) out.push(`Renamed to “${f.title}”`);
  if ("status" in f && !(adding && f.status === "open")) {
    const column = lookups.columns.find(c => c.id === f.status)?.name || f.status;
    out.push(f.status === "done" ? "Marked done" : `Moved to ${column}`);
  }
  if ("today" in f) out.push(f.today === "false" ? "Removed from Today" : "Added to Today");
  if ("due-date" in f) out.push(f["due-date"] ? `Due ${formatDate(f["due-date"])}` : "Removed due date");
  if ("snoozed-until" in f) out.push(f["snoozed-until"] ? `Snoozed until ${formatDate(f["snoozed-until"])}` : "Unsnoozed");
  if ("priority" in f && !(adding && f.priority === "none")) out.push(`${f.priority[0]?.toUpperCase() || ""}${f.priority.slice(1)} priority`);
  if ("project" in f) out.push(f.project ? `In ${name(lookups.projects, f.project)}` : "Removed from project");
  if ("tags" in f) out.push(f.tags ? "Tagged " + f.tags.split(",").map(t => name(lookups.tags, t)).join(", ") : "Removed tags");
  if ("parent" in f) out.push(f.parent ? `Under “${lookups.tasks.find(t => t.id === f.parent)?.title || f.parent}”` : "Made top-level");
  if (!adding && "description" in f) out.push("Edited notes");
  if (!adding && "icon" in f) out.push("Changed icon");
  if ("attachment" in f) out.push("Attached an image");
  if ("file" in f && !out.length) out.push(adding ? "From a file" : "Updated from a file");
  return out;
}

// [done, in progress, failed]
const verbs: Record<string, [string, string, string?]> = {
  "tasks add": ["Added task", "Adding task", "Couldn’t add task"],
  "tasks update": ["Updated task", "Updating task", "Couldn’t update task"],
  "tasks get": ["Read task", "Reading task"],
  "tasks list": ["Looked through tasks", "Looking through tasks"],
  "tasks tree": ["Looked through tasks", "Looking through tasks"],
  "tasks search": ["Searched tasks", "Searching tasks"],
  "tasks duplicates": ["Checked for duplicates", "Checking for duplicates"],
  "tasks comment": ["Commented on", "Commenting on", "Couldn’t comment on"],
  "tasks comments": ["Read comments", "Reading comments"],
  "tasks merge": ["Merged tasks", "Merging tasks", "Couldn’t merge tasks"],
  "projects add": ["Added project", "Adding project", "Couldn’t add project"],
  "projects update": ["Updated project", "Updating project", "Couldn’t update project"],
  "projects list": ["Looked at projects", "Looking at projects"],
  "tags add": ["Added tag", "Adding tag", "Couldn’t add tag"],
  "tags update": ["Updated tag", "Updating tag", "Couldn’t update tag"],
  "tags list": ["Looked at tags", "Looking at tags"],
  "jobs add": ["Scheduled a job", "Scheduling a job", "Couldn’t schedule the job"],
  "jobs update": ["Updated job", "Updating job", "Couldn’t update the job"],
  "jobs list": ["Looked at jobs", "Looking at jobs"],
  "jobs run": ["Started a job", "Starting a job", "Couldn’t start the job"],
  "jobs reset": ["Reset job memory", "Resetting job memory", "Couldn’t reset job memory"],
  "runs list": ["Looked at runs", "Looking at runs"],
  "runs get": ["Read a run", "Reading a run"],
  "runs watch": ["Followed a run", "Following a run"],
  "runs cancel": ["Cancelled a run", "Cancelling a run", "Couldn’t cancel the run"],
  "images upload": ["Uploaded an image", "Uploading an image", "Couldn’t upload the image"],
  "help ": ["Read Sift help", "Reading Sift help"],
  "schema ": ["Read Sift’s schema", "Reading Sift’s schema"],
  "icons ": ["Searched icons", "Searching icons"],
  "columns ": ["Read columns", "Reading columns"],
  "history ": ["Read history", "Reading history"],
  "undo ": ["Undid a change", "Undoing a change", "Couldn’t undo the change"],
  "models ": ["Checked Pi models", "Checking Pi models"],
  "version ": ["Checked Sift’s version", "Checking Sift’s version"],
  "backup ": ["Backed up the workspace", "Backing up the workspace", "Couldn’t back up the workspace"],
};

const CHANGES = new Set(["tasks add", "tasks update", "tasks comment", "tasks merge", "projects add", "projects update", "tags add", "tags update", "jobs add", "jobs update", "jobs run", "jobs reset", "runs cancel", "undo ", "images upload", "backup "]);

const verbKey = (call: SiftCall) => {
  const [group, sub = ""] = call.pos;
  return verbs[group + " " + sub] ? group + " " + sub : group + " ";
};

/**
 * Describes a Sift call for a card. `result` is null while the command runs.
 */
export function describeSiftOp(call: SiftCall, result: SiftResult | null, lookups: Lookups): SiftOp {
  const [group, sub = "", target = ""] = call.pos;
  const key = verbKey(call);
  const [done, doing, failed] = verbs[key] || ["Ran sift " + call.pos.join(" "), "Running sift " + call.pos.join(" ")];
  const changeKind = CHANGES.has(key);
  const op: SiftOp = { verb: result ? done : doing + "…", emphasis: changeKind ? "change" : "read", icon: changeKind ? "task" : "read", tasks: [], changes: [] };
  if (result && !result.ok) {
    op.error = result.error;
    op.verb = failed || `${done} — it failed`;
    op.emphasis = "change";
  }
  const data = result?.ok ? result.data : undefined;
  const obj = asObject(data);
  switch (group) {
    case "tasks": {
      op.icon = sub === "comment" || sub === "comments" ? "comment" : sub === "merge" ? "merge" : sub === "search" || sub === "duplicates" ? "search" : changeKind ? "task" : "read";
      if (sub === "add" || sub === "update") {
        const task = taskOf(obj?.task);
        op.tasks = ref(task, target);
        if (!op.tasks.length && sub === "add" && call.flags.title) op.tasks = [{ id: "", title: call.flags.title }];
        op.changes = taskChanges(call, lookups, sub === "add");
        if (sub === "update" && result?.ok && task?.status === "done" && call.flags.status === "done") { op.verb = "Completed task"; op.changes = op.changes.filter(c => c !== "Marked done"); }
        else if (sub === "update" && result?.ok && op.changes.length === 1 && op.changes[0].startsWith("Moved to ")) op.verb = op.changes.shift()!;
        const dupes = Array.isArray(obj?.potentialDuplicates) ? obj.potentialDuplicates.length : 0;
        if (dupes) op.detail = plural(dupes, "possible duplicate");
        if (call.flags.reason) op.quote = call.flags.reason;
      } else if (sub === "get") {
        op.tasks = ref(taskOf(obj?.task), target);
        const history = Array.isArray(obj?.history) ? obj.history.length : 0;
        if (history) op.detail = plural(history, "change") + " in history";
      } else if (sub === "list" || sub === "tree" || sub === "search") {
        const list = Array.isArray(data) ? data.map(taskOf).filter(Boolean) as Partial<Task>[] : [];
        op.tasks = list.map(t => ({ id: t.id!, title: t.title || "", snapshot: t }));
        const query = call.pos.slice(2).join(" ");
        if (sub === "search" && query) op.verb = result ? `Searched for “${query}”` : `Searching for “${query}”…`;
        if (Array.isArray(data)) op.detail = sub === "search" ? plural(list.length, "result") : plural(list.length, "task");
      } else if (sub === "duplicates") {
        const list = (Array.isArray(data) ? data as { id: string; title: string }[] : []).filter(d => d && typeof d.id === "string");
        if (call.flags.title) op.verb = (result ? "Checked for duplicates of" : "Checking for duplicates of") + ` “${call.flags.title}”` + (result ? "" : "…");
        if (result?.ok) op.detail = list.length ? plural(list.length, "possible duplicate") : "None found";
        op.tasks = list.map(d => ({ id: d.id, title: d.title || "" }));
      } else if (sub === "comment") {
        op.tasks = ref(undefined, target);
        op.quote = call.flags.text;
      } else if (sub === "comments") {
        op.tasks = ref(undefined, target);
        if (Array.isArray(data)) op.detail = plural(data.length, "comment");
      } else if (sub === "merge") {
        const merged = taskOf(obj?.merged), into = taskOf(obj?.task);
        op.tasks = [...ref(merged, target), ...ref(into, call.flags.into)];
        if (call.flags.reason) op.quote = call.flags.reason;
      }
      break;
    }
    case "projects":
    case "tags": {
      op.icon = group === "projects" ? "project" : "tag";
      const e = asObject(data);
      if (sub === "add" || sub === "update") {
        const name = (typeof e?.name === "string" && e.name) || call.flags.name || "";
        if (name) op.entity = { name, color: typeof e?.color === "string" ? e.color : call.flags.color };
      } else if (Array.isArray(data)) op.detail = plural(data.length, group === "projects" ? "project" : "tag");
      break;
    }
    case "jobs":
    case "runs": {
      op.icon = group === "jobs" ? "job" : "run";
      if (typeof obj?.name === "string") op.entity = { name: obj.name };
      if (typeof obj?.jobName === "string") op.entity = { name: obj.jobName };
      if (group === "jobs" && sub === "run" && typeof obj?.id === "string") op.runId = obj.id;
      if (group === "runs" && (sub === "get" || sub === "watch")) op.runId = target;
      if (Array.isArray(data)) op.detail = plural(data.length, group === "jobs" ? "job" : "run");
      break;
    }
    case "images": op.icon = "image"; break;
    case "undo": op.icon = "undo"; break;
    case "history": op.icon = "read"; op.tasks = ref(undefined, target); if (Array.isArray(data)) op.detail = plural(data.length, "change"); break;
    case "icons": op.icon = "search"; if (call.pos.length > 2) op.verb = (result ? "Searched icons for" : "Searching icons for") + ` “${call.pos.slice(2).join(" ")}”` + (result ? "" : "…"); break;
    default: op.icon = changeKind ? "sift" : "read";
  }
  // A task the command touched shows as it is now in the workspace.
  op.tasks = op.tasks.map(t => {
    const live = lookups.tasks.find(v => v.id === t.id);
    return live ? { id: t.id, title: live.title, snapshot: live } : t;
  });
  // A failed change changed nothing: keep the error, the task if it exists,
  // and drop what it meant to do.
  if (op.error) {
    op.changes = [];
    op.detail = undefined;
    op.tasks = op.tasks.filter(t => lookups.tasks.some(v => v.id === t.id));
  }
  return op;
}
