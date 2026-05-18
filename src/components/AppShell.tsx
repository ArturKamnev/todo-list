import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import type { Project, Task, ThemeMode, ViewId } from "../types";

interface AppShellProps {
  activeView: ViewId;
  setActiveView: (view: ViewId) => void;
  projects: Project[];
  tasks: Task[];
  theme: ThemeMode;
  onNewTask: () => void;
  onOpenCommandPalette: () => void;
  onToggleTheme: () => void;
  children: ReactNode;
}

export function AppShell({
  activeView,
  setActiveView,
  projects,
  tasks,
  theme,
  onNewTask,
  onOpenCommandPalette,
  onToggleTheme,
  children,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <Sidebar activeView={activeView} setActiveView={setActiveView} projects={projects} tasks={tasks} />
      <main className="main-area">
        <TopBar
          activeView={activeView}
          theme={theme}
          onNewTask={onNewTask}
          onOpenCommandPalette={onOpenCommandPalette}
          onToggleTheme={onToggleTheme}
        />
        <div className="content-area">{children}</div>
      </main>
    </div>
  );
}
