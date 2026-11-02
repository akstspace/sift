import { lazy, type ComponentType, type JSX } from "react";

/**
 * A code-split view that renders synchronously once its module has loaded.
 * React.lazy alone suspends on its first render even after a prefetch, and a
 * shown Suspense fallback holds the reveal back (about 300ms in React 19), so a
 * page transition passes through a blank frame. Preloaded views skip that.
 */
export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>) {
  let ready: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = () => pending ??= load().then(
    component => (ready = component),
    (error: unknown) => { pending = null; throw error; },
  );
  const Lazy = lazy(() => preload().then(component => ({ default: component })));
  function View(props: P) {
    const Ready = ready;
    return Ready ? <Ready {...props} /> : <Lazy {...(props as P & JSX.IntrinsicAttributes)} />;
  }
  return Object.assign(View, { preload });
}
