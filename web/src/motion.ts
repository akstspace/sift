// One short, interruptible motion language. Never animate every streamed event.
export const settle = [0.16, 1, 0.3, 1] as const;
export const shellSpring = { type: "spring", stiffness: 340, damping: 38, mass: 0.8 } as const;
export const selectionSpring = { type: "spring", stiffness: 480, damping: 40, mass: 0.65 } as const;
export const pageOrder = ["today", "backlog", "organization", "jobs", "runs", "settings", "trash"];

// A floating inspector enters from the board's right edge and settles without
// bounce. Its backdrop follows the same presence lifecycle, including exit.
export function taskSheetMotion(reduced: boolean, mobile: boolean) {
  return {
    initial: { opacity: 0, x: reduced ? 0 : mobile ? 40 : 80, scale: reduced || mobile ? 1 : 0.985 },
    animate: { opacity: 1, x: 0, scale: 1, transition: { duration: reduced ? 0.1 : 0.34, ease: settle } },
    exit: { opacity: 0, x: reduced ? 0 : mobile ? 32 : 56, scale: reduced || mobile ? 1 : 0.99, transition: { duration: reduced ? 0.08 : 0.18, ease: [0.4, 0, 1, 1] as const } },
  };
}

export function pageMotion(reduced: boolean) {
  return {
    enter: (direction: number) => ({ opacity: 0, x: reduced ? 0 : direction * 18, filter: reduced ? "none" : "blur(2px)" }),
    visible: { opacity: 1, x: 0, filter: "blur(0px)", transition: { duration: reduced ? 0.1 : 0.24, ease: settle } },
    exit: (direction: number) => ({ opacity: 0, x: reduced ? 0 : direction * -8, filter: "blur(0px)", transition: { duration: reduced ? 0.06 : 0.1 } }),
  };
}
