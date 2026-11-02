"use client"

import * as React from "react"
import { cn } from "cn"
import { IconChevronLeft as ChevronLeftIcon, IconChevronRight as ChevronRightIcon } from "@tabler/icons-react"
import { DayPicker, getDefaultClassNames, type DayButton } from "react-day-picker"
import { Button, buttonVariants } from "./button"

// shadcn Calendar, with label captions instead of native month/year dropdowns.
function Calendar({ className, classNames, showOutsideDays = true, components, ...props }: React.ComponentProps<typeof DayPicker>) {
  const defaults = getDefaultClassNames()
  return <DayPicker showOutsideDays={showOutsideDays} captionLayout="label"
    className={cn("group/calendar bg-background p-3 [--cell-size:2.25rem]", className)}
    classNames={{
      root: cn("w-fit", defaults.root),
      months: cn("relative flex flex-col gap-4", defaults.months),
      month: cn("flex w-full flex-col gap-3", defaults.month),
      nav: cn("absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1", defaults.nav),
      button_previous: cn(buttonVariants({ variant: "ghost" }), "size-(--cell-size) p-0 aria-disabled:opacity-50", defaults.button_previous),
      button_next: cn(buttonVariants({ variant: "ghost" }), "size-(--cell-size) p-0 aria-disabled:opacity-50", defaults.button_next),
      month_caption: cn("flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)", defaults.month_caption),
      caption_label: cn("text-sm font-medium select-none", defaults.caption_label),
      month_grid: cn("w-full border-collapse", defaults.month_grid),
      weekdays: cn("flex", defaults.weekdays),
      weekday: cn("flex-1 rounded-md text-xs font-normal text-muted-foreground select-none", defaults.weekday),
      week: cn("mt-1 flex w-full", defaults.week),
      day: cn("group/day relative aspect-square h-full w-full p-0 text-center select-none", defaults.day),
      today: cn("rounded-md bg-accent text-accent-foreground", defaults.today),
      outside: cn("text-muted-foreground", defaults.outside),
      disabled: cn("text-muted-foreground opacity-50", defaults.disabled),
      hidden: cn("invisible", defaults.hidden),
      ...classNames,
    }}
    components={{
      Root: ({ className, rootRef, ...props }) => <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />,
      Chevron: ({ orientation }) => orientation === "left" ? <ChevronLeftIcon className="size-4" /> : <ChevronRightIcon className="size-4" />,
      DayButton: CalendarDayButton,
      ...components,
    }} {...props} />
}
function CalendarDayButton({ className, day, modifiers, ...props }: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => { if (modifiers.focused) ref.current?.focus() }, [modifiers.focused])
  return <Button ref={ref} variant="ghost" size="icon" data-day={day.date.toLocaleDateString()}
    data-selected-single={modifiers.selected}
    className={cn("flex aspect-square size-(--cell-size) flex-col gap-1 leading-none font-normal group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground", className)}
    {...props} />
}
export { Calendar, CalendarDayButton }
