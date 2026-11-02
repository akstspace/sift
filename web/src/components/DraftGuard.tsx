import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { Button } from "./ui/button";

type Protection = { dirty: boolean; busy: boolean };
const DraftContext = createContext<{
  guard: (action: () => void) => void;
  protect: (id: string, state: Protection | null) => void;
} | null>(null);

export function DraftGuardProvider({ children }: { children: ReactNode }) {
  const protections = useRef(new Map<string, Protection>());
  const [pending, setPending] = useState<(() => void) | null>(null);
  const protect = useCallback((id: string, state: Protection | null) => {
    if (state) protections.current.set(id, state);
    else protections.current.delete(id);
  }, []);
  const guard = useCallback((action: () => void) => {
    const states = [...protections.current.values()];
    if (states.some(state => state.busy)) {
      toast.info("Wait for the current operation to finish before leaving.");
    } else if (states.some(state => state.dirty)) {
      setPending(() => action);
    } else action();
  }, []);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if ([...protections.current.values()].some(state => state.dirty || state.busy)) event.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);
  return <DraftContext.Provider value={{ guard, protect }}>
    {children}
    <AlertDialog open={!!pending} onOpenChange={() => setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Keep your unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>This view has changes that haven’t been saved. Keep editing, or discard this draft to continue.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <Button variant="destructive" onClick={() => { const action = pending; setPending(null); action?.(); }}>Discard changes</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </DraftContext.Provider>;
}

export function useDraftGuard() {
  const context = useContext(DraftContext);
  if (!context) throw new Error("Draft guard provider is missing");
  return context;
}

export function useDraftProtection(dirty: boolean, busy: boolean) {
  const { protect } = useDraftGuard();
  const id = useId();
  useEffect(() => { protect(id, { dirty, busy }); return () => protect(id, null); }, [id, dirty, busy, protect]);
}
