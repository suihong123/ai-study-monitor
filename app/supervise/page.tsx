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

type LastAnalyzeImage = {
  dataUrl: string;
  width: number;
  height: number;
  sizeKb: string;
};

const reminders: Partial<Record<StudyStatus, string>> = {
  distracted: "请继续专注学习",
  away: "请回到座位继续完成作业",
  lying: "请保持良好学习姿势"
};

const correctionButtons: Array<{ status: StudyStatus; label: string }> = [
  { status: "studying", label: "我在学习" },
  { status: "distracted", label: "我走神了" },
  { status: "away", label: "我离座了" },
  { status: "lying", label: "我趴桌了" },
  { status: "unrelated", label: "我在玩无关物品" }
];

const angleWarningTerms = [
  "未见书桌",
  "未见学习行为",
  "未看到桌面",
  "未看到双手",
  "画面不清晰"
];

const abnormalStatuses: StudyStatus[] = ["distracted", "unrelated", "lying", "away"];

type FrequencyReason = "normal" | "abnormal" | "focused";

export default function SupervisePage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordsRef = useRef<StudyRecord[]>([]);
  const startedAtRef = useRef<Date>(new Date());
  const finishingRef = useRef(false);
  const analyzingRef = useRef(false);
  const intensityUntilRef = useRef(0);
  const abnormalLockRef = useRef(false);
  const aiCallCountRef = useRef(0);
  const analyzeFailureCountRef = useRef(0);
  const frequencyReasonRef = useRef<FrequencyReason>("normal");
  const initialAnalyzeTimerRef = useRef<number | null>(null);
  const [current, setCurrent] = useState<CurrentSupervision | null>(null);
  const [status, setStatus] = useState<StudyStatus>("unknown");
  const [records, setRecords] = useState<StudyRecord[]>([]);
  const [cameraError, setCameraError] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiCallCount, setAiCallCount] = useState(0);
  const [currentIntervalSeconds, setCurrentIntervalSeconds] = useState(60);
  const [intensity, setIntensity] = useState<SupervisionIntensity>("standard");
  const [lastAnalyzeImage, setLastAnalyzeImage] = useState<LastAnalyzeImage | null>(null);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [pageActive, setPageActive] = useState(true);

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
  const latestRecord = records[records.length - 1];
  const shouldShowAngleWarning =
    latestRecord?.status === "unknown" &&
    angleWarningTerms.some((term) => latestRecord.reason?.includes(term));

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
  }, []);

  const applyInterval = useCallback((nextInterval: number, reason: FrequencyReason) => {
    setCurrentIntervalSeconds(nextInterval);
    setIntensity(intensityFromInterval(nextInterval));
    frequencyReasonRef.current = reason;
  }, []);

  const defaultIntervalForNow = useCallback(() => {
    if (!current) return 60;
    const liveElapsedMinutes = Math.floor((Date.now() - startedAtRef.current.getTime()) / 60_000);
    return applyPlanLimit(timeDefaultInterval(liveElapsedMinutes), current.accessCode);
  }, [current]);

  const highIntervalForCurrentPlan = useCallback(() => {
    if (!current) return 60;
    return applyPlanLimit(15, current.accessCode);
  }, [current]);

  const updateDynamicInterval = useCallback((nextRecords: StudyRecord[]) => {
    const latest = nextRecords[nextRecords.length - 1];
    if (!latest || !current) return;

    const defaultInterval = defaultIntervalForNow();
    const highInterval = highIntervalForCurrentPlan();
    const recentStudyingCount = [...nextRecords]
      .reverse()
      .findIndex((record) => record.status !== "studying");
    const consecutiveStudying =
      recentStudyingCount === -1 ? nextRecords.length : recentStudyingCount;
    const recentNormalCount = [...nextRecords]
      .reverse()
      .findIndex((record) => !abnormalStatuses.includes(record.status));
    const consecutiveAbnormal =
      recentNormalCount === -1 ? nextRecords.length : recentNormalCount;

    if (consecutiveStudying >= 8) {
      intensityUntilRef.current = 0;
      abnormalLockRef.current = false;
      applyInterval(slowerInterval(defaultInterval), "focused");
      return;
    }

    if (consecutiveStudying >= 2) {
      intensityUntilRef.current = 0;
      abnormalLockRef.current = false;
      applyInterval(defaultInterval, "normal");
      return;
    }

    if (abnormalStatuses.includes(latest.status)) {
      intensityUntilRef.current = Date.now() + 3 * 60 * 1000;
      abnormalLockRef.current = consecutiveAbnormal >= 2;
      applyInterval(highInterval, "abnormal");
      return;
    }

    if (abnormalLockRef.current || Date.now() < intensityUntilRef.current) {
      applyInterval(highInterval, "abnormal");
      return;
    }

    applyInterval(defaultInterval, "normal");
  }, [applyInterval, current, defaultIntervalForNow, highIntervalForCurrentPlan]);

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

  const captureImage = useCallback((): LastAnalyzeImage | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * 640);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
    return {
      dataUrl,
      width: canvas.width,
      height: canvas.height,
      sizeKb: estimateDataUrlSizeKb(dataUrl)
    };
  }, []);

  const analyze = useCallback(async () => {
    if (!current || finishingRef.current || document.hidden || !navigator.onLine) return;
    const imagePayload = captureImage();
    if (!imagePayload || analyzingRef.current) return;
    const activeSupervision = current;
    const currentFrequencyReason = frequencyReasonRef.current;
    setLastAnalyzeImage(imagePayload);

    analyzingRef.current = true;
    setAnalyzing(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: imagePayload.dataUrl,
          accessCodeId: activeSupervision.accessCode.id,
          sessionId: activeSupervision.session.id,
          sessionToken: activeSupervision.session.session_token,
          currentFrequencySeconds: currentIntervalSeconds,
          frequencyBoostedByAbnormal: currentFrequencyReason === "abnormal",
          frequencyLoweredByFocus: currentFrequencyReason === "focused"
        })
      });
      const result = await response.json();
      if (!response.ok) {
        setCameraError(result.error ?? "AI识别失败，请稍后重试。");
        analyzeFailureCountRef.current += 1;
        if (analyzeFailureCountRef.current >= 3) {
          intensityUntilRef.current = 0;
          abnormalLockRef.current = false;
          applyInterval(defaultIntervalForNow(), "normal");
        }
        return;
      }
      analyzeFailureCountRef.current = 0;
      const nextStatus = (result.status ?? "unknown") as StudyStatus;
      const draftRecords = [
        ...recordsRef.current,
        {
          id: result.recordId ?? undefined,
          status: nextStatus,
          timestamp: new Date().toISOString(),
          confidence: result.confidence ?? null,
          reason: result.reason ?? null,
          analyze_mode: result.analyze_mode ?? result.analyzeMode ?? "mock",
          current_frequency_seconds: currentIntervalSeconds,
          frequency_boosted_by_abnormal: currentFrequencyReason === "abnormal",
          frequency_lowered_by_focus: currentFrequencyReason === "focused",
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
    } catch {
      setCameraError("AI识别失败，请检查网络后继续。");
      analyzeFailureCountRef.current += 1;
      if (analyzeFailureCountRef.current >= 3) {
        intensityUntilRef.current = 0;
        abnormalLockRef.current = false;
        applyInterval(defaultIntervalForNow(), "normal");
      }
    } finally {
      analyzingRef.current = false;
      setAnalyzing(false);
    }
  }, [
    applyInterval,
    captureImage,
    current,
    currentIntervalSeconds,
    defaultIntervalForNow,
    maybeRemind,
    updateDynamicInterval
  ]);

  const correctLatestRecord = useCallback(
    async (nextStatus: StudyStatus) => {
      if (!current) return;
      const latest = recordsRef.current[recordsRef.current.length - 1];
      if (!latest?.id) return;

      const correctedRecords = recordsRef.current.map((record, index) =>
        index === recordsRef.current.length - 1
          ? {
              ...record,
              status: nextStatus,
              manual_corrected: true,
              correction_source: "user",
              corrected_at: new Date().toISOString()
            }
          : record
      );
      recordsRef.current = correctedRecords;
      setRecords(correctedRecords);
      setStatus(nextStatus);

      await fetch("/api/records/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessCodeId: current.accessCode.id,
          sessionId: current.session.id,
          sessionToken: current.session.session_token,
          recordId: latest.id,
          status: nextStatus
        })
      });
    },
    [current]
  );

  const finish = useCallback(async () => {
    if (!current || finishingRef.current) return;
    const activeSupervision = current;
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
          sessionId: activeSupervision.session.id,
          accessCodeId: activeSupervision.accessCode.id,
          records: finalRecords,
          startTime: startedAtRef.current.toISOString(),
          endTime,
          stats: finalStats,
          reportLevel: activeSupervision.accessCode.report_level,
          sessionToken: activeSupervision.session.session_token
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
          reportLevel: activeSupervision.accessCode.report_level
        })
      );

      await fetch("/api/access-code", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "finish-session",
          sessionId: activeSupervision.session.id,
          accessCodeId: activeSupervision.accessCode.id,
          records: finalRecords,
          endTime,
          durationMinutes,
          aiCallCount: aiCallCountRef.current,
          reportLevel: activeSupervision.accessCode.report_level,
          sessionToken: activeSupervision.session.session_token
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
      applyInterval(defaultIntervalForNow(), "normal");
    }
  }, [applyInterval, current, defaultIntervalForNow]);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    const activeSupervision = current;

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
        initialAnalyzeTimerRef.current = window.setTimeout(() => void analyze(), 1200);
      } catch {
        setCameraError("无法打开摄像头，请确认浏览器权限和HTTPS访问。");
        void fetch("/api/client-error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessCodeId: activeSupervision.accessCode.id,
            sessionId: activeSupervision.session.id,
            sessionToken: activeSupervision.session.session_token,
            errorType: "摄像头权限失败",
            errorMessage: "无法打开摄像头，请确认浏览器权限和HTTPS访问。"
          })
        });
      }
    }

    void startCamera();
    return () => {
      cancelled = true;
      if (initialAnalyzeTimerRef.current) {
        window.clearTimeout(initialAnalyzeTimerRef.current);
        initialAnalyzeTimerRef.current = null;
      }
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
    function updateActivity() {
      setPageActive(!document.hidden && navigator.onLine);
    }

    updateActivity();
    document.addEventListener("visibilitychange", updateActivity);
    window.addEventListener("online", updateActivity);
    window.addEventListener("offline", updateActivity);
    return () => {
      document.removeEventListener("visibilitychange", updateActivity);
      window.removeEventListener("online", updateActivity);
      window.removeEventListener("offline", updateActivity);
    };
  }, []);

  useEffect(() => {
    if (!current || !pageActive || finishingRef.current) return;
    const timeout = window.setTimeout(
      () => void analyze(),
      currentIntervalSeconds * 1000
    );
    return () => window.clearTimeout(timeout);
  }, [analyze, current, currentIntervalSeconds, pageActive, records.length]);

  useEffect(() => {
    if (!current || abnormalLockRef.current || Date.now() < intensityUntilRef.current) return;
    applyInterval(defaultIntervalForNow(), "normal");
  }, [applyInterval, current, defaultIntervalForNow, elapsedMinutes]);

  useEffect(() => {
    if (current && (todayRemainingMinutes <= 0 || totalRemainingMinutes <= 0)) {
      void finish();
    }
  }, [current, finish, todayRemainingMinutes, totalRemainingMinutes]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-5">
      <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-warn">
        当前为测试模式，状态识别为模拟结果，正式版将接入 AI 视觉模型。
      </div>
      <div className="mb-4 rounded-md border border-line bg-white p-3 text-sm leading-6 text-muted">
        <div className="font-medium text-ink">最佳拍摄角度提示</div>
        <div className="mt-1">
          建议手机放置于孩子侧前方45°位置。确保能够看到：上半身、双手、桌面、作业区域。这样可提高识别准确率。
        </div>
      </div>
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
          <button
            type="button"
            onClick={() => setImagePreviewOpen(true)}
            className="mt-3 rounded-md border border-line bg-white px-4 py-2 text-sm font-medium"
          >
            查看AI识别图片
          </button>
          {cameraError && (
            <p className="mt-3 rounded-md border border-alert bg-red-50 p-3 text-sm text-alert">
              {cameraError}
            </p>
          )}
          {shouldShowAngleWarning && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-warn">
              <div className="font-medium">当前拍摄角度可能不适合学习监督。</div>
              <div className="mt-1">建议调整手机位置，让画面同时看到：</div>
              <ul className="mt-1 list-inside list-disc">
                <li>孩子上半身</li>
                <li>双手</li>
                <li>桌面</li>
                <li>作业本/书本/屏幕</li>
                <li>笔或文具</li>
              </ul>
            </div>
          )}
        </section>

        <aside className="space-y-3">
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">当前状态</div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <StatusBadge status={status} />
              <span className="text-sm text-muted">
                {analyzing ? "分析中" : "自动调整中"}
              </span>
            </div>
            <div className="mt-4 border-t border-line pt-3">
              <div className="text-sm font-medium">识别不准？手动标记当前状态</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {correctionButtons.map((item) => (
                  <button
                    key={item.status}
                    onClick={() => void correctLatestRecord(item.status)}
                    className="rounded-md border border-line px-3 py-2 text-sm"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">当前监督强度</div>
            <div className="mt-1 text-2xl font-semibold">
              {intensityLabels[intensity]}
            </div>
            <div className="mt-2 text-sm text-muted">
              系统会根据学习状态自动调整监督频率。
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
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm font-medium">最近记录</div>
            <div className="mt-3 space-y-2 text-sm">
              {records.slice(-10).reverse().map((record, index) => (
                <div key={`${record.timestamp}-${index}`} className="rounded-md bg-panel px-3 py-2">
                  <div className="font-medium">
                    {new Date(record.timestamp).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit"
                    })}
                  </div>
                  <div className="mt-1">
                    {record.status === "studying"
                      ? "学习中"
                      : `${record.status === "distracted" ? "疑似走神" : record.status === "away" ? "离座" : record.status === "lying" ? "趴桌" : record.status === "unrelated" ? "无关物品" : "无法判断"}${record.triggered_reminder ? "，已提醒" : ""}`}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    置信度：
                    {typeof record.confidence === "number"
                      ? `${Math.round(record.confidence * 100)}%`
                      : "-"}
                    {" / "}
                    {record.triggered_reminder ? "已提醒" : "未提醒"}
                    {" / "}
                    {record.analyze_mode === "qwen" ? "真实AI识别" : "模拟识别"}
                    {record.frequency_boosted_by_abnormal && " / 异常后提频"}
                    {record.frequency_lowered_by_focus && " / 连续专注降频"}
                  </div>
                  {record.reason && (
                    <div className="mt-1 text-xs leading-5 text-muted">
                      原因：{record.reason}
                    </div>
                  )}
                </div>
              ))}
              {records.length === 0 && <div className="text-muted">暂无记录</div>}
            </div>
          </div>
        </aside>
      </div>
      {imagePreviewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-md bg-white p-5 shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">AI实际识别图片</h2>
                <p className="mt-2 text-sm leading-6 text-muted">
                  这是系统实际发送给 AI 模型分析的图片，用于检查拍摄角度和截图裁切是否正确。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setImagePreviewOpen(false)}
                className="rounded-md border border-line px-3 py-2 text-sm font-medium"
              >
                关闭
              </button>
            </div>

            {!lastAnalyzeImage ? (
              <div className="mt-5 rounded-md bg-panel p-4 text-sm text-muted">
                暂无AI识别图片，请等待首次识别完成。
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <img
                  src={lastAnalyzeImage.dataUrl}
                  alt="AI实际识别图片"
                  className="w-full rounded-md border border-line bg-black object-contain"
                />
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <DebugItem label="图片尺寸" value={`${lastAnalyzeImage.width} × ${lastAnalyzeImage.height}`} />
                  <DebugItem label="图片大小" value={`${lastAnalyzeImage.sizeKb} KB`} />
                  <DebugItem label="最近一次识别状态" value={latestRecord ? statusText(latestRecord.status) : "-"} />
                  <DebugItem
                    label="最近一次 analyze_mode"
                    value={latestRecord?.analyze_mode === "qwen" ? "真实AI识别" : latestRecord ? "模拟识别" : "-"}
                  />
                  <DebugItem
                    label="最近一次 confidence"
                    value={
                      typeof latestRecord?.confidence === "number"
                        ? `${Math.round(latestRecord.confidence * 100)}%`
                        : "-"
                    }
                  />
                  <DebugItem label="最近一次识别原因" value={latestRecord?.reason ?? "-"} wide />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function estimateDataUrlSizeKb(dataUrl: string) {
  const base64 = dataUrl.split(",")[1] ?? "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(1, Math.round((base64.length * 3) / 4 - padding) / 1024).toFixed(1);
}

function timeDefaultInterval(elapsedMinutes: number) {
  if (elapsedMinutes < 15) return 15;
  if (elapsedMinutes < 60) return 30;
  if (elapsedMinutes < 120) return 60;
  return 90;
}

function applyPlanLimit(desiredInterval: number, accessCode: AccessCode) {
  return Math.max(desiredInterval, accessCode.min_interval_seconds);
}

function slowerInterval(currentDefaultInterval: number) {
  if (currentDefaultInterval <= 15) return 30;
  if (currentDefaultInterval <= 30) return 60;
  if (currentDefaultInterval <= 60) return 90;
  return currentDefaultInterval;
}

function intensityFromInterval(intervalSeconds: number): SupervisionIntensity {
  if (intervalSeconds <= 30) return "high";
  if (intervalSeconds <= 60) return "standard";
  return "low";
}

function statusText(status: StudyStatus) {
  if (status === "studying") return "学习中";
  if (status === "distracted") return "疑似走神";
  if (status === "away") return "离座";
  if (status === "lying") return "趴桌";
  if (status === "unrelated") return "无关物品";
  return "无法判断";
}

function DebugItem({
  label,
  value,
  wide
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={`rounded-md bg-panel p-3 ${wide ? "sm:col-span-2" : ""}`}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 break-words font-medium">{value}</div>
    </div>
  );
}
