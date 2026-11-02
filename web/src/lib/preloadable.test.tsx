import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { preloadable } from "./preloadable";

const Greeting = ({ name }: { name: string }) => <p>Hello {name}</p>;
describe("preloadable views", () => {
  it("renders synchronously after a preload, without a fallback", async () => {
    const load = vi.fn(async () => Greeting), View = preloadable(load);
    await View.preload(); await View.preload();
    render(<Suspense fallback={<p>Loading</p>}><View name="Sift" /></Suspense>);
    expect(screen.getByText("Hello Sift")).toBeDefined(); expect(screen.queryByText("Loading")).toBeNull();
    expect(load).toHaveBeenCalledOnce();
  });
  it("falls back to lazy loading when rendered before any preload", async () => {
    const View = preloadable(async () => Greeting);
    render(<Suspense fallback={<p>Loading</p>}><View name="later" /></Suspense>);
    expect(screen.getByText("Loading")).toBeDefined();
    expect(await screen.findByText("Hello later")).toBeDefined();
  });
  it("retries a failed load instead of caching the failure", async () => {
    const load = vi.fn<() => Promise<typeof Greeting>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(Greeting), View = preloadable(load);
    await expect(View.preload()).rejects.toThrow("offline");
    await act(async () => { await View.preload(); });
    render(<View name="again" />);
    expect(screen.getByText("Hello again")).toBeDefined(); expect(load).toHaveBeenCalledTimes(2);
  });
});
