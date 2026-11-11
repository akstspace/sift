// One short, interruptible motion language. Never animate every streamed event.
//
// Thesis: the shell never moves; only the work surface changes. Sibling pages
// trade places without a blank frame (the next page arrives while the last one
// leaves), with a small drift that follows sidebar order. Opening a project is
// the one authored moment: its name lifts out of the list and becomes the
// board's heading, and the board settles in beneath it. Reduced motion keeps
// the cross-fade and drops all travel and scale.
export const settle = [0.16, 1, 0.3, 1] as const;
export const leave = [0.4, 0, 1, 1] as const;
export const shellSpring = { type: "spring", stiffness: 340, damping: 38, mass: 0.8 } as const;
export const selectionSpring = { type: "spring", stiffness: 520, damping: 42, mass: 0.6 } as const;
export const titleMorph = { type: "spring", stiffness: 420, damping: 40, mass: 0.7 } as const;
export const pageOrder = ["backlog", "activity", "organization", "jobs", "runs", "settings", "archive", "trash"];
export const projectTitleId = (id: string) => "project-title:" + id;

export type PageDirection = { sign: 1 | -1; depth: boolean };

/** Direction for a route change. Entering a project goes deeper; leaving it returns. */
export function pageDirection(from: { page: string; project: string }, to: { page: string; project: string }): PageDirection {
  if (!from.project && to.project) return { sign: 1, depth: true };
  if (from.project && !to.project && to.page === "organization") return { sign: -1, depth: true };
  return { sign: pageOrder.indexOf(to.page) < pageOrder.indexOf(from.page) ? -1 : 1, depth: false };
}

// A floating inspector enters from the board's right edge and settles without
// bounce. It becomes opaque well before it stops travelling, so the board never
// ghosts through it. Its backdrop follows the same presence lifecycle.
/** Switching between the task panel and the full page: the sheet reshapes, and its header and footer travel with it. */
export const sheetMorph = { duration: 0.36, ease: settle } as const;

/** The task panel slides in from the right; the full page rises into place. */
export function taskSheetMotion(reduced: boolean, mobile: boolean, page = false) {
  if (page && !reduced) {
    return {
      initial: { opacity: 0, y: 14, scale: 0.99 },
      animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.34, ease: settle, opacity: { duration: 0.14, ease: "linear" } } },
      exit: { opacity: 0, y: 10, scale: 0.995, transition: { duration: 0.18, ease: leave, opacity: { duration: 0.16, delay: 0.02 } } },
    };
  }
  return {
    initial: { opacity: 0, x: reduced ? 0 : mobile ? 36 : 64, scale: reduced || mobile ? 1 : 0.985 },
    animate: { opacity: 1, x: 0, scale: 1, transition: reduced ? { duration: 0.12 } : { duration: 0.36, ease: settle, opacity: { duration: 0.14, ease: "linear" } } },
    exit: { opacity: 0, x: reduced ? 0 : mobile ? 28 : 40, scale: reduced || mobile ? 1 : 0.99, transition: reduced ? { duration: 0.08 } : { duration: 0.18, ease: leave, opacity: { duration: 0.16, delay: 0.02 } } },
  };
}

export function pageMotion(reduced: boolean) {
  return {
    enter: (d: PageDirection) => reduced ? { opacity: 0 } : d.depth
      ? { opacity: 0, y: d.sign > 0 ? 14 : -6, scale: d.sign > 0 ? 0.992 : 1.004 }
      : { opacity: 0, x: d.sign * 14 },
    visible: { opacity: 1, x: 0, y: 0, scale: 1, transition: reduced ? { duration: 0.14 } : { duration: 0.34, ease: settle, opacity: { duration: 0.2, ease: "linear" } } },
    exit: (d: PageDirection) => reduced ? { opacity: 0, transition: { duration: 0.08 } } : d.depth
      ? { opacity: 0, y: d.sign > 0 ? -6 : 10, scale: d.sign > 0 ? 1.004 : 0.994, transition: { duration: 0.16, ease: leave } }
      : { opacity: 0, x: d.sign * -10, transition: { duration: 0.14, ease: leave } },
  };
}

/** A card that arrives (agent-created, moved between columns) settles into place; one already present never re-animates. */
export function cardMotion(reduced: boolean) {
  return {
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 },
    exit: { opacity: 0, scale: reduced ? 1 : 0.98, transition: { duration: reduced ? 0.06 : 0.12, ease: leave } },
  };
}
