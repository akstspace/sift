import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { DraftGuardProvider, useDraftGuard, useDraftProtection } from "./DraftGuard";

function Protected({ dirty = false, busy = false, action }: { dirty?: boolean; busy?: boolean; action: () => void }) {
  useDraftProtection(dirty, busy); const { guard } = useDraftGuard();
  return <button onClick={() => guard(action)}>Leave view</button>;
}
describe("draft protection", () => {
  it("allows clean navigation without a confirmation", async () => {
    const action = vi.fn(); render(<DraftGuardProvider><Protected action={action} /></DraftGuardProvider>);
    await userEvent.click(screen.getByText("Leave view")); expect(action).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
  });
  it("keeps drafts on cancellation and runs only the confirmed action", async () => {
    const action = vi.fn(); const user = userEvent.setup();
    const { unmount } = render(<DraftGuardProvider><Protected dirty action={action} /></DraftGuardProvider>);
    await user.click(screen.getByText("Leave view")); expect(screen.getByRole("alertdialog")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Keep editing" })); expect(action).not.toHaveBeenCalled();
    await user.click(screen.getByText("Leave view"));
    await user.click(screen.getByRole("button", { name: "Discard changes" })); expect(action).toHaveBeenCalledOnce();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    unmount(); const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean); expect(clean.defaultPrevented).toBe(false);
  });
  it("blocks leaving during operations even when a draft is dirty", () => {
    const action = vi.fn(); const info = vi.spyOn(toast, "info").mockReturnValue(1);
    const { rerender } = render(<DraftGuardProvider><Protected dirty busy action={action} /></DraftGuardProvider>);
    fireEvent.click(screen.getByText("Leave view")); expect(action).not.toHaveBeenCalled(); expect(info).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    rerender(<DraftGuardProvider><Protected action={action} /></DraftGuardProvider>);
    fireEvent.click(screen.getByText("Leave view")); expect(action).toHaveBeenCalledOnce();
  });
  it("asks about one draft only when guarding its own scope", async () => {
    const own = vi.fn(), all = vi.fn(); const user = userEvent.setup();
    function Scoped({ dirty }: { dirty: boolean }) {
      const scope = useDraftProtection(dirty, false); const { guard } = useDraftGuard();
      return <><button onClick={() => guard(own, scope)}>Close editor</button><button onClick={() => guard(all)}>Leave everything</button></>;
    }
    const { rerender } = render(<DraftGuardProvider><Protected dirty action={vi.fn()} /><Scoped dirty={false} /></DraftGuardProvider>);
    // Another view's draft doesn't stop a clean editor from closing.
    await user.click(screen.getByText("Close editor")); expect(own).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByText("Leave everything")); expect(screen.getByRole("alertdialog")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Keep editing" })); expect(all).not.toHaveBeenCalled();
    rerender(<DraftGuardProvider><Protected dirty action={vi.fn()} /><Scoped dirty /></DraftGuardProvider>);
    await user.click(screen.getByText("Close editor")); expect(screen.getByRole("alertdialog")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Discard changes" })); expect(own).toHaveBeenCalledTimes(2);
  });
  it("fails clearly when used outside its provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(useDraftGuard)).toThrow("Draft guard provider is missing");
  });
});
