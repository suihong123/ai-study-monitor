"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraPreview } from "@/components/CameraPreview";
import { StatusBadge } from "@/components/StatusBadge";
import { Timer } from "@/components/Timer";
import { calculateStats } from "@/lib/stats";
import {
  intensityLabels,
  type AccessCode,
  type StudyRecord,
  type StudySession,
  type StudyStatus,
  type SupervisionIntensity
} from "@/types";

type CurrentSupervision = {
  accessCode: AccessCode;
  session: StudySession;
  totalRemainingMinutes: number;
  todayRemainingMinutes: number;
};

const reminders: Partial<Record<StudyStatus, string>> = {
  distracted: "请继续专注学习",
  away: "请回到座位继续完成作业",
  lying: "请保持良好学习姿势"
};

export default function SupervisePage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordsRef = useRef<StudyRecord[]>([]);
  const startedAtRef = useRef<Date>(new Date());
  const finishingRef = useRef(false);
  const analyzingRef = useRef(false);
  const intensityUntilRef = useRef(0);
  const aiCallCountRef = useRef(0);
  const [current, setCurrent] = useState<CurrentSupervision | null>(null);
  const [status, setStatus] = useState<StudyStatus>("unknown");
  const [records, setRecords] = useState<StudyRecord[]>([]);
  const [cameraError, setCameraError] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiCallCount, setAiCallCount] = useState(0);
  const [currentIntervalSeconds, setCurrentIntervalSeconds] = useState(60);
  const [intensity, setIntensity] = useState<SupervisionIntensity>("basic");

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const todayRemainingMinutes = Math.max(
    0,
    (current?.todayRemainingMinutes ?? 0) - elapsedMinutes
  );
  const totalRemainingMinutes = Math.max(
    0,
    (current?.totalRemainingMinutes ?? 0) - elapsedMinutes
  );

  const stats = useMemo(() => calculateStats(records), [records]);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
  }, []);

  const updateDynamicInterval = useCallback((nextRecords: StudyRecord[]) => {
    const latest = nextRecords[nextRecords.length - 1];
    if (!latest || !current) return;

    const baseInterval = current.accessCode.base_interval_seconds;
    const minInterval = current.accessCode.min_interval_seconds;
    const recentStudyingCount = [...nextRecords]
      .reverse()
      .findIndex((record) => record.status !== "studying");
    const consecutiveStudying =
      recentStudyingCount === -1 ? nextRecords.length : recentStudyingCount;

    if (consecutiveStudying >= 2) {
      intensityUntilRef.current = 0;
      setIntensity("basic");
      setCurrentIntervalSeconds(baseInterval);
      return;
    }

    if (latest.status === "distracted") {
      intensityUntilRef.current = Date.now() + 3 * 60 * 1000;
      setIntensity("boosted");
      setCurrentIntervalSeconds(Math.max(30, minInterval));
      return;
    }

    if (["away", "lying", "unrelated"].includes(latest.status)) {
      intensityUntilRef.current = Date.now() + 2 * 60 * 1000;
      setIntensity("high");
      setCurrentIntervalSeconds(minInterval);
      return;
    }

    if (Date.now() > intensityUntilRef.current) {
      setIntensity("basic");
      setCurrentIntervalSeconds(baseInterval);
    }
  }, [current]);

  const maybeRemind = useCallback(
    (nextRecords: StudyRecord[]) => {
      const latest = nextRecords[nextRecords.length - 1];
      if (!latest) return false;
      let reminded = false;

      if (latest.status === "distracted") {
        const previous = nextRecords[nextRecords.length - 2];
        if (previous?.status === "distracted") {
          speak(reminders.distracted!);
          reminded = true;
        }
      }

      if (latest.status === "away") {
        speak(reminders.away!);
        reminded = true;
      }
      if (latest.status === "lying") {
        speak(reminders.lying!);
        reminded = true;
      }
      if (latest.status === "unrelated") {
        speak(reminders.distracted!);
        reminded = true;
      }
      return reminded;
    },
    [speak]
  );

  const captureImage = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * 640);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6);
  }, []);

  const analyze = useCallback(async () => {
    const image = captureImage();
    if (!image || analyzingRef.current) return;

    analyzingRef.current = true;
    setAnalyzing(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image,
          accessCodeId: current?.accessCode.id,
          sessionId: current?.session.id,
          sessionToken: current?.session.session_token
        })
      });
      const result = await response.json();
      if (!response.ok) {
        setCameraError(result.error ?? "AI识别失败，请稍后重试。");
        return;
      }
      const nextStatus = (result.status ?? "unknown") as StudyStatus;
      const draftRecords = [
        ...recordsRef.current,
        {
          status: nextStatus,
          timestamp: new Date().toISOString(),
          current_frequency_seconds: currentIntervalSeconds,
          ai_called: true,
          triggered_reminder: false,
          error_message: null
        }
      ];
      const reminded = maybeRemind(draftRecords);
      const nextRecords = draftRecords.map((record, index) =>
        index === draftRecords.length - 1
          ? { ...record, triggered_reminder: reminded }
          : record
      );

      recordsRef.current = nextRecords;
      setRecords(nextRecords);
      setStatus(nextStatus);
      aiCallCountRef.current += 1;
      setAiCallCount(aiCallCountRef.current);
      updateDynamicInterval(nextRecords);
    } finally {
      analyzingRef.current = false;
      setAnalyzing(false);
    }
  }, [captureImage, current?.accessCode.id, current?.session.id, current?.session.session_token, currentIntervalSeconds, maybeRemind, updateDynamicInterval]);

  const finish = useCallback(async () => {
    if (!current || finishingRef.current) return;
    finishingRef.current = true;
    const endTime = new Date().toISOString();
    const finalRecords = recordsRef.current;
    const durationMinutes = Math.max(
      1,
      Math.ceil((Date.now() - startedAtRef.current.getTime()) / 60_000)
    );
    const finalStats = calculateStats(finalRecords, durationMinutes);

    try {
      const reportResponse = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: current.session.id,
          accessCodeId: current.accessCode.id,
          records: finalRecords,
          startTime: startedAtRef.current.toISOString(),
          endTime,
          stats: finalStats,
          reportLevel: current.accessCode.report_level,
          sessionToken: current.session.session_token
        })
      });
      const report = await reportResponse.json();

      window.sessionStorage.setItem(
        "latest-report",
        JSON.stringify({
          stats: report.stats ?? finalStats,
          summary: report.summary ?? "本次学习报告已生成。",
          conclusion: report.conclusion ?? "本次学习报告已生成。",
          parentAdvice: report.parentAdvice ?? "建议继续观察孩子的学习节奏。",
          trend: report.trend ?? null,
          records: finalRecords,
          reportLevel: current.accessCode.report_level
        })
      );

      await fetch("/api/access-code", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "finish-session",
          sessionId: current.session.id,
          accessCodeId: current.accessCode.id,
          records: finalRecords,
          endTime,
          durationMinutes,
          aiCallCount: aiCallCountRef.current,
          reportLevel: current.accessCode.report_level,
          sessionToken: current.session.session_token
        })
      });
    } finally {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      router.push("/report");
    }
  }, [current, router]);

  useEffect(() => {
    const raw = window.sessionStorage.getItem("current-supervision");
    if (!raw) {
      router.replace("/");
      return;
    }
    const parsed = JSON.parse(raw) as CurrentSupervision;
    setCurrent(parsed);
    startedAtRef.current = new Date(parsed.session.start_time);
  }, [router]);

  useEffect(() => {
    if (current) {
      setCurrentIntervalSeconds(current.accessCode.base_interval_seconds);
    }
  }, [current]);

  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
        if (cancelled) return;
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        window.setTimeout(() => void analyze(), 1200);
      } catch {
        setCameraError("无法打开摄像头，请确认浏览器权限和HTTPS访问。");
        void fetch("/api/client-error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessCodeId: current.accessCode.id,
            sessionId: current.session.id,
            sessionToken: current.session.session_token,
            errorType: "摄像头权限失败",
            errorMessage: "无法打开摄像头，请确认浏览器权限和HTTPS访问。"
          })
        });
      }
    }

    if (current) void startCamera();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [analyze, current]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current.getTime()) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!current) return;
    const timeout = window.setTimeout(
      () => void analyze(),
      currentIntervalSeconds * 1000
    );
    return () => window.clearTimeout(timeout);
  }, [analyze, current, currentIntervalSeconds, records.length]);

  useEffect(() => {
    if (current && (todayRemainingMinutes <= 0 || totalRemainingMinutes <= 0)) {
      void finish();
    }
  }, [current, finish, todayRemainingMinutes, totalRemainingMinutes]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">学习监督中</h1>
          <p className="mt-1 text-sm text-muted">请将手机固定在桌边，保持画面稳定。</p>
        </div>
        <button
          onClick={() => void finish()}
          className="h-11 rounded-md bg-alert px-4 font-semibold text-white"
        >
          结束监督
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <section>
          <CameraPreview ref={videoRef} />
          {cameraError && (
            <p className="mt-3 rounded-md border border-alert bg-red-50 p-3 text-sm text-alert">
              {cameraError}
            </p>
          )}
        </section>

        <aside className="space-y-3">
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">当前状态</div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <StatusBadge status={status} />
              <span className="text-sm text-muted">
                {analyzing ? "分析中" : `${currentIntervalSeconds}秒后更新`}
              </span>
            </div>
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">当前监督强度</div>
            <div className="mt-1 text-2xl font-semibold">
              {intensityLabels[intensity]}
            </div>
          </div>
          <Timer label="已监督时长" minutes={elapsedMinutes} />
          <Timer label="今日剩余额度" minutes={todayRemainingMinutes} />
          <Timer label="总剩余监督时长" minutes={totalRemainingMinutes} />
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">本次已调用AI次数</div>
            <div className="mt-1 text-2xl font-semibold">{aiCallCount}次</div>
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">当前专注率</div>
            <div className="mt-1 text-2xl font-semibold">{stats.focusRate}%</div>
          </div>
        </aside>
      </div>
    </main>
  );
}
