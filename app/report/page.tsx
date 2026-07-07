"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ReportCard } from "@/components/ReportCard";
import { appVersion } from "@/lib/version";
import type { GeneratedReport } from "@/types";

export default function ReportPage() {
  const [report, setReport] = useState<GeneratedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const isMockMode =
    !report ||
    report.records.length === 0 ||
    report.records.some((record) => (record.analyze_mode ?? "mock") === "mock");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const token = params.get("token");
    const cached = window.sessionStorage.getItem("latest-report");
    const cachedReport = cached ? (JSON.parse(cached) as GeneratedReport) : null;

    if (!sessionId || !token) {
      if (cachedReport) setReport(cachedReport);
      setLoading(false);
      return;
    }
    const activeSessionId = sessionId;
    const activeToken = token;

    async function loadReport() {
      try {
        const response = await fetch(
          `/api/report?session_id=${encodeURIComponent(activeSessionId)}&token=${encodeURIComponent(activeToken)}`
        );
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error ?? "报告加载失败");
        }
        setReport(result as GeneratedReport);
        window.sessionStorage.setItem("latest-report", JSON.stringify(result));
      } catch (loadError) {
        if (cachedReport?.session?.id === activeSessionId) {
          setReport(cachedReport);
        } else {
          setError(loadError instanceof Error ? loadError.message : "报告加载失败");
        }
      } finally {
        setLoading(false);
      }
    }

    void loadReport();
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-5 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">学习监督报告</h1>
        {report && (
          <div
            className={
              isMockMode
                ? "mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-warn"
                : "mt-4 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm leading-6 text-muted"
            }
          >
            {isMockMode
              ? "当前为测试模式，状态识别为模拟结果，本报告仅用于流程测试，不代表真实学习判断。"
              : "本报告基于AI视觉识别生成，用于帮助家长了解本次学习过程。识别结果仅供参考，可结合实际情况判断。"}
          </div>
        )}
        <p className="mt-2 text-muted">本次监督已结束。</p>
        {report?.session && (
          <div className="mt-2 text-sm leading-6 text-muted">
            <div>{formatDateTime(report.session.startTime)} - {formatDateTime(report.session.endTime)}</div>
            <div>报告版本：{appVersion.version}</div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="rounded-md border border-line bg-white p-5 text-muted">
          正在加载学习报告...
        </div>
      ) : report ? (
        <ReportCard
          stats={report.stats}
          conclusion={report.conclusion ?? report.summary}
          parentAdvice={report.parentAdvice ?? "建议继续观察孩子的学习节奏。"}
          records={report.records ?? []}
          reportLevel={report.reportLevel ?? "basic"}
          trend={report.trend ?? null}
          habitTrend={report.habitTrend ?? null}
        />
      ) : (
        <div className="rounded-md border border-line bg-white p-5 text-muted">
          {error || "暂无学习报告，请先完成一次监督。"}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2 print:hidden">
        {report && (
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex h-11 items-center rounded-md border border-line px-4 font-semibold"
          >
            打印 / 保存PDF
          </button>
        )}
        <Link
          href="/"
          className="inline-flex h-11 items-center rounded-md bg-brand px-4 font-semibold text-white"
        >
          返回首页
        </Link>
      </div>
      {report && (
        <p className="mt-5 text-xs leading-5 text-muted">
          本报告由Session识别记录按时间段统计生成，不做身份识别，不代表对孩子能力或态度的评价。
        </p>
      )}
    </main>
  );
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
