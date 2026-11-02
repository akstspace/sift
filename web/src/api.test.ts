import { afterEach, describe, expect, it, vi } from "vitest";
import { api, friendlyTime, localDate, upload } from "./api";

afterEach(() => vi.useRealTimers());
describe("private local API client", () => {
  it("uses same-origin cookie auth without embedding a bearer", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch); expect(await api("/health")).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith("/api/health", { method: "GET", headers: { "Content-Type": "application/json", "X-Sift-Request": "1" }, body: undefined });
    await api("/tasks", "POST", { title: "Hello" });
    expect(fetch.mock.calls[1][1].body).toBe('{"title":"Hello"}');
  });
  it.each([[{ error: "Revision conflict" }, "Revision conflict"], [{}, "Request failed (409)"]])("surfaces server failure %j", async (body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => body }));
    await expect(api("/tasks")).rejects.toThrow(message);
  });
  it("uploads a real File with a multipart body and a local request header", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ attachment: { id: "img_test" }, url: "/api/images/img_test" }) });
    vi.stubGlobal("fetch", fetch); const file = new File(["image"], "local.png", { type: "image/png" });
    expect((await upload(file)).attachment.id).toBe("img_test");
    expect(fetch.mock.calls[0][1].body.get("file")).toBe(file);
    expect(fetch.mock.calls[0][1].headers).toEqual({ "X-Sift-Request": "1" });
  });
  it("does not hide upload or transport errors", async () => {
    const file = new File([], "bad.svg");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Unsupported image" }) }));
    await expect(upload(file)).rejects.toThrow("Unsupported image");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
    await expect(api("/snapshot")).rejects.toThrow("Offline");
  });
});
describe("dates", () => {
  it("renders absent and invalid timestamps truthfully", () => {
    expect(friendlyTime("")).toBe("Not yet"); expect(friendlyTime("bad date")).toBe("bad date");
    const date = "2026-01-02T12:00:00Z";
    expect(friendlyTime(date)).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date)));
  });
  it("uses the workspace timezone and has a UTC fallback", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-02T01:00:00Z"));
    expect(localDate("America/Los_Angeles")).toBe("2026-01-01");
    expect(localDate("Asia/Tokyo")).toBe("2026-01-02");
    expect(localDate("not/a/timezone")).toBe("2026-01-02");
  });
});
