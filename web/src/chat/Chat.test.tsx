import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { TestProviders, catalogFixture, deferred, snapshotFixture, taskFixture } from "../test/fixtures";
import type { Snapshot } from "../types";
import { ChatDock, preloadChat } from "./Chat";
import { CHAT_EVENT, MAX_IMAGE_BYTES, readImages, type ChatInfo } from "./useChat";

const preference = vi.hoisted(() => ({ reduced: false }));
const toasts = vi.hoisted(() => ({ shown: [] as [string, string][] }));
vi.mock("motion/react", async original => {
  const real = await original<typeof import("motion/react")>();
  const { createElement } = await import("react");
  // jsdom can't measure layout, so a shared-layout (layoutId) exit never finishes there.
  // Real Chrome covers the pill-to-panel morph; here the surfaces simply swap.
  const plain = new Map<PropertyKey, unknown>();
  const motion = new Proxy(real.motion, {
    get(target, key) {
      if (!plain.has(key)) {
        const Component = Reflect.get(target, key) as Parameters<typeof createElement>[0];
        plain.set(key, ({ layoutId: _, ...props }: Record<string, unknown>) => createElement(Component, props));
      }
      return plain.get(key);
    },
  });
  return { ...real, motion, useReducedMotion: () => preference.reduced };
});
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
vi.mock("sonner", async original => {
  const say = (tone: string) => (text: string) => { toasts.shown.push([tone, text]); return 1; };
  return { ...await original<typeof import("sonner")>(), toast: Object.assign(say("info"), { error: say("error"), warning: say("warning"), success: say("success") }) };
});
const mock = vi.mocked(api);

const chatInfo = (over: Partial<ChatInfo> = {}): ChatInfo => ({
  available: true, sessionId: "chat_1", running: false,
  model: { id: "sol-x", name: "Sol X", provider: "tokenplex", reasoning: true }, thinkingLevel: "medium",
  models: [{ id: "sol-x", name: "Sol X", provider: "tokenplex", reasoning: true }, { id: "gpt-y", provider: "openai" }],
  thinkingLevels: ["off", "low", "medium", "high"],
  commands: [{ name: "compact", description: "Compact the context", source: "extension" }, { name: "review", source: "skill" }, { name: "standup", source: "prompt" }, { name: "zap" }],
  chosen: { provider: "", model: "", thinking: "" }, dialogs: [], messages: [], ...over,
});
let state: ChatInfo;
let peek: Partial<ChatInfo>;
let routes: Map<string, (body: unknown) => unknown>;
const snap: Snapshot = snapshotFixture({ tasks: [taskFixture({ id: "task_1", title: "Pay rent" })] });

beforeEach(() => {
  preference.reduced = false; toasts.shown = []; localStorage.clear();
  state = chatInfo(); peek = {}; routes = new Map();
  mock.mockReset();
  mock.mockImplementation(async (path, method = "GET", body) => {
    if (path === "/chat?peek=1") return { loaded: false, running: false, dialogs: [], ...peek };
    if (path === "/chat") return state;
    const route = routes.get(`${method} ${path}`);
    if (route) return route(body);
    if (path === "/chat/prompt") return { disposition: "started" };
    return {};
  });
});

const calls = (path: string) => mock.mock.calls.filter(c => c[0] === path).map(c => c[2]);
const emit = async (...events: Record<string, unknown>[]) => {
  await act(async () => {
    for (const e of events) window.dispatchEvent(new CustomEvent(CHAT_EVENT, { detail: e }));
    // The hook applies events on the next frame; this frame callback is queued after its.
    await new Promise<void>(r => requestAnimationFrame(() => r()));
  });
};
function dock(props: Partial<Parameters<typeof ChatDock>[0]> = {}) {
  const onOpenTask = vi.fn(), onOpenRun = vi.fn();
  const view = { context: "Page: All tasks." };
  const ui = (p: Partial<Parameters<typeof ChatDock>[0]> = {}) => (
    <TestProviders><ChatDock snapshot={snap} catalog={catalogFixture} view={view} onOpenTask={onOpenTask} onOpenRun={onOpenRun} {...props} {...p} /></TestProviders>
  );
  const result = render(ui());
  return { ...result, onOpenTask, onOpenRun, again: (p: Partial<Parameters<typeof ChatDock>[0]>) => result.rerender(ui(p)) };
}
const pill = () => screen.getByRole("button", { name: /Open chat/ });
async function openChat() {
  fireEvent.click(pill());
  const panel = await screen.findByRole("complementary", { name: "Ask Sift" });
  await within(panel).findByRole("textbox", { name: "Message Sift" });
  // The composer takes focus a frame after it mounts; let that settle first.
  await act(async () => { await new Promise<void>(r => requestAnimationFrame(() => r())); });
  return panel;
}
const composer = () => screen.getByRole("textbox", { name: "Message Sift" }) as HTMLTextAreaElement;
async function type(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  await act(async () => {});
}
async function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(composer(), { key, ...init });
  await act(async () => {});
}

describe("chat pill", () => {
  it("opens the panel, remembers it, and closes from the header", async () => {
    await act(async () => { await preloadChat(); });
    dock();
    expect(pill().getAttribute("aria-label")).toBe("Ask Sift. Open chat (⌘J)");
    expect(pill().querySelector("svg.sift-mono")).not.toBeNull(); expect(pill().textContent).not.toContain("π");
    fireEvent.pointerEnter(pill()); fireEvent.focus(pill());
    const panel = await openChat();
    expect(localStorage.getItem("sift.chat")).toBe("open");
    expect(await within(panel).findByText("What can I sift for you?")).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(composer()));
    fireEvent.click(within(panel).getByRole("button", { name: "Close chat (Esc)" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(localStorage.getItem("sift.chat")).toBe("closed");
  });
  it("toggles with ⌘J or Ctrl J unless a dialog has the keyboard", async () => {
    dock();
    fireEvent.keyDown(window, { key: "j", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.queryByRole("complementary")).toBeNull();
    // As Radix renders task details: a dialog without aria-modal.
    const modal = document.createElement("div"); modal.setAttribute("role", "dialog"); modal.dataset.state = "open"; document.body.append(modal);
    fireEvent.keyDown(window, { key: "J", ctrlKey: true });
    expect(screen.queryByRole("complementary")).toBeNull();
    modal.remove();
    fireEvent.keyDown(window, { key: "J", ctrlKey: true });
    expect(await screen.findByRole("complementary", { name: "Ask Sift" })).toBeDefined();
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });
  it("closes on Escape from inside the panel, but not over a menu or from elsewhere", async () => {
    localStorage.setItem("sift.chat", "open");
    dock();
    const panel = await screen.findByRole("complementary", { name: "Ask Sift" });
    await within(panel).findByText("What can I sift for you?");
    // Any focus the composer would take happens a frame after it mounts.
    await act(async () => { await new Promise<void>(r => requestAnimationFrame(() => r())); });
    expect(document.activeElement).toBe(document.body);
    const outside = document.createElement("input"); document.body.append(outside); outside.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("complementary")).toBeDefined();
    outside.remove();
    composer().focus();
    const menu = document.createElement("div"); menu.setAttribute("role", "menu"); document.body.append(menu);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("complementary")).toBeDefined();
    menu.remove();
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(pill()));
    // Already closed: nothing to do.
    fireEvent.keyDown(window, { key: "Escape" });
  });
  it("says when Pi is working, has a question, or replied while closed", async () => {
    preference.reduced = true;
    peek = { running: true };
    dock({ raised: true });
    await waitFor(() => expect(pill().getAttribute("aria-label")).toBe("Sift is working…. Open chat (⌘J)"));
    expect(document.querySelector(".chat-dock.raised")).not.toBeNull();
    await emit({ type: "agent_settled" });
    expect(pill().getAttribute("aria-label")).toBe("New reply from Sift. Open chat (⌘J)");
    await emit({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow?" });
    expect(pill().getAttribute("aria-label")).toBe("Sift has a question. Open chat (⌘J)");
    state = chatInfo({ running: true, dialogs: [{ id: "d1", method: "confirm", title: "Allow?" }] });
    // A resync before the panel ever opened only re-checks whether Pi is busy.
    peek = { running: true };
    await emit({ type: "sift_chat_resync" });
    expect(calls("/chat")).toHaveLength(0);
    const panel = await openChat();
    expect(await within(panel).findByRole("heading", { name: "Allow?" })).toBeDefined();
  });
  it("shows a question that was already waiting when the page loaded", async () => {
    peek = { dialogs: [{ id: "d0", method: "select", title: "Pick", options: ["A"] }] };
    dock();
    await waitFor(() => expect(pill().getAttribute("aria-label")).toMatch(/^Sift has a question/));
  });
  it("survives a failed peek and storage that can't be used", async () => {
    mock.mockImplementation(async path => { if (path === "/chat?peek=1") throw new Error("offline"); return state; });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    dock();
    expect(await screen.findByRole("button", { name: /Ask Sift/ })).toBeDefined();
    await openChat();
  });
});

describe("chat conversation", () => {
  it("starts Pi, then shows the reply as it streams", async () => {
    const reply = deferred<{ disposition: string }>();
    routes.set("POST /chat/prompt", () => reply.promise);
    const { onOpenTask } = dock();
    const panel = await openChat();
    expect(within(panel).getByText("Sol X")).toBeDefined();
    await type("  Plan my day  ");
    await press("Enter");
    // The message shows at once, before Pi confirms it.
    expect(panel.querySelector(".user-message.pending")?.textContent).toContain("Plan my day");
    expect(composer().value).toBe("");
    expect(calls("/chat/prompt")[0]).toEqual({ message: "Plan my day", images: [], context: "Page: All tasks." });
    await act(async () => reply.resolve({ disposition: "started" }));
    expect(within(panel).getByRole("status", { name: "Sift is replying" })).toBeDefined();
    expect(composer().placeholder).toBe("Add to what Sift is doing…");
    await emit(
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: "Plan my day", siftContext: "Page: All tasks.", timestamp: 2 } },
      { type: "message_start", message: { role: "assistant", content: [], timestamp: 3 } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Start with " } },
    );
    expect(panel.querySelector(".user-message.pending")).toBeNull();
    expect(panel.querySelector(".user-context")?.textContent).toBe("Sift shared: All tasks");
    await waitFor(() => expect(within(panel).queryByRole("status", { name: "Sift is replying" })).toBeNull());
    expect(panel.querySelector(".agent-markdown.streaming")?.textContent).toBe("Start with");
    await emit(
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Start with rent." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "sift tasks get task_1" } }], timestamp: 3 } },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sift tasks get task_1" } },
      { type: "tool_execution_end", toolCallId: "c1", output: '{"task":{"id":"task_1","title":"Pay rent"},"history":[]}' },
      { type: "agent_settled" },
    );
    expect(within(panel).getByText("Start with rent.")).toBeDefined();
    fireEvent.click(within(panel).getByRole("button", { name: /Read task/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Open task Pay rent" }));
    expect(onOpenTask).toHaveBeenCalledWith(snap.tasks[0]);
    // Replies while open aren't "unread".
    fireEvent.click(within(panel).getByRole("button", { name: "Close chat (Esc)" }));
    await waitFor(() => expect(pill().getAttribute("aria-label")).toMatch(/^Ask Sift/));
  });
  it("loads earlier messages and replays what arrived while loading", async () => {
    state = chatInfo({ messages: [{ role: "user", content: "Earlier", timestamp: 1 }], notice: "Pi couldn't open the previous conversation, so this is a new one." });
    const loading = deferred<ChatInfo>();
    mock.mockImplementation(async path => path === "/chat" ? loading.promise : { running: false, dialogs: [] });
    dock();
    fireEvent.click(pill());
    expect(await screen.findByText("Starting Pi…", { selector: "p" })).toBeDefined();
    expect(screen.getByText("Connecting…")).toBeDefined();
    await emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Answer" }], timestamp: 2 } });
    await act(async () => loading.resolve(state));
    expect(await screen.findByText("Earlier")).toBeDefined();
    expect(screen.getByText("Answer")).toBeDefined();
    expect(screen.getByText(/couldn't open the previous conversation/)).toBeDefined();
    // The notice goes once the person carries on.
    mock.mockImplementation(async path => path === "/chat/prompt" ? { disposition: "started" } : state);
    await type("Thanks"); await press("Enter");
    await waitFor(() => expect(screen.queryByText(/couldn't open the previous conversation/)).toBeNull());
  });
  it("explains when Pi can't start and tries again", async () => {
    state = chatInfo({ available: false, error: "Pi isn't installed." });
    dock();
    fireEvent.click(pill());
    expect(await screen.findByRole("heading", { name: "Pi isn’t available right now" })).toBeDefined();
    expect(screen.getByText("Pi isn't installed.")).toBeDefined();
    expect(screen.getByText("Not connected")).toBeDefined();
    expect(composer().disabled).toBe(true);
    const retry = deferred<ChatInfo>();
    mock.mockImplementation(async path => path === "/chat" ? retry.promise : {});
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Starting Pi…", { selector: "p" })).toBeDefined();
    await act(async () => retry.resolve(chatInfo()));
    expect(await screen.findByText("What can I sift for you?")).toBeDefined();
  });
  it("explains a request that failed outright", async () => {
    mock.mockImplementation(async path => { if (path === "/chat") throw new Error("Sift is busy with a backup."); return {}; });
    dock();
    fireEvent.click(pill());
    expect(await screen.findByText("Sift is busy with a backup.")).toBeDefined();
    mock.mockImplementation(async path => { if (path === "/chat") throw new Error(""); return {}; });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Sift couldn’t start Pi.")).toBeDefined();
  });
  it("suggests a first message for what's on screen", async () => {
    dock({ view: { context: "Page: All tasks. Open task: Pay rent (task_1)." }, snapshot: { ...snap, runs: [{ id: "run_1" } as Snapshot["runs"][number]] } });
    const panel = await openChat();
    const ideas = within(panel).getAllByRole("listitem").map(li => li.textContent);
    expect(ideas).toEqual(["Break “Pay rent” into smaller steps", "Add a task:", "What did my agents do today?", "Find tasks that look like duplicates"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Add a task:" }));
    await waitFor(() => expect(composer().value).toBe("Add a task: "));
    await waitFor(() => expect(document.activeElement).toBe(composer()));
  });
  it.each<[Partial<Snapshot>, string]>([
    [{ tasks: [] }, "What’s on my plate this week?"],
    [{}, "What should I focus on today?"],
  ])("suggests based on the workspace", async (over, idea) => {
    dock({ snapshot: { ...snap, ...over } });
    const panel = await openChat();
    expect(within(panel).getByRole("button", { name: idea })).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Help me set up a morning planning job" })).toBeDefined();
  });
  it("keeps the draft when sending fails, and drops it when Pi handles a command itself", async () => {
    routes.set("POST /chat/prompt", () => { throw new Error("Pi stopped."); });
    dock();
    const panel = await openChat();
    await type("Hello");
    fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
    expect(await within(panel).findByRole("alert")).toHaveProperty("textContent", "Pi stopped.");
    expect(composer().value).toBe("Hello");
    expect(panel.querySelector(".user-message")).toBeNull();
    // Typing clears the error.
    await type("Hello!");
    expect(within(panel).queryByRole("alert")).toBeNull();
    routes.set("POST /chat/prompt", () => ({ disposition: "handled" }));
    await type("/compact ");
    await press("Enter");
    await waitFor(() => expect(calls("/chat/prompt").at(-1)).toEqual({ message: "/compact", images: [], context: "Page: All tasks." }));
    await waitFor(() => expect(panel.querySelector(".user-message")).toBeNull());
    // Shift+Enter is a new line, and an empty message doesn't send.
    await type("line");
    await press("Enter", { shiftKey: true });
    await type("   ");
    await press("Enter");
    expect(calls("/chat/prompt")).toHaveLength(2);
  });
  it("adds to a running reply as a queued message, and stops it", async () => {
    state = chatInfo({ running: true, queue: { steering: ["<sift-context>Page: All tasks.</sift-context>\n\nAlso the dentist"] } });
    routes.set("POST /chat/prompt", () => ({ disposition: "queued" }));
    dock();
    const panel = await openChat();
    expect(within(panel).getByText("Also the dentist")).toBeDefined();
    expect(within(panel).getByText("Queued — Sift reads it after the current step")).toBeDefined();
    await type("And the car");
    fireEvent.click(within(panel).getByRole("button", { name: "Send — Sift reads it after the current step" }));
    await waitFor(() => expect(calls("/chat/prompt")).toHaveLength(1));
    // No optimistic copy: Pi's queue shows it.
    expect(panel.querySelectorAll(".user-message.pending")).toHaveLength(1);
    await emit({ type: "queue_update", steering: ["Also the dentist"], followUp: ["And the car"] });
    expect(panel.querySelectorAll(".queued")).toHaveLength(2);
    await emit({ type: "queue_update" });
    expect(panel.querySelectorAll(".queued")).toHaveLength(0);
    fireEvent.click(within(panel).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls("/chat/abort")).toHaveLength(1));
    routes.set("POST /chat/abort", () => { throw new Error("Already stopped"); });
    fireEvent.click(within(panel).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(toasts.shown).toContainEqual(["error", "Already stopped"]));
  });
  it("starts over with /new or the header button", async () => {
    state = chatInfo({ messages: [{ role: "user", content: "Old topic" }] });
    dock();
    const panel = await openChat();
    expect(within(panel).getByText("Old topic")).toBeDefined();
    routes.set("POST /chat/new", () => { state = chatInfo(); return {}; });
    await type("/new");
    // An exact command sends instead of picking from the menu.
    await press("Enter");
    expect(await within(panel).findByText("What can I sift for you?")).toBeDefined();
    expect(calls("/chat/prompt")).toHaveLength(0);
    routes.set("POST /chat/new", () => { throw new Error("Wait for the reply to finish"); });
    fireEvent.click(within(panel).getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(toasts.shown).toContainEqual(["error", "Wait for the reply to finish"]));
    // Another tab started over.
    state = chatInfo({ messages: [{ role: "user", content: "Fresh" }] });
    await emit({ type: "sift_chat_reset" });
    expect(await within(panel).findByText("Fresh")).toBeDefined();
  });
  it("keeps up with Pi's status: retries, compaction, crashes, and reconnects", async () => {
    dock();
    const panel = await openChat();
    await emit({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "Overloaded" });
    expect(within(panel).getByText("Retrying (attempt 2 of 3)… Overloaded")).toBeDefined();
    await emit({ type: "auto_retry_start", attempt: 1 });
    expect(within(panel).getByText("Retrying (attempt 1)…")).toBeDefined();
    await emit({ type: "auto_retry_start" });
    expect(within(panel).getByText("Retrying…")).toBeDefined();
    await emit({ type: "auto_retry_end" });
    expect(within(panel).queryByText(/Retrying/)).toBeNull();
    await emit({ type: "compaction_start" });
    expect(within(panel).getByText("Summarizing earlier messages to make room…")).toBeDefined();
    await emit({ type: "compaction_end" });
    await emit({ type: "agent_start" }, { type: "sift_chat_stopped", reason: "exited", error: "Pi crashed." });
    expect(within(panel).getByRole("alert").textContent).toBe("Pi crashed. Your next message starts it again.");
    await emit({ type: "sift_chat_stopped", reason: "exited" });
    expect(within(panel).getByRole("alert").textContent).toBe("Pi stopped unexpectedly. Your next message starts it again.");
    await emit({ type: "agent_start" });
    expect(within(panel).queryByRole("alert")).toBeNull();
    await emit({ type: "sift_chat_stopped", reason: "idle" });
    await waitFor(() => expect(within(panel).queryByRole("button", { name: "Stop" })).toBeNull());
    // After a reconnect the conversation reloads.
    state = chatInfo({ messages: [{ role: "assistant", content: [{ type: "text", text: "Missed while away" }] }] });
    await emit({ type: "sift_chat_resync" });
    expect(await within(panel).findByText("Missed while away")).toBeDefined();
    // Malformed and unrelated events are ignored.
    await emit({}, { type: "turn_end" }, { type: "extension_ui_request", method: "setWidget" });
  });
  it("lets the reader scroll back and jump to the latest message", async () => {
    dock();
    const panel = await openChat();
    const log = within(panel).getByRole("log", { name: "Conversation" });
    Object.defineProperties(log, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400, configurable: true } });
    log.scrollTop = 200;
    fireEvent.scroll(log);
    const latest = await within(panel).findByRole("button", { name: "Latest" });
    fireEvent.click(latest);
    expect(log.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
    log.scrollTop = 1590;
    fireEvent.scroll(log);
    await waitFor(() => expect(within(panel).queryByRole("button", { name: "Latest" })).toBeNull());
  });
});

describe("chat questions and extension UI", () => {
  it("answers each kind of question inline", async () => {
    dock();
    const panel = await openChat();
    await emit(
      { type: "extension_ui_request", id: "s", method: "select", title: "Which list?", options: ["Home", "Work"], timeout: 30000 },
      { type: "extension_ui_request", id: "s", method: "select", title: "Which list?", options: ["Home", "Work"] },
    );
    const card = within(panel).getByRole("region", { name: "Which list?" });
    expect(within(card).getByText("Sift is waiting for you")).toBeDefined();
    expect(card.querySelector(".question-timer")).not.toBeNull();
    expect(within(panel).queryByRole("status", { name: "Sift is replying" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByRole("button", { name: "Home" })));
    fireEvent.click(within(card).getByRole("button", { name: "Work" }));
    await waitFor(() => expect(calls("/chat/dialogs/s")).toEqual([{ value: "Work" }]));
    expect(within(panel).queryByRole("region", { name: "Which list?" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(composer()));

    await emit({ type: "extension_ui_request", id: "c", method: "confirm", title: "Delete it?", message: "This can't be undone." });
    let q = within(panel).getByRole("region", { name: "Delete it?" });
    expect(within(q).getByText("This can't be undone.")).toBeDefined();
    fireEvent.click(within(q).getByRole("button", { name: "No" }));
    await emit({ type: "extension_ui_request", id: "c2", method: "confirm" });
    q = within(panel).getByRole("region", { name: "Sift needs an answer" });
    fireEvent.click(within(q).getByRole("button", { name: "Yes" }));
    await emit({ type: "extension_ui_request", id: "c3", method: "confirm", title: "Skip?" });
    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect([calls("/chat/dialogs/c"), calls("/chat/dialogs/c2"), calls("/chat/dialogs/c3")]).toEqual([[{ confirmed: false }], [{ confirmed: true }], [{ cancelled: true }]]));

    await emit({ type: "extension_ui_request", id: "i", method: "input", title: "Name?", placeholder: "A name" });
    const input = within(panel).getByRole("textbox", { name: "Name?" });
    expect(input.getAttribute("placeholder")).toBe("A name");
    fireEvent.change(input, { target: { value: "Rent" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Send answer" }));
    await emit({ type: "extension_ui_request", id: "e", method: "editor", prefill: "Draft" });
    const editor = within(panel).getByRole("textbox", { name: "Answer" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("Draft");
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await emit({ type: "extension_ui_request", id: "e2", method: "input" });
    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect([calls("/chat/dialogs/i"), calls("/chat/dialogs/e"), calls("/chat/dialogs/e2")]).toEqual([[{ value: "Rent" }], [{ value: "Draft" }], [{ cancelled: true }]]));
  });
  it("drops a question Pi stopped waiting for, and reports other failures", async () => {
    dock();
    const panel = await openChat();
    await emit({ type: "extension_ui_request", id: "x", method: "select", title: "Pick one", options: ["A"] }, { type: "extension_ui_request", id: "y", method: "select", title: "Pick two", options: ["B"] });
    await emit({ type: "sift_chat_dialog_closed", id: "x" });
    expect(within(panel).queryByRole("region", { name: "Pick one" })).toBeNull();
    routes.set("POST /chat/dialogs/y", () => { throw new Error("That question is no longer waiting for an answer"); });
    fireEvent.click(within(panel).getByRole("button", { name: "B" }));
    await emit({ type: "extension_ui_request", id: "z", method: "select", title: "Pick three", options: ["C"] });
    routes.set("POST /chat/dialogs/z", () => { throw new Error("Pi stopped"); });
    fireEvent.click(within(panel).getByRole("button", { name: "C" }));
    await waitFor(() => expect(toasts.shown).toEqual([["error", "Pi stopped"]]));
    // A stopped Pi asks nothing more.
    await emit({ type: "extension_ui_request", id: "w", method: "select", title: "Pick four", options: ["D"] }, { type: "sift_chat_stopped", reason: "shutdown" });
    expect(within(panel).queryByRole("region", { name: "Pick four" })).toBeNull();
  });
  it("shows extension notes, statuses, and text it puts in the composer", async () => {
    state = chatInfo({ statuses: { git: "main" } });
    dock();
    const panel = await openChat();
    expect(panel.querySelector(".composer-note")?.textContent).toBe("main");
    await emit(
      { type: "extension_ui_request", method: "notify", message: "Saved", notifyType: "info" },
      { type: "extension_ui_request", method: "notify", message: "Careful", notifyType: "warning" },
      { type: "extension_ui_request", method: "notify", message: "Broke", notifyType: "error" },
      { type: "extension_ui_request", method: "notify" },
      { type: "extension_ui_request", method: "setStatus", statusKey: "tokens", statusText: "12k" },
      { type: "extension_ui_request", method: "setStatus", statusKey: "git" },
      { type: "extension_ui_request", method: "set_editor_text", text: "Try this" },
    );
    // An empty note shows nothing.
    expect(toasts.shown).toEqual([["info", "Saved"], ["warning", "Careful"], ["error", "Broke"]]);
    expect(panel.querySelector(".composer-note")?.textContent).toBe("12k");
    expect(composer().value).toBe("Try this");
    await emit({ type: "extension_ui_request", method: "set_editor_text" });
    expect(composer().value).toBe("");
    await emit({ type: "thinking_level_changed", level: "high" });
    expect(within(panel).getByRole("button", { name: /Change model/ }).getAttribute("aria-label")).toBe("Model: Sol X, thinking high. Change model");
    await emit({ type: "thinking_level_changed" });
    expect(within(panel).getByRole("button", { name: /Change model/ }).getAttribute("aria-label")).toBe("Model: Sol X. Change model");
  });
  it("keeps extension statuses when the session's settings change", async () => {
    dock();
    const panel = await openChat();
    await emit({ type: "extension_ui_request", method: "setStatus", statusKey: "k", statusText: "Busy" });
    state = chatInfo({ model: { id: "gpt-y", provider: "openai" } });
    await emit({ type: "sift_chat_configured" });
    expect(await within(panel).findByText("gpt-y")).toBeDefined();
    expect(panel.querySelector(".composer-note")?.textContent).toBe("Busy");
  });
});

describe("chat model and thinking", () => {
  it("chooses a model, Pi's default, and how hard to think", async () => {
    routes.set("PUT /chat/settings", body => { const b = body as { provider: string; model: string; thinking: string }; state = chatInfo({ chosen: b, thinkingLevel: b.thinking || "medium", model: b.model ? state.models.find(m => m.id === b.model) : state.model }); return state; });
    dock();
    const panel = await openChat();
    fireEvent.click(within(panel).getByRole("button", { name: "Model: Sol X, thinking medium. Change model" }));
    const menu = await screen.findByRole("radiogroup", { name: "Model" });
    const def = within(menu).getByRole("radio", { name: /Pi’s default/ });
    expect(def.getAttribute("aria-checked")).toBe("true");
    expect(def.textContent).toContain("Now Sol X");
    expect(within(menu).getByText("tokenplex")).toBeDefined();
    expect(within(menu).getByText("sol-x")).toBeDefined();
    fireEvent.click(within(menu).getByRole("radio", { name: "gpt-y" }));
    await waitFor(() => expect(calls("/chat/settings").at(-1)).toEqual({ provider: "openai", model: "gpt-y", thinking: "" }));
    await waitFor(() => expect(within(menu).getByRole("radio", { name: "gpt-y" }).getAttribute("aria-checked")).toBe("true"));
    expect(within(menu).getByRole("radio", { name: /Pi’s default/ }).textContent).toContain("As set in Pi");
    const thinking = screen.getByRole("radiogroup", { name: "Thinking" });
    fireEvent.click(within(thinking).getByRole("radio", { name: "high" }));
    await waitFor(() => expect(calls("/chat/settings").at(-1)).toEqual({ provider: "openai", model: "gpt-y", thinking: "high" }));
    await waitFor(() => expect(within(thinking).getByRole("radio", { name: "high" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(within(menu).getByRole("radio", { name: /Pi’s default/ }));
    await waitFor(() => expect(calls("/chat/settings").at(-1)).toEqual({ provider: "", model: "", thinking: "high" }));
    routes.set("PUT /chat/settings", () => { throw new Error("Unknown model"); });
    fireEvent.click(within(menu).getByRole("radio", { name: "gpt-y" }));
    await waitFor(() => expect(toasts.shown).toContainEqual(["error", "Unknown model"]));
  });
  it("shows a switch in progress and waits for a running reply", async () => {
    const pending = deferred<ChatInfo>();
    routes.set("PUT /chat/settings", () => pending.promise);
    state = chatInfo({ thinkingLevels: ["off"], thinkingLevel: "off", model: null });
    dock();
    const panel = await openChat();
    fireEvent.click(within(panel).getByRole("button", { name: "Model: No model, thinking off. Change model" }));
    const menu = await screen.findByRole("radiogroup", { name: "Model" });
    expect(screen.queryByRole("radiogroup", { name: "Thinking" })).toBeNull();
    expect(within(menu).getByRole("radio", { name: /Pi’s default/ }).textContent).toContain("As set in Pi");
    fireEvent.click(within(menu).getByRole("radio", { name: /^Sol X/ }));
    expect(await within(menu).findByLabelText("Switching")).toBeDefined();
    expect((within(menu).getByRole("radio", { name: "gpt-y" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve(chatInfo({ running: true })));
    await emit({ type: "agent_start" });
    expect(screen.getByText("You can change the model after this reply.")).toBeDefined();
    expect((within(menu).getByRole("radio", { name: "gpt-y" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("offers Pi's default when the chosen model is gone", async () => {
    state = chatInfo({ modelError: "The chat's model openai/gpt-z isn't available in Pi. Choose another model.", chosen: { provider: "openai", model: "gpt-z", thinking: "low" } });
    routes.set("PUT /chat/settings", () => { state = chatInfo(); return state; });
    dock();
    const panel = await openChat();
    const problem = within(panel).getByRole("alert");
    expect(problem.textContent).toContain("isn't available in Pi");
    expect(within(panel).getByRole("button", { name: /Change model/ }).className).toContain("problem");
    await type("Hi");
    expect((within(panel).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(problem).getByRole("button", { name: "Use Pi’s default" }));
    await waitFor(() => expect(calls("/chat/settings")).toEqual([{ provider: "", model: "", thinking: "low" }]));
    await waitFor(() => expect(within(panel).queryByRole("alert")).toBeNull());
    state = chatInfo({ modelError: "Still missing" });
    routes.set("PUT /chat/settings", () => { throw new Error("No default model"); });
    await emit({ type: "sift_chat_configured" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Use Pi’s default" }));
    await waitFor(() => expect(toasts.shown).toContainEqual(["error", "No default model"]));
  });
});

describe("chat composer", () => {
  it("completes commands from the slash menu", async () => {
    dock();
    const panel = await openChat();
    await type("/");
    const menu = within(panel).getByRole("listbox", { name: "Commands" });
    expect(within(menu).getAllByRole("option").map(o => o.textContent)).toEqual([
      "/newStart a new chat without the earlier context", "/compactCompact the context", "/reviewSkill", "/standupPrompt", "/zapCommand",
    ]);
    expect(composer().getAttribute("aria-activedescendant")).toBe(within(menu).getAllByRole("option")[0].id);
    await press("ArrowUp");
    expect(within(menu).getAllByRole("option")[4].getAttribute("aria-selected")).toBe("true");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(within(menu).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    await press("Tab");
    expect(composer().value).toBe("/compact ");
    await waitFor(() => expect(within(panel).queryByRole("listbox")).toBeNull());
    await type("/re");
    expect(within(panel).getAllByRole("option").map(o => o.textContent?.split(/(?=[A-Z])/)[0])).toEqual(["/review"]);
    await press("Enter");
    expect(composer().value).toBe("/review ");
    await type("/s");
    fireEvent.mouseEnter(within(panel).getAllByRole("option")[0]);
    fireEvent.mouseDown(within(panel).getByRole("option", { name: /standup/ }));
    expect(composer().value).toBe("/standup ");
    await type("/z");
    await press("Escape");
    await waitFor(() => expect(within(panel).queryByRole("listbox")).toBeNull());
    // Escape in the menu doesn't close the panel.
    expect(screen.getByRole("complementary")).toBeDefined();
    await type("/nothing-like-this");
    await waitFor(() => expect(within(panel).queryByRole("listbox")).toBeNull());
    // An input method composing text owns Enter.
    await type("こんにちは");
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true });
    expect(calls("/chat/prompt")).toHaveLength(0);
  });
  it("attaches pasted, dropped, and chosen images, within limits", async () => {
    dock();
    const panel = await openChat();
    const png = (name: string, size = 10) => new File(["x".repeat(size)], name, { type: "image/png" });
    fireEvent.paste(composer(), { clipboardData: { files: [png("shot.png")] } });
    expect(await within(panel).findByRole("img", { name: "shot.png" })).toBeDefined();
    // Pasted text isn't an image.
    fireEvent.paste(composer(), { clipboardData: { files: [] } });
    const box = panel.querySelector(".chat-composer")!;
    fireEvent.dragOver(box, { dataTransfer: { types: ["text/plain"] } });
    expect(box.className).not.toContain("dragging");
    fireEvent.dragOver(box, { dataTransfer: { types: ["Files"] } });
    expect(box.className).toContain("dragging");
    // jsdom has no DragEvent, so give the leave event its destination by hand.
    const leave = (to: Element) => { const e = createEvent.dragLeave(box); Object.defineProperty(e, "relatedTarget", { value: to }); fireEvent(box, e); };
    leave(composer());
    expect(box.className).toContain("dragging");
    leave(document.body);
    expect(box.className).not.toContain("dragging");
    fireEvent.drop(box, { dataTransfer: { files: [png("drop.png"), new File(["x"], "notes.txt", { type: "text/plain" })] } });
    expect(await within(panel).findByRole("img", { name: "drop.png" })).toBeDefined();
    const chooser = panel.querySelector<HTMLInputElement>("input[type=file]")!;
    const click = vi.spyOn(chooser, "click");
    fireEvent.click(within(panel).getByRole("button", { name: "Attach images" }));
    expect(click).toHaveBeenCalled();
    fireEvent.change(chooser, { target: { files: [png("a.png"), png("b.png"), png("c.png")] } });
    await waitFor(() => expect(within(panel).getByRole("list", { name: "Attached images" }).children).toHaveLength(4));
    expect(within(panel).getByRole("alert").textContent).toBe("Attach up to 4 images.");
    expect((within(panel).getByRole("button", { name: "Attach images" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(chooser, { target: { files: null } });
    fireEvent.click(within(panel).getByRole("button", { name: "Remove drop.png" }));
    expect(within(panel).queryByRole("img", { name: "drop.png" })).toBeNull();
    // An image alone is a message.
    fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls("/chat/prompt")).toHaveLength(1));
    const sent = calls("/chat/prompt")[0] as { message: string; images: { mimeType: string; data: string }[] };
    expect(sent.message).toBe("");
    expect(sent.images).toHaveLength(3);
    expect(sent.images[0]).toEqual({ mimeType: "image/png", data: btoa("x".repeat(10)) });
    expect(panel.querySelector(".user-message.pending img")).not.toBeNull();
  });
  it("shares the current view unless switched off for this message", async () => {
    const { again } = dock({ view: { context: "Page: All tasks. Open task: Pay rent (task_1)." } });
    const panel = await openChat();
    const chip = within(panel).getByRole("button", { name: "All tasks · Pay rent" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(within(panel).getByRole("button", { name: "View not shared" }).getAttribute("aria-pressed")).toBe("false");
    await type("Private");
    await press("Enter");
    await waitFor(() => expect(calls("/chat/prompt")[0]).toEqual({ message: "Private", images: [], context: "" }));
    expect(panel.querySelector(".user-context")).toBeNull();
    // A new view is shared again.
    again({ view: { context: "Page: All tasks." } });
    expect(await within(panel).findByRole("button", { name: "All tasks" })).toBeDefined();
    // With nothing to share, there is no chip; and commands never carry it.
    again({ view: { context: "" } });
    expect(panel.querySelector(".context-chip")).toBeNull();
  });
  it("doesn't share the view with a slash command", async () => {
    routes.set("POST /chat/prompt", () => ({ disposition: "started" }));
    dock();
    const panel = await openChat();
    await type("/zap now");
    await press("Enter");
    await waitFor(() => expect(panel.querySelector(".user-message.pending")).not.toBeNull());
    expect(panel.querySelector(".user-context")).toBeNull();
  });
  it("lets people type while Pi is still starting", async () => {
    const loading = deferred<ChatInfo>();
    mock.mockImplementation(async path => path === "/chat" ? loading.promise : { disposition: "started" });
    dock();
    fireEvent.click(pill());
    const box = await screen.findByRole("textbox", { name: "Message Sift" });
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(box));
    await type("Early");
    await press("Enter");
    expect(mock.mock.calls.some(c => c[0] === "/chat/prompt")).toBe(false);
    expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => loading.resolve(chatInfo()));
    await press("Enter");
    await waitFor(() => expect(mock.mock.calls.some(c => c[0] === "/chat/prompt")).toBe(true));
  });
  it("leaves focus alone on touch screens", async () => {
    vi.stubGlobal("matchMedia", vi.fn((q: string) => ({ matches: q === "(pointer: coarse)", media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    preference.reduced = true;
    dock();
    await openChat();
    await act(async () => { await new Promise<void>(r => requestAnimationFrame(() => r())); });
    expect(document.activeElement).not.toBe(composer());
  });
});

describe("reading images for Pi", () => {
  const file = (name: string, type: string, size = 4) => new File(["a".repeat(Math.min(size, 16))], name, { type }) as File & { size: number };
  it("skips files that aren't images and explains the ones it can't use", async () => {
    const big = file("big.png", "image/png"); Object.defineProperty(big, "size", { value: MAX_IMAGE_BYTES + 1 });
    const unnamed = file("", "image/png"); Object.defineProperty(unnamed, "size", { value: MAX_IMAGE_BYTES + 1 });
    expect(await readImages([file("a.txt", "text/plain")], 0)).toEqual({ images: [], error: "" });
    expect((await readImages([file("a.bmp", "image/bmp")], 0)).error).toBe("Images must be PNG, JPEG, WebP, or GIF.");
    expect((await readImages([big], 0)).error).toBe("big.png is over 5 MB.");
    expect((await readImages([unnamed], 0)).error).toBe("That image is over 5 MB.");
    const read = await readImages([file("a.webp", "image/webp"), file("b.gif", "image/gif")], 3);
    expect(read.images.map(i => [i.name, i.mimeType, i.data])).toEqual([["a.webp", "image/webp", btoa("aaaa")]]);
    expect(read.error).toBe("Attach up to 4 images.");
  });
  it("reports a file that can't be read", async () => {
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) { setTimeout(() => this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>)); });
    await expect(readImages([file("a.png", "image/png")], 0)).rejects.toBeNull();
  });
});
