import { Children, cloneElement, isValidElement, useId, useState, type ReactNode, type ComponentType } from "react";
import type { ComponentProps } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  IconArrowRight as ArrowRight,
  IconCheck as Check,
  IconCircleCheck as CircleCheck,
  IconCopy as Copy,
  IconLoader2 as LoaderCircle,
  IconX as X,
} from "@tabler/icons-react";
import { Button } from "./ui/button";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import type { CatalogIcon } from "../types";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Label } from "./ui/label";
import { toast } from "sonner";

export { Button };
/** Content-shaped actions still use the shared shadcn Button focus/disabled contract. */
export function Action(props: ComponentProps<typeof Button>) {
  return <Button variant="plain" data-slot="action" {...props} />;
}
export function Mark({ animate = false }: { animate?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className="sift-mark">
      <rect width="64" height="64" rx="15" fill="#2B2539" />
      {[[10,10],[26,10],[42,10],[18,26],[34,26],[26,42]].map(([x,y], i) => (
        <motion.rect
          key={i}
          x={x} y={y} width="12" height="12" rx="4"
          fill={i === 5 ? "#EFC8C8" : "#BED3CC"}
          initial={animate ? { opacity: 0, y: reduced ? 0 : -5 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            delay: reduced ? 0 : i * 0.045,
            duration: reduced ? 0.08 : 0.4,
            ease: [0.16, 1, 0.3, 1],
          }}
        />
      ))}
    </svg>
  );
}
export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip><TooltipTrigger asChild><Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button></TooltipTrigger><TooltipContent sideOffset={6}>{label}</TooltipContent></Tooltip>
  );
}
export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const control = Children.count(children) === 1 && isValidElement<Record<string, unknown>>(children) ? cloneElement(children, {
    id: children.props.id || id,
    "aria-labelledby": children.props["aria-label"] ? undefined : id + "-label",
    "aria-describedby": hint ? id + "-hint" : children.props["aria-describedby"],
  }) : children;
  return (
    <div className={"field " + className}>
      <Label id={id + "-label"} htmlFor={isValidElement<Record<string, unknown>>(children) ? String(children.props.id || id) : id}>{label}</Label>
      {control}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}
export function Busy({ label = "Working…" }: { label?: string }) {
  return (
    <span className="inline-status" role="status">
      <LoaderCircle className="spin" size={16} />
      {label}
    </span>
  );
}
export function Empty({
  icon: Icon = CircleCheck,
  title,
  children,
  action,
}: {
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-symbol">
        <Icon size={30} strokeWidth={1.4} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function CopyButton({
  text,
  label = "Copy command",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          toast.error("Couldn’t copy. Allow clipboard access in your browser, then try again.");
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
      {copied ? "Copied" : label}
    </Button>
  );
}
export function Confirm({
  title,
  description,
  action,
  destructive = false,
  children,
}: {
  title: string;
  description: string;
  action: () => Promise<unknown>;
  destructive?: boolean;
  children: (open: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      {children(() => { setError(""); setOpen(true); })}
      <AlertDialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={busy}
            >
              Cancel
            </AlertDialogCancel>
            <Button
              variant={destructive ? "destructive" : "default"}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await action();
                  setOpen(false);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Busy /> : title}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
export function TaskIcon({
  id,
  catalog,
  size = 18,
}: {
  id: string;
  catalog: CatalogIcon[];
  size?: number;
}) {
  const icon = catalog.find((i) => i.id === id);
  if (icon?.symbol && /^ti-[a-z0-9-]+$/.test(icon.symbol))
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        className="tabler-task-icon"
      >
        <use href={`/tabler-icons.svg#${icon.symbol}`} />
      </svg>
    );
  return <CircleCheck size={size} aria-hidden="true" />;
}
export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton label="Close" onClick={onClick}>
      <X size={18} />
    </IconButton>
  );
}
export function NextButton({
  onClick,
  children = "Continue",
  disabled = false,
}: {
  onClick: () => void;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Button onClick={onClick} disabled={disabled}>
      {children}
      <ArrowRight size={16} />
    </Button>
  );
}
