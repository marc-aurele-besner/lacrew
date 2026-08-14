import type { ReactNode } from "react";
import type { Metadata } from "next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { Provider } from "@/components/provider";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import "./global.css";

export const metadata: Metadata = {
  title: { default: "LaCrew docs", template: "%s · LaCrew docs" },
  description:
    "Protocol spec, contract interfaces, SDK reference, and self-hosting guide for LaCrew.",
};

// Every route on this site is a docs page, so the sidebar lives in the root
// layout instead of a nested one.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>
          <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
            {children}
          </DocsLayout>
        </Provider>
      </body>
    </html>
  );
}
