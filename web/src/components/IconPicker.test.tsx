import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { catalogFixture, TestProviders } from "../test/fixtures";
import { IconPicker } from "./IconPicker";

it("searches offline with typos, exposes selection, keyboard activation, empty results, and dismissal", async () => {
  const user = userEvent.setup(), select = vi.fn(), close = vi.fn();
  render(<IconPicker catalog={catalogFixture} selected="mail" onSelect={select} onClose={close} />, { wrapper: TestProviders });
  const query = screen.getByRole("textbox", { name: "Search icon catalog" });
  expect(document.activeElement).toBe(query);
  expect(screen.getByRole("button", { name: "Mail" }).getAttribute("aria-pressed")).toBe("true");
  await user.type(query, "mial");
  expect(screen.getByRole("status").textContent).toBe("1–1 of 1 icons");
  await user.tab(); await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledWith("mail");
  fireEvent.change(query, { target: { value: "zzzzzzzzzz" } });
  expect(screen.getByRole("status").textContent).toContain("No matching icons");
  expect(document.querySelectorAll(".icon-grid button")).toHaveLength(0);
  await user.keyboard("{Escape}"); expect(close).toHaveBeenCalledOnce();
});

it("renders at most 60 results, pages in both directions, and resets paging on search", async () => {
  const user = userEvent.setup();
  const catalog = Array.from({ length: 61 }, (_, i) => ({ id: `sample-${i}`, name: `Sample ${i}`, category: "System", aliases: [] }));
  render(<IconPicker catalog={catalog} selected="sample-60" onSelect={vi.fn()} onClose={vi.fn()} />, { wrapper: TestProviders });
  const pages = screen.getByRole("navigation", { name: "Icon result pages" });
  expect(document.querySelectorAll(".icon-grid button")).toHaveLength(60);
  expect((within(pages).getByRole("button", { name: "Previous icons" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Next icons" }));
  expect(document.querySelectorAll(".icon-grid button")).toHaveLength(1);
  expect(screen.getByRole("status").textContent).toBe("61–61 of 61 icons");
  expect((screen.getByRole("button", { name: "Next icons" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Previous icons" }));
  expect(screen.getByRole("status").textContent).toBe("1–60 of 61 icons");
  await user.click(screen.getByRole("button", { name: "Next icons" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search icon catalog" }), { target: { value: "sample-60" } });
  expect(screen.getByRole("status").textContent).toBe("1–1 of 1 icons");
  expect(screen.queryByRole("navigation")).toBeNull();
});
