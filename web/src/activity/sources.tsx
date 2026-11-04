import type { ComponentType } from "react";
import {
  IconActivity,
  IconBrandBitbucket,
  IconBrandDiscord,
  IconBrandFigma,
  IconBrandGithub,
  IconBrandGitlab,
  IconBrandTeams,
  IconBrandNotion,
  IconBrandSlack,
  IconCalendarEvent,
  IconFileText,
  IconGitCommit,
  IconMail,
  IconMessageCircle,
  IconTerminal2,
  IconUser,
  IconWorld,
} from "@tabler/icons-react";
import { MonoMark } from "../components/shared";

type Icon = ComponentType<{ size?: number; "aria-hidden"?: boolean; className?: string }>;

const SiftIcon: Icon = ({ size = 14 }) => <MonoMark size={Math.round(size * 0.86)} />;

// Sources are free text from Pi; known names get their mark and a proper label.
const SOURCES: { match: RegExp; label: string; icon: Icon }[] = [
  { match: /^(github|gh|pull ?requests?)$/, label: "GitHub", icon: IconBrandGithub },
  { match: /^(git|commits?|repo(sitor(y|ies))?)$/, label: "Git", icon: IconGitCommit },
  { match: /^gitlab$/, label: "GitLab", icon: IconBrandGitlab },
  { match: /^bitbucket$/, label: "Bitbucket", icon: IconBrandBitbucket },
  { match: /^slack$/, label: "Slack", icon: IconBrandSlack },
  { match: /^(ms ?)?teams$/, label: "Teams", icon: IconBrandTeams },
  { match: /^discord$/, label: "Discord", icon: IconBrandDiscord },
  { match: /^(chat|messages?|im)$/, label: "Chat", icon: IconMessageCircle },
  { match: /^(e-?mail|gmail|mail|outlook)$/, label: "Email", icon: IconMail },
  { match: /^(calendar|gcal|google calendar|meet|zoom|meetings?)$/, label: "Calendar", icon: IconCalendarEvent },
  { match: /^(browser|web|chrome|safari|firefox|history)$/, label: "Browser", icon: IconWorld },
  { match: /^(shell|terminal|zsh|bash|cli)$/, label: "Terminal", icon: IconTerminal2 },
  { match: /^(docs?|documents?|google docs|files?|notes?)$/, label: "Docs", icon: IconFileText },
  { match: /^notion$/, label: "Notion", icon: IconBrandNotion },
  { match: /^figma$/, label: "Figma", icon: IconBrandFigma },
  { match: /^sift$/, label: "Sift", icon: SiftIcon },
  { match: /^(you|user|manual)$/, label: "You", icon: IconUser },
];

export function sourceOf(source: string): { label: string; icon: Icon } {
  const key = source.trim().toLowerCase();
  const known = SOURCES.find(s => s.match.test(key));
  if (known) return known;
  return { label: key ? key[0].toUpperCase() + key.slice(1) : "Activity", icon: IconActivity };
}
