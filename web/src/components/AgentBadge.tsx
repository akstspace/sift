import type { Job } from "../types";

export type Who = { name: string; kind: "you" | "sift" | "job" | "agent" };

/** Who made a change, in words: "You", "Sift" (the chat), a job's name, or the agent's own label. */
export function actorName(actor: string, jobs: Job[]): Who {
  if (!actor || actor === "user") return { name: "You", kind: "you" };
  if (actor === "chat") return { name: "Sift", kind: "sift" };
  if (actor.startsWith("job:")) {
    const job = jobs.find(j => j.id === actor.slice(4));
    return { name: job?.name || "A deleted job", kind: "job" };
  }
  if (actor === "local-agent") return { name: "Local agent", kind: "agent" };
  return { name: actor, kind: "agent" };
}

/** A quiet "AI" mark on a task whose status an agent changed and the person hasn't reviewed. */
export function AgentBadge({ actor, jobs }: { actor: string; jobs: Job[] }) {
  const label = `${actorName(actor, jobs).name} changed the status. Open the task to review it.`;
  return (
    <span className="agent-badge" title={label}>
      <span aria-hidden="true">AI</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
