import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { searchIcons } from "./icon-search";
import type { CatalogIcon } from "./types";

const vectors = JSON.parse(readFileSync("../internal/sift/testdata/icon-search.json", "utf8")) as {
  catalog: CatalogIcon[];
  cases: { query: string; ids: string[] }[];
};

it.each(vectors.cases)("ranks the shared CLI/picker query '$query' deterministically", ({ query, ids }) => {
  const original = structuredClone(vectors.catalog);
  expect(searchIcons(vectors.catalog, query).map(icon => icon.id)).toEqual(ids);
  expect(vectors.catalog).toEqual(original);
});

it("bounds long and pathological queries, supports empty metadata, and never fabricates a result", () => {
  expect(searchIcons(vectors.catalog, "x".repeat(1000))).toEqual([]);
  expect(searchIcons([], "gmail")).toEqual([]);
  expect(searchIcons([{ id: "", name: "", category: "", aliases: [] }], "gmail")).toEqual([]);
  expect(searchIcons(vectors.catalog, "calendar " + " ".repeat(1000)).map(i => i.id)).toEqual(["calendar", "calendar-filled"]);
  expect(searchIcons([{ id: "x".repeat(40), name: "", category: "", aliases: [] }], "xyx")).toEqual([]);
});

it("finds real offline Tabler brands, filled variants, and misspelled names", () => {
  const catalog = JSON.parse(readFileSync("../internal/sift/icon-catalog.json", "utf8")) as CatalogIcon[];
  expect(catalog).toHaveLength(6257);
  for (const [query, id] of [["slcak", "brand-slack"], ["gmial", "brand-gmail"], ["calender", "calendar"], ["circle check filled", "circle-check-filled"]]) {
    expect(searchIcons(catalog, query).slice(0, 20).map(i => i.id)).toContain(id);
  }
});
