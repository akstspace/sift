import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { ActivityEntry, ActivityPage } from "../types";
import { TaskTime } from "./TaskTime";
import { sourceOf } from "./sources";

vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
const mock = vi.mocked(api);

const entry = (id: string, start: string, end: string): ActivityEntry => ({
  id, start, end, title: "Session " + id, summary: "", category: id === "a" ? "review" : "unknown", source: "github", link: "", taskId: "tsk_a", sourceKey: "",
  actor: "job:job_activity", createdAt: start, updatedAt: start, revision: 1,
});
const page = (entries: ActivityEntry[]): ActivityPage => ({ entries, checks: [], gaps: [], tracker: null, defaultPrompt: "", defaultTimes: [], categories: [], lookbackDays: 7 });

beforeEach(() => { mock.mockReset(); });

describe("time on a task", () => {
  it("shows nothing until the task has sessions", async () => {
    mock.mockResolvedValue(page([]));
    const { container } = render(<TaskTime taskId="tsk_a" cursor={1} tz="UTC" />);
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/activity?task=tsk_a"));
    expect(container.innerHTML).toBe("");
  });
  it("keeps quiet when activity can't be read", async () => {
    const failed = vi.fn();
    mock.mockImplementation(async () => { failed(); throw Error("offline"); });
    const { container } = render(<TaskTime taskId="tsk_a" cursor={1} tz="UTC" />);
    await waitFor(() => expect(failed).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
  it("totals overlapping sessions once and opens a session's day", async () => {
    mock.mockResolvedValue(page([
      entry("a", "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z"),
      entry("b", "2026-11-03T09:30:00Z", "2026-11-03T10:15:00Z"),
    ]));
    const onOpenDay = vi.fn();
    render(<TaskTime taskId="tsk_a" cursor={1} tz="UTC" onOpenDay={onOpenDay} />);
    expect(await screen.findByRole("heading", { name: "Worked on" })).toBeDefined();
    expect(screen.getByText("1h 15m · 2 sessions")).toBeDefined();
    await userEvent.setup().click(screen.getByRole("button", { name: /Session a/ }));
    expect(onOpenDay).toHaveBeenCalledWith("2026-11-03");
    expect(screen.queryByText(/earlier/)).toBeNull();
  });
  it("lists the latest four and counts the rest", async () => {
    const at = (h: number) => `2026-11-0${1 + Math.floor(h / 24)}T${String(h % 24).padStart(2, "0")}:00:00Z`;
    mock.mockResolvedValue(page(Array.from({ length: 5 }, (_, i) => entry("e" + i, at(i * 5), at(i * 5)))));
    const { rerender } = render(<TaskTime taskId="tsk_a" cursor={1} tz="UTC" />);
    expect(await screen.findByText("5 sessions")).toBeDefined();
    expect(screen.getByText("1 earlier session on My activity")).toBeDefined();
    expect(screen.getAllByRole("button").map(b => b.textContent)).toEqual([expect.stringContaining("Session e4"), expect.stringContaining("Session e3"), expect.stringContaining("Session e2"), expect.stringContaining("Session e1")]);
    expect(screen.getAllByRole("button").every(b => (b as HTMLButtonElement).disabled)).toBe(true);
    mock.mockResolvedValue(page([...Array.from({ length: 6 }, (_, i) => entry("f" + i, at(i), at(i)))]));
    rerender(<TaskTime taskId="tsk_a" cursor={2} tz="UTC" />);
    expect(await screen.findByText("2 earlier sessions on My activity")).toBeDefined();
    mock.mockResolvedValue(page([entry("g", at(1), at(2))]));
    rerender(<TaskTime taskId="tsk_a" cursor={3} tz="UTC" />);
    expect(await screen.findByText("1h · 1 session")).toBeDefined();
  });
});

describe("sources", () => {
  it("names known sources and gives unknown ones a tidy label", () => {
    const cases: [string, string][] = [
      ["GitHub", "GitHub"], ["gh", "GitHub"], ["pull request", "GitHub"], ["commits", "Git"], ["repository", "Git"], ["slack", "Slack"],
      ["Gmail", "Email"], ["e-mail", "Email"], ["zoom", "Calendar"], ["meetings", "Calendar"], ["chrome", "Browser"], ["zsh", "Terminal"],
      ["google docs", "Docs"], ["notes", "Docs"], ["notion", "Notion"], ["figma", "Figma"], ["sift", "Sift"], ["manual", "You"],
      ["GitLab", "GitLab"], ["bitbucket", "Bitbucket"], ["MS Teams", "Teams"], ["discord", "Discord"], ["chat", "Chat"], ["messages", "Chat"],
      ["linear", "Linear"], ["  ", "Activity"],
    ];
    for (const [source, label] of cases) expect(sourceOf(source).label, source).toBe(label);
    const Sift = sourceOf("sift").icon;
    const { container } = render(<Sift size={14} />);
    expect(container.querySelector("svg")).not.toBeNull();
    const Default = sourceOf("sift").icon;
    render(<Default />);
  });
});
