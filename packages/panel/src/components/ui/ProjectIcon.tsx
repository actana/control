import { useState, useEffect } from "react";
import { projectImageUrl } from "~/lib/project-image-url";

type ProjectLike = {
  id?: string;
  icon: string;
  iconColor: string;
  imagePath?: string | null;
  updatedAt?: number;
};

export function ProjectIcon({ project, size = 36 }: { project: ProjectLike; size?: number }) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [project.imagePath, project.updatedAt]);

  if (project.id && project.imagePath && !imgFailed) {
    return (
      <img
        src={projectImageUrl(project.id, project.updatedAt)}
        alt=""
        onError={() => setImgFailed(true)}
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.22,
          objectFit: "cover",
          border: `1px solid ${project.iconColor}33`,
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        background: `linear-gradient(135deg, ${project.iconColor}22, ${project.iconColor}08)`,
        border: `1px solid ${project.iconColor}33`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--mono)",
        fontSize: size * 0.36,
        fontWeight: 600,
        color: project.iconColor,
        letterSpacing: "-0.02em",
        flexShrink: 0,
      }}
    >
      {project.icon}
    </div>
  );
}
