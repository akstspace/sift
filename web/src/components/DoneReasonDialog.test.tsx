import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { deferred, TestProviders } from "../test/fixtures";
import { DoneReasonDialog } from "./DoneReasonDialog";

describe("Done reason confirmation", () => {
  it("requires nonblank text and allows cancellation without completing", async () => {
    const onConfirm = vi.fn(), onCancel = vi.fn(), user = userEvent.setup();
    render(<DoneReasonDialog title="Finish research" onConfirm={onConfirm} onCancel={onCancel} />, { wrapper: TestProviders });
    const input = screen.getByRole("textbox", { name: "Done reason" });
    expect(document.activeElement).toBe(input);
    expect((screen.getByRole("button", { name: "Mark Done" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(input.closest("form")!);
    await user.type(input, "   "); fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" })); expect(onCancel).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}"); expect(onCancel).toHaveBeenCalledTimes(2);
  });
  it("preserves a failed reason, trims it, and blocks duplicate submission and dismissal while saving", async () => {
    const pending = deferred<void>(), onConfirm = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined), onCancel = vi.fn(), user = userEvent.setup();
    render(<DoneReasonDialog title="Finish research" onConfirm={onConfirm} onCancel={onCancel} />, { wrapper: TestProviders });
    const input = screen.getByRole("textbox", { name: "Done reason" });
    await user.type(input, "  Verified the change  ");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true }); fireEvent.submit(input.closest("form")!);
    await user.keyboard("{Escape}");
    expect(onConfirm).toHaveBeenCalledOnce(); expect(onConfirm).toHaveBeenCalledWith("Verified the change"); expect(onCancel).not.toHaveBeenCalled();
    await act(async () => pending.reject(Error("Revision changed; reopen the task")));
    expect((await screen.findByRole("alert")).textContent).toContain("Revision changed");
    expect((input as HTMLTextAreaElement).value).toBe("  Verified the change  ");
    await user.click(screen.getByRole("button", { name: "Mark Done" })); expect(onConfirm).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Close" })); expect(onCancel).toHaveBeenCalledOnce();
  });
});
