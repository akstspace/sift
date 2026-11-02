import { useId, useMemo, useState, type ComponentProps } from "react";
import { IconCheck as Check, IconSelector as ChevronsUpDown } from "@tabler/icons-react";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import type { ChoiceOption } from "./Choice";

/** shadcn's Popover + Command combobox, with bounded results for large boards. */
export function SearchChoice({ value, onValueChange, options, placeholder = "Choose…", searchLabel = "Search choices", ...props }: Omit<ComponentProps<typeof Button>, "onChange" | "value"> & {
  value: string;
  onValueChange: (value: string) => void;
  options: ChoiceOption[];
  placeholder?: string;
  searchLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();
  const matches = useMemo(() => options.filter(o => (o.label + " " + o.value).toLocaleLowerCase().includes(query.toLocaleLowerCase())), [options, query]);
  const visible = matches.slice(0, 80);
  return <Popover open={open} onOpenChange={v => { setOpen(v); if (!v) setQuery(""); }}>
    <PopoverTrigger asChild><Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-controls={open ? listId : undefined} className="search-choice" {...props}>
      <span>{options.find(o => o.value === value)?.label || placeholder}</span><ChevronsUpDown aria-hidden="true" size={15} />
    </Button></PopoverTrigger>
    <PopoverContent className="search-choice-content" align="start" sideOffset={6}>
      <Command shouldFilter={false} label={searchLabel}>
        <CommandInput aria-label={searchLabel} placeholder={searchLabel + "…"} value={query} onValueChange={setQuery} />
        <CommandList id={listId} aria-label={searchLabel}>
          <CommandEmpty>No matches found.</CommandEmpty>
          <CommandGroup>{visible.map(option => <CommandItem key={option.value} value={option.value || "__sift_empty_choice__"} disabled={option.disabled} onSelect={() => { onValueChange(option.value); setOpen(false); setQuery(""); }}>
            <span className="search-choice-label">{option.label}</span>{value === option.value && <Check size={15} aria-hidden="true" />}
          </CommandItem>)}</CommandGroup>
        </CommandList>
        {matches.length > visible.length && <p className="choice-more">{matches.length} matches. Keep typing to narrow the list.</p>}
      </Command>
    </PopoverContent>
  </Popover>;
}

export function TimezoneChoice({ value, onValueChange, ...props }: Omit<ComponentProps<typeof SearchChoice>, "options" | "searchLabel">) {
  const options = useMemo(() => [...new Set(["UTC", value, ...Intl.supportedValuesOf("timeZone")])].filter(Boolean).sort().map(t => ({ value: t, label: t.replaceAll("_", " ") })), [value]);
  return <SearchChoice value={value} onValueChange={onValueChange} options={options} searchLabel="Search timezones" {...props} />;
}
