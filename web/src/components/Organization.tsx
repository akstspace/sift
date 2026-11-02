import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { IconArchive as Archive, IconChevronRight as ChevronRight, IconFolder as Folder, IconGitMerge as Merge, IconPencil as Pencil, IconPlus as Plus } from "@tabler/icons-react";
import { toast } from "sonner";
import { api } from "../api";
import type { Entity, Snapshot } from "../types";
import { Action, Button, Busy, Confirm, Empty, Field } from "./shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Choice } from "./Choice";
import { Checkbox } from "./ui/checkbox";
import { useDraftGuard, useDraftProtection } from "./DraftGuard";
import { projectTitleId, titleMorph } from "../motion";

type Kind = "project" | "tag";
type Editing = { kind: Kind; entity: Entity };
type Props = { snapshot: Snapshot; refresh: () => Promise<void> };
// Stored order follows IDs; people scan by name, with "Project 2" before "Project 10".
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const sorted = (entities: Entity[]) => [...entities].sort((a, b) => byName.compare(a.name, b.name) || a.id.localeCompare(b.id));
const blank = (kind: Kind): Entity => ({ id: "", name: "", color: kind === "tag" ? "slate" : "blue", archived: false, icon: kind === "tag" ? "tag" : "folder" });
const plural = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;
const live = (snapshot: Snapshot) => snapshot.tasks.filter(t => !t.deletedAt && !t.mergedInto && !t.archivedAt);

/** Projects are a destination of their own: each row opens that project's board. */
export function Organization({ snapshot, refresh, onProject }: Props & { onProject: (id: string) => void }) {
  const [showArchived, setShowArchived] = useState(false);
  const { edit, dialog } = useEntityEditor(snapshot, refresh);
  const archived = snapshot.projects.filter(p => p.archived).length;
  const projects = sorted(snapshot.projects.filter(p => showArchived || !p.archived));
  const tasks = live(snapshot);
  const create = () => edit({ kind: "project", entity: blank("project") });
  return <div className="page-body organization-page">
    <header className="page-heading">
      <div><h1>Projects</h1><p>Choose a project to open its board.</p></div>
      <div className="heading-actions">
        {archived > 0 && <label className="checkbox-inline"><Checkbox checked={showArchived} onCheckedChange={v => setShowArchived(v === true)} />Show archived</label>}
        <Button onClick={create}><Plus size={16} />New project</Button>
      </div>
    </header>
    <section className="organization-section" aria-label="Projects">
      {projects.length ? <div className="entity-list">{projects.map(p => {
        const count = tasks.filter(t => t.project === p.id).length;
        return <div className="entity-row" key={p.id}>
          <span className={"status-dot " + p.color} />
          <Action className="entity-name" onClick={() => onProject(p.id)}>
            <span><motion.span className="project-title-morph" layoutId={projectTitleId(p.id)} transition={titleMorph}>{p.name}</motion.span>{p.archived && <> <small>Archived</small></>}</span>
            <ChevronRight size={15} aria-hidden="true" />
          </Action>
          <span className="entity-count muted small">{plural(count)}</span>
          <Button size="icon" variant="ghost" aria-label={"Edit " + p.name} onClick={() => edit({ kind: "project", entity: p })}><Pencil size={14} /></Button>
        </div>;
      })}</div> : archived ? <Empty icon={Folder} title="No active projects." action={<Button variant="outline" onClick={() => setShowArchived(true)}>Show archived</Button>}>
        Archived projects keep their tasks. Show them to open or restore one.
      </Empty> : <Empty icon={Folder} title="No projects yet." action={<Button onClick={create}><Plus size={16} />Create a project</Button>}>
        A project gives related tasks a board of their own. Agents can file work into projects too.
      </Empty>}
    </section>
    {dialog}
  </div>;
}

/** Tags only label and filter tasks, so their upkeep lives with other workspace settings. */
export function TagManager({ snapshot, refresh }: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const { edit, dialog } = useEntityEditor(snapshot, refresh);
  const archived = snapshot.tags.filter(t => t.archived).length;
  const tags = sorted(snapshot.tags.filter(t => showArchived || !t.archived));
  const tasks = live(snapshot);
  return <section className="settings-section" aria-label="Tags">
    <div>
      <h2>Tags</h2>
      <p>Tags label tasks across projects and filter any board. Add them from a task; rename, merge or archive them here.</p>
    </div>
    <div className="settings-controls tag-manager">
      {tags.length ? <div className="entity-list">{tags.map(t => <div className="entity-row" key={t.id}>
        <span className={"status-dot " + t.color} />
        <Action className="entity-name" onClick={() => edit({ kind: "tag", entity: t })}><span>{t.name}{t.archived && <> <small>Archived</small></>}</span></Action>
        <span className="entity-count muted small">{plural(tasks.filter(task => task.tags.includes(t.id)).length)}</span>
        <Button size="icon" variant="ghost" aria-label={"Edit " + t.name} onClick={() => edit({ kind: "tag", entity: t })}><Pencil size={14} /></Button>
      </div>)}</div> : <p className="quiet-empty">{archived ? "Every tag is archived." : "No tags yet. Add one from any task’s Tags field."}</p>}
      <div className="button-row">
        <Button type="button" variant="outline" size="sm" onClick={() => edit({ kind: "tag", entity: blank("tag") })}><Plus size={14} />New tag</Button>
        {archived > 0 && <label className="checkbox-inline"><Checkbox checked={showArchived} onCheckedChange={v => setShowArchived(v === true)} />Show archived tags</label>}
      </div>
    </div>
    {dialog}
  </section>;
}

function useEntityEditor(snapshot: Snapshot, refresh: () => Promise<void>): { edit: (value: Editing) => void; dialog: ReactNode } {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [baseline, setBaseline] = useState("");
  const [merge, setMerge] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { guard } = useDraftGuard();
  const dirty = !!editing && JSON.stringify(editing) !== baseline;
  useDraftProtection(dirty, busy);
  const edit = (value: Editing) => guard(() => {
    setError(""); setMerge("");
    setBaseline(JSON.stringify(value)); setEditing(structuredClone(value));
  });
  const close = () => guard(() => setEditing(null));
  const dialog = <Dialog open={!!editing} onOpenChange={close}>
    <DialogContent>
      <DialogHeader><DialogTitle>{editing?.entity.id ? "Edit" : "New"} {editing?.kind}</DialogTitle><DialogDescription>{editing?.kind === "project" ? "Group related tasks in one project." : "Use a tag to label related tasks across projects."}</DialogDescription></DialogHeader>
      {editing && <form className="stack" onSubmit={async e => {
        e.preventDefault(); if (busy) return; setBusy(true); setError("");
        try { await api("/" + editing.kind + "s", "POST", editing.entity); await refresh(); setEditing(null); toast.success(editing.kind === "project" ? "Project saved" : "Tag saved"); }
        catch (err) { setError((err as Error).message); } finally { setBusy(false); }
      }}>
        <Field label="Name"><Input required maxLength={100} value={editing.entity.name} onChange={e => setEditing({ ...editing, entity: { ...editing.entity, name: e.target.value } })} /></Field>
        <Field label="Color"><Choice value={editing.entity.color} onValueChange={v => setEditing({ ...editing, entity: { ...editing.entity, color: v } })} options={["slate", "blue", "green", "amber", "purple", "rose"].map(c => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))} /></Field>
        <label className="checkbox-inline"><Checkbox checked={editing.entity.archived} onCheckedChange={v => setEditing({ ...editing, entity: { ...editing.entity, archived: v === true } })} /><Archive size={14} />Archived (existing tasks stay assigned)</label>
        {editing.entity.id && <div className="entity-merge">
          <Field label="Merge into another"><Choice value={merge} onValueChange={setMerge} options={[{ value: "", label: "Choose a survivor…" }, ...sorted(snapshot[editing.kind === "project" ? "projects" : "tags"].filter(e => e.id !== editing.entity.id && !e.archived)).map(e => ({ value: e.id, label: e.name }))]} /></Field>
          <Confirm title="Merge organization" description="All task assignments move to the survivor. The source is archived and its ID remains in history." action={async () => {
            setBusy(true);
            try { await api("/" + editing.kind + "s/" + editing.entity.id + "/merge", "POST", { target: merge }); await refresh(); setEditing(null); toast.success("Assignments merged"); }
            finally { setBusy(false); }
          }}>{open => <Button type="button" variant="outline" onClick={open} disabled={!merge || dirty || busy}><Merge size={14} />Merge</Button>}</Confirm>
        </div>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="button-row"><Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={busy || !editing.entity.name.trim()}>{busy ? <Busy label="Saving" /> : "Save " + editing.kind}</Button></div>
      </form>}
    </DialogContent>
  </Dialog>;
  return { edit, dialog };
}
