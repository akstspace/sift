import { useRef, useState } from "react";
import { Button, Busy, Field } from "./shared";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { useDraftProtection } from "./DraftGuard";

export function DoneReasonDialog({ title, onCancel, onConfirm }: {
  title: string;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  useDraftProtection(!!reason.trim(), busy);
  const submit = async () => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try { await onConfirm(reason.trim()); }
    catch (e) { setError((e as Error).message); }
    finally { saving.current = false; setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving.current) onCancel(); }}>
    <DialogContent className="done-reason-dialog" showCloseButton={!busy} onInteractOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (saving.current) event.preventDefault(); }}>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <DialogHeader>
          <DialogTitle>Mark task Done</DialogTitle>
          <DialogDescription>Mark “{title}” as Done. You can note what was completed; it’s saved in task history.</DialogDescription>
        </DialogHeader>
        <Field label="Done reason" hint="Optional. Leave blank to just mark it Done.">
          <Textarea autoFocus maxLength={10000} rows={4} value={reason} disabled={busy} placeholder="What was addressed? (optional)" onChange={event => setReason(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }} />
        </Field>
        {error && <p className="error" role="alert">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? <Busy label="Saving" /> : "Mark Done"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
