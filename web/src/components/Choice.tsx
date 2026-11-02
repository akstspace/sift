import type { ComponentProps } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export type ChoiceOption = { value: string; label: string; disabled?: boolean };
// Radix reserves the empty string for its placeholder. Keep domain values
// unchanged, including "no project", "all tasks", and Pi's explicit default.
const empty = "__sift_empty_choice__";
export function Choice({ value, onValueChange, options, placeholder = "Choose…", disabled, required, name, ...props }: Omit<ComponentProps<typeof SelectTrigger>, "onChange" | "value"> & {
  value: string;
  onValueChange: (value: string) => void;
  options: ChoiceOption[];
  placeholder?: string;
  required?: boolean;
  name?: string;
}) {
  return <Select value={value || empty} onValueChange={v => onValueChange(v === empty ? "" : v)} disabled={disabled} required={required} name={name}>
    <SelectTrigger {...props}><SelectValue placeholder={placeholder} /></SelectTrigger>
    <SelectContent position="popper" align="start" sideOffset={5}>
      {options.map(option => <SelectItem key={option.value} value={option.value || empty} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
