import { Action } from "./shared";
import { useRef, useState } from "react";
import { Input } from "./ui/input";
import { TimezoneChoice } from "./SearchChoice";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { pageMotion } from "../motion";
import {
  IconArrowLeft as ArrowLeft,
  IconArrowRight as ArrowRight,
  IconCheck as Check,
  IconCircleCheck as CheckCircle2,
  IconCircle as Circle,
  IconFolderLock as FolderLock,
  IconDatabase as HardDrive,
  IconLoader2 as LoaderCircle,
  IconRefresh as RefreshCw,
  IconShieldCheck as ShieldCheck,
  IconTerminal2 as Terminal,
  IconCircleX as XCircle,
} from "@tabler/icons-react";
import { api } from "../api";
import type { PiInfo, Settings } from "../types";
import { Button, CopyButton, Field, Mark } from "./shared";
import { InstallApp } from "./InstallApp";

export function Onboarding({
  settings,
  storageReady,
  storageError = "",
  onFinish,
  onCreateJob,
}: {
  settings: Settings;
  storageReady: boolean;
  storageError?: string;
  onFinish: (settings: Settings) => Promise<void>;
  onCreateJob: () => void;
}) {
  const reduced = !!useReducedMotion();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0),
    [timezone, setTimezone] = useState(
      () =>
        Intl.DateTimeFormat().resolvedOptions().timeZone || settings.timezone,
    ),
    [pi, setPi] = useState<PiInfo | null>(null),
    [probe, setProbe] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [installed, setInstalled] = useState<string[]>([]);
  const check = async () => {
    setProbe(true);
    setError("");
    try {
      setPi(await api<PiInfo>("/pi"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProbe(false);
    }
  };
  const setup = async (action: string) => {
    setBusy(action);
    setError("");
    try {
      const result = await api<{ note?: string; installed: boolean }>(
        "/setup/" + action,
        "POST",
        {},
      );
      if (!result.installed)
        throw Error(result.note || "Setup could not be completed");
      setInstalled((v) => [...v, action]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const finish = async (job = false) => {
    setBusy("finish");
    setError("");
    try {
      await onFinish({ ...settings, timezone, onboarded: true });
      if (job) onCreateJob();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const titles = [
    "A little space for your next move.",
    "Local by design. Connected on your terms.",
    "Give your agents a way in.",
    "Make this space yours.",
  ];
  return (
    <div className="onboarding">
      <header className="onboard-header">
        <a href="#" aria-label="Sift home" className="wordmark">
          <Mark />
          Sift
        </a>
        <span>Private. On this computer.</span>
      </header>
      <main className="onboard-main">
        <div className="onboard-art" aria-hidden="true">
          <motion.div className="art-anchor" animate={{ y: reduced ? 0 : step === 3 ? 8 : 0 }}>
            <Mark animate />
          </motion.div>
          <div className="observation-lines">
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="observation"
                initial={{
                  opacity: 0,
                  x: reduced ? 0 : (i % 2 ? 1 : -1) * 45,
                  y: reduced ? 0 : 20,
                  rotate: reduced ? 0 : (i - 1) * 6,
                }}
                animate={{ opacity: 1, x: reduced ? 0 : step === 3 ? (1 - i) * 5 : 0, y: 0, rotate: 0 }}
                transition={{
                  delay: reduced ? 0 : 0.15 + i * 0.12,
                  duration: reduced ? 0.1 : 0.65,
                  ease: [0.16, 1, 0.3, 1],
                }}
              >
                <span
                  className={
                    "observation-check " + (step === 3 ? "checked" : "")
                  }
                >
                  {step === 3 ? <Check size={13} /> : <Circle size={13} />}
                </span>
                <motion.span
                  className="observation-ink"
                  animate={{ width: [72, 108, 86][i] }}
                />
                <span className="observation-dot" />
              </motion.div>
            ))}
          </div>
          <div className="art-caption">A clear place for what matters.</div>
        </div>
        <div className="onboard-content">
          <nav className="step-dots" aria-label="Setup progress">
            {["Welcome", "Connections", "Agent access", "Your workspace"].map(
              (name, i) => (
                <Action
                  key={name}
                  aria-label={name}
                  aria-current={i === step ? "step" : undefined}
                  onClick={() => setStep(i)}
                  className={i <= step ? "active" : ""}
                >
                  {i < step ? <Check size={12} /> : <span />}
                </Action>
              ),
            )}
          </nav>
          <AnimatePresence mode="wait" initial={false}>
            <motion.section
              key={step}
              variants={pageMotion(reduced)}
              custom={{ sign: 1, depth: false }}
              initial="enter"
              animate="visible"
              exit="exit"
              onAnimationComplete={() => { if (step > 0) heading.current?.focus(); }}
            >
              <h1 ref={heading} tabIndex={-1}>{titles[step]}</h1>
              {step === 0 ? (
                <>
                  <p className="onboard-lede">
                    Your tasks, your agents, one clear view. Sift turns local
                    observations into work you can actually move forward.
                  </p>
                  <div className="onboard-promises">
                    <p>
                      <FolderLock size={18} />
                      <span>Your workspace stays on this computer.</span>
                    </p>
                    <p>
                      <Terminal size={18} />
                      <span>Any local agent can add and update tasks.</span>
                    </p>
                    <p>
                      <ShieldCheck size={18} />
                      <span>
                        Every change has a history. You stay in control.
                      </span>
                    </p>
                  </div>
                  <p className="muted">
                    No Sift account needed. Use your existing AI setup.
                  </p>
                </>
              ) : step === 1 ? (
                <>
                  <p className="onboard-lede">
                    Connect Pi to run agents and check that image storage is
                    ready. Checking connections won’t run an AI task.
                  </p>
                  <div className="connection-row">
                    <HardDrive size={20} />
                    <div>
                      <strong>Local image storage</strong>
                      <small>
                        Saves task images on this computer
                      </small>
                    </div>
                    <span className={storageReady ? "success" : storageError ? "error-text" : "muted"}
                      role="status" aria-label={storageReady ? "Image storage ready" : storageError ? "Image storage unavailable" : "Starting image storage"}>
                      {storageReady ? (
                        <CheckCircle2 size={20} />
                      ) : storageError ? (
                        <XCircle size={20} />
                      ) : (
                        <LoaderCircle size={20} className="spin" />
                      )}
                    </span>
                  </div>
                  {!storageReady && storageError && (
                    <div className="error" role="alert">
                      <XCircle size={16} />
                      <div>
                        <strong>Image storage is unavailable.</strong>
                        <p>Restart Sift to try again. You can continue without images.</p>
                        <details><summary>Technical details</summary><p className="break-anywhere">{storageError}</p></details>
                      </div>
                    </div>
                  )}
                  <div className="connection-row">
                    <Terminal size={20} />
                    <div>
                      <strong>Pi coding agent</strong>
                      <small>
                        {pi
                          ? `${pi.version} · ${pi.models?.length || 0} configured models`
                          : "Uses your normal providers and extensions"}
                      </small>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={check}
                      disabled={probe}
                    >
                      {probe ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : pi ? (
                        <Check size={14} />
                      ) : (
                        <RefreshCw size={14} />
                      )}{" "}
                      {probe ? "Checking" : pi ? "Recheck" : "Check Pi"}
                    </Button>
                  </div>
                  <Field
                    label="Your timezone"
                    hint="Daily work rolls over at midnight here. Existing jobs keep their own timezone."
                  >
                    <TimezoneChoice value={timezone} onValueChange={setTimezone} />
                  </Field>
                  <small className="muted">
                    Pi agents can access files and tools with your computer
                    account’s permissions. Only ask them to use sources and
                    actions you trust.
                  </small>
                </>
              ) : step === 2 ? (
                <>
                  <p className="onboard-lede">
                    Choose what to install. Nothing changes until you click, and
                    you can return to these options in Settings.
                  </p>
                  {[
                    {
                      key: "cli",
                      title: "Make sift available in your terminal",
                      note: "Adds the sift command to ~/.local/bin. Your terminal settings stay unchanged.",
                    },
                    {
                      key: "skill",
                      title: "Teach local agents about Sift",
                      note: "Installs instructions for using Sift. If a skill is already installed, you choose whether to replace it in Settings.",
                    },
                    {
                      key: "startup",
                      title: "Start at login",
                      note: "Keep schedules running with the browser closed. Takes effect at your next login.",
                    },
                  ].map((item) => (
                    <div className="setup-row" key={item.key}>
                      <div>
                        <strong>{item.title}</strong>
                        <p>{item.note}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy || installed.includes(item.key)}
                        onClick={() => setup(item.key)}
                      >
                        {busy === item.key ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : installed.includes(item.key) ? (
                          <Check size={14} />
                        ) : null}
                        {installed.includes(item.key) ? "Installed" : "Install"}
                      </Button>
                    </div>
                  ))}
                  <div className="command-line">
                    <code>sift help</code>
                    <CopyButton text="sift help" />
                  </div>
                </>
              ) : (
                <>
                  <p className="onboard-lede">
                    Start with a clean Today, or set up your first scheduled
                    agent. There are no sample tasks to clear away.
                  </p>
                  <div className="finish-note">
                    <CheckCircle2 size={22} />
                    <div>
                      <strong>Ready when you are</strong>
                      <p>
                        Capture a task manually, invite an agent through the
                        CLI, or let a scheduled job bring work to you.
                      </p>
                    </div>
                  </div>
                  <div className="install-offer">
                    <InstallApp />
                    <small>The local service still needs to be running.</small>
                  </div>
                </>
              )}
              {error && (
                <div className="error" role="alert">
                  <XCircle size={16} />
                  {error}
                </div>
              )}
              <footer className="onboard-actions">
                {step > 0 && (
                  <Button
                    variant="ghost"
                    onClick={() => setStep(step - 1)}
                    disabled={!!busy}
                  >
                    <ArrowLeft size={16} />
                    Back
                  </Button>
                )}
                <div className="push" />
                {step === 3 ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => finish(true)}
                      disabled={!!busy}
                    >
                      Set up an agent
                    </Button>
                    <Button onClick={() => finish()} disabled={!!busy}>
                      {busy === "finish" ? "Opening…" : "Enter workspace"}
                      <ArrowRight size={16} />
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setStep(step + 1)}>
                    {step === 0
                      ? "Find your focus"
                      : step === 1 && !pi
                        ? "Continue for now"
                        : "Continue"}
                    <ArrowRight size={16} />
                  </Button>
                )}
              </footer>
            </motion.section>
          </AnimatePresence>
        </div>
      </main>
      <footer className="onboard-footer">
        <span>Your work, in focus.</span>
        <Action onClick={() => finish()} disabled={!!busy}>
          Skip setup
        </Action>
      </footer>
    </div>
  );
}
