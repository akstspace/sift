import { memo, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Choice } from "./Choice";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  IconCalendar as Calendar,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconCircle as Circle,
  IconGripVertical as GripVertical,
  IconSubtask as ListTree,
  IconPaperclip as Paperclip,
  IconPlus as Plus,
} from "@tabler/icons-react";
import type { CatalogIcon, Column, Entity, Task } from "../types";
import { Action, Button, Empty, TaskIcon } from "./shared";

interface Props {
  tasks: Task[];
  allTasks: Task[];
  columns: Column[];
  projects: Entity[];
  catalog: CatalogIcon[];
  view: string;
  onOpen: (t: Task) => void;
  onAdd: (status?: string, parent?: string) => void;
  onChange: (t: Task) => Promise<void>;
  today: string;
  selected?: string;
}
const priorities: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// Move a lifted card to the adjacent workflow column in one keystroke, not in
// tiny pixel increments. Enter/Space drops and Escape cancels via KeyboardSensor.
export const columnCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return;
  event.preventDefault();
  const rect = context.collisionRect;
  if (!rect) return;
  const columns = context.droppableContainers.getEnabled()
    .map(column => ({ column, rect: context.droppableRects.get(column.id) }))
    .filter((entry): entry is typeof entry & { rect: NonNullable<typeof entry.rect> } => !!entry.rect)
    .sort((a, b) => a.rect.left - b.rect.left);
  const current = columns.findIndex(entry => entry.column.id === context.over?.id);
  const next = columns[current + (event.code === "ArrowRight" ? 1 : -1)];
  if (!next) return;
  return {
    x: currentCoordinates.x + next.rect.left + (next.rect.width - rect.width) / 2 - rect.left,
    y: currentCoordinates.y + Math.max(next.rect.top + 48, Math.min(rect.top, next.rect.bottom - rect.height)) - rect.top,
  };
};
function TaskCard({
  task,
  childrenTasks,
  props,
  compact = false,
  preview = false,
  initiallyExpanded = true,
}: {
  task: Task;
  childrenTasks: Task[];
  props: Props;
  compact?: boolean;
  preview?: boolean;
  initiallyExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const reduced = useReducedMotion();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } =
    useDraggable({ id: preview ? `preview-${task.id}` : task.id, data: { task, expanded }, disabled: compact || preview });
  const complete = childrenTasks.filter((c) => c.status === "done").length;
  const project = props.projects.find((p) => p.id === task.project);
  const nested = expanded && childrenTasks.length > 0 && (
    <motion.div
      className="nested-tasks"
      initial={preview ? false : { height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.2 }}
    >
      {childrenTasks.map((c) => (
        <div key={c.id}>
          <Action
            className="task-check"
            aria-label={"Toggle " + c.title}
            onClick={() => props.onChange({ ...c, status: c.status === "done" ? "open" : "done" })}
          >
            {c.status === "done" ? <Check size={13} /> : <Circle size={14} />}
          </Action>
          <Action className={c.status === "done" ? "struck" : ""} onClick={() => props.onOpen(c)}>
            {c.title}
          </Action>
          <ChevronRight size={12} />
        </div>
      ))}
      <Action className="text-button" onClick={() => props.onAdd(undefined, task.id)}>
        <Plus size={13} />
        Add subtask
      </Action>
    </motion.div>
  );
  return (
    <motion.article
      ref={setNodeRef}
      initial={false}
      animate={{ opacity: isDragging ? 0.35 : 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0.08 : 0.15 }}
      className={`task-card ${preview ? "drag-preview" : ""} ${compact ? "compact" : ""} ${task.status === "done" ? "completed" : ""} ${props.selected === task.id ? "selected" : ""}`}
    >
      <div className="task-card-main">
        <Action
          className="task-check"
          aria-label={
            task.status === "done"
              ? "Reopen " + task.title
              : "Complete " + task.title
          }
          onClick={() =>
            props.onChange({
              ...task,
              status: task.status === "done" ? "open" : "done",
            })
          }
        >
          {task.status === "done" ? <Check size={13} /> : <Circle size={17} />}
        </Action>
        <Action className="task-open" onClick={() => props.onOpen(task)}>
          <span className="task-name">
            {!compact && task.icon && (
              <TaskIcon id={task.icon} catalog={props.catalog} size={16} />
            )}
            <span>{task.title}</span>
          </span>
          {compact && project && (
            <span className="project-inline">{project.name}</span>
          )}
        </Action>
        {!compact && (
          <Action
            className="drag-handle"
            ref={setActivatorNodeRef}
            aria-label={"Drag " + task.title}
            {...listeners}
            {...attributes}
          >
            <GripVertical size={14} />
          </Action>
        )}
        {compact && (
          <Choice
            className="row-status"
            aria-label={"Status for " + task.title}
            value={task.status}
            onValueChange={(v) =>
              props.onChange({ ...task, status: v })
            }
            options={[...props.columns].sort((a, b) => a.order - b.order).map(c => ({ value: c.id, label: c.name }))}
          />
        )}
      </div>
      {(task.priority !== "none" ||
        project ||
        task.dueDate ||
        task.attachments.length > 0 ||
        childrenTasks.length > 0) && (
        <div className="task-meta">
          {priorities[task.priority] && (
            <span className={"priority " + task.priority}>
              <span />
              {priorities[task.priority]}
            </span>
          )}
          {!compact && project && (
            <span className="project-label">{project.name}</span>
          )}
          {task.dueDate && (
            <span
              className={
                task.dueDate < props.today && task.status !== "done"
                  ? "overdue"
                  : ""
              }
            >
              <Calendar size={12} />
              {new Intl.DateTimeFormat(undefined, {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              }).format(new Date(task.dueDate + "T12:00:00Z"))}
            </span>
          )}
          {task.attachments.length > 0 && (
            <span>
              <Paperclip size={12} />
              {task.attachments.length}
            </span>
          )}
          {childrenTasks.length > 0 && (
            <Action
              className="subtask-toggle"
              aria-label={(expanded ? "Hide" : "Show") + " subtasks for " + task.title}
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown size={13} /> : <ListTree size={13} />}{" "}
              {complete}/{childrenTasks.length}
            </Action>
          )}
        </div>
      )}
      <AnimatePresence initial={false}>{nested}</AnimatePresence>
    </motion.article>
  );
}
const MemoTaskCard = memo(TaskCard);
function BoardColumn({
  column,
  tasks,
  props,
  childrenByParent,
}: {
  column: Column;
  tasks: Task[];
  props: Props;
  childrenByParent: Map<string, Task[]>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const [limit, setLimit] = useState(70);
  return (
    <section
      ref={setNodeRef}
      className={"board-column " + (isOver ? "drag-over" : "")}
      aria-label={column.name}
    >
      <header>
        <span className={"status-dot " + column.color} />
        <h2>{column.name}</h2>
        <span className="count">{tasks.length}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={"Add task to " + column.name}
          onClick={() => props.onAdd(column.id)}
        >
          <Plus size={16} />
        </Button>
      </header>
      <div className="column-tasks">
        <AnimatePresence initial={false}>
          {tasks.slice(0, limit).map((t) => (
            <MemoTaskCard
              key={t.id}
              task={t}
              childrenTasks={childrenByParent.get(t.id) || []}
              props={props}
            />
          ))}
        </AnimatePresence>
        {tasks.length > limit && (
          <Button variant="ghost" onClick={() => setLimit(limit + 70)}>
            Show more ({tasks.length - limit})
          </Button>
        )}
        {tasks.length === 0 && (
          <Action
            className="empty-column"
            onClick={() => props.onAdd(column.id)}
          >
            <Plus size={15} /> Add a task
          </Action>
        )}
      </div>
    </section>
  );
}
export function TaskBoard(props: Props) {
  const { tasks, allTasks, view, columns } = props;
  const [dragging, setDragging] = useState<{ task: Task; expanded: boolean } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnCoordinates }),
  );
  const childrenByParent = useMemo(() => {
    const m = new Map<string, Task[]>();
    allTasks.forEach((t) => {
      if (t.parentId && !t.deletedAt && !t.mergedInto) {
        const list = m.get(t.parentId) || [];
        list.push(t);
        m.set(t.parentId, list);
      }
    });
    return m;
  }, [allTasks]);
  const visibleIDs = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks]);
  const top = tasks.filter((t) => !t.parentId || !visibleIDs.has(t.parentId));
  const scroll = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: top.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 84,
    overscan: 8,
  });
  const move = async (e: DragEndEvent) => {
    setDragging(null);
    if (!e.over) return;
    const task = allTasks.find((t) => t.id === String(e.active.id));
    if (task && task.status !== e.over.id)
      await props.onChange({ ...task, status: String(e.over.id) });
  };
  if (!tasks.length)
    return (
      <Empty
        title="A clear space to start."
        action={
          <Button onClick={() => props.onAdd()}>
            <Plus size={16} />
            Create a task
          </Button>
        }
      >
        Add your next move, or let a local agent bring useful work here. Nothing
        is added without a real action.
      </Empty>
    );
  if (view === "list")
    return (
      <div className="task-list" ref={scroll}>
        <div className="list-caption">
          <span>Task</span>
          <span>Status</span>
        </div>
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const t = top[item.index];
            return (
              <div
                key={t.id}
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <TaskCard
                  task={t}
                  childrenTasks={childrenByParent.get(t.id) || []}
                  props={props}
                  compact
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  return (
    <DndContext
      sensors={sensors}
      accessibility={{ screenReaderInstructions: { draggable: "Press Space or Enter to lift a task. Use Left and Right to choose a workflow column. Press Space or Enter to drop, or Escape to cancel." } }}
      onDragStart={(e) =>
        setDragging(e.active.data.current as { task: Task; expanded: boolean })
      }
      onDragCancel={() => setDragging(null)}
      onDragEnd={move}
    >
      <div className="kanban">
        {[...columns]
          .sort((a, b) => a.order - b.order)
          .map((c) => (
            <BoardColumn
              key={c.id}
              column={c}
              tasks={top.filter((t) => t.status === c.id)}
              childrenByParent={childrenByParent}
              props={props}
            />
          ))}
      </div>
      {/* Page transitions use filters/transforms, which establish a containing
          block for fixed elements. Keep drag geometry in viewport coordinates. */}
      {createPortal(<DragOverlay zIndex={40} dropAnimation={null} style={{ pointerEvents: "none" }}>
        {dragging && <div aria-hidden="true" inert>
          <TaskCard task={dragging.task} childrenTasks={childrenByParent.get(dragging.task.id) || []} props={props} preview initiallyExpanded={dragging.expanded} />
        </div>}
      </DragOverlay>, document.body)}
    </DndContext>
  );
}
