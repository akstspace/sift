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
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={11} aria-hidden="true" />
    </a>
  ),
  img: ({ src, alt }) =>
    typeof src === "string" && /^\/api\/images\/img_[a-f0-9]{32}$/.test(src)
      ? <img src={src} alt={alt || "Attached image"} />
      : <span className="muted">[External image blocked]</span>,
};

export function AgentMarkdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={("markdown agent-markdown " + className).trim()}>
    <Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown>
  </div>;
}
