import {
  Bot,
  CalendarDays,
  CheckCircle2,
  ChartNoAxesGantt,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Settings,
  Sparkles,
} from "lucide-react";
import { useI18n, type TranslationKey } from "../i18n";
import type { Project, Task, ViewId } from "../types";

const navItems: Array<{ id: ViewId; labelKey: TranslationKey; icon: typeof LayoutDashboard }> = [
  { id: "dashboard", labelKey: "nav.dashboard", icon: LayoutDashboard },
  { id: "today", labelKey: "nav.today", icon: CheckCircle2 },
  { id: "upcoming", labelKey: "nav.upcoming", icon: CalendarDays },
  { id: "projects", labelKey: "nav.projects", icon: Inbox },
  { id: "calendar", labelKey: "nav.calendar", icon: ListTodo },
  { id: "visualization", labelKey: "nav.visualization", icon: ChartNoAxesGantt },
  { id: "assistant", labelKey: "nav.assistant", icon: Bot },
  { id: "settings", labelKey: "nav.settings", icon: Settings },
];

interface SidebarProps {
  activeView: ViewId;
  setActiveView: (view: ViewId) => void;
  projects: Project[];
  tasks: Task[];
}

export function Sidebar({ activeView, setActiveView, projects, tasks }: SidebarProps) {
  const { t } = useI18n();

  return (
    <aside className="sidebar">
      <div className="window-drag-region" />
      <div className="brand-row">
        <div className="brand-mark">
          <Sparkles size={17} />
        </div>
        <div>
          <strong>Todo AI</strong>
          <span>{t("app.tagline")}</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label={t("sidebar.primary")}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;
          return (
            <button
              className={`sidebar-nav__item ${isActive ? "sidebar-nav__item--active" : ""}`}
              key={item.id}
              onClick={() => setActiveView(item.id)}
            >
              <Icon size={17} />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      <div className="project-list">
        <div className="sidebar-label">{t("sidebar.projects")}</div>
        {projects.map((project) => {
          const activeCount = tasks.filter((task) => task.projectId === project.id && task.status === "active").length;
          return (
            <button className="project-list__item" key={project.id} onClick={() => setActiveView("projects")}>
              <span className="project-dot" style={{ background: project.color }} />
              <span>{project.name}</span>
              <span className="project-count">{activeCount}</span>
            </button>
          );
        })}
      </div>

      <div className="sidebar-card">
        <span>{t("sidebar.aiFocus")}</span>
        <strong>{t("sidebar.aiFocusText")}</strong>
      </div>
    </aside>
  );
}
