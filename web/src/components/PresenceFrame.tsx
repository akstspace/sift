import type { ComponentProps } from "react";
import { motion, useIsPresent } from "motion/react";

/**
 * A view inside AnimatePresence (mode="popLayout") stays on screen briefly while
 * it leaves. During that moment it is visual only: it cannot be clicked,
 * focused, or read by assistive technology, so there is never a second copy of
 * the controls the person is about to use.
 */
export function PresenceFrame({ ref, ...props }: ComponentProps<typeof motion.div>) {
  const present = useIsPresent();
  return <motion.div ref={ref} {...props} inert={!present} aria-hidden={present ? undefined : true} data-leaving={present ? undefined : ""} />;
}
