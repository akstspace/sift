import { useId, useState, type ComponentProps } from "react";
import { IconCalendar as CalendarDays } from "@tabler/icons-react";
import { format, isValid, parseISO } from "date-fns";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Calendar } from "./ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function DateChoice({ value, onValueChange, placeholder = "Set date", ...props }: Omit<ComponentProps<typeof Button>, "onChange" | "value"> & { value: string; onValueChange: (value: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value), [error, setError] = useState("");
  const errorId = useId();
  const selected = value ? parseISO(value) : undefined;
  const apply = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft) || !isValid(parseISO(draft))) {
      setError("Enter a valid date as YYYY-MM-DD.");
      return;
    }
    onValueChange(draft); setOpen(false);
  };
  return <Popover open={open} onOpenChange={next => { setDraft(value); setError(""); setOpen(next); }}>
    <PopoverTrigger asChild><Button type="button" variant="outline" className={"date-choice " + (!value ? "date-choice-empty" : "")} {...props}>
      <span>{selected ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(selected) : placeholder}</span><CalendarDays size={15} aria-hidden="true" />
    </Button></PopoverTrigger>
    <PopoverContent className="date-choice-content" align="start" sideOffset={6}>
      <div className="date-choice-entry">
        <Input aria-label="Date (YYYY-MM-DD)" aria-invalid={!!error} aria-describedby={error ? errorId : undefined} placeholder="YYYY-MM-DD" value={draft} onChange={e => { setDraft(e.target.value); setError(""); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); apply(); } }} />
        <Button type="button" variant="outline" size="sm" onClick={apply}>Set date</Button>
      </div>
      {error && <p id={errorId} role="alert" className="error">{error}</p>}
      <Calendar mode="single" selected={selected} defaultMonth={selected} autoFocus onSelect={day => { onValueChange(day ? format(day, "yyyy-MM-dd") : ""); setOpen(false); }} />
      <div className="date-choice-actions"><Button type="button" variant="ghost" size="sm" onClick={() => { onValueChange(format(new Date(), "yyyy-MM-dd")); setOpen(false); }}>Today</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!value} onClick={() => { onValueChange(""); setOpen(false); }}>Clear date</Button></div>
    </PopoverContent>
  </Popover>;
}
