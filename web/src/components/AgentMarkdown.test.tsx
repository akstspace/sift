import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentMarkdown, transcriptBlocks } from "./AgentMarkdown";

describe("agent markdown", () => {
  it("renders an agent's note as real structure, below the page's headings", () => {
    const { container } = render(<AgentMarkdown text={"# Plan\n## Today\n### Also\n#### Deep\n##### Deeper\n###### Deepest\n\n1. **Deliver** exports\n2. Triage `current_context_usage`\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode block\n```"} />);
    expect([...container.querySelectorAll("h3, h4, h5, h6")].map(h => h.tagName + ":" + h.textContent)).toEqual(["H3:Plan", "H4:Today", "H5:Also", "H6:Deep", "H6:Deeper", "H6:Deepest"]);
    expect(container.querySelector("h1, h2")).toBeNull();
    expect(container.querySelector("ol strong")?.textContent).toBe("Deliver");
    expect(container.querySelector("li code")?.textContent).toBe("current_context_usage");
    expect((container.querySelector("input[type=checkbox]") as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector("td")?.textContent).toBe("1");
    expect(container.querySelector("pre code")?.textContent).toBe("code block\n");
    expect(container.textContent).not.toMatch(/[#*`]/);
  });
  it("keeps untrusted output inert: no raw HTML, no script links, no remote images", () => {
    const { container } = render(<AgentMarkdown className="extra" text={'<img src=x onerror="alert(1)"><script>alert(2)</script>\n\n[bad](javascript:alert(3)) [site](https://example.com) ![remote](https://example.com/p.png) ![local](/api/images/img_' + "a".repeat(32) + ")"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.querySelector(".agent-markdown.extra")).not.toBeNull();
    const bad = screen.getByText("bad").closest("a")!;
    expect(bad.getAttribute("href") || "").not.toMatch(/javascript/i);
    const site = within(container).getByRole("link", { name: "site" });
    expect(site.getAttribute("href")).toBe("https://example.com");
    expect(site.getAttribute("target")).toBe("_blank"); expect(site.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("[External image blocked]")).toBeDefined();
    expect(screen.getByRole("img", { name: "local" }).getAttribute("src")).toBe("/api/images/img_" + "a".repeat(32));
    render(<AgentMarkdown text={"![](/api/images/img_" + "b".repeat(32) + ")"} />);
    expect(screen.getByRole("img", { name: "Attached image" })).toBeDefined();
  });
  it("joins streamed text so Markdown split between chunks still renders", () => {
    const blocks = transcriptBlocks([
      { type: "text", text: "##" }, { type: "text", text: "# Today\n1. **Deli" }, { type: "text", text: "ver**" },
      { type: "tool", text: "Running read" },
      { type: "text", text: "Done." },
    ]);
    expect(blocks).toEqual([
      { kind: "text", text: "### Today\n1. **Deliver**", key: 0 },
      { kind: "log", entry: { type: "tool", text: "Running read" }, key: 3 },
      { kind: "text", text: "Done.", key: 4 },
    ]);
    expect(transcriptBlocks([])).toEqual([]);
  });
});
