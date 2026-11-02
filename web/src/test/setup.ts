import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// jsdom has no visual viewport; use an explicit asynchronous frame boundary.
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0) as unknown as number;
globalThis.cancelAnimationFrame = id => clearTimeout(id);
Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn(() => ({
  matches: false, media: "", onchange: null,
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
})) });

// Browser layout APIs used by Radix/cmdk; behavior remains tested in real Chrome.
globalThis.ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};
HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.scrollTo = vi.fn();
window.scrollTo = vi.fn();
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};
