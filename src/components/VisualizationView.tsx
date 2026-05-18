import { CalendarClock, Clock3 } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "./EmptyState";
import { useI18n } from "../i18n";
import type { Project, Task } from "../types";
import { compareScheduledAt, getScheduleDate, getScheduleTime, getTodayISO, getTomorrowISO } from "../utils/date";

interface VisualizationViewProps {
  tasks: Task[];
  projects: Project[];
}

const timelineStart = 6 * 60;
const timelineEnd = 22 * 60;
const timelineSpan = timelineEnd - timelineStart;

export function VisualizationView({ tasks, projects }: VisualizationViewProps) {
  const { t } = useI18n();
  const [selectedDate, setSelectedDate] = useState(getTodayISO());
  const dayTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.status === "active" && getScheduleDate(task.scheduledAt) === selectedDate)
        .sort((a, b) => compareScheduledAt(a.scheduledAt, b.scheduledAt)),
    [selectedDate, tasks],
  );
  const timedTasks = dayTasks.filter((task) => getScheduleTime(task.scheduledAt));
  const unscheduledTasks = dayTasks.filter((task) => !getScheduleTime(task.scheduledAt));

  return (
    <section className="visualization-page">
      <div className="panel-heading">
        <div>
          <h2>{t("visualization.title")}</h2>
          <p>{t("visualization.description")}</p>
        </div>
        <CalendarClock size={18} />
      </div>

      <div className="visualization-controls">
        <div className="calendar-tabs">
          <button className={selectedDate === getTodayISO() ? "calendar-tabs__item calendar-tabs__item--active" : "calendar-tabs__item"} onClick={() => setSelectedDate(getTodayISO())} type="button">
            {t("calendar.today")}
          </button>
          <button className={selectedDate === getTomorrowISO() ? "calendar-tabs__item calendar-tabs__item--active" : "calendar-tabs__item"} onClick={() => setSelectedDate(getTomorrowISO())} type="button">
            {t("calendar.tomorrow")}
          </button>
        </div>
        <label className="visualization-date">
          <span>{t("visualization.selectedDate")}</span>
          <input value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} type="date" />
        </label>
      </div>

      {dayTasks.length === 0 ? (
        <EmptyState icon={Clock3} title={t("visualization.emptyTitle")} description={t("visualization.emptyDescription")} />
      ) : (
        <div className="day-plan">
          <div className="day-plan__timeline" aria-label={t("visualization.timeline")}>
            <div className="day-plan__hours" aria-hidden="true">
              {["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"].map((hour) => (
                <span key={hour}>{hour}</span>
              ))}
            </div>
            <div className="day-plan__lane">
              {timedTasks.length === 0 ? (
                <div className="day-plan__empty">{t("visualization.noTimedTasks")}</div>
              ) : (
                timedTasks.map((task) => {
                  const project = projects.find((item) => item.id === task.projectId);
                  const startMinutes = clamp(getStartMinutes(task.scheduledAt), timelineStart, timelineEnd);
                  const top = ((startMinutes - timelineStart) / timelineSpan) * 100;
                  const height = Math.max(44, ((task.durationMinutes ?? 30) / timelineSpan) * 100);
                  return (
                    <article className="day-plan__task" key={task.id} style={{ top: `${top}%`, minHeight: `${height}%` }}>
                      <time>{getScheduleTime(task.scheduledAt)}</time>
                      <div>
                        <strong>{task.title}</strong>
                        <span>
                          {project?.name ?? t("task.project")}
                          {task.durationMinutes ? ` - ${formatDuration(task.durationMinutes)}` : ""}
                        </span>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </div>

          <aside className="unscheduled-panel">
            <h3>{t("visualization.unscheduled")}</h3>
            {unscheduledTasks.length === 0 ? (
              <p>{t("visualization.noUnscheduled")}</p>
            ) : (
              <div className="compact-stack">
                {unscheduledTasks.map((task) => {
                  const project = projects.find((item) => item.id === task.projectId);
                  return (
                    <div className="compact-task" key={task.id}>
                      <strong>{task.title}</strong>
                      <span>{project?.name ?? t("task.project")}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function getStartMinutes(value: string | null) {
  const time = getScheduleTime(value);
  if (!time) return timelineStart;
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
