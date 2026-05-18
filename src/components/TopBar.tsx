import { Command, Moon, Plus, Search, Sun } from "lucide-react";
import { useI18n, type TranslationKey } from "../i18n";
import type { ThemeMode, ViewId } from "../types";

const viewTitle: Record<ViewId, TranslationKey> = {
  dashboard: "nav.dashboard",
  today: "nav.today",
  upcoming: "nav.upcoming",
  projects: "nav.projects",
  calendar: "nav.calendar",
  visualization: "nav.visualization",
  assistant: "nav.assistant",
  settings: "nav.settings",
};

interface TopBarProps {
  activeView: ViewId;
  theme: ThemeMode;
  onNewTask: () => void;
  onOpenCommandPalette: () => void;
  onToggleTheme: () => void;
}

export function TopBar({ activeView, theme, onNewTask, onOpenCommandPalette, onToggleTheme }: TopBarProps) {
  const { language, t } = useI18n();
  const currentDate = new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());

  return (
    <header className="topbar">
      <div>
        <h1>{t(viewTitle[activeView])}</h1>
        <p>{currentDate}</p>
      </div>
      <div className="topbar__actions">
        <button className="command-trigger" onClick={onOpenCommandPalette}>
          <Search size={16} />
          <span>{t("topbar.command")}</span>
          <kbd>
            <Command size={12} /> K
          </kbd>
        </button>
        <button className="icon-button" onClick={onToggleTheme} aria-label={t("topbar.toggleTheme")}>
          {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
        </button>
        <button className="button button--primary" onClick={onNewTask} type="button">
          <Plus size={16} />
          {t("topbar.newTask")}
        </button>
      </div>
    </header>
  );
}
