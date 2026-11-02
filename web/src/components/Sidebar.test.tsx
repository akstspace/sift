import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "./AppSidebar";
import { Sidebar, SidebarProvider, SidebarTrigger, SidebarMenuButton, useSidebar } from "./ui/sidebar";
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async original => ({ ...await original<typeof import("motion/react")>(), useReducedMotion: () => preference.reduced }));
beforeEach(() => { preference.reduced = false; });

function responsive(mobile: boolean) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mobile ? 390 : 1440 });
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("767px") && mobile, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
}
function mount(mobile = false) {
  responsive(mobile);
  const props = { page: "backlog", project: "p0", projects: Array.from({ length: 12 }, (_, i) => ({ id: "p" + i, name: "Project " + i, color: "sea", icon: "folder", archived: i === 11 })), counts: { today: 2, backlog: 5, jobs: undefined }, version: "fixture", navigate: vi.fn(), openProject: vi.fn(), addTask: vi.fn(), showHelp: vi.fn() };
  return { ...render(<SidebarProvider><SidebarTrigger /><AppSidebar {...props} /></SidebarProvider>), props, user: userEvent.setup() };
}
describe("responsive workspace navigation", () => {
  it("retains the selected destination and collapse action with reduced motion", async () => {
    preference.reduced = true; const { user } = mount();
    expect(screen.getByRole("button", { name: "Project 0" }).getAttribute("aria-current")).toBe("page");
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" })); expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeDefined();
  });
  it("limits active projects, highlights the selected destination, and routes every sidebar action", async () => {
    const { props, user } = mount();
    expect(screen.queryByRole("button", { name: "Project 10" })).toBeNull(); expect(screen.queryByRole("button", { name: "Project 11" })).toBeNull();
    expect(screen.getByRole("button", { name: "Project 0" }).getAttribute("aria-current")).toBe("page");
    for (const [label, page] of [["Today", "today"], ["Backlog", "backlog"], ["Projects & tags", "organization"], ["Agents", "jobs"], ["Run history", "runs"], ["Settings", "settings"], ["Trash", "trash"], ["Manage projects", "organization"]]) {
      await user.click(screen.getByRole("button", { name: label })); expect(props.navigate).toHaveBeenLastCalledWith(page);
    }
    await user.click(screen.getByRole("button", { name: "New task" })); expect(props.addTask).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Project 1" })); expect(props.openProject).toHaveBeenCalledWith("p1");
    await user.click(screen.getByRole("button", { name: "Help and shortcuts" })); expect(props.showHelp).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("link", { name: "Sift home" })); expect(props.navigate).toHaveBeenLastCalledWith("today");
  });
  it("collapses with the keyboard except while typing, and persists the explicit toggle", async () => {
    const { user } = mount(); fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(screen.getByRole("button", { name: "Expand sidebar" }).getAttribute("aria-expanded")).toBe("false");
    expect(document.cookie).toContain("sidebar_state=false");
    const input = document.createElement("input"); document.body.append(input); fireEvent.keyDown(input, { key: "b", ctrlKey: true });
    fireEvent.keyDown(input, { key: "b", metaKey: true });
    const editable = document.createElement("div"); editable.contentEditable = "true";
    Object.defineProperty(editable, "isContentEditable", { value: true }); document.body.append(editable);
    fireEvent.keyDown(editable, { key: "b", ctrlKey: true }); editable.remove();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeDefined(); input.remove();
    await user.click(screen.getByRole("button", { name: "Expand sidebar" })); expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeDefined();
  });
  it("uses a modal drawer on mobile and returns focus to its trigger after navigation or dismissal", async () => {
    const { props, user } = mount(true); const trigger = screen.getByRole("button", { name: "Open navigation" });
    expect(screen.queryByRole("dialog")).toBeNull(); await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Workspace navigation" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Project 1" })); expect(props.openProject).toHaveBeenCalledWith("p1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.click(trigger); await user.click(screen.getByRole("button", { name: "Close navigation" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(window, { key: "b", ctrlKey: true }); expect(await screen.findByRole("dialog")).toBeDefined();
    await user.keyboard("{Escape}"); await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it("offers an explicit first project action and supports controlled and fixed sidebars", async () => {
    responsive(false); const navigate = vi.fn(), change = vi.fn();
    const props = { page: "today", project: "", projects: [], counts: {}, version: "fixture", navigate, openProject: vi.fn(), addTask: vi.fn(), showHelp: vi.fn() };
    const { rerender } = render(<SidebarProvider open onOpenChange={change}><SidebarTrigger /><AppSidebar {...props} /></SidebarProvider>);
    const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Create a project" })); expect(navigate).toHaveBeenCalledWith("organization");
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" })); expect(change).toHaveBeenCalledWith(false);
    rerender(<SidebarProvider><Sidebar collapsible="none">Fixed navigation</Sidebar></SidebarProvider>); expect(screen.getByText("Fixed navigation")).toBeDefined();
  });
  it("accepts explicit sidebar state and renders a plain menu action without a tooltip", async () => {
    responsive(false);
    function Direct() { const { setOpen } = useSidebar(); return <SidebarMenuButton onClick={() => setOpen(false)}>Close directly</SidebarMenuButton>; }
    render(<SidebarProvider><SidebarTrigger /><Direct /></SidebarProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Close directly" })); expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeDefined();
  });
  it("rejects sidebar consumers outside their provider", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(useSidebar)).toThrow("useSidebar must be used within a SidebarProvider"); log.mockRestore();
  });
});
