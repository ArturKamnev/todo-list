import {
  Bot,
  CalendarDays,
  CheckCircle2,
  ChartNoAxesGantt,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Settings,
} from "lucide-react";
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import gsap from "gsap";
import { useI18n, type TranslationKey } from "../i18n";
import type { MainViewId, Project, Task, ViewId } from "../types";
import { createCategoryViewId, getCategoryIdFromView } from "../utils/navigation";
import aevumLogoDark from "../../media/aevum-logo-dark.png";
import aevumLogoLight from "../../media/aevum-logo-light.png";

const navItems: Array<{ id: MainViewId; labelKey: TranslationKey; icon: typeof LayoutDashboard }> = [
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
  const menuRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const hasPlacedSelectionRef = useRef(false);
  const activeCategoryId = getCategoryIdFromView(activeView);
  const activeCategory = activeCategoryId ? projects.find((project) => project.id === activeCategoryId) : undefined;
  const activeSelectionKey = activeCategoryId ? `category:${activeCategoryId}` : `view:${activeView}`;
  const selectionStyle = {
    "--sidebar-selection-color": activeCategory?.color ?? "var(--accent-strong)",
  } as CSSProperties;

  function setSelectionTarget(key: string) {
    return (element: HTMLButtonElement | null) => {
      if (element) {
        itemRefs.current.set(key, element);
      } else {
        itemRefs.current.delete(key);
      }
    };
  }

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const selection = selectionRef.current;
    if (!menu || !selection) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;

    const placeSelection = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const target = itemRefs.current.get(activeSelectionKey);
        if (!target || target.offsetParent === null) {
          gsap.set(selection, { autoAlpha: 0 });
          return;
        }

        const menuRect = menu.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        if (targetRect.width < 1 || targetRect.height < 1) {
          gsap.set(selection, { autoAlpha: 0 });
          return;
        }

        const nextGeometry = {
          x: targetRect.left - menuRect.left,
          y: targetRect.top - menuRect.top,
          width: targetRect.width,
          height: targetRect.height,
          autoAlpha: 1,
        };

        if (reduceMotion || !hasPlacedSelectionRef.current) {
          gsap.set(selection, nextGeometry);
          hasPlacedSelectionRef.current = true;
          return;
        }

        gsap.to(selection, {
          ...nextGeometry,
          duration: 0.24,
          ease: "power3.out",
          overwrite: "auto",
        });
      });
    };

    placeSelection();

    const resizeObserver = new ResizeObserver(placeSelection);
    resizeObserver.observe(menu);
    const activeTarget = itemRefs.current.get(activeSelectionKey);
    if (activeTarget) resizeObserver.observe(activeTarget);
    window.addEventListener("resize", placeSelection);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", placeSelection);
    };
  }, [activeSelectionKey, projects]);

  return (
    <aside className="sidebar">
      <div className="window-drag-region" />
      <div className="brand-row">
        <div className="brand-mark brand-logo" aria-hidden="true">
          <img className="brand-logo__image brand-logo__image--dark" src={aevumLogoDark} alt="" />
          <img className="brand-logo__image brand-logo__image--light" src={aevumLogoLight} alt="" />
        </div>
        <div>
          <strong>Aevum</strong>
          <span>{t("app.tagline")}</span>
        </div>
      </div>

      <div className="sidebar-menu" ref={menuRef}>
        <span className="sidebar-selection" ref={selectionRef} style={selectionStyle} aria-hidden="true" />
        <nav className="sidebar-nav" aria-label={t("sidebar.primary")}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                className={`sidebar-nav__item ${isActive ? "sidebar-nav__item--active" : ""}`}
                key={item.id}
                onClick={() => setActiveView(item.id)}
                ref={setSelectionTarget(`view:${item.id}`)}
                type="button"
                aria-current={isActive ? "page" : undefined}
              >
                <Icon size={17} />
                <span>{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="project-list" aria-label={t("sidebar.projects")}>
          <div className="sidebar-label">{t("sidebar.projects")}</div>
          {projects.map((project) => {
            const categoryViewId = createCategoryViewId(project.id);
            const isActive = activeCategoryId === project.id;
            const activeCount = tasks.filter((task) => task.projectId === project.id && task.status === "active").length;
            return (
              <button
                className={`project-list__item ${isActive ? "project-list__item--active" : ""}`}
                key={project.id}
                onClick={() => setActiveView(categoryViewId)}
                ref={setSelectionTarget(`category:${project.id}`)}
                type="button"
                title={project.name}
                aria-current={isActive ? "page" : undefined}
              >
                <span className="project-dot" style={{ background: project.color }} />
                <span>{project.name}</span>
                <span className="project-count">{activeCount}</span>
              </button>
            );
          })}
        </div>
      </div>

    </aside>
  );
}
