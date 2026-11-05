import { useId, useState, type ComponentProps } from "react";
import { IconCalendar as CalendarDays } from "@tabler/icons-react";
import { format, isValid, parseISO } from "date-fns";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Calendar } from "./ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const shortDate = (d: Date) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(d);

export function DateChoice({ value, onValueChange, placeholder = "Set date", max, required = false, ...props }: Omit<ComponentProps<typeof Button>, "onChange" | "value"> & {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** The latest day that can be chosen (YYYY-MM-DD). */
  max?: string;
  /** Always has a day: no "Clear date". */
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value), [error, setError] = useState("");
  const errorId = useId(), shownId = useId();
  const selected = value ? parseISO(value) : undefined;
  const latest = max ? parseISO(max) : undefined;
  const today = format(new Date(), "yyyy-MM-dd");
  const apply = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft) || !isValid(parseISO(draft))) {
      setError("Enter a valid date as YYYY-MM-DD.");
      return;
    }
    if (max && latest && draft > max) {
      setError(`Choose ${shortDate(latest)} or earlier.`);
      return;
    }
    onValueChange(draft); setOpen(false);
  };
  return <Popover open={open} onOpenChange={next => { setDraft(value); setError(""); setOpen(next); }}>
    {/* Named by its field's label and then what it shows ("Due date, 5 Nov 2026"), so the name holds the visible text. */}
    <PopoverTrigger asChild><Button type="button" variant="outline" className={"date-choice " + (!value ? "date-choice-empty" : "")} {...props}
      aria-labelledby={props["aria-labelledby"] ? `${props["aria-labelledby"]} ${shownId}` : undefined}>
      <span id={shownId}>{selected ? shortDate(selected) : placeholder}</span><CalendarDays size={15} aria-hidden="true" />
    </Button></PopoverTrigger>
    <PopoverContent className="date-choice-content" align="start" sideOffset={6}>
      <div className="date-choice-entry">
        <Input aria-label="Date (YYYY-MM-DD)" aria-invalid={!!error} aria-describedby={error ? errorId : undefined} placeholder="YYYY-MM-DD" value={draft} onChange={e => { setDraft(e.target.value); setError(""); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); apply(); } }} />
        <Button type="button" variant="outline" size="sm" onClick={apply}>Set date</Button>
      </div>
      {error && <p id={errorId} role="alert" className="error">{error}</p>}
      <Calendar mode="single" required={required} selected={selected} defaultMonth={selected} autoFocus disabled={latest ? { after: latest } : undefined}
        onSelect={(day: Date | undefined) => { if (day || !required) onValueChange(day ? format(day, "yyyy-MM-dd") : ""); setOpen(false); }} />
      <div className="date-choice-actions"><Button type="button" variant="ghost" size="sm" disabled={!!max && today > max} onClick={() => { onValueChange(today); setOpen(false); }}>Today</Button>
        {!required && <Button type="button" variant="ghost" size="sm" disabled={!value} onClick={() => { onValueChange(""); setOpen(false); }}>Clear date</Button>}</div>
    </PopoverContent>
  </Popover>;
}
