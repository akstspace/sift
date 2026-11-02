import { Action } from "./shared";
import { IconPicker } from "./IconPicker";
import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Choice } from "./Choice";
import { SearchChoice } from "./SearchChoice";
import { DateChoice } from "./DateChoice";
import { Checkbox } from "./ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { motion, useReducedMotion } from "motion/react";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  IconArrowUpRight as ArrowUpRight,
  IconCheck as Check,
  IconChevronLeft as ChevronLeft,
  IconCopy as Copy,
  IconEye as Eye,
  IconPhotoPlus as ImagePlus,
  IconLayersIntersect as Layers2,
  IconPlus as Plus,
  IconPencil as Pencil,
  IconDeviceFloppy as Save,
  IconTrash as Trash2,
  IconArrowBackUp as Undo2,
  IconX as X,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, friendlyTime, upload } from "../api";
import type {
  CatalogIcon,
  Duplicate,
  HistoryEntry,
  Snapshot,
  Task,
} from "../types";
import {
  Button,
  Busy,
  CloseButton,
  Confirm,
  CopyButton,
  Field,
  TaskIcon,
} from "./shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useDraftGuard, useDraftProtection } from "./DraftGuard";
import { taskSheetMotion } from "../motion";
import { useIsMobile } from "../hooks/use-mobile";
import { TaskTitle, type TaskTitleHandle } from "./TaskTitle";

export function TaskDetail({
  initial,
  snapshot,
  catalog,
  onClose,
  onSave,
  onOpen,
  onAddChild,
  refresh,
}: {
  initial: Task;
  snapshot: Snapshot;
  catalog: CatalogIcon[];
  onClose: () => void;
  onSave: (t: Task, reason?: string) => Promise<Task>;
  onOpen: (t: Task) => void;
  onAddChild: (parent: string) => void;
  refresh: () => Promise<void>;
}) {
  const reduced = !!useReducedMotion();
  const mobile = useIsMobile();
  const { guard } = useDraftGuard();
  const opener = useRef(document.activeElement as HTMLElement | null);
  const [task, setTask] = useState<Task>(() => structuredClone(initial)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tab, setTab] = useState(initial.id ? "preview" : "write"),
    [history, setHistory] = useState<HistoryEntry[]>([]),
    [duplicates, setDuplicates] = useState<Duplicate[]>([]),
    [iconPicker, setIconPicker] = useState(false),
    [viewer, setViewer] = useState(""),
    [mergeTarget, setMergeTarget] = useState(""),
    [pendingOpen, setPendingOpen] = useState<Task | null>(null),
    [mergeReason, setMergeReason] = useState(""),
    [newCheck, setNewCheck] = useState("");
  const form = useRef<HTMLFormElement>(null),
    titleRef = useRef<TaskTitleHandle>(null),
    picker = useRef<HTMLInputElement>(null);
  const baseline = useRef(JSON.stringify(initial));
  const dirty = JSON.stringify(task) !== baseline.current || !!newCheck.trim();
  useDraftProtection(dirty, busy);
  // A completed merge may navigate only after this sheet's busy protection has
  // been released. Parent navigation still passes through the ordinary guard.
  useEffect(() => {
    if (pendingOpen && !busy) {
      setPendingOpen(null);
      onOpen(pendingOpen);
    }
  }, [pendingOpen, busy, onOpen]);
  const current = snapshot.tasks.find((t) => t.id === task.id);
  const conflict = !!current && current.revision !== task.revision;
  const children = snapshot.tasks.filter(
    (t) => t.parentId === task.id && !t.deletedAt && !t.mergedInto,
  );
  const parent = snapshot.tasks.find((t) => t.id === task.parentId);
  useEffect(() => {
    let cancelled = false;
    if (initial.id)
      api<{ history: HistoryEntry[] }>("/tasks/" + initial.id)
        .then((v) => { if (!cancelled) setHistory(v.history); })
        .catch(() => {});
    return () => { cancelled = true; };
  }, [initial.id]);
  useEffect(() => {
    let cancelled = false;
    if (task.title.trim().length < 3) {
      setDuplicates([]);
      return;
    }
    const timer = setTimeout(() => {
      api<Duplicate[]>(
        "/tasks/duplicates?title=" +
          encodeURIComponent(task.title) +
          "&id=" +
          task.id +
          "&project=" +
          task.project,
      )
        .then(value => { if (!cancelled) setDuplicates(value); })
        .catch(() => {});
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [task.title, task.id, task.project]);
  const update = <K extends keyof Task>(key: K, value: Task[K]) =>
    setTask((t) => ({ ...t, [key]: value }));
  const close = () => guard(onClose);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const pendingCheck = newCheck.trim() ? [{ id: crypto.randomUUID(), title: newCheck.trim(), done: false }] : [];
      const saved = await onSave({ ...task, checklist: [...task.checklist, ...pendingCheck] });
      setTask(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addImages = async (files: File[]) => {
    if (busy || !files.length) return;
    setBusy(true);
    setError("");
    try {
      const uploaded: { id: string; markdown: string }[] = [];
      for (const file of files) {
        const result = await upload(file);
        uploaded.push({ id: result.attachment.id, markdown: `\n\n![${file.name.replace(/[\[\]]/g, "")}](${result.url})` });
        // Commit each successful upload to the current draft, not a stale copy.
        // A later failed file must not hide the earlier successful attachments.
        setTask(t => ({ ...t, attachments: [...new Set([...t.attachments, result.attachment.id])], description: t.description + uploaded.at(-1)!.markdown }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const merge = async () => {
    const target = snapshot.tasks.find((t) => t.id === mergeTarget);
    if (!target) return;
    const result = await api<{ task: Task }>("/tasks/" + task.id + "/merge", "POST", {
      target: target.id,
      revision: task.revision,
      targetRevision: target.revision,
      reason: mergeReason,
    });
    await refresh();
    setMergeTarget("");
    setPendingOpen(result.task);
    toast.success("Tasks merged. Undo is available in History.");
  };
  // Stable renderer identities preserve the actual image button across live
  // history/duplicate updates, including between pointer-down and click.
  const markdownComponents = useMemo<Components>(() => ({
    img: ({ src, alt }) =>
      typeof src === "string" &&
      /^\/api\/images\/img_[a-f0-9]{32}$/.test(src) ? (
        <Action type="button" className="markdown-image" onClick={() => setViewer(src)}>
          <img src={src} alt={alt || "Task attachment"} />
        </Action>
      ) : (
        <span className="muted">[External image blocked]</span>
      ),
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <ArrowUpRight size={11} />
      </a>
    ),
  }), []);
  return (
    <>
      <Sheet open>
      <SheetContent asChild forceMount showCloseButton={false} overlayClassName="detail-backdrop"
        overlay={<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: reduced ? 0.1 : 0.24 } }} exit={{ opacity: 0, transition: { duration: reduced ? 0.08 : 0.18 } }} />}
        onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); const target = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('[data-sidebar="trigger"]'); target?.focus(); }}
        onPointerDownOutside={event => { event.preventDefault(); close(); }}
        onEscapeKeyDown={event => {
          event.preventDefault();
          // Radix observes Escape before React's input handler. Let an active
          // rename cancel itself, rather than also dismissing the task sheet.
          if (task.id && event.target instanceof HTMLElement && event.target.getAttribute("aria-label") === "Task title") return;
          close();
        }}
        aria-describedby={undefined}>
      <motion.aside
        className="task-detail"
        aria-label={task.id ? "Task details" : "New task"}
        {...taskSheetMotion(reduced, mobile)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            form.current?.requestSubmit();
          }
        }}
      >
        <header className="detail-top">
          <SheetTitle asChild><span>{task.id ? "Task details" : "New task"}</span></SheetTitle>
          {task.id && <CopyButton text={task.id} label="Copy ID" />}
          <div className="push" />
          <CloseButton onClick={close} />
        </header>
        <form
          ref={form}
          className="detail-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          onPaste={(e) => {
            const images = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (images.length) {
              e.preventDefault();
              addImages(images);
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length) {
              e.preventDefault();
              addImages(Array.from(e.dataTransfer.files));
            }
          }}
        >
          <fieldset className="detail-scroll" disabled={busy}>
            {parent && (
              <Action
                type="button"
                className="parent-link"
                onClick={() => {
                  onOpen(parent);
                }}
              >
                <ChevronLeft size={14} />
                {parent.title}
              </Action>
            )}
            <div className="detail-title">
              <Action
                type="button"
                className="icon-picker-trigger"
                aria-label="Choose task icon"
                onClick={() => setIconPicker(true)}
              >
                <TaskIcon id={task.icon} catalog={catalog} size={24} />
              </Action>
              <TaskTitle ref={titleRef} value={task.title} isNew={!task.id} onChange={value => update("title", value)} />
            </div>
            {conflict && (
              <div className="notice warning" role="alert">
                This task changed elsewhere. Your draft is preserved.{" "}
                <Action
                  type="button"
                  onClick={() => guard(() => { baseline.current = JSON.stringify(current); setTask(structuredClone(current!)); setNewCheck(""); })}
                >
                  Load latest version
                </Action>{" "}
                before saving again.
              </div>
            )}
            {task.mergedInto && (
              <div className="notice">
                Merged into {task.mergedInto}. Undo the merge from History to
                recover it.
              </div>
            )}
            <div className="task-properties">
              <Field label="Status">
                <Choice value={task.status} onValueChange={v => update("status", v)} options={[...snapshot.columns].sort((a, b) => a.order - b.order).map(c => ({ value: c.id, label: c.name }))} />
              </Field>
              <Field label="Priority">
                <Choice value={task.priority} onValueChange={v => update("priority", v)} options={["none", "low", "medium", "high", "urgent"].map(v => ({ value: v, label: v === "none" ? "No priority" : v[0].toUpperCase() + v.slice(1) }))} />
              </Field>
              <Field label="Project">
                <Choice value={task.project} onValueChange={v => update("project", v)} options={[{ value: "", label: "No project" }, ...snapshot.projects.filter(p => !p.archived || p.id === task.project).map(p => ({ value: p.id, label: p.name }))]} />
              </Field>
              <Field label="Focus">
                <Choice value={String(task.today)} onValueChange={v => update("today", v === "true")} options={[{ value: "true", label: "Today" }, { value: "false", label: "Backlog only" }]} />
              </Field>
              <Field label="Due date">
                <DateChoice value={task.dueDate} onValueChange={v => update("dueDate", v)} />
              </Field>
              <Field label="Snooze until">
                <DateChoice value={task.snoozedUntil} onValueChange={v => update("snoozedUntil", v)} />
              </Field>
            </div>
            <Field label="Tags">
              <div className="tag-options">
                {snapshot.tags
                  .filter((t) => !t.archived)
                  .map((t) => (
                    <Action
                      key={t.id}
                      type="button"
                      className={task.tags.includes(t.id) ? "active" : ""}
                      onClick={() =>
                        update(
                          "tags",
                          task.tags.includes(t.id)
                            ? task.tags.filter((id) => id !== t.id)
                            : [...task.tags, t.id],
                        )
                      }
                    >
                      {task.tags.includes(t.id) && <Check size={12} />} {t.name}
                    </Action>
                  ))}
                {!snapshot.tags.length && (
                  <small>Create tags in Projects & tags.</small>
                )}
              </div>
            </Field>
            <Tabs value={tab} onValueChange={setTab} className="description-tabs">
            <div className="section-heading">
              <h3>Description</h3>
              <TabsList aria-label="Description mode">
                <TabsTrigger value="preview" aria-label="Preview description"><Eye size={14} aria-hidden="true" />Preview</TabsTrigger>
                <TabsTrigger value="write" aria-label="Edit description"><Pencil size={14} aria-hidden="true" />Edit</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="write">
              <Textarea
                className="description-editor"
                aria-label="Markdown description"
                placeholder="Add context, references, or a useful next step…"
                value={task.description}
                onChange={(e) => update("description", e.target.value)}
                rows={7}
              />
            </TabsContent>
            <TabsContent value="preview">
              <div className="markdown">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {task.description || "*No description yet.*"}
                </Markdown>
              </div>
            </TabsContent>
            </Tabs>
            <div className="attachment-toolbar">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => picker.current?.click()}
                disabled={busy}
              >
                <ImagePlus size={15} />
                Attach image
              </Button>
              <small>Paste or drop · up to 20 MB</small>
              <Input
                hidden
                ref={picker}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                onChange={(e) => {
                  addImages(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />
            </div>
            {task.attachments.length > 0 && (
              <div className="attachment-grid">
                {task.attachments.map((id) => (
                  <div key={id}>
                    <Action
                      type="button"
                      onClick={() => setViewer("/api/images/" + id)}
                    >
                      <img
                        src={"/api/images/" + id}
                        alt={
                          snapshot.attachments.find((a) => a.id === id)?.name ||
                          "Task attachment"
                        }
                      />
                    </Action>
                    <Action
                      type="button"
                      aria-label="Remove attachment"
                      onClick={() =>
                        update(
                          "attachments",
                          task.attachments.filter((a) => a !== id),
                        )
                      }
                    >
                      <X size={12} />
                    </Action>
                  </div>
                ))}
              </div>
            )}
            <div className="section-heading">
              <h3>Checklist</h3>
              <span>
                {task.checklist.filter((c) => c.done).length}/
                {task.checklist.length}
              </span>
            </div>
            <div className="checklist">
              {task.checklist.map((item) => (
                <div key={item.id}>
                  <Checkbox
                    aria-label={"Complete " + item.title}
                    checked={item.done}
                    onCheckedChange={(checked) =>
                      update(
                        "checklist",
                        task.checklist.map((c) =>
                          c.id === item.id
                            ? { ...c, done: checked === true }
                            : c,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label="Checklist item"
                    value={item.title}
                    onChange={(e) =>
                      update(
                        "checklist",
                        task.checklist.map((c) =>
                          c.id === item.id
                            ? { ...c, title: e.target.value }
                            : c,
                        ),
                      )
                    }
                  />
                  <Action
                    type="button"
                    aria-label="Remove checklist item"
                    onClick={() =>
                      update(
                        "checklist",
                        task.checklist.filter((c) => c.id !== item.id),
                      )
                    }
                  >
                    <X size={14} />
                  </Action>
                </div>
              ))}
              <div>
                <Plus size={15} />
                <Input
                  aria-label="New checklist item"
                  placeholder="Add a step…"
                  value={newCheck}
                  onChange={(e) => setNewCheck(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (newCheck.trim()) {
                        update("checklist", [
                          ...task.checklist,
                          {
                            id: crypto.randomUUID(),
                            title: newCheck.trim(),
                            done: false,
                          },
                        ]);
                        setNewCheck("");
                      }
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!newCheck.trim()}
                  onClick={() => {
                    update("checklist", [
                      ...task.checklist,
                      {
                        id: crypto.randomUUID(),
                        title: newCheck.trim(),
                        done: false,
                      },
                    ]);
                    setNewCheck("");
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
            {!task.parentId && task.id && (
              <>
                <div className="section-heading">
                  <h3>Subtasks</h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={dirty}
                    onClick={() => onAddChild(task.id)}
                  >
                    <Plus size={13} />
                    Add
                  </Button>
                </div>
                {children.map((c) => (
                  <Action
                    className="detail-subtask"
                    type="button"
                    key={c.id}
                    onClick={() => {
                      onOpen(c);
                    }}
                  >
                    {c.status === "done" ? (
                      <Check size={14} />
                    ) : (
                      <Layers2 size={14} />
                    )}
                    <span>{c.title}</span>
                    <ArrowUpRight size={13} />
                  </Action>
                ))}
                {!children.length && (
                  <p className="muted small">
                    Break larger work into full tasks. Save your changes before
                    adding a subtask.
                  </p>
                )}
              </>
            )}
            {task.id && (
              <Field
                label="Parent task"
                hint="Only one level of subtasks is supported."
              >
                <SearchChoice value={task.parentId} onValueChange={v => update("parentId", v)} searchLabel="Search parent tasks" options={[{ value: "", label: "Top-level task" }, ...snapshot.tasks.filter(t => t.id !== task.id && !t.parentId && !t.deletedAt && !t.mergedInto).map(t => ({ value: t.id, label: t.title }))]} />
              </Field>
            )}
            {duplicates.length > 0 && (
              <div className="duplicate-box">
                <h3>
                  <Copy size={14} />
                  Potential duplicates
                </h3>
                <p>Suggestions only. Nothing is merged automatically.</p>
                {duplicates.map((d) => (
                  <div key={d.id}>
                    <Action
                      type="button"
                      onClick={() => {
                        const target = snapshot.tasks.find(
                          (t) => t.id === d.id,
                        );
                        if (
                          target
                        )
                          onOpen(target);
                      }}
                    >
                      {d.title}
                      <small>
                        {snapshot.columns.find((c) => c.id === d.status)?.name}{" "}
                        · {d.reasons.join(" · ")}
                      </small>
                    </Action>
                    {task.id && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={dirty}
                        onClick={() => setMergeTarget(d.id)}
                      >
                        Merge
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {task.id && (
              <>
                <div className="section-heading">
                  <h3>History</h3>
                  <span>Revision {task.revision}</span>
                </div>
                <ol className="history-list">
                  {[...history].reverse().map((h) => (
                    <li key={h.id}>
                      <span className="history-node" />
                      <div>
                        <strong>{h.actor === "user" ? "You" : h.actor}</strong>
                        <p>
                          {h.reason ||
                            (!h.before
                              ? "Created this task"
                              : "Updated this task")}
                        </p>
                        <time>{friendlyTime(h.at)}</time>
                      </div>
                      <Confirm
                        title="Undo change"
                        description="Undo this action only if no newer changes would be overwritten. Related merge changes are restored together."
                        action={async () => {
                          await api("/undo/" + h.id, "POST", {});
                          await refresh();
                          onClose();
                          toast.success("Change undone");
                        }}
                      >
                        {(open) => (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={"Undo history entry " + h.id}
                            onClick={open}
                          >
                            <Undo2 size={14} />
                          </Button>
                        )}
                      </Confirm>
                    </li>
                  ))}
                </ol>
                <div className="task-origin">
                  <span>{task.id}</span>
                  <span>Source: {task.source || "manual"}</span>
                </div>
              </>
            )}
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
          </fieldset>
          <footer className="detail-actions">
            {task.id && (
              <Confirm
                title={task.deletedAt ? "Restore task" : "Delete task"}
                description={
                  task.deletedAt
                    ? "Return this task to your workspace."
                    : "The task stays recoverable in Trash for the configured retention period. Move subtasks out before deleting a parent."
                }
                destructive={!task.deletedAt}
                action={async () => {
                  await onSave(
                    {
                      ...task,
                      deletedAt: task.deletedAt ? "" : new Date().toISOString(),
                    },
                    task.deletedAt
                      ? "Restore deleted task"
                      : "Move task to Trash",
                  );
                  onClose();
                }}
              >
                {(open) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={open}
                    aria-label={task.deletedAt ? "Restore task" : "Delete task"}
                  >
                    {task.deletedAt ? (
                      <Undo2 size={16} />
                    ) : (
                      <Trash2 size={16} />
                    )}
                  </Button>
                )}
              </Confirm>
            )}
            <div className="push" />
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                busy || conflict || !!task.mergedInto || !task.title.trim()
              }
            >
              {busy ? (
                <Busy label="Saving" />
              ) : (
                <>
                  <Save size={14} />
                  {task.id ? "Save changes" : "Create task"}
                </>
              )}
            </Button>
          </footer>
        </form>
      </motion.aside>
      </SheetContent>
      </Sheet>
      {iconPicker && <IconPicker catalog={catalog} selected={task.icon} onClose={() => setIconPicker(false)} onSelect={id => { update("icon", id); setIconPicker(false); }} />}
      <Dialog open={!!viewer} onOpenChange={() => setViewer("")}>
        <DialogContent className="image-viewer">
          <DialogTitle className="sr-only">Task image</DialogTitle>
          <DialogDescription className="sr-only">
            Full-size local image attachment.
          </DialogDescription>
          <img src={viewer || undefined} alt="Full-size task attachment" />
        </DialogContent>
      </Dialog>
      <Dialog open={!!mergeTarget} onOpenChange={() => setMergeTarget("")}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge into this task?</DialogTitle>
            <DialogDescription>
              “{snapshot.tasks.find((t) => t.id === mergeTarget)?.title}”
              survives. Descriptions, attachments, checklists, and subtasks are
              preserved. The source task remains recoverable through Undo.
            </DialogDescription>
          </DialogHeader>
          <Field label="Merge reason">
            <Textarea
              value={mergeReason}
              onChange={(e) => setMergeReason(e.target.value)}
              placeholder="Why are these the same work?"
            />
          </Field>
          <Button
            disabled={!mergeReason.trim() || busy}
            onClick={async () => { setBusy(true); try { await merge(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }}
          >
            Merge tasks
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
