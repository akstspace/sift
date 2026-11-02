import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { IconCheck as Check, IconPencil as Pencil } from "@tabler/icons-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export type TaskTitleHandle = { focus: () => void };

/** Existing tasks open for reading. Renaming is explicit and reversible;
 * changes still belong to the task draft until Save changes is chosen. */
export function TaskTitle({ value, isNew, onChange, ref }: {
  value: string;
  isNew: boolean;
  onChange: (value: string) => void;
  ref?: Ref<TaskTitleHandle>;
}) {
  const [editing, setEditing] = useState(isNew);
  const beforeEdit = useRef(value);
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => {
    if (editing) input.current?.focus();
    else heading.current?.focus();
  } }), [editing]);
  useEffect(() => { if (editing && !isNew) input.current?.focus(); }, [editing, isNew]);
  const finish = () => {
    if (!value.trim()) {
      input.current?.setCustomValidity("Enter a task title.");
      input.current?.reportValidity();
      return;
    }
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  };
  return <div className="task-title-content">
    {editing ? <Textarea ref={input} required maxLength={500} aria-label="Task title"
      placeholder="What needs to move forward?" value={value} rows={2}
      onChange={event => { event.target.setCustomValidity(""); onChange(event.target.value); }}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!isNew) finish();
        }
        if (event.key === "Escape" && !isNew) {
          event.preventDefault(); event.stopPropagation();
          onChange(beforeEdit.current); setEditing(false);
          requestAnimationFrame(() => editButton.current?.focus());
        }
      }} /> : <h2 ref={heading} tabIndex={-1} className="task-title-heading">{value}</h2>}
    {!isNew && <Button ref={editButton} type="button" variant="ghost" size="icon"
      className="task-title-edit" aria-label={editing ? "Finish editing title" : "Edit task title"}
      title={editing ? "Finish editing title" : "Edit task title"}
      onClick={() => {
        if (editing) finish();
        else { beforeEdit.current = value; setEditing(true); }
      }}>{editing ? <Check size={17} /> : <Pencil size={17} />}</Button>}
  </div>;
}
