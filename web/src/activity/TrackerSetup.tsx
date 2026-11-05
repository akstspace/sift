import { useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import { IconArrowRight as ArrowRight, IconBrandGithub, IconCalendarEvent, IconMessageCircle } from "@tabler/icons-react";
import { toast } from "sonner";
import { api } from "../api";
import { Busy, Button, MonoMark } from "../components/shared";
import { settle } from "../motion";
import { TrackerFields, draftFrom, saveTracker } from "./TrackerForm";

/** First visit to My activity: what Sift will look at, when, and a start button. */
export function TrackerSetup({ defaultPrompt, defaultTimes, timezone, refresh }: { defaultPrompt: string; defaultTimes: string[]; timezone: string; refresh: () => Promise<void> }) {
  const reduced = !!useReducedMotion();
  const [draft, setDraft] = useState(() => draftFrom(null, defaultPrompt, defaultTimes));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await saveTracker(draft, null, timezone);
      if (draft.backfill) {
        try { await api("/activity/check", "POST", {}); }
        catch (err) { toast.info("Tracking is on. The first check will run at its scheduled time: " + (err as Error).message); }
      }
      await refresh();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  const rise = (delay: number) => ({ initial: { opacity: 0, y: reduced ? 0 : 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: reduced ? 0.12 : 0.5, ease: settle, delay: reduced ? 0 : delay } });
  return (
    <section className="tracker-setup" aria-labelledby="tracker-setup-title">
      <div className="tracker-setup-copy">
        <motion.span className="tracker-eyebrow" {...rise(0)}><MonoMark size={13} />My activity</motion.span>
        <motion.h1 id="tracker-setup-title" {...rise(0.04)}>See where your day went.</motion.h1>
        <motion.p className="tracker-lede" {...rise(0.08)}>
          A few times a day, Sift uses Pi to look through the tools you already use, like commits, pull requests, messages and meetings, and writes down what you worked on. Link it to your tasks and watch your day take shape.
        </motion.p>
        <motion.form onSubmit={start} {...rise(0.14)}>
          <TrackerFields draft={draft} onChange={setDraft} defaultPrompt={defaultPrompt} timezone={timezone} disabled={busy} isNew />
          {error && <div className="error" role="alert">{error}</div>}
          <div className="tracker-setup-actions">
            <Button type="submit" disabled={busy}>{busy ? <Busy label="Starting" /> : <>Start tracking<ArrowRight size={16} aria-hidden /></>}</Button>
            <small>Change what it looks at, or turn it off, any time.</small>
          </div>
        </motion.form>
      </div>
      <SetupPreview reduced={reduced} />
    </section>
  );
}

/** Most recent first, as My activity lists a day. */
const SAMPLE = [
  { time: "13:40", length: "45m", title: "Reviewed the onboarding pull request", meta: "Reviewing · GitHub", cat: "review", icon: IconBrandGithub, from: 5.67, to: 6.42 },
  { time: "11:05", length: "20m", title: "Replied to Maya about the launch date", meta: "Messages · Chat", cat: "message", icon: IconMessageCircle, from: 3.08, to: 3.42 },
  { time: "10:30", length: "30m", title: "Platform standup", meta: "Meetings · Calendar", cat: "meeting", icon: IconCalendarEvent, from: 2.5, to: 3 },
  { time: "09:10", length: "1h 15m", title: "Fixed staging CI for the web app", meta: "Coding · GitHub", cat: "code", icon: IconBrandGithub, from: 1.17, to: 2.42 },
];

/** A picture of a filled-in day, drawn in as if a check were writing it: the check on top, then what it found. */
function SetupPreview({ reduced }: { reduced: boolean }) {
  const span = 8;
  const at = (i: number) => reduced ? 0 : 0.55 + i * 0.34;
  return (
    <div className="setup-preview" aria-hidden="true">
      <motion.div className="setup-preview-card" initial={{ opacity: 0, y: reduced ? 0 : 16, scale: reduced ? 1 : 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: reduced ? 0.12 : 0.7, ease: settle, delay: reduced ? 0 : 0.18 }}>
        <div className="setup-preview-head">
          <strong>Today</strong>
          <span>2h 50m recorded</span>
        </div>
        <div className="ribbon setup-preview-ribbon">
          <div className="ribbon-track" style={{ "--lanes": 1 } as CSSProperties}>
            <span className="ribbon-checked" style={{ left: 0, width: "75%" }} />
            <span className="ribbon-gap is-running" style={{ left: "75%", width: "25%" }} />
            {SAMPLE.map((s, i) => (
              <motion.span key={s.title} className="ribbon-session" style={{ left: `${(s.from / span) * 100}%`, width: `${((s.to - s.from) / span) * 100}%`, top: 6, height: "calc(100% - 12px)", background: `var(--cat-${s.cat})` }}
                initial={{ opacity: 0, scaleX: reduced ? 1 : 0 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ duration: reduced ? 0.12 : 0.45, ease: settle, delay: at(i + 1) }} />
            ))}
          </div>
          <div className="ribbon-hours">
            {["8", "10", "12", "14", "16"].map((h, i) => <span key={h} className={i === 0 ? "is-start" : i === 4 ? "is-end" : undefined} style={{ left: `${i * 25}%` }}>{h}</span>)}
          </div>
        </div>
        <ol className="setup-preview-rows">
          <motion.li className="setup-preview-live" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: at(0) }}>
            <span className="row-time"><span className="preview-time">14:30</span></span>
            <span className="row-rail"><span className="gap-node"><span /></span></span>
            <span className="setup-preview-text"><strong>Sift is reading your activity</strong><span className="gap-shimmer"><span /><span /></span></span>
          </motion.li>
          {SAMPLE.map((s, i) => {
            const Icon = s.icon;
            return (
              <motion.li key={s.title} style={{ "--cat": `var(--cat-${s.cat})` } as CSSProperties} initial={{ opacity: 0, y: reduced ? 0 : -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0.12 : 0.4, ease: settle, delay: at(i + 1) }}>
                <span className="row-time"><span className="preview-time">{s.time}</span><span>{s.length}</span></span>
                <span className="row-rail"><span className="session-node"><Icon size={13} /></span></span>
                <span className="setup-preview-text"><strong>{s.title}</strong><small><span className="legend-swatch" />{s.meta}</small></span>
              </motion.li>
            );
          })}
        </ol>
      </motion.div>
    </div>
  );
}
