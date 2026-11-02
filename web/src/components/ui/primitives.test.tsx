import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Badge } from "./badge";
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator, BreadcrumbEllipsis } from "./breadcrumb";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter } from "./card";
import { Progress } from "./progress";
import { Skeleton } from "./skeleton";
import { Switch } from "./switch";
import { Toggle } from "./toggle";
import { Sheet, SheetContent, SheetTrigger, SheetClose, SheetHeader, SheetFooter, SheetTitle, SheetDescription } from "./sheet";
import { SidebarProvider, Sidebar, SidebarInset, SidebarInput, SidebarSeparator, SidebarGroup, SidebarGroupLabel, SidebarGroupContent, SidebarGroupAction, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuAction, SidebarMenuSkeleton, SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton, SidebarRail } from "./sidebar";
import * as Menu from "./dropdown-menu";
import * as Dialog from "./dialog";
import * as Alert from "./alert-dialog";
import * as Select from "./select";

describe("shared shadcn contracts", () => {
  it("gives grouped choices proper labels and keeps disabled values unselectable", async () => {
    const change = vi.fn(); render(<Select.Select onValueChange={change}><Select.SelectTrigger aria-label="Workflow"><Select.SelectValue placeholder="Choose workflow" /></Select.SelectTrigger><Select.SelectContent><Select.SelectGroup><Select.SelectLabel>Active work</Select.SelectLabel><Select.SelectItem value="open">Open</Select.SelectItem><Select.SelectItem value="blocked" disabled>Blocked</Select.SelectItem></Select.SelectGroup><Select.SelectSeparator /><Select.SelectItem value="done">Done</Select.SelectItem></Select.SelectContent></Select.Select>);
    const user = userEvent.setup(); await user.click(screen.getByRole("combobox", { name: "Workflow" }));
    expect(screen.getByRole("group", { name: "Active work" })).toBeDefined(); expect(screen.getByRole("option", { name: "Blocked" }).getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("option", { name: "Done" })); expect(change).toHaveBeenCalledWith("done");
  });
  it("offers named dialog close actions and explicit alert confirmation without accidental execution", async () => {
    const action = vi.fn(); render(<><Dialog.Dialog><Dialog.DialogTrigger>Review details</Dialog.DialogTrigger><Dialog.DialogContent showCloseButton={false}><Dialog.DialogTitle>Details</Dialog.DialogTitle><Dialog.DialogDescription>Local workspace detail</Dialog.DialogDescription><Dialog.DialogClose>Keep work</Dialog.DialogClose><Dialog.DialogFooter showCloseButton /></Dialog.DialogContent></Dialog.Dialog><Alert.AlertDialog><Alert.AlertDialogTrigger>Review action</Alert.AlertDialogTrigger><Alert.AlertDialogContent><Alert.AlertDialogHeader><Alert.AlertDialogMedia>!</Alert.AlertDialogMedia><Alert.AlertDialogTitle>Confirm local action</Alert.AlertDialogTitle><Alert.AlertDialogDescription>No changes until confirmed</Alert.AlertDialogDescription></Alert.AlertDialogHeader><Alert.AlertDialogFooter><Alert.AlertDialogCancel>Cancel action</Alert.AlertDialogCancel><Alert.AlertDialogAction onClick={action}>Confirm action</Alert.AlertDialogAction></Alert.AlertDialogFooter></Alert.AlertDialogContent></Alert.AlertDialog></>);
    const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Review details" })); await user.click(screen.getByRole("button", { name: "Close" })); expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Review details" })); await user.click(screen.getByRole("button", { name: "Keep work" }));
    await user.click(screen.getByRole("button", { name: "Review action" })); expect(action).not.toHaveBeenCalled(); await user.click(screen.getByRole("button", { name: "Cancel action" }));
    await user.click(screen.getByRole("button", { name: "Review action" })); await user.click(screen.getByRole("button", { name: "Confirm action" })); expect(action).toHaveBeenCalledOnce(); expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("preserves card content, link semantics, custom separators, and progress values", async () => {
    const action = vi.fn(); render(<><Card className="example"><CardHeader><CardTitle>Evidence</CardTitle><CardDescription>Reviewed results</CardDescription><CardAction><button onClick={action}>Inspect</button></CardAction></CardHeader><CardContent><Badge>Local</Badge><Badge asChild><a href="#item">Linked badge</a></Badge><Skeleton aria-label="Loading details" /><Progress aria-label="Completion" value={25} /><Progress aria-label="Not started" /></CardContent><CardFooter>Footer evidence</CardFooter></Card><Breadcrumb><BreadcrumbList><BreadcrumbItem><BreadcrumbLink href="#root">Root</BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbLink asChild><a href="#parent">Parent</a></BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator>/</BreadcrumbSeparator><BreadcrumbItem><BreadcrumbEllipsis /><BreadcrumbPage>Current</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb></>);
    await userEvent.setup().click(screen.getByRole("button", { name: "Inspect" })); expect(action).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Root" }).getAttribute("href")).toBe("#root");
    expect(screen.getByRole("link", { name: "Current" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("progressbar", { name: "Completion" }).getAttribute("aria-valuenow")).toBe("25");
    expect(document.querySelector('[data-slot="progress-indicator"]')?.getAttribute("style")).toContain("-75%");
    expect(screen.getByText("Footer evidence")).toBeDefined();
  });
  it("supports keyboard switch and toggle state without native select menus", async () => {
    function Controls() { const [checked, setChecked] = useState(false); return <><Switch aria-label="Notify me" checked={checked} onCheckedChange={setChecked} /><Toggle aria-label="Pin task">Pin</Toggle></>; }
    render(<Controls />); const user = userEvent.setup(); screen.getByRole("switch").focus(); await user.keyboard(" ");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"); await user.click(screen.getByRole("button", { name: "Pin task" }));
    expect(screen.getByRole("button", { name: "Pin task" }).getAttribute("aria-pressed")).toBe("true");
  });
  it.each(["top", "right", "bottom", "left"] as const)("sheets have named content, footer actions, and focus restoration on the %s", async side => {
    render(<Sheet><SheetTrigger>Open sheet</SheetTrigger><SheetContent side={side}><SheetHeader><SheetTitle>Sheet evidence</SheetTitle><SheetDescription>Only deliberate changes</SheetDescription></SheetHeader><SheetFooter><SheetClose>Keep workspace</SheetClose></SheetFooter></SheetContent></Sheet>);
    const user = userEvent.setup(), trigger = screen.getByRole("button", { name: "Open sheet" }); await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Sheet evidence" })).toBeDefined(); await user.click(screen.getByRole("button", { name: "Keep workspace" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("composes optional sidebar content and submenu links while preserving button behavior", async () => {
    const edit = vi.fn(); render(<SidebarProvider><Sidebar side="right" variant="floating"><SidebarInput aria-label="Find project" /><SidebarSeparator /><SidebarGroup><SidebarGroupLabel asChild><h2>Projects</h2></SidebarGroupLabel><SidebarGroupAction asChild><button onClick={edit}>Edit projects</button></SidebarGroupAction><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild variant="outline" tooltip={{ children: "Project details" }}><a href="#project">Project details</a></SidebarMenuButton><SidebarMenuAction showOnHover asChild><button onClick={edit}>Rename</button></SidebarMenuAction><SidebarMenuSkeleton showIcon /><SidebarMenuSkeleton /><SidebarMenuSub><SidebarMenuSubItem><SidebarMenuSubButton size="sm" isActive href="#child">Small child</SidebarMenuSubButton><SidebarMenuSubButton asChild><a href="#other">Other child</a></SidebarMenuSubButton></SidebarMenuSubItem></SidebarMenuSub></SidebarMenuItem><SidebarMenuItem><SidebarMenuAction onClick={edit}>Archive</SidebarMenuAction></SidebarMenuItem></SidebarMenu></SidebarGroupContent></SidebarGroup><SidebarRail /></Sidebar><SidebarInset>Workspace</SidebarInset></SidebarProvider>);
    const user = userEvent.setup(); await user.type(screen.getByRole("textbox", { name: "Find project" }), "Sift"); await user.click(screen.getByRole("button", { name: "Rename" })); await user.click(screen.getByRole("button", { name: "Archive" })); expect(edit).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link", { name: "Small child" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("link", { name: "Other child" }).getAttribute("href")).toBe("#other"); fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe("collapsed");
  });
  it("supports menu checkbox/radio selection, disabled items, shortcuts, and nested commands", async () => {
    const select = vi.fn(), checked = vi.fn(), radio = vi.fn();
    render(<Menu.DropdownMenu><Menu.DropdownMenuTrigger>Task menu</Menu.DropdownMenuTrigger><Menu.DropdownMenuContent><Menu.DropdownMenuLabel inset>Task actions</Menu.DropdownMenuLabel><Menu.DropdownMenuGroup><Menu.DropdownMenuItem inset onSelect={select}>Inspect<Menu.DropdownMenuShortcut>⌘I</Menu.DropdownMenuShortcut></Menu.DropdownMenuItem><Menu.DropdownMenuItem disabled>Unavailable</Menu.DropdownMenuItem><Menu.DropdownMenuItem variant="destructive">Trash</Menu.DropdownMenuItem></Menu.DropdownMenuGroup><Menu.DropdownMenuSeparator /><Menu.DropdownMenuCheckboxItem checked onCheckedChange={checked}>Today</Menu.DropdownMenuCheckboxItem><Menu.DropdownMenuRadioGroup value="open" onValueChange={radio}><Menu.DropdownMenuRadioItem value="open">Open</Menu.DropdownMenuRadioItem><Menu.DropdownMenuRadioItem value="done">Done</Menu.DropdownMenuRadioItem></Menu.DropdownMenuRadioGroup><Menu.DropdownMenuSub><Menu.DropdownMenuSubTrigger inset>More</Menu.DropdownMenuSubTrigger><Menu.DropdownMenuPortal><Menu.DropdownMenuSubContent><Menu.DropdownMenuItem onSelect={select}>Nested command</Menu.DropdownMenuItem></Menu.DropdownMenuSubContent></Menu.DropdownMenuPortal></Menu.DropdownMenuSub></Menu.DropdownMenuContent></Menu.DropdownMenu>);
    const user = userEvent.setup(), trigger = screen.getByRole("button", { name: "Task menu" });
    await user.click(trigger); expect(screen.getByRole("menuitem", { name: "Unavailable" }).getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Today" })); expect(checked).toHaveBeenCalledWith(false);
    await user.click(trigger); await user.click(screen.getByRole("menuitemradio", { name: "Done" })); expect(radio).toHaveBeenCalledWith("done");
    await user.click(trigger); await user.click(screen.getByRole("menuitem", { name: "More" }));
    const nested = await screen.findByRole("menuitem", { name: "Nested command" }); nested.focus(); await user.keyboard("{Enter}"); expect(select).toHaveBeenCalledOnce();
  });
});
