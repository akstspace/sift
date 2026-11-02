import {
  IconArchive as Archive,
  IconHelpCircle as CircleHelp,
  IconFolder as Folder,
  IconHistory as History,
  IconPlus as Plus,
  IconSettings as Settings2,
  IconSunHigh as SunMedium,
  IconTerminal2 as Terminal,
  IconTrash as Trash2,
  IconX as X,
} from "@tabler/icons-react";
import type { Entity } from "../types";
import { useId } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { selectionSpring } from "../motion";
import { Mark } from "./shared";
import { Button } from "./ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";

export const navigation = [
  { id: "today", label: "Today", icon: SunMedium },
  { id: "backlog", label: "Backlog", icon: Archive },
  { id: "organization", label: "Projects & tags", icon: Folder },
  { id: "jobs", label: "Agents", icon: Terminal },
  { id: "runs", label: "Run history", icon: History },
];

function Selection({ active }: { active: boolean }) {
  const reduced = useReducedMotion();
  return active ? <motion.span aria-hidden="true" className="sidebar-selection" layoutId={reduced ? undefined : "selected-destination"} initial={false} transition={reduced ? { duration: 0 } : selectionSpring} /> : null;
}

export function AppSidebar({
  page,
  project,
  projects,
  counts,
  version,
  navigate,
  openProject,
  addTask,
  showHelp,
}: {
  page: string;
  project: string;
  projects: Entity[];
  counts: Record<string, number | undefined>;
  version: string;
  navigate: (page: string) => void;
  openProject: (id: string) => void;
  addTask: () => void;
  showHelp: () => void;
}) {
  const { state, isMobile, setOpenMobile } = useSidebar();
  const selectionId = useId();
  const compact = state === "collapsed" && !isMobile;
  const go = (action: () => void) => {
    setOpenMobile(false);
    action();
  };
  return (
    <LayoutGroup id={selectionId}><Sidebar collapsible="icon" className="sift-sidebar">
      <SidebarHeader className="sift-sidebar-header">
        <div className="sift-sidebar-brand">
          <a
            href="#"
            className="wordmark"
            aria-label="Sift home"
            onClick={(e) => {
              e.preventDefault();
              go(() => navigate("today"));
            }}
          >
            <Mark />
            <span className="sidebar-label">Sift</span>
          </a>
          <span className="workspace-label sidebar-label">Personal</span>
          {isMobile && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close navigation"
              onClick={() => setOpenMobile(false)}
            >
              <X />
            </Button>
          )}
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="sift-create-task"
              tooltip="New task · N"
              aria-label="New task"
              onClick={() => go(addTask)}
            >
              <Plus />
              <span>New task</span>
              {!compact && <kbd>N</kbd>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <nav aria-label="Main navigation">
            <SidebarMenu>
              {navigation.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    isActive={page === id && !project}
                    aria-current={page === id && !project ? "page" : undefined}
                    aria-label={label}
                    tooltip={label}
                    onClick={() => go(() => navigate(id))}
                  >
                    <Selection active={page === id && !project} />
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                  {counts[id] !== undefined && (
                    <SidebarMenuBadge>{counts[id]}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
        <SidebarGroup className="sift-project-group">
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupAction
            aria-label="Manage projects"
            title="Manage projects"
            onClick={() => go(() => navigate("organization"))}
          >
            <Plus />
          </SidebarGroupAction>
          <SidebarMenu>
            {projects
              .filter((p) => !p.archived)
              .slice(0, 10)
              .map((p) => (
                <SidebarMenuItem key={p.id}>
                  <SidebarMenuButton
                    isActive={project === p.id}
                    aria-current={project === p.id ? "page" : undefined}
                    aria-label={p.name}
                    tooltip={p.name}
                    onClick={() => go(() => openProject(p.id))}
                  >
                    <Selection active={project === p.id} />
                    <Folder className={"project-color " + p.color} />
                    <span>{p.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            {!projects.some((p) => !p.archived) && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Create a project"
                  aria-label="Create a project"
                  onClick={() => go(() => navigate("organization"))}
                >
                  <Plus />
                  <span>Create a project</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="sift-sidebar-footer">
        <SidebarMenu>
          {[
            { id: "settings", label: "Settings", icon: Settings2 },
            { id: "trash", label: "Trash", icon: Trash2 },
          ].map(({ id, label, icon: Icon }) => (
            <SidebarMenuItem key={id}>
              <SidebarMenuButton
                isActive={page === id}
                aria-current={page === id ? "page" : undefined}
                aria-label={label}
                tooltip={label}
                onClick={() => go(() => navigate(id))}
              >
                <Selection active={page === id} />
                <Icon />
                <span>{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label="Help and shortcuts"
              tooltip="Help and shortcuts · ?"
              onClick={() => go(showHelp)}
            >
              <CircleHelp />
              <span>Help & shortcuts</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <span className="sift-version sidebar-label">Sift {version}</span>
      </SidebarFooter>
    </Sidebar></LayoutGroup>
  );
}
