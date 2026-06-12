"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ReportCard } from "@/components/ReportCard";
import type { ReportLevel, StudyRecord, StudyStats } from "@/types";

type ReportState = {
  stats: StudyStats;
  summary: string;
  conclusion: string;
  parentAdvice: string;
  trend: Record<string, string> | null;
  records: StudyRecord[];
  reportLevel: ReportLevel;
};

export default function ReportPage() {
  const [report, setReport] = useState<ReportState | null>(null);

  useEffect(() => {
    const raw = window.sessionStorage.getItem("latest-report");
    if (raw) setReport(JSON.parse(raw) as ReportState);
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-5 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">学习监督报告</h1>
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-warn">
          当前为测试模式，状态识别为模拟结果，本报告仅用于流程测试，不代表真实学习判断。
        </div>
        <p className="mt-2 text-muted">本次监督已结束。</p>
      </div>

      {report ? (
        <ReportCard
          stats={report.stats}
          conclusion={report.conclusion ?? report.summary}
          parentAdvice={report.parentAdvice ?? "建议继续观察孩子的学习节奏。"}
          records={report.records ?? []}
          reportLevel={report.reportLevel ?? "basic"}
          trend={report.trend ?? null}
        />
      ) : (
        <div className="rounded-md border border-line bg-white p-5 text-muted">
          暂无学习报告，请先完成一次监督。
        </div>
      )}

      <Link
        href="/"
        className="mt-6 inline-flex h-11 w-fit items-center rounded-md bg-brand px-4 font-semibold text-white"
      >
        返回首页
      </Link>
    </main>
  );
}
