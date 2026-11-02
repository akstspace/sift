import { createRef, useState, type RefObject } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TaskTitle, type TaskTitleHandle } from "./TaskTitle";

function Draft({ isNew = false, value = "Read the research notes", handle }: {
  isNew?: boolean; value?: string; handle?: RefObject<TaskTitleHandle | null>;
}) {
  const [title, setTitle] = useState(value);
  return <TaskTitle ref={handle} value={title} isNew={isNew} onChange={setTitle} />;
}

describe("explicit task title editing", () => {
  it("opens existing tasks as a heading, without a textbox or caret", () => {
    const handle = createRef<TaskTitleHandle>(); render(<Draft handle={handle} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("heading").textContent).toBe("Read the research notes");
    expect(screen.getByRole("button", { name: "Edit task title" })).toBeDefined();
    handle.current!.focus(); expect(document.activeElement).toBe(screen.getByRole("heading"));
  });
  it("focuses the title only after explicit pencil activation", async () => {
    const user = userEvent.setup(); render(<Draft />);
    await user.click(screen.getByRole("button", { name: "Edit task title" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Task title" }));
    await user.clear(screen.getByRole("textbox")); await user.type(screen.getByRole("textbox"), "Renamed draft");
    await user.click(screen.getByRole("button", { name: "Finish editing title" }));
    expect(screen.getByRole("heading").textContent).toBe("Renamed draft");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button")));
  });
  it("Enter finishes a rename and returns keyboard focus to its pencil", async () => {
    const user = userEvent.setup(); render(<Draft />);
    await user.click(screen.getByRole("button")); await user.type(screen.getByRole("textbox"), " updated{Enter}");
    expect(screen.getByRole("heading").textContent).toBe("Read the research notes updated");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button")));
  });
  it("Escape cancels only the current rename without dismissing the sheet", async () => {
    const escape = vi.fn(); const user = userEvent.setup();
    render(<div onKeyDown={escape}><Draft /></div>);
    await user.click(screen.getByRole("button")); await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Accidental rename"); escape.mockClear();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading").textContent).toBe("Read the research notes");
    expect(escape).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button")));
  });
  it("cancellation restores the latest accepted draft, not the original task", async () => {
    const user = userEvent.setup(); render(<Draft />);
    await user.click(screen.getByRole("button")); await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "First rename{Enter}");
    await user.click(screen.getByRole("button")); await user.type(screen.getByRole("textbox"), " discarded{Escape}");
    expect(screen.getByRole("heading").textContent).toBe("First rename");
  });
  it("does not finish an empty or whitespace-only title; fixes validation on input", async () => {
    const user = userEvent.setup(); render(<Draft />);
    await user.click(screen.getByRole("button")); await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "   ");
    await user.click(screen.getByRole("button", { name: "Finish editing title" }));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.checkValidity()).toBe(false);
    await user.type(input, "Valid title{Enter}");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("new tasks start in writing mode and expose focus for the sheet", async () => {
    const handle = createRef<TaskTitleHandle>(); render(<Draft isNew value="" handle={handle} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.required).toBe(true); expect(input.maxLength).toBe(500);
    expect(screen.queryByRole("button")).toBeNull();
    handle.current!.focus(); expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "New task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("textbox")).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("New task");
  });
  it.each([
    { key: "Enter", shiftKey: true }, { key: "Enter", metaKey: true },
    { key: "Enter", ctrlKey: true }, { key: "Enter", isComposing: true }, { key: "ArrowLeft" },
  ])("does not intercept modified/composing/non-edit keys: %j", async event => {
    render(<Draft />); fireEvent.click(screen.getByRole("button"));
    fireEvent.keyDown(screen.getByRole("textbox"), event);
    expect(screen.getByRole("textbox")).toBeDefined();
  });
});
