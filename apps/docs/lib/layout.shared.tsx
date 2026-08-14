import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const repoUrl = "https://github.com/marc-aurele-besner/lacrew";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: "LaCrew docs" },
    githubUrl: repoUrl,
  };
}
