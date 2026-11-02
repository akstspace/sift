import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionMonitor, type ConnectionState } from "./connection";
afterEach(() => vi.useRealTimers());
describe("truthful connection messaging", () => {
  it("does not report an outage while the first connection opens", () => {
    vi.useFakeTimers(); const states: ConnectionState[] = [];
    const monitor = new ConnectionMonitor(s => states.push(s));
    vi.advanceTimersByTime(7999);
    expect(states).toEqual(["connecting"]);
    monitor.open(); vi.advanceTimersByTime(20000);
    expect(states).toEqual(["connecting", "connected"]);
  });
  it("reports a stream that never opens, despite repeated retry errors", () => {
    vi.useFakeTimers(); const states: ConnectionState[] = [];
    const monitor = new ConnectionMonitor(s => states.push(s));
    vi.advanceTimersByTime(3000); monitor.error();
    vi.advanceTimersByTime(5000);
    expect(states.at(-1)).toBe("interrupted"); monitor.dispose();
  });
  it("hides brief reconnects and recovers from a confirmed outage", () => {
    vi.useFakeTimers(); const states: ConnectionState[] = [];
    const monitor = new ConnectionMonitor(s => states.push(s));
    monitor.open(); monitor.error(); vi.advanceTimersByTime(3999);
    expect(states.at(-1)).toBe("reconnecting");
    monitor.open(); vi.advanceTimersByTime(10000);
    expect(states).not.toContain("interrupted");
    monitor.error(); vi.advanceTimersByTime(4000);
    expect(states.at(-1)).toBe("interrupted");
    monitor.error(); expect(states.at(-1)).toBe("interrupted");
    monitor.open(); expect(states.at(-1)).toBe("connected");
  });
  it("never publishes after unmount, including late browser callbacks", () => {
    vi.useFakeTimers(); const publish = vi.fn();
    const monitor = new ConnectionMonitor(publish);
    monitor.dispose(); monitor.error(); monitor.open(); vi.runAllTimers();
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("retains the original deadline during repeated reconnect errors", () => {
    vi.useFakeTimers(); const states: ConnectionState[] = [];
    const monitor = new ConnectionMonitor(s => states.push(s));
    monitor.open(); monitor.error(); vi.advanceTimersByTime(3000);
    monitor.error(); vi.advanceTimersByTime(1000);
    expect(states.at(-1)).toBe("interrupted"); monitor.dispose();
  });
});
