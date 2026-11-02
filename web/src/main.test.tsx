import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const root = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("react-dom/client", () => ({ default: { createRoot: vi.fn(() => root) } }));
vi.mock("./App", () => ({ default: () => null }));
describe("private application bootstrap", () => {
  beforeEach(() => { vi.resetModules(); root.render.mockReset(); });
  it("mounts the workspace and tolerates service-worker registration refusal", async () => {
    const element = document.createElement("div"); element.id = "root"; document.body.append(element);
    const register = vi.fn().mockRejectedValue(new Error("Unavailable"));
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
    const add = vi.spyOn(window, "addEventListener");
    await import("./main"); expect(root.render).toHaveBeenCalledOnce(); expect(register).not.toHaveBeenCalled();
    const listener = add.mock.calls.find(([name]) => name === "load")![1] as EventListener;
    await act(async () => listener(new Event("load")));
    expect(register).toHaveBeenCalledWith("/sw.js"); window.removeEventListener("load", listener);
    element.remove(); delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });
  it("still mounts when service workers are unsupported", async () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    const element = document.createElement("div"); element.id = "root"; document.body.append(element);
    const add = vi.spyOn(window, "addEventListener"); await import("./main");
    expect(root.render).toHaveBeenCalledOnce(); expect(add.mock.calls.some(([name]) => name === "load")).toBe(false); element.remove();
  });
});
