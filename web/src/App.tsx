import { Input } from "./components/ui/input";
import { Choice } from "./components/Choice";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import {
  IconArchive as Archive,
  IconBell as Bell,
  IconCheck as Check,
  IconChevronRight as ChevronRight,
  IconHelpCircle as CircleHelp,
  IconClock as Clock3,
  IconFolder as Folder,
  IconHistory as History,
  IconLayoutGrid as LayoutGrid,
  IconList as List,
  IconMenu2 as Menu,
  IconMoon as Moon,
  IconPlus as Plus,
  IconSearch as Search,
  IconSettings as Settings2,
  IconAdjustmentsHorizontal as SlidersHorizontal,
  IconSun as Sun,
  IconSunHigh as SunMedium,
  IconTerminal2 as Terminal,
  IconTrash as Trash2,
  IconWifiOff as WifiOff,
  IconX as X,
} from "@tabler/icons-react";
import { Toaster, toast } from "sonner";
import { api, friendlyTime, localDate } from "./api";
import {
  newTask,
  type CatalogIcon,
  type Settings as SettingsType,
  type Snapshot,
  type Task,
  type HistoryEntry,
} from "./types";
import { Action, Button, Busy, Empty, IconButton, Mark } from "./components/shared";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
const Onboarding = lazy(() => import("./components/Onboarding").then(m => ({ default: m.Onboarding })));
import { TaskBoard } from "./components/TaskBoard";
// Opening a task is the workspace's primary interaction. Its sheet must be
// ready with the board, not replaced by a second panel after a lazy import.
import { TaskDetail } from "./components/TaskDetail";
const Jobs = lazy(() => import("./components/Jobs").then(m => ({ default: m.Jobs })));
const Runs = lazy(() => import("./components/Jobs").then(m => ({ default: m.Runs })));
const Settings = lazy(() => import("./components/Settings").then(m => ({ default: m.Settings })));
const Organization = lazy(() => import("./components/Organization").then(m => ({ default: m.Organization })));
import { AppSidebar } from "./components/AppSidebar";
import { SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "./components/ui/breadcrumb";
import { Separator } from "./components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { DraftGuardProvider, useDraftGuard } from "./components/DraftGuard";
import { pageMotion, pageOrder } from "./motion";
import { ConnectionMonitor, type ConnectionState } from "./connection";
import { useInertBackground } from "./hooks/useInertBackground";

export default function App() {
  useInertBackground();
  return <MotionConfig reducedMotion="user"><TooltipProvider><DraftGuardProvider><Workspace /></DraftGuardProvider></TooltipProvider></MotionConfig>;
}

function Workspace() {
  const reduced = !!useReducedMotion();
  const { guard } = useDraftGuard();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [catalog, setCatalog] = useState<CatalogIcon[]>([]),
    [page, setPage] = useState("today"),
    [project, setProject] = useState(""),
    [query, setQuery] = useState(""),
    [priority, setPriority] = useState(""),
    [tag, setTag] = useState(""),
    [due, setDue] = useState(""),
    [status, setStatus] = useState(""),
    [filters, setFilters] = useState(false),
    [selected, setSelected] = useState<Task | null>(null),
    [connection, setConnection] = useState<ConnectionState>("connecting"),
    [connectionAttempt, setConnectionAttempt] = useState(0),
    [loadError, setLoadError] = useState(""),
    [storageReady, setStorageReady] = useState(false),
    [storageError, setStorageError] = useState(""),
    [sidebarOpen, setSidebarOpen] = useState(() => { try { return localStorage.getItem("sift.sidebar") !== "collapsed"; } catch { return true; } }),
    [darkTheme, setDarkTheme] = useState(false),
    [notifications, setNotifications] = useState(false),
    [help, setHelp] = useState(false),
    [onboarding, setOnboarding] = useState(false),
    [createJob, setCreateJob] = useState(false),
    [selectedRun, setSelectedRun] = useState(""),
    [clock, setClock] = useState(Date.now());
  const search = useRef<HTMLInputElement>(null),
    refreshRunning = useRef(false),
    cursor = useRef(0),
    snapshotRef = useRef(snapshot),
    seenNotifications = useRef(new Set<string>());
  const routeKey = project ? `project:${project}` : page;
  const previousRoute = useRef({ key: routeKey, page });
  const direction = useRef(1);
  if (previousRoute.current.key !== routeKey) {
    direction.current = pageOrder.indexOf(page) < pageOrder.indexOf(previousRoute.current.page) ? -1 : 1;
    previousRoute.current = { key: routeKey, page };
  }
  snapshotRef.current = snapshot;
  const refresh = useCallback(async () => {
    if (refreshRunning.current) return;
    refreshRunning.current = true;
    try {
      const value = await api<Snapshot>("/snapshot");
      cursor.current = value.cursor;
      setSnapshot(value);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      refreshRunning.current = false;
    }
  }, []);
  useEffect(() => {
    refresh();
    api<CatalogIcon[]>("/icons")
      .then(setCatalog)
      .catch(() => {});
    const health = () =>
      api<{ storage: { ready: boolean; error?: string } }>("/health")
        .then((h) => {
          setStorageReady(h.storage.ready);
          setStorageError(h.storage.error || "");
        })
        .catch(() => {
          setStorageReady(false);
          setStorageError("Cannot check image storage. Check the local service connection.");
        });
    health();
    const timer = setInterval(() => {
      setClock(Date.now());
      health();
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!snapshot) return;
    const source = new EventSource("/api/events?after=" + cursor.current);
    const monitor = new ConnectionMonitor(setConnection);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    source.onopen = () => {
      monitor.open();
      refresh();
    };
    source.onerror = () => monitor.error();
    source.addEventListener("reset", () => { cursor.current = 0; refresh(); });
    source.addEventListener("change", () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        refresh();
      }, 180);
    });
    return () => {
      source.close();
      monitor.dispose();
      if (debounce) clearTimeout(debounce);
    };
  }, [!!snapshot, refresh, connectionAttempt]);
  useEffect(() => {
    const theme = snapshot?.settings.theme || "system";
    const system = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      setDarkTheme(theme === "dark" || (theme === "system" && system.matches));
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && system.matches),
      );
      document.documentElement.style.colorScheme =
        theme === "system" ? (system.matches ? "dark" : "light") : theme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" || (theme === "system" && system.matches) ? "#18191B" : "#EBE9E4");
    };
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [snapshot?.settings.theme]);
  useEffect(() => {
    if (!snapshot) return;
    for (const n of snapshot.notifications) {
      if (seenNotifications.current.has(n.id)) continue;
      seenNotifications.current.add(n.id);
      if (!n.read && new Date(n.at).valueOf() > Date.now() - 5000) {
        toast(n.title, { description: n.message });
        if (
          snapshot.settings.desktopNotifications &&
          "Notification" in window &&
          window.Notification.permission === "granted"
        )
          new window.Notification(n.title, {
            body: n.message,
            icon: "/icon-192.png",
          });
      }
    }
  }, [snapshot?.notifications]);
  const navigate = (value: string, projectId = "") => guard(() => {
    setPage(value);
    setProject(projectId);
    setQuery("");
    setSelected(null);
    setPriority("");
    setTag("");
    setDue("");
    setStatus("");
  });
  const saveSettings = async (settings: SettingsType) => {
    await api("/settings", "PUT", settings);
    await refresh();
  };
  const saveTask = async (task: Task, reason = "") => {
    const result = await api<{ task: Task; potentialDuplicates: unknown[] }>(
      "/tasks" + (task.id ? "/" + task.id : ""),
      task.id ? "PUT" : "POST",
      {
        task,
        expectedRevision: task.revision,
        reason,
        requestId: crypto.randomUUID(),
      },
    );
    await refresh();
    return result.task;
  };
  const changeTask = async (task: Task) => {
    try {
      const saved = await saveTask(
        task,
        task.status === "done"
          ? "Marked complete in workspace"
          : "Updated in workspace",
      );
      toast.success(
        task.status === "done" ? "Task completed" : "Task updated",
        {
          action: {
            label: "Undo",
             onClick: async () => {
               try {
                const h = await api<HistoryEntry[]>(
                 "/history?entity=" + task.id,
               );
               const change = h.find(entry => entry.after?.revision === saved.revision && entry.entityId === saved.id);
                  if (!change) throw Error("This change is no longer available to undo. Open task history to review it.");
                 await api("/undo/" + change.id, "POST", {});
                await refresh();
              } catch (e) {
                toast.error((e as Error).message);
              }
            },
          },
        },
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const openTask = (task: Task) => guard(() => setSelected(task));
  const addTask = (taskStatus = "open", parent = "") => guard(() => {
    const t = newTask(parent);
    t.status = taskStatus;
    t.today = page === "today";
    t.project =
      project || snapshot?.tasks.find((v) => v.id === parent)?.project || "";
    setSelected(t);
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const input =
        e.target instanceof HTMLElement &&
        (e.target.matches("input,textarea,select") ||
          e.target.isContentEditable);
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        search.current?.focus();
      }
      if (!input && e.key === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        addTask();
      }
      if (!input && e.key === "?") setHelp(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [page, project, snapshot]);
  const timezone = snapshot?.settings.timezone || "UTC";
  const today = localDate(timezone);
  void clock;
  const activeTasks = useMemo(
    () => snapshot?.tasks.filter((t) => !t.deletedAt && !t.mergedInto) || [],
    [snapshot?.tasks],
  );
  const todayTasks = useMemo(
    () =>
      activeTasks.filter(
        (t) =>
          (t.today ||
            (t.dueDate && t.dueDate <= today) ||
            (t.snoozedUntil && t.snoozedUntil <= today)) &&
          (!t.snoozedUntil || t.snoozedUntil <= today) &&
          (t.status !== "done" ||
            localDateAt(t.updatedAt, timezone) ===
              today),
      ),
    [activeTasks, today, timezone],
  );
  const tasks = useMemo(() => {
    if (!snapshot) return [];
    let list =
      page === "trash"
        ? snapshot.tasks.filter((t) => !!t.deletedAt)
        : page === "today"
          ? todayTasks
          : activeTasks;
    return list
      .filter(
        (t) =>
          (page === "trash" || !t.snoozedUntil || t.snoozedUntil <= today) &&
          (!project || t.project === project) &&
          (!query ||
            (t.title + " " + t.description + " " + t.id)
              .toLowerCase()
              .includes(query.toLowerCase())) &&
          (!priority || t.priority === priority) &&
          (!tag || t.tags.includes(tag)) &&
          (!status || t.status === status) &&
          (!due ||
            (due === "overdue"
              ? !!t.dueDate && t.dueDate < today && t.status !== "done"
              : due === "today"
                ? t.dueDate === today
                : !t.dueDate)),
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }, [
    snapshot?.tasks,
    page,
    todayTasks,
    activeTasks,
    today,
    project,
    query,
    priority,
    tag,
    status,
    due,
  ]);
  const doneToday = todayTasks.filter((t) => t.status === "done").length;
  if (!snapshot)
    return (
      <MotionConfig reducedMotion="user">
        <div className="initial-state">
          <Mark />
          <h1>Sift</h1>
          {loadError ? (
            <>
              <p className="error">Cannot connect to your local workspace.</p>
              <p className="muted">Start the local service, then try again.</p>
              <code>sift serve</code>
              <Button onClick={refresh}>Reconnect</Button>
            </>
          ) : (
            <Busy label="Opening your workspace" />
          )}
        </div>
      </MotionConfig>
    );
  if (!snapshot.settings.onboarded || onboarding)
    return (
      <MotionConfig reducedMotion="user">
        <Suspense fallback={<div className="loading-screen"><Busy label="Opening setup" /></div>}><Onboarding
          settings={snapshot.settings}
          storageReady={storageReady}
          storageError={storageError}
          onFinish={async (cfg) => {
            await saveSettings(cfg);
            setOnboarding(false);
          }}
          onCreateJob={() => {
            setPage("jobs");
            setCreateJob(true);
          }}
        /></Suspense>
        <Toaster theme={darkTheme ? "dark" : "light"} richColors />
      </MotionConfig>
    );
  const boardPage = ["today", "backlog", "trash"].includes(page);
  const title = project
    ? snapshot.projects.find((p) => p.id === project)?.name || "Project"
    : page === "today"
      ? "Today"
      : page === "trash"
        ? "Trash"
        : "Backlog";
  const activeRuns = snapshot.runs.filter((r) => r.status === "running"),
    unread = snapshot.notifications.filter((n) => !n.read).length;
  const navItems = [
    {
      id: "today",
      label: "Today",
      icon: SunMedium,
      count: todayTasks.filter((t) => t.status !== "done").length,
    },
    {
      id: "backlog",
      label: "Backlog",
      icon: Archive,
      count: activeTasks.filter((t) => t.status !== "done").length,
    },
    { id: "organization", label: "Projects & tags", icon: Folder },
    {
      id: "jobs",
      label: "Agents",
      icon: Terminal,
      count: activeRuns.length || undefined,
    },
    { id: "runs", label: "Run history", icon: History },
  ];
  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      <TooltipProvider>
        <SidebarProvider open={sidebarOpen} onOpenChange={open => { setSidebarOpen(open); try { localStorage.setItem("sift.sidebar", open ? "expanded" : "collapsed"); } catch { /* Storage can be disabled. */ } }} className={"app-shell " + (selected ? "detail-open" : "")}>
          <a className="skip-link" href="#main">
            Skip to main content
          </a>
          <AppSidebar page={page} project={project} projects={snapshot.projects} counts={{today: todayTasks.filter(t => t.status !== "done").length, backlog: activeTasks.filter(t => t.status !== "done").length, jobs: activeRuns.length || undefined}} version={snapshot.version} navigate={navigate} openProject={id => navigate("backlog", id)} addTask={() => addTask()} showHelp={() => setHelp(true)} />
          <div className="workspace">
            <header className="topbar">
              <SidebarTrigger />
              <Separator orientation="vertical" className="topbar-separator" />
              <Breadcrumb className="sift-breadcrumb"><BreadcrumbList><BreadcrumbItem className="breadcrumb-workspace">Workspace</BreadcrumbItem><BreadcrumbSeparator className="breadcrumb-workspace" /><BreadcrumbItem><BreadcrumbPage>{boardPage ? title : navItems.find(v => v.id === page)?.label || "Settings"}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
              <div className="global-search">
                <Search size={16} />
                <Input
                  ref={search}
                  aria-label="Search all tasks"
                  placeholder="Search all tasks…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    if (!boardPage || page === "today") setPage("backlog");
                  }}
                />
                <kbd>⌘ K</kbd>
                {query && (
                  <Action
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                  >
                    <X size={13} />
                  </Action>
                )}
              </div>
              <IconButton
                label="Change theme"
                onClick={() =>
                  saveSettings({
                    ...snapshot.settings,
                    theme: darkTheme
                      ? "light"
                      : "dark",
                  }).catch((e) => toast.error(e.message))
                }
              >
                {darkTheme ? (
                  <Sun size={17} />
                ) : (
                  <Moon size={17} />
                )}
              </IconButton>
              <div className="notification-control">
                <IconButton
                  label={
                    unread ? `${unread} unread notifications` : "Notifications"
                  }
                  onClick={() => setNotifications((v) => !v)}
                >
                  <Bell size={17} />
                  {unread > 0 && <span className="notification-dot" />}
                </IconButton>
              </div>
            </header>
            {(connection === "interrupted" || loadError) && (
              <div className="connection-banner" role="status">
                <WifiOff size={15} />
                <span>{loadError ? "Couldn’t refresh your workspace. Your current view is preserved." :
                  "Connection interrupted. Your current view is preserved; reconnecting to local Sift…"}</span>
                <Button variant="ghost" size="sm" onClick={() => { refresh(); setConnectionAttempt(n => n + 1); }}>
                  Retry
                </Button>
              </div>
            )}
            <main id="main" className="main-content" tabIndex={0}>
              <Suspense fallback={<div className="page-body"><Busy label="Opening view" /></div>}><AnimatePresence mode="wait" initial={false} custom={direction.current}>
                <motion.div
                  key={routeKey}
                  custom={direction.current}
                  className="page-transition"
                  variants={pageMotion(reduced)}
                  initial="enter"
                  animate="visible"
                  exit="exit"
                  onAnimationComplete={() => { document.getElementById("main")?.scrollTo({ top: 0 }); }}
                >
                  {boardPage ? (
                    <div className="board-page">
                      <header className="page-heading">
                          <div>
                            <div className="board-title">
                            <h1>{title}</h1>
                          {page === "today" && (
                              <p className="today-date">
                              {new Intl.DateTimeFormat(undefined, {
                                weekday: "long",
                                month: "long",
                                day: "numeric",
                                timeZone: snapshot.settings.timezone,
                              }).format(new Date())}
                              </p>
                          )}
                            </div>
                          <p>
                            {page === "today"
                              ? todayTasks.length
                                ? `${doneToday} of ${todayTasks.length} tasks complete`
                                : "A little clarity for the day ahead."
                              : page === "trash"
                                ? `Recoverable for ${snapshot.settings.trashRetentionDays} days. History is kept after removal.`
                                : project
                                  ? "A home for the work that belongs together."
                                  : "Everything worth coming back to."}
                          </p>
                        </div>
                        {page !== "trash" && (
                          <Button onClick={() => addTask()}>
                            <Plus size={16} />
                            <span>New task</span>
                          </Button>
                        )}
                      </header>
                      {page === "today" && todayTasks.length > 0 && (
                        <div
                          className="daily-progress"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={todayTasks.length}
                          aria-valuenow={doneToday}
                          aria-label={`${doneToday} of ${todayTasks.length} tasks complete`}
                        >
                          <motion.div
                            initial={false}
                            animate={{
                              width:
                                (doneToday / todayTasks.length) * 100 + "%",
                            }}
                          />
                        </div>
                      )}
                      <div className="task-toolbar">
                        <div className="toolbar-scope">
                          <span>
                            {tasks.length}{" "}
                            {tasks.length === 1 ? "task" : "tasks"}
                          </span>
                          {query && (
                            <span className="query-label">
                              matching “{query}”
                            </span>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setFilters((v) => !v)}
                          aria-expanded={filters}
                        >
                          <SlidersHorizontal size={14} />
                          Filters
                          {[priority, tag, due, status].filter(Boolean).length >
                            0 && (
                            <span className="filter-count">
                              {
                                [priority, tag, due, status].filter(Boolean)
                                  .length
                              }
                            </span>
                          )}
                        </Button>
                        <ToggleGroup type="single" value={snapshot.settings.view} onValueChange={view => { if(view) saveSettings({...snapshot.settings, view}).catch(e => toast.error(e.message)); }}
                          className="view-toggle"
                          aria-label="Task view"
                        >
                          <ToggleGroupItem value="board"
                            aria-label="Kanban view"
                          >
                            <LayoutGrid size={16} />
                            <span>Board</span>
                          </ToggleGroupItem>
                          <ToggleGroupItem value="list"
                            aria-label="List view"
                          >
                            <List size={17} />
                            <span>List</span>
                          </ToggleGroupItem>
                        </ToggleGroup>
                      </div>
                      <AnimatePresence initial={false}>
                        {filters && (
                          <motion.div
                            className="filter-bar"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                          >
                            <Choice
                              aria-label="Filter priority"
                              value={priority}
                              onValueChange={setPriority}
                              options={[{ value: "", label: "All priorities" }, ...["urgent", "high", "medium", "low", "none"].map(p => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))]}
                            />
                            <Choice
                              aria-label="Filter tags"
                              value={tag}
                              onValueChange={setTag}
                              options={[{ value: "", label: "All tags" }, ...snapshot.tags.map(t => ({ value: t.id, label: t.name }))]}
                            />
                            <Choice
                              aria-label="Filter due date"
                              value={due}
                              onValueChange={setDue}
                              options={[{ value: "", label: "Any due date" }, { value: "overdue", label: "Overdue" }, { value: "today", label: "Due today" }, { value: "none", label: "No due date" }]}
                            />
                            <Choice
                              aria-label="Filter status"
                              value={status}
                              onValueChange={setStatus}
                              options={[{ value: "", label: "All statuses" }, ...[...snapshot.columns].sort((a, b) => a.order - b.order).map(c => ({ value: c.id, label: c.name }))]}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setPriority("");
                                setTag("");
                                setDue("");
                                setStatus("");
                              }}
                            >
                              Clear
                            </Button>
                          </motion.div>
                        )}
                      </AnimatePresence>
                      {tasks.length === 0 &&
                      (query || priority || tag || due || status) ? (
                        <Empty
                          icon={Search}
                          title="No tasks match this view."
                          action={
                            <Button
                              variant="outline"
                              onClick={() => {
                                setQuery("");
                                setPriority("");
                                setTag("");
                                setDue("");
                                setStatus("");
                              }}
                            >
                              Clear search & filters
                            </Button>
                          }
                        >
                          Try a broader search or remove a filter. Your other
                          work is still here.
                        </Empty>
                      ) : page === "trash" ? (
                        <div className="trash-list">
                          {tasks.length ? (
                            tasks.map((t) => (
                                  <Action key={t.id} onClick={() => openTask(t)}>
                                <Trash2 size={15} />
                                <span>{t.title}</span>
                                <small>{friendlyTime(t.deletedAt)}</small>
                                <ChevronRight size={14} />
                                  </Action>
                            ))
                          ) : (
                            <Empty icon={Trash2} title="Nothing in Trash.">
                              Deleted tasks stay here temporarily, so an
                              accidental click doesn’t have to stick.
                            </Empty>
                          )}
                        </div>
                      ) : (
                        <AnimatePresence mode="wait" initial={false}><motion.div key={snapshot.settings.view} className="task-view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0.06 : 0.12 }}><TaskBoard
                          tasks={tasks}
                          allTasks={snapshot.tasks}
                          columns={snapshot.columns}
                          projects={snapshot.projects}
                          catalog={catalog}
                          view={snapshot.settings.view}
                          onOpen={openTask}
                          onAdd={addTask}
                          onChange={changeTask}
                          today={today}
                          selected={selected?.id}
                        /></motion.div></AnimatePresence>
                      )}
                    </div>
                  ) : page === "jobs" ? (
                    <Jobs
                      snapshot={snapshot}
                      refresh={refresh}
                      create={createJob}
                      onCreated={() => setCreateJob(false)}
                      onRun={(id) => {
                        setSelectedRun(id);
                        setPage("runs");
                      }}
                    />
                  ) : page === "runs" ? (
                    <Runs
                      snapshot={snapshot}
                      selected={selectedRun}
                      onSelect={setSelectedRun}
                      refresh={refresh}
                    />
                  ) : page === "organization" ? (
                    <Organization
                      snapshot={snapshot}
                      refresh={refresh}
                      onProject={(id) => {
                        navigate("backlog", id);
                      }}
                    />
                  ) : (
                    <Settings
                      snapshot={snapshot}
                      refresh={refresh}
                      onSettings={saveSettings}
                      onOnboard={() => setOnboarding(true)}
                    />
                  )}
                </motion.div>
              </AnimatePresence></Suspense>
            </main>
            {activeRuns.length > 0 && (
              <div className="activity-strip">
                <span className="running-indicator" />
                <Action
                  onClick={() => {
                    navigate("runs");
                    setSelectedRun(activeRuns[0].id);
                  }}
                >
                  {activeRuns.length === 1
                    ? activeRuns[0].jobName
                    : `${activeRuns.length} agents`}{" "}
                  working
                  <ChevronRight size={13} />
                </Action>
                <span>Task changes appear here live</span>
              </div>
            )}
          </div>
          <AnimatePresence mode="wait">
            {selected && (
              <TaskDetail
                key={selected.id || "new:" + selected.parentId}
                initial={selected}
                snapshot={snapshot}
                catalog={catalog}
                onClose={() => setSelected(null)}
                onSave={saveTask}
                onOpen={openTask}
                onAddChild={(parent) => addTask("open", parent)}
                refresh={refresh}
              />
            )}
          </AnimatePresence>
        </SidebarProvider>
        <Dialog open={notifications} onOpenChange={setNotifications}>
          <DialogContent className="notifications-dialog">
            <DialogHeader>
              <DialogTitle>Notifications</DialogTitle>
              <DialogDescription>
                Local service activity and things that need your attention.
              </DialogDescription>
            </DialogHeader>
            {snapshot.notifications.length ? (
              <div className="notification-list">
                {[...snapshot.notifications]
                  .sort((a, b) => b.at.localeCompare(a.at))
                  .map((n) => (
                    <div key={n.id} className={n.read ? "read" : ""}>
                      <Bell size={16} />
                      <div>
                        <strong>{n.title}</strong>
                        <p>{n.message}</p>
                        <small>{friendlyTime(n.at)}</small>
                      </div>
                      {!n.read && (
                        <IconButton
                          label="Mark notification read"
                          onClick={async () => {
                            await api(
                              "/notifications/" + n.id + "/read",
                              "POST",
                              {},
                            );
                            await refresh();
                          }}
                        >
                          <Check size={15} />
                        </IconButton>
                      )}
                    </div>
                  ))}
              </div>
            ) : (
              <Empty icon={Bell} title="You’re all caught up.">
                When something needs your attention, it will appear here.
              </Empty>
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={help} onOpenChange={setHelp}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>A little orientation</DialogTitle>
              <DialogDescription>
                Sift is a local workspace, not a cloud service. The local
                service keeps schedules running, even with this window closed.
              </DialogDescription>
            </DialogHeader>
            <dl className="shortcut-list">
              <div>
                <dt>New task</dt>
                <dd>
                  <kbd>N</kbd>
                </dd>
              </div>
              <div>
                <dt>Search all tasks</dt>
                <dd>
                  <kbd>⌘ / Ctrl K</kbd>
                </dd>
              </div>
              <div>
                <dt>Save a task</dt>
                <dd>
                  <kbd>⌘ / Ctrl Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>Close task details</dt>
                <dd>
                  <kbd>Escape</kbd>
                </dd>
              </div>
              <div>
                <dt>This guide</dt>
                <dd>
                  <kbd>?</kbd>
                </dd>
              </div>
            </dl>
            <p className="muted small">
              Move Kanban cards with the drag handle. Status menus in List view
              and task details provide a keyboard-accessible alternative.
            </p>
            <div className="command-line">
              <code>sift help</code>
            </div>
          </DialogContent>
        </Dialog>
        <Toaster theme={darkTheme ? "dark" : "light"} richColors closeButton position="bottom-right" />
      </TooltipProvider>
    </MotionConfig>
  );
}
function localDateAt(at: string, tz: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  } catch {
    return at.slice(0, 10);
  }
}
