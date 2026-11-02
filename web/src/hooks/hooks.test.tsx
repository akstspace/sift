import { act, render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useInertBackground } from "./useInertBackground";
import { useIsMobile } from "./use-mobile";
import { useMediaQuery } from "./use-media-query";
import { useInstall } from "./useInstall";
import { renderToString } from "react-dom/server";

function InertOwner() { useInertBackground(); return null; }
describe("modal sibling focus isolation", () => {
  it("makes only Radix-hidden siblings inert and restores owned attributes", async () => {
    const hidden = document.createElement("div");
    hidden.setAttribute("aria-hidden", "true"); hidden.setAttribute("data-aria-hidden", "true");
    const preexisting = hidden.cloneNode() as HTMLElement; preexisting.inert = true;
    const unrelated = document.createElement("div"); unrelated.setAttribute("aria-hidden", "true");
    const portal = document.createElement("div");
    document.body.append(hidden, preexisting, unrelated, portal);
    const { unmount } = render(<InertOwner />);
    expect(hidden.inert).toBe(true); expect(preexisting.inert).toBe(true);
    expect(unrelated.inert).not.toBe(true); expect(portal.inert).not.toBe(true);
    hidden.removeAttribute("aria-hidden");
    await waitFor(() => expect(hidden.inert).toBe(false));
    hidden.setAttribute("aria-hidden", "true");
    await waitFor(() => expect(hidden.inert).toBe(true));
    hidden.removeAttribute("data-aria-hidden");
    await waitFor(() => expect(hidden.inert).toBe(false));
    hidden.setAttribute("data-aria-hidden", "true");
    await waitFor(() => expect(hidden.inert).toBe(true));
    hidden.remove();
    await waitFor(() => expect(hidden.inert).toBe(false));
    document.body.append(hidden);
    await waitFor(() => expect(hidden.inert).toBe(true));
    unmount();
    expect(hidden.inert).toBe(false); expect(preexisting.inert).toBe(true);
    hidden.remove(); preexisting.remove(); unrelated.remove(); portal.remove();
  });
});
describe("responsive media subscriptions", () => {
  it("uses a stable desktop fallback when server-rendered without browser media state", () => {
    function Query() { return <span>{String(useMediaQuery("(max-width: 767px)"))}</span>; }
    expect(renderToString(<Query />)).toContain("false");
  });
  it("subscribes to the actual query and cleans up resize listeners", () => {
    const listeners = new Set<() => void>(); let matches = false;
    const remove = vi.fn((_: string, fn: () => void) => listeners.delete(fn));
    const media = { get matches() { return matches; }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: remove };
    const match = vi.fn(() => media); vi.stubGlobal("matchMedia", match);
    const { result, unmount } = renderHook(() => ({ mobile: useIsMobile(), direct: useMediaQuery("(prefers-reduced-motion: reduce)") }));
    expect(result.current).toEqual({ mobile: false, direct: false });
    expect(match).toHaveBeenCalledWith("(max-width: 767px)");
    act(() => { matches = true; [...listeners].forEach(fn => fn()); });
    expect(result.current).toEqual({ mobile: true, direct: true });
    unmount(); expect(remove).toHaveBeenCalled(); expect(listeners.size).toBe(0);
  });
});
describe("opt-in app window installation", () => {
  it("shows guidance without silently installing or requesting permissions", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const { result } = renderHook(useInstall);
    expect(result.current.installed).toBe(false); expect(result.current.available).toBe(false);
    await act(() => result.current.install()); expect(result.current.guidance).toBe(true);
    act(() => result.current.setGuidance(false)); expect(result.current.guidance).toBe(false);
  });
  it.each(["accepted", "dismissed"])("honors browser install outcome %s", async outcome => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const { result, unmount } = renderHook(useInstall);
    const event = new Event("beforeinstallprompt", { cancelable: true });
    const prompt = vi.fn().mockResolvedValue(undefined);
    Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true); expect(result.current.available).toBe(true);
    await act(() => result.current.install()); expect(prompt).toHaveBeenCalledOnce();
    expect(result.current.installed).toBe(outcome === "accepted"); expect(result.current.available).toBe(false);
    act(() => window.dispatchEvent(new Event("appinstalled")));
    expect(result.current.installed).toBe(true); unmount();
  });
  it("recognizes an already-installed standalone window", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    expect(renderHook(useInstall).result.current.installed).toBe(true);
  });
});
