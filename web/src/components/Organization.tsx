import { useState } from "react";
import { IconArchive as Archive, IconFolder as Folder, IconGitMerge as Merge, IconPencil as Pencil, IconPlus as Plus, IconTag as Tag } from "@tabler/icons-react";
import { toast } from "sonner";
import { api } from "../api";
import type { Entity, Snapshot } from "../types";
import { Action, Button, Busy, Confirm, Field } from "./shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Choice } from "./Choice";
import { Checkbox } from "./ui/checkbox";
import { useDraftGuard, useDraftProtection } from "./DraftGuard";

type Editing = { kind: "project" | "tag"; entity: Entity };
export function Organization({ snapshot, refresh, onProject }: {
  snapshot: Snapshot; refresh: () => Promise<void>; onProject: (id: string) => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [baseline, setBaseline] = useState("");
  const [showArchived, setShowArchived] = useState(false);
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
  return <div className="page-body organization-page">
    <header className="page-heading">
      <div><h1>Projects & tags</h1><p>A little structure, without the ceremony.</p></div>
      <label className="checkbox-inline"><Checkbox checked={showArchived} onCheckedChange={v => setShowArchived(v === true)} />Show archived</label>
    </header>
    {(["project", "tag"] as const).map(kind => {
      const entities = snapshot[kind === "project" ? "projects" : "tags"].filter(e => showArchived || !e.archived);
      return <section className="organization-section" key={kind}>
        <header className="section-heading">
          <h2>{kind === "project" ? <Folder size={18} /> : <Tag size={18} />} {kind === "project" ? "Projects" : "Tags"}</h2>
          <Button variant="outline" size="sm" onClick={() => edit({ kind, entity: { id: "", name: "", color: "blue", archived: false, icon: "folder" } })}><Plus size={14} />New {kind}</Button>
        </header>
        {!entities.length ? <div className="quiet-empty">No {kind === "project" ? "projects" : "tags"} yet. Create one when your work needs a home.</div> :
          <div className="entity-list">{entities.map(e => <div className="entity-row" key={e.id}>
            <span className={"status-dot " + e.color} />
            <Action className="entity-name" onClick={() => kind === "project" ? onProject(e.id) : edit({ kind, entity: e })}>{e.name}{e.archived && <small>Archived</small>}</Action>
            <span className="muted small">{snapshot.tasks.filter(t => !t.deletedAt && !t.mergedInto && (kind === "project" ? t.project === e.id : t.tags.includes(e.id))).length} tasks</span>
            <Button size="icon" variant="ghost" aria-label={"Edit " + e.name} onClick={() => edit({ kind, entity: e })}><Pencil size={14} /></Button>
          </div>)}</div>}
      </section>;
    })}
    <Dialog open={!!editing} onOpenChange={close}>
      <DialogContent>
        <DialogHeader><DialogTitle>{editing?.entity.id ? "Edit" : "New"} {editing?.kind}</DialogTitle><DialogDescription>Agents can discover and apply the same stable IDs through the CLI.</DialogDescription></DialogHeader>
        {editing && <form className="stack" onSubmit={async e => {
          e.preventDefault(); if (busy) return; setBusy(true); setError("");
          try { await api("/" + editing.kind + "s", "POST", editing.entity); await refresh(); setEditing(null); toast.success(editing.kind === "project" ? "Project saved" : "Tag saved"); }
          catch (err) { setError((err as Error).message); } finally { setBusy(false); }
        }}>
          <Field label="Name"><Input required maxLength={100} value={editing.entity.name} onChange={e => setEditing({ ...editing, entity: { ...editing.entity, name: e.target.value } })} /></Field>
          <Field label="Color"><Choice value={editing.entity.color} onValueChange={v => setEditing({ ...editing, entity: { ...editing.entity, color: v } })} options={["slate", "blue", "green", "amber", "purple", "rose"].map(c => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))} /></Field>
          <label className="checkbox-inline"><Checkbox checked={editing.entity.archived} onCheckedChange={v => setEditing({ ...editing, entity: { ...editing.entity, archived: v === true } })} /><Archive size={14} />Archived (existing tasks stay assigned)</label>
          {editing.entity.id && <div className="entity-merge">
            <Field label="Merge into another"><Choice value={merge} onValueChange={setMerge} options={[{ value: "", label: "Choose a survivor…" }, ...snapshot[editing.kind === "project" ? "projects" : "tags"].filter(e => e.id !== editing.entity.id && !e.archived).map(e => ({ value: e.id, label: e.name }))]} /></Field>
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
    </Dialog>
  </div>;
}
