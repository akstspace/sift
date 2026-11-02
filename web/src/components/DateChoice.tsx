import { useState, type ComponentProps } from "react";
import { IconCalendar as CalendarDays } from "@tabler/icons-react";
import { format, parseISO } from "date-fns";
import { Button } from "./ui/button";
import { Calendar } from "./ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function DateChoice({ value, onValueChange, ...props }: Omit<ComponentProps<typeof Button>, "onChange" | "value"> & { value: string; onValueChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = value ? parseISO(value) : undefined;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="outline" className={"date-choice " + (!value ? "date-choice-empty" : "")} {...props}>
      <span>{selected ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(selected) : "No date"}</span><CalendarDays size={15} aria-hidden="true" />
    </Button></PopoverTrigger>
    <PopoverContent className="date-choice-content" align="start" sideOffset={6}>
      <Calendar mode="single" selected={selected} defaultMonth={selected} autoFocus onSelect={day => { onValueChange(day ? format(day, "yyyy-MM-dd") : ""); setOpen(false); }} />
      <div className="date-choice-actions"><Button type="button" variant="ghost" size="sm" onClick={() => { onValueChange(format(new Date(), "yyyy-MM-dd")); setOpen(false); }}>Today</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!value} onClick={() => { onValueChange(""); setOpen(false); }}>Clear date</Button></div>
    </PopoverContent>
  </Popover>;
}
