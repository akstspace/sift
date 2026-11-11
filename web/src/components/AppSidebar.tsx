import {
  IconArchive as Archive,
  IconListCheck as ListCheck,
  IconHelpCircle as CircleHelp,
  IconFolder as Folder,
  IconHistory as History,
  IconPlus as Plus,
  IconSettings as Settings2,
  IconTerminal2 as Terminal,
  IconTimeline as Timeline,
  IconTrash as Trash2,
  IconX as X,
} from "@tabler/icons-react";
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
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui/sidebar";

export const navigation = [
  { id: "backlog", label: "All tasks", icon: ListCheck },
  { id: "activity", label: "My activity", icon: Timeline },
  { id: "organization", label: "Projects", icon: Folder },
  { id: "jobs", label: "Agents", icon: Terminal },
  { id: "runs", label: "Run history", icon: History },
];

// One highlight travels between destinations. It sits beside the button, not
// inside it: buttons clip their content, which would cut the moving highlight
// down to a sliver mid-flight.
function Selection({ active }: { active: boolean }) {
  const reduced = useReducedMotion();
  return active ? <motion.span aria-hidden="true" className="sidebar-selection" layoutId={reduced ? undefined : "selected-destination"} initial={false} transition={reduced ? { duration: 0 } : selectionSpring} /> : null;
}

export function AppSidebar({
  page,
  project,
  counts,
  version,
  navigate,
  addTask,
  showHelp,
}: {
  page: string;
  project: string;
  counts: Record<string, number | undefined>;
  version: string;
  navigate: (page: string) => void;
  addTask: () => void;
  showHelp: () => void;
}) {
  const { state, isMobile, setOpenMobile } = useSidebar();
  const selectionId = useId();
  const compact = state === "collapsed" && !isMobile;
  const activePage = project ? "organization" : page;
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
              go(() => navigate("backlog"));
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
                  <Selection active={activePage === id} />
                  <SidebarMenuButton
                    isActive={activePage === id}
                    aria-current={activePage === id ? "page" : undefined}
                    aria-label={label}
                    tooltip={label}
                    onClick={() => go(() => navigate(id))}
                  >
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
      </SidebarContent>
      <SidebarFooter className="sift-sidebar-footer">
        <SidebarMenu>
          {[
            { id: "settings", label: "Settings", icon: Settings2 },
            { id: "archive", label: "Archive", icon: Archive },
            { id: "trash", label: "Trash", icon: Trash2 },
          ].map(({ id, label, icon: Icon }) => (
            <SidebarMenuItem key={id}>
              <Selection active={page === id} />
              <SidebarMenuButton
                isActive={page === id}
                aria-current={page === id ? "page" : undefined}
                aria-label={label}
                tooltip={label}
                onClick={() => go(() => navigate(id))}
              >
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
