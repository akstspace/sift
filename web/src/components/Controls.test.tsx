import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { format } from "date-fns";
import { toast } from "sonner";
import { deferred, TestProviders } from "../test/fixtures";
import { DateChoice } from "./DateChoice";
import { InstallApp } from "./InstallApp";
import { Choice } from "./Choice";
import { SearchChoice } from "./SearchChoice";
import { Busy, CloseButton, Confirm, CopyButton, Field, Mark, NextButton, TaskIcon } from "./shared";
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async original => ({ ...await original<typeof import("motion/react")>(), useReducedMotion: () => preference.reduced }));
beforeEach(() => { preference.reduced = false; });

describe("local calendar choices", () => {
  function Dates({ initial = "2026-01-02" }) {
    const [value, setValue] = useState(initial);
    return <><DateChoice aria-label="Due date" value={value} onValueChange={setValue} /><output aria-label="Stored date">{value}</output></>;
  }
  it("selects a calendar day, navigates months, and never uses a native date/select control", async () => {
    const user = userEvent.setup(); render(<Dates />, { wrapper: TestProviders });
    await user.click(screen.getByRole("button", { name: "Due date" }));
    expect(screen.getByText("January 2026")).toBeDefined(); expect(document.querySelector('input[type="date"],select')).toBeNull();
    await user.click(screen.getByRole("button", { name: /next month/i })); expect(screen.getByText("February 2026")).toBeDefined();
    await user.click(screen.getByRole("button", { name: /previous month/i }));
    await user.click(screen.getByRole("button", { name: /Saturday, January 3rd, 2026/ }));
    expect(screen.getByRole("status", { name: "Stored date" }).textContent).toBe("2026-01-03");
    await waitFor(() => expect(screen.queryByText("January 2026")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Due date" }));
  });
  it("can deselect the selected day or clear explicitly, and Today uses the local civil date", async () => {
    const user = userEvent.setup(); render(<Dates />, { wrapper: TestProviders });
    await user.click(screen.getByRole("button", { name: "Due date" }));
    await user.click(screen.getByRole("button", { name: /Friday, January 2nd, 2026/ }));
    expect(screen.getByRole("status", { name: "Stored date" }).textContent).toBe("");
    await user.click(screen.getByRole("button", { name: "Due date" }));
    expect((screen.getByRole("button", { name: "Clear date" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("status", { name: "Stored date" }).textContent).toBe(format(new Date(), "yyyy-MM-dd"));
    await user.click(screen.getByRole("button", { name: "Due date" })); await user.click(screen.getByRole("button", { name: "Clear date" }));
    expect(screen.getByRole("status", { name: "Stored date" }).textContent).toBe("");
  });
});

describe("shared accessibility and deliberate actions", () => {
  it("keeps the gather mark visible without spatial motion when requested", async () => {
    preference.reduced = true; render(<Mark animate />);
    await waitFor(() => expect(document.querySelectorAll(".sift-mark rect")).toHaveLength(7));
    expect(document.querySelector(".sift-mark")).toBeDefined();
  });
  it("round-trips empty domain choices and resets searchable queries after dismissal", async () => {
    const change = vi.fn(), user = userEvent.setup();
    render(<><Choice aria-label="Project" value="p" onValueChange={change} options={[{ value: "", label: "No project" }, { value: "p", label: "Project" }]} /><SearchChoice aria-label="Parent" value="missing" onValueChange={change} options={[{ value: "p", label: "Parent evidence" }]} /></>, { wrapper: TestProviders });
    await user.click(screen.getByRole("combobox", { name: "Project" })); await user.click(screen.getByRole("option", { name: "No project" })); expect(change).toHaveBeenCalledWith("");
    expect(screen.getByRole("combobox", { name: "Parent" }).textContent).toContain("Choose…");
    await user.click(screen.getByRole("combobox", { name: "Parent" })); await user.type(screen.getByRole("combobox", { name: "Search choices" }), "nothing matches");
    expect(screen.getByText("No matches found.")).toBeDefined(); await user.keyboard("{Escape}");
    await user.click(screen.getByRole("combobox", { name: "Parent" })); expect((screen.getByRole("combobox", { name: "Search choices" }) as HTMLInputElement).value).toBe("");
    await user.click(screen.getByRole("option", { name: "Parent evidence" })); expect(change).toHaveBeenLastCalledWith("p");
  });
  it("associates labels and hints without replacing explicit control names", () => {
    render(<><Field label="A useful label" hint="Local hint"><input /></Field><Field label="Visual label"><input id="existing" aria-label="Explicit name" aria-describedby="existing-help" /></Field><Field label="A group"><span>One</span><span>Two</span></Field><Field label="Text only">Plain content</Field></>);
    const field = screen.getByRole("textbox", { name: "A useful label" });
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe("Local hint");
    expect(screen.getByRole("textbox", { name: "Explicit name" }).getAttribute("aria-describedby")).toBe("existing-help");
    expect(document.querySelector('label[for="existing"]')?.textContent).toBe("Visual label");
    expect(screen.getByText("Plain content")).toBeDefined();
  });
  it("copies only on request, acknowledges success, resets, and reports denied clipboard access", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {}); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const error = vi.spyOn(toast, "error").mockReturnValue(1);
    const { unmount } = render(<CopyButton text="sift tasks list" />);
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy command" })));
    expect(writeText).toHaveBeenCalledWith("sift tasks list"); expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
    await act(async () => vi.advanceTimersByTime(1800));
    writeText.mockRejectedValueOnce(new Error("Denied"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy command" })));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Allow clipboard access"));
    unmount(); vi.useRealTimers();
  });
  it("keeps a failing confirmation open for retry and cannot dismiss an in-flight mutation", async () => {
    const user = userEvent.setup(); const pending = deferred<unknown>();
    const action = vi.fn().mockRejectedValueOnce(new Error("Workspace is busy")).mockReturnValueOnce(pending.promise);
    render(<Confirm title="Remove evidence" description="Only this selected item" action={action} destructive>{open => <button onClick={open}>Review removal</button>}</Confirm>, { wrapper: TestProviders });
    await user.click(screen.getByRole("button", { name: "Review removal" })); await user.click(screen.getByRole("button", { name: "Cancel" })); expect(action).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Review removal" })); await user.click(screen.getByRole("button", { name: "Remove evidence" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Workspace is busy");
    await user.click(screen.getByRole("button", { name: "Remove evidence" }));
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}"); expect(screen.getByRole("alertdialog")).toBeDefined();
    await act(async () => pending.resolve({}));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull()); expect(action).toHaveBeenCalledTimes(2);
  });
  it("renders only a same-origin catalog symbol, safe unknown fallback, and accessible action helpers", async () => {
    const user = userEvent.setup(), close = vi.fn(), next = vi.fn();
    render(<><TaskIcon id="brand-slack" catalog={[{ id: "brand-slack", name: "Brand Slack", category: "Brand", symbol: "ti-brand-slack", aliases: [] }]} /><TaskIcon id="unknown" catalog={[]} /><TaskIcon id="bad" catalog={[{ id: "bad", name: "Invalid", category: "System", symbol: "https://example.com/icon.svg#bad", aliases: [] }]} /><TaskIcon id="missing" catalog={[{ id: "missing", name: "Missing", category: "System", aliases: [] }]} /><Mark animate /><Busy /><CloseButton onClick={close} /><NextButton onClick={next} /></>, { wrapper: TestProviders });
    expect(document.querySelector('.tabler-task-icon use')?.getAttribute("href")).toBe("/tabler-icons.svg#ti-brand-slack");
    expect(document.querySelectorAll("use")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Working…");
    await user.click(screen.getByRole("button", { name: "Close" })); await user.click(screen.getByRole("button", { name: "Continue" })); expect(close).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce();
  });
  it("shows app-window guidance and updates the installed state from the browser event", async () => {
    const user = userEvent.setup(); render(<InstallApp />, { wrapper: TestProviders });
    await user.click(screen.getByRole("button", { name: "Install Sift as an app" }));
    expect(within(screen.getByRole("dialog")).getByText(/Safari on macOS/)).toBeDefined(); await user.keyboard("{Escape}");
    act(() => window.dispatchEvent(new Event("appinstalled")));
    expect((screen.getByRole("button", { name: "App window installed" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
