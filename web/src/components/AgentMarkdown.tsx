import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconArrowUpRight as ArrowUpRight } from "@tabler/icons-react";

// Agent output is untrusted text. Markdown becomes React elements (raw HTML is
// shown as text, unsafe link protocols are dropped), links open outside Sift,
// and only Sift's own attached images load. Agent headings sit two levels
// below the page's, so they never compete with the run's own heading.
const heading = (Tag: "h3" | "h4" | "h5" | "h6") => ({ children }: { children?: ReactNode }) => <Tag>{children}</Tag>;
const components: Components = {
  h1: heading("h3"),
  h2: heading("h4"),
  h3: heading("h5"),
  h4: heading("h6"),
  h5: heading("h6"),
  h6: heading("h6"),
  a: ({ href, children }) => {
    // A pasted address reads as its site and a hint of the rest; the link and its tooltip keep all of it.
    const bare = typeof href === "string" && typeof children === "string" && (children === href || "mailto:" + children === href);
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={bare ? href : undefined} className={bare ? "bare-link" : undefined}>
        {bare ? <span>{shortUrl(href)}</span> : children}
        <ArrowUpRight size={11} aria-hidden="true" />
      </a>
    );
  },
  img: ({ src, alt }) =>
    typeof src === "string" && /^\/api\/images\/img_[a-f0-9]{32}$/.test(src)
      ? <img src={src} alt={alt || "Attached image"} />
      : <span className="muted">[External image blocked]</span>,
};

/** An address without its scheme or "www.", at most 44 characters: its start, "…", and its
 *  last path segment (or last 13 characters when that segment is long). */
export function shortUrl(href: string): string {
  const plain = href.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, "").replace(/^www\./i, "").replace(/\/$/, "");
  if (plain.length <= 44) return plain;
  const last = plain.slice(plain.lastIndexOf("/"));
  const tail = last.length > 1 && last.length <= 21 ? last : plain.slice(-13);
  return plain.slice(0, 43 - tail.length) + "…" + tail;
}

export function AgentMarkdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={("markdown agent-markdown " + className).trim()}>
    <Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown>
  </div>;
}
