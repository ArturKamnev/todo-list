import type { Project } from "../types";

export function ProjectBadge({ project }: { project?: Project }) {
  if (!project) return null;

  return (
    <span className="project-badge">
      <span className="project-badge__dot" style={{ background: project.color }} />
      {project.name}
    </span>
  );
}
