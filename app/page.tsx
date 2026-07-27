"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getDeviceId } from "@/lib/device";
import { privacyNoticeText, privacyNoticeVersion } from "@/lib/privacy";
import { loadReportHistory, reportUrl, saveReportHistory, type ReportHistoryEntry } from "@/lib/report-history";
import { appVersion } from "@/lib/version";
import type { AccessCode, StudySession } from "@/types";

type CurrentSupervision = {
  accessCode: AccessCode;
  session: StudySession;
  totalRemainingMinutes: number;
};

export default function HomePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(true);
  const [reportHistory, setReportHistory] = useState<ReportHistoryEntry[]>([]);
  const [recoverableSupervision, setRecoverableSupervision] =
    useState<CurrentSupervision | null>(null);

  useEffect(() => {
    setReportHistory(loadReportHistory());
  }, []);

  function enterSupervision(supervision: CurrentSupervision) {
    window.sessionStorage.setItem("current-supervision", JSON.stringify(supervision));
    router.push("/supervise");
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/access-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "validate",
          code,
          deviceId: getDeviceId(),
          privacyAcknowledged,
          privacyNoticeVersion
        })
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "访问码验证失败");
        return;
      }

      const supervision = {
        accessCode: result.accessCode,
        session: result.session,
        totalRemainingMinutes: result.totalRemainingMinutes
      };

      if (result.recoverable) {
        setRecoverableSupervision(supervision);
        return;
      }

      enterSupervision(supervision);
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  async function finishRecoverableSession() {
    if (!recoverableSupervision) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/session/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessCodeId: recoverableSupervision.accessCode.id,
          sessionId: recoverableSupervision.session.id,
          sessionToken: recoverableSupervision.session.session_token,
          endTime: new Date().toISOString(),
          reportLevel: recoverableSupervision.accessCode.report_level
        })
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error ?? "结算失败，请稍后重试");
        return;
      }
      setRecoverableSupervision(null);
      window.sessionStorage.removeItem("current-supervision");
      const reportToken = recoverableSupervision.session.report_token;
      if (reportToken) {
        const entry = {
          sessionId: recoverableSupervision.session.id,
          reportToken,
          startTime: recoverableSupervision.session.start_time,
          endTime: new Date().toISOString()
        };
        saveReportHistory(entry);
        router.push(reportUrl(entry));
        return;
      }
      setError("已结束并结算未完成的监督。");
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 py-8">
      <section className="flex flex-1 flex-col justify-center">
        <div className="mb-8">
          <h1 className="text-4xl font-bold tracking-normal text-ink">
            AI学习监督助手
          </h1>
          <p className="mt-3 text-lg leading-8 text-muted">
            记录孩子学习节奏
            <br />
            帮助养成专注习惯
          </p>
        </div>

        <div className="mb-5 grid gap-2 rounded-md border border-line bg-white p-4 text-sm text-muted">
          <div>记录本次学习过程和连续学习时长</div>
          <div>观察孩子平均专注时间是否逐步提升</div>
          <div>发现容易中断学习的时间段</div>
          <div>生成学习习惯反馈报告</div>
          <div>帮助家长判断监督是否正在改善学习习惯</div>
        </div>

        <form onSubmit={start} className="rounded-md border border-line bg-white p-5">
          <label className="block text-sm font-medium text-ink" htmlFor="code">
            访问码
          </label>
          <input
            id="code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            className="mt-2 h-12 w-full rounded-md border border-line px-4 text-lg outline-none focus:border-brand"
            autoCapitalize="characters"
            placeholder="请输入访问码"
            required
          />
          {error && <p className="mt-3 text-sm text-alert">{error}</p>}
          <label className="mt-4 flex items-start gap-2 text-sm leading-6 text-muted">
            <input
              type="checkbox"
              checked={privacyAcknowledged}
              onChange={(event) => setPrivacyAcknowledged(event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0"
            />
            <span>{privacyNoticeText}</span>
          </label>
          <button
            type="submit"
            disabled={loading || !privacyAcknowledged}
            className="mt-5 h-12 w-full rounded-md bg-brand px-4 font-semibold text-white disabled:opacity-60"
          >
            {loading ? "正在验证" : "开始监督"}
          </button>
        </form>

        {reportHistory.length > 0 && (
          <section className="mt-4 rounded-md border border-line bg-white p-4">
            <div className="text-sm font-semibold text-ink">近期趋势报告</div>
            <div className="mt-3 grid gap-2">
              {reportHistory.slice(0, 3).map((item) => (
                <button
                  key={item.sessionId}
                  type="button"
                  onClick={() => router.push(reportUrl(item))}
                  className="flex items-center justify-between rounded-md bg-panel px-3 py-3 text-left text-sm"
                >
                  <span>{formatReportDate(item.startTime)}</span>
                  <span className="font-medium text-brand">查看趋势</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="mt-4 rounded-md border border-line bg-white p-4 text-sm leading-6 text-muted">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="font-semibold text-ink">当前版本：{appVersion.version}</span>
              <span className="ml-0 block sm:ml-3 sm:inline">
                更新时间：{appVersion.updatedAt}
              </span>
            </div>
          </div>
          <p className="mt-2">{appVersion.summary}</p>
          <details className="mt-2">
            <summary className="cursor-pointer font-medium text-brand">
              查看更新说明
            </summary>
            <ul className="mt-2 grid gap-1 pl-4">
              {appVersion.highlights.map((item) => (
                <li key={item} className="list-disc">
                  {item}
                </li>
              ))}
            </ul>
          </details>
        </section>
      </section>

      <section className="mb-4 rounded-md border border-line bg-white p-4 text-sm leading-7 text-muted">
        <div className="font-semibold text-ink">隐私声明</div>
        <p>本系统不做人脸识别，不进行身份识别，不保存视频或截图。</p>
        <p>监督时只截取单帧用于本次状态分析；Qwen 模式下会发送给第三方模型。</p>
        <p>系统会保存监督记录和学习报告数据，便于查看历史报告和习惯趋势。</p>
      </section>

      {recoverableSupervision && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-md bg-white p-5 shadow-lg">
            <h2 className="text-xl font-semibold">检测到未结束监督</h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              当前访问码存在未结束的监督记录。你可以恢复监督继续使用，也可以立即结束并结算本次监督。
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                disabled={loading}
                onClick={() => enterSupervision(recoverableSupervision)}
                className="h-11 rounded-md bg-brand px-4 font-semibold text-white disabled:opacity-60"
              >
                恢复监督
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => void finishRecoverableSession()}
                className="h-11 rounded-md border border-line px-4 font-medium disabled:opacity-60"
              >
                结束并结算
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function formatReportDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
