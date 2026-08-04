import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI学习监督助手",
  description: "自动记录孩子学习状态，生成学习专注报告"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0d7f6f"
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  const isStaging = process.env.NEXT_PUBLIC_APP_ENV === "staging";
  const stagingProjectRef =
    process.env.NEXT_PUBLIC_EXPECTED_SUPABASE_PROJECT_REF;

  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-panel text-ink antialiased">
        {isStaging ? (
          <div
            className="bg-amber-100 px-4 py-2 text-center text-sm font-semibold text-amber-900"
            data-app-environment="staging"
            data-supabase-project-ref={stagingProjectRef}
            role="status"
          >
            v0.9 测试环境
          </div>
        ) : null}
        {children}
      </body>
    </html>
  );
}
