"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraPreview } from "@/components/CameraPreview";
import { StatusBadge } from "@/components/StatusBadge";
import { Timer } from "@/components/Timer";
import { calculateLearningInsights, calculateStats } from "@/lib/stats";
import {
  intensityLabels,
  type AccessCode,
  type LearningState,
  type Presence,
  type ReminderType,
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

type LastReminder = {
  type: ReminderType;
  text: string;
  timestamp: number;
};

const reminderLabels: Record<ReminderType, string> = {
  uncertain: "学习提醒",
  away: "离座提醒"
};

const firstReminderTexts: Record<ReminderType, string> = {
  uncertain: "加油哦，继续完成当前任务吧。",
  away: "请回到座位继续学习。本次离座情况会记录到学习报告中。"
};

const repeatReminderTexts: Record<ReminderType, string> = {
  uncertain: "别忘了手上的题目哦。",
  away: "请回到座位继续学习。本次离座情况会记录到学习报告中。"
};

const reminderCooldownMs = 3 * 60 * 1000;
const awayDurationReminderMs = 60 * 1000;
const startupSupervisionMs = 5 * 60 * 1000;

const correctionButtons: Array<{ status: StudyStatus; label: string }> = [
  { status: "studying", label: "我在学习" },
  { status: "unknown", label: "证据不足" },
  { status: "away", label: "我离座了" }
];

const angleWarningTerms = [
  "未见书桌",
  "未见学习行为",
  "未看到桌面",
  "未看到双手",
  "画面不清晰"
];

const abnormalStatuses: StudyStatus[] = ["distracted", "unrelated", "lying", "away", "unknown"];
const maxAnalyzeIntervalSeconds = 300;

type FrequencyReason = "normal" | "abnormal" | "focused";
type WakeLockSentinel = {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};
type WebAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};
type AudioTestStep = {
  label: string;
  status: "pending" | "success" | "failed" | "skipped";
  detail?: string;
};
type BeepPattern = "single" | "triple";

function createInlineBeepWavUrl() {
  const sampleRate = 44100;
  const durationSeconds = 0.6;
  const frequency = 880;
  const amplitude = 0.35;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);

  function writeString(offset: number, value: string) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, sampleCount * 2, true);

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / sampleCount;
    const fadeIn = Math.min(1, progress / 0.08);
    const fadeOut = Math.min(1, (1 - progress) / 0.12);
    const envelope = Math.min(fadeIn, fadeOut);
    const sample =
      Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude * envelope;
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }

  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return `data:audio/wav;base64,${window.btoa(binary)}`;
}

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
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const awayStartAtRef = useRef<number | null>(null);
  const lastReminderAtRef = useRef<Partial<Record<ReminderType, number>>>({});
  const reminderCountByTypeRef = useRef<Partial<Record<ReminderType, number>>>({});
  const [current, setCurrent] = useState<CurrentSupervision | null>(null);
  const [status, setStatus] = useState<StudyStatus>("unknown");
  const [presence, setPresence] = useState<Presence>("present");
  const [learningState, setLearningState] = useState<LearningState>("uncertain");
  const [records, setRecords] = useState<StudyRecord[]>([]);
  const [cameraError, setCameraError] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [currentIntervalSeconds, setCurrentIntervalSeconds] = useState(60);
  const [intensity, setIntensity] = useState<SupervisionIntensity>("standard");
  const [pageActive, setPageActive] = useState(true);
  const [lastReminder, setLastReminder] = useState<LastReminder | null>(null);
  const [placementConfirmed, setPlacementConfirmed] = useState(false);
  const [needsRecoveryDecision, setNeedsRecoveryDecision] = useState(false);
  const [audioTestMessage, setAudioTestMessage] = useState("");
  const [audioTestSteps, setAudioTestSteps] = useState<AudioTestStep[]>([]);
  const [wakeLockMessage, setWakeLockMessage] = useState("");
  const [awayDurationSeconds, setAwayDurationSeconds] = useState(0);
  const [awayCanRemind, setAwayCanRemind] = useState(false);
  const [awayCooldownUntil, setAwayCooldownUntil] = useState(0);
  const [lastAudioResult, setLastAudioResult] = useState("暂无声音播放记录");

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
  const learningInsights = useMemo(
    () => calculateLearningInsights(records, Math.max(1, elapsedMinutes)),
    [elapsedMinutes, records]
  );
  const latestRecord = records[records.length - 1];
  const latestRecordTime = latestRecord
    ? new Date(latestRecord.timestamp).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })
    : "暂无";
  const isStartupSupervision = elapsedSeconds < startupSupervisionMs / 1000;
  const currentModeLabel = isStartupSupervision ? "启动强监督" : "正常监督";
  const consecutiveUncertainCount = [...records]
    .reverse()
    .findIndex((record) => {
      const recordPresence = record.presence ?? legacyPresenceFromStatus(record.status);
      const recordLearningState =
        record.learning_state ?? legacyLearningStateFromStatus(record.status);
      return !(recordPresence === "present" && recordLearningState === "uncertain");
    });
  const recentUncertainCount =
    consecutiveUncertainCount === -1 ? records.length : consecutiveUncertainCount;
  const shouldShowAngleWarning =
    recentUncertainCount >= 2 ||
    (latestRecord?.status === "unknown" &&
      angleWarningTerms.some((term) => latestRecord.reason?.includes(term)));
  const reminderCooldownRemainingMinutes = lastReminder
    ? Math.max(
        0,
        Math.ceil(
          (reminderCooldownMs - (Date.now() - lastReminder.timestamp)) / 60_000
        )
      )
    : 0;
  const awayCooldownRemainingSeconds = Math.max(
    0,
    Math.ceil((awayCooldownUntil - Date.now()) / 1000)
  );

  const playBeep = useCallback(async (pattern: BeepPattern = "single") => {
    const AudioContextClass =
      window.AudioContext ?? (window as WebAudioWindow).webkitAudioContext;
    if (!AudioContextClass) {
      return false;
    }

    const audioContext = new AudioContextClass();

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const beepCount = pattern === "triple" ? 3 : 1;
    const duration = 0.6;
    const gap = 0.2;

    await new Promise<void>((resolve, reject) => {
      let endedCount = 0;
      const finishOne = () => {
        endedCount += 1;
        if (endedCount === beepCount) {
          window.setTimeout(() => {
            void audioContext.close();
            resolve();
          }, 50);
        }
      };

      try {
        for (let index = 0; index < beepCount; index += 1) {
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          const startAt = audioContext.currentTime + index * (duration + gap);

          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(880, startAt);
          gain.gain.setValueAtTime(0.0001, startAt);
          gain.gain.exponentialRampToValueAtTime(0.3, startAt + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration - 0.02);

          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.onended = finishOne;
          oscillator.start(startAt);
          oscillator.stop(startAt + duration);
        }
      } catch (error) {
        void audioContext.close();
        reject(error);
      }
    });

    return true;
  }, []);

  const playInlineWav = useCallback(async () => {
    const audio = new Audio(createInlineBeepWavUrl());
    audio.preload = "auto";
    audio.muted = false;
    audio.volume = 1;
    audio.setAttribute("playsinline", "true");
    await audio.play();
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      window.setTimeout(resolve, 900);
    });
  }, []);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) {
      return false;
    }

    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "zh-CN";
      utterance.rate = 0.95;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      console.error("[提醒声音] speechSynthesis 播放失败", error);
      return false;
    }
  }, []);

  const playReminderAudio = useCallback(
    async (reminderType: ReminderType, text: string) => {
      const pattern: BeepPattern = reminderType === "away" ? "triple" : "single";
      try {
        const beepPlayed = await playBeep(pattern);
        if (beepPlayed) {
          setLastAudioResult(
            reminderType === "away" ? "WebAudio 三声蜂鸣播放成功" : "WebAudio 单声蜂鸣播放成功"
          );
          return true;
        }
      } catch (error) {
        setLastAudioResult(
          `WebAudio 播放失败：${error instanceof Error ? error.message : String(error)}`
        );
      }

      try {
        await playInlineWav();
        setLastAudioResult("Audio 标签蜂鸣播放成功");
        return true;
      } catch (error) {
        setLastAudioResult(
          `Audio 标签播放失败：${error instanceof Error ? error.message : String(error)}`
        );
      }

      const speechStarted = speak(text);
      setLastAudioResult(
        speechStarted ? "蜂鸣失败，已尝试 TTS 兜底" : "蜂鸣和 TTS 均未启动，请检查媒体音量"
      );
      return speechStarted;
    },
    [playBeep, playInlineWav, speak]
  );

  const testReminderSound = useCallback(async () => {
    const nextSteps: AudioTestStep[] = [];
    const updateStep = (step: AudioTestStep) => {
      const existingIndex = nextSteps.findIndex((item) => item.label === step.label);
      const next =
        existingIndex >= 0
          ? nextSteps.map((item, index) => (index === existingIndex ? step : item))
          : [...nextSteps, step];
      nextSteps.splice(0, nextSteps.length, ...next);
      setAudioTestSteps(next);
    };

    console.info("[提醒声音测试] 开始安卓兼容播放测试");
    setAudioTestMessage("");
    setAudioTestSteps([]);
    setLastAudioResult("正在测试提醒声音");
    let webAudioOk = false;
    let audioTagOk = false;

    try {
      updateStep({ label: "WebAudio", status: "pending", detail: "开始播放 880Hz / 0.6秒 / gain 0.3" });
      const beepPlayed = await playBeep();
      webAudioOk = beepPlayed;
      updateStep(
        beepPlayed
          ? { label: "WebAudio", status: "success", detail: "已完成播放" }
          : { label: "WebAudio", status: "failed", detail: "当前浏览器不支持 Web Audio API" }
      );
      setLastAudioResult(beepPlayed ? "测试：WebAudio 蜂鸣播放成功" : "测试：WebAudio 不支持");
    } catch (error) {
      console.error("[提醒声音测试] WebAudio 播放失败", error);
      updateStep({
        label: "WebAudio",
        status: "failed",
        detail: error instanceof Error ? error.message : String(error)
      });
      setLastAudioResult(
        `测试：WebAudio 播放失败：${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!webAudioOk) {
      try {
        updateStep({ label: "Audio标签", status: "pending", detail: "开始播放内联 base64 wav" });
        await playInlineWav();
        audioTagOk = true;
        updateStep({ label: "Audio标签", status: "success", detail: "已完成播放" });
        setLastAudioResult("测试：Audio 标签蜂鸣播放成功");
      } catch (error) {
        console.error("[提醒声音测试] Audio 标签播放失败", error);
        updateStep({
          label: "Audio标签",
          status: "failed",
          detail: error instanceof Error ? error.message : String(error)
        });
        setLastAudioResult(
          `测试：Audio 标签播放失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      updateStep({ label: "Audio标签", status: "skipped", detail: "WebAudio 已成功，未继续测试" });
    }

    if (!webAudioOk && !audioTagOk) {
      const speechStarted = speak("这是学习监督提醒声音，请确认音量合适。");
      updateStep(
        speechStarted
          ? { label: "TTS", status: "success", detail: "已尝试 speechSynthesis 朗读" }
          : { label: "TTS", status: "failed", detail: "speechSynthesis 不可用或启动失败" }
      );
      setLastAudioResult(speechStarted ? "测试：已尝试 TTS 兜底" : "测试：声音播放均未启动");
    } else {
      updateStep({ label: "TTS", status: "skipped", detail: "前置提示音已成功，未继续测试" });
    }

    setAudioTestMessage("如果安卓仍无声，请检查媒体音量，不是铃声音量。");
  }, [playBeep, playInlineWav, speak]);

  const applyInterval = useCallback((nextInterval: number, reason: FrequencyReason) => {
    const boundedInterval = Math.min(nextInterval, maxAnalyzeIntervalSeconds);
    setCurrentIntervalSeconds(boundedInterval);
    setIntensity(intensityFromInterval(boundedInterval));
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
    const startupActive = Date.now() - startedAtRef.current.getTime() < startupSupervisionMs;
    if (startupActive) {
      applyInterval(highInterval, reminderTypeForRecord(latest) ? "abnormal" : "normal");
      return;
    }

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

    if (consecutiveStudying >= 3) {
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

  const triggerReminder = useCallback(
    (reminderType: ReminderType) => {
      const lastReminderAt = lastReminderAtRef.current[reminderType] ?? 0;
      if (Date.now() - lastReminderAt < reminderCooldownMs) {
        return null;
      }

      const reminderCount = reminderCountByTypeRef.current[reminderType] ?? 0;
      const text =
        reminderCount === 0
          ? firstReminderTexts[reminderType]
          : repeatReminderTexts[reminderType];

      void playReminderAudio(reminderType, text);
      lastReminderAtRef.current[reminderType] = Date.now();
      reminderCountByTypeRef.current[reminderType] = reminderCount + 1;
      if (reminderType === "away") {
        setAwayCooldownUntil(Date.now() + reminderCooldownMs);
      }
      const reminder = {
        type: reminderType,
        text,
        timestamp: Date.now()
      };
      setLastReminder(reminder);
      return reminder;
    },
    [playReminderAudio]
  );

  const maybeRemind = useCallback(
    (nextRecords: StudyRecord[]) => {
      const latest = nextRecords[nextRecords.length - 1];
      if (!latest) return null;

      const latestReminderType = reminderTypeForRecord(latest);
      const latestIsAway = latestReminderType === "away";
      if (!latestIsAway) {
        awayStartAtRef.current = null;
        setAwayDurationSeconds(0);
        setAwayCanRemind(false);
      }

      if (!latestReminderType) return null;

      if (latestIsAway) {
        const previous = nextRecords[nextRecords.length - 2];
        const previousIsAway = previous ? reminderTypeForRecord(previous) === "away" : false;
        const latestTimestamp = new Date(latest.timestamp).getTime();
        if (!awayStartAtRef.current) {
          awayStartAtRef.current = Number.isFinite(latestTimestamp) ? latestTimestamp : Date.now();
        }
        const awayDurationMs = Date.now() - awayStartAtRef.current;
        const durationConditionMet = awayDurationMs >= awayDurationReminderMs;
        const reminderReady = previousIsAway || durationConditionMet;
        setAwayDurationSeconds(Math.max(0, Math.floor(awayDurationMs / 1000)));
        setAwayCanRemind(reminderReady);

        if (!reminderReady) return null;
        return triggerReminder("away");
      }

      const previous = nextRecords[nextRecords.length - 2];
      if (!previous || latestReminderType !== reminderTypeForRecord(previous)) {
        return null;
      }

      return triggerReminder(latestReminderType);
    },
    [triggerReminder]
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
    if (!current || !placementConfirmed || finishingRef.current || document.hidden || !navigator.onLine) return;
    const image = captureImage();
    if (!image || analyzingRef.current) return;
    const activeSupervision = current;
    const currentFrequencyReason = frequencyReasonRef.current;

    analyzingRef.current = true;
    setAnalyzing(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image,
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
      const nextPresence = (result.presence ?? legacyPresenceFromStatus(nextStatus)) as Presence;
      const nextLearningState = (result.learning_state ??
        legacyLearningStateFromStatus(nextStatus)) as LearningState;
      const draftRecords = [
        ...recordsRef.current,
        {
          id: result.recordId ?? undefined,
          status: nextStatus,
          presence: nextPresence,
          learning_state: nextLearningState,
          timestamp: new Date().toISOString(),
          confidence: result.confidence ?? null,
          reason: result.reason ?? null,
          analyze_mode: result.analyze_mode ?? result.analyzeMode ?? "mock",
          current_frequency_seconds: currentIntervalSeconds,
          frequency_boosted_by_abnormal: currentFrequencyReason === "abnormal",
          frequency_lowered_by_focus: currentFrequencyReason === "focused",
          ai_called: true,
          triggered_reminder: false,
          reminder_type: null,
          reminder_text: null,
          error_message: null
        }
      ];
      const reminder = maybeRemind(draftRecords);
      const nextRecords = draftRecords.map((record, index) =>
        index === draftRecords.length - 1
          ? {
              ...record,
              triggered_reminder: Boolean(reminder),
              reminder_type: reminder?.type ?? null,
              reminder_text: reminder?.text ?? null
            }
          : record
      );

      recordsRef.current = nextRecords;
      setRecords(nextRecords);
      setStatus(nextStatus);
      setPresence(nextPresence);
      setLearningState(nextLearningState);
      aiCallCountRef.current += 1;
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
    placementConfirmed,
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
              presence: legacyPresenceFromStatus(nextStatus),
              learning_state: legacyLearningStateFromStatus(nextStatus),
              manual_corrected: true,
              correction_source: "user",
              corrected_at: new Date().toISOString()
            }
          : record
      );
      recordsRef.current = correctedRecords;
      setRecords(correctedRecords);
      setStatus(nextStatus);
      setPresence(legacyPresenceFromStatus(nextStatus));
      setLearningState(legacyLearningStateFromStatus(nextStatus));

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

  const markLatestRecordReminder = useCallback((reminder: LastReminder) => {
    const currentRecords = recordsRef.current;
    if (currentRecords.length === 0) return;
    const nextRecords = currentRecords.map((record, index) =>
      index === currentRecords.length - 1
        ? {
            ...record,
            triggered_reminder: true,
            reminder_type: reminder.type,
            reminder_text: reminder.text
          }
        : record
    );
    recordsRef.current = nextRecords;
    setRecords(nextRecords);
  }, []);

  const sendHeartbeat = useCallback(async () => {
    if (!current || finishingRef.current || !navigator.onLine) return;
    try {
      const response = await fetch("/api/session-heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessCodeId: current.accessCode.id,
          sessionId: current.session.id,
          sessionToken: current.session.session_token
        })
      });
      if (!response.ok) {
        const result = await response.json();
        setCameraError(result.error ?? "会话已结束，请重新开始监督。");
      }
    } catch {
      setCameraError("心跳同步失败，请检查网络。");
    }
  }, [current]);

  const releaseWakeLock = useCallback(async () => {
    const wakeLock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (!wakeLock) return;
    try {
      await wakeLock.release();
    } catch {
      // Wake Lock may already be released by the browser.
    }
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator)) {
      setWakeLockMessage("为了保证监督正常运行，请将手机自动锁屏时间调整为较长时间。");
      return;
    }
    if (wakeLockRef.current || document.hidden) return;

    try {
      const wakeLock = await navigator.wakeLock.request("screen");
      wakeLockRef.current = wakeLock as WakeLockSentinel;
      setWakeLockMessage("");
      wakeLockRef.current.addEventListener("release", () => {
        wakeLockRef.current = null;
      });
    } catch {
      setWakeLockMessage("为了保证监督正常运行，请将手机自动锁屏时间调整为较长时间。");
    }
  }, []);

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
          ...(finalRecords.length > 0 ? { records: finalRecords } : {}),
          endTime,
          durationMinutes,
          aiCallCount: aiCallCountRef.current,
          reportLevel: activeSupervision.accessCode.report_level,
          sessionToken: activeSupervision.session.session_token
        })
      });
    } finally {
      void releaseWakeLock();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      router.push("/report");
    }
  }, [current, releaseWakeLock, router]);

  useEffect(() => {
    const raw = window.sessionStorage.getItem("current-supervision");
    if (!raw) {
      router.replace("/");
      return;
    }
    const parsed = JSON.parse(raw) as CurrentSupervision;
    setCurrent(parsed);
    startedAtRef.current = new Date(parsed.session.start_time);
    const seenKey = `supervision-seen-${parsed.session.id}`;
    if (window.sessionStorage.getItem(seenKey) === "true") {
      setNeedsRecoveryDecision(true);
    } else {
      window.sessionStorage.setItem(seenKey, "true");
    }
    setPlacementConfirmed(
      window.sessionStorage.getItem(`placement-confirmed-${parsed.session.id}`) === "true"
    );
  }, [router]);

  useEffect(() => {
    if (current) {
      applyInterval(defaultIntervalForNow(), "normal");
    }
  }, [applyInterval, current, defaultIntervalForNow]);

  useEffect(() => {
    if (!current || !placementConfirmed || needsRecoveryDecision) return;
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
  }, [analyze, current, needsRecoveryDecision, placementConfirmed]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current.getTime()) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    function updateActivity() {
      setPageActive(!document.hidden && navigator.onLine);
      if (!document.hidden && navigator.onLine && current && placementConfirmed && !needsRecoveryDecision) {
        void requestWakeLock();
      }
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
  }, [current, needsRecoveryDecision, placementConfirmed, requestWakeLock]);

  useEffect(() => {
    if (!current || !placementConfirmed || needsRecoveryDecision) return;
    void requestWakeLock();
    return () => {
      void releaseWakeLock();
    };
  }, [current, needsRecoveryDecision, placementConfirmed, releaseWakeLock, requestWakeLock]);

  useEffect(() => {
    if (!current || !placementConfirmed || needsRecoveryDecision || !pageActive || finishingRef.current) return;
    const timeout = window.setTimeout(
      () => void analyze(),
      currentIntervalSeconds * 1000
    );
    return () => window.clearTimeout(timeout);
  }, [analyze, current, currentIntervalSeconds, needsRecoveryDecision, pageActive, placementConfirmed, records.length]);

  useEffect(() => {
    if (!current || needsRecoveryDecision || !pageActive || finishingRef.current) return;
    void sendHeartbeat();
    const timer = window.setInterval(() => void sendHeartbeat(), 60_000);
    return () => window.clearInterval(timer);
  }, [current, needsRecoveryDecision, pageActive, sendHeartbeat]);

  useEffect(() => {
    if (!current || needsRecoveryDecision || !pageActive || finishingRef.current) return;
    const timer = window.setInterval(() => {
      const awayStartAt = awayStartAtRef.current;
      const latest = recordsRef.current[recordsRef.current.length - 1];
      const latestIsAway = latest ? reminderTypeForRecord(latest) === "away" : false;
      if (!awayStartAt || !latestIsAway) {
        setAwayDurationSeconds(0);
        setAwayCanRemind(false);
        return;
      }

      const durationSeconds = Math.max(0, Math.floor((Date.now() - awayStartAt) / 1000));
      const conditionMet = durationSeconds >= awayDurationReminderMs / 1000;
      setAwayDurationSeconds(durationSeconds);
      setAwayCanRemind(conditionMet);

      if (conditionMet) {
        const reminder = triggerReminder("away");
        if (reminder) {
          markLatestRecordReminder(reminder);
        }
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [current, markLatestRecordReminder, needsRecoveryDecision, pageActive, triggerReminder]);

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
        当前为测试模式，状态识别为模拟结果，正式版将使用智能识别。
      </div>
      <div className="mb-4 rounded-md border border-line bg-white p-3 text-sm leading-6 text-muted">
        <div className="font-medium text-ink">最佳拍摄角度提示</div>
        <div className="mt-1">
          建议手机放置于孩子侧前方45°位置。确保能够看到：上半身、双手、桌面、作业区域。这样可提高识别准确率。
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={testReminderSound}
            className="w-fit rounded-md border border-line px-3 py-2 text-sm font-medium text-ink"
          >
            测试提醒声音
          </button>
          <span className="text-xs text-muted">
            提醒声音会跟随手机或浏览器音量。请关闭静音模式，并把媒体音量调高。
          </span>
        </div>
        {audioTestMessage && (
          <div className="mt-2 rounded-md bg-panel p-2 text-xs text-muted">
            {audioTestMessage}
          </div>
        )}
        <AudioTestSteps steps={audioTestSteps} />
        {wakeLockMessage && (
          <div className="mt-2 rounded-md bg-amber-50 p-2 text-xs leading-5 text-warn">
            {wakeLockMessage}
          </div>
        )}
      </div>
      <div className="mb-4 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm leading-6 text-muted">
        学习过程会自动生成报告，包括学习时长、证据不足、离座和提醒记录。
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
          {cameraError && (
            <p className="mt-3 rounded-md border border-alert bg-red-50 p-3 text-sm text-alert">
              {cameraError}
            </p>
          )}
          {shouldShowAngleWarning && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-warn">
              <div className="font-medium">当前画面证据不足，请调整手机角度。</div>
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
              <StatusBadge status={status} presence={presence} learningState={learningState} />
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
            <div className="text-sm text-muted">当前模式</div>
            <div className="mt-1 text-xl font-semibold">
              {isStartupSupervision ? "启动强监督中" : "正常监督中"}
            </div>
            {isStartupSupervision && (
              <div className="mt-2 text-sm leading-5 text-muted">
                前5分钟将高频检查，确保孩子在画面内并开始学习。
              </div>
            )}
            <div className="mt-4 border-t border-line pt-3 text-sm text-muted">
              当前监督强度
            </div>
            <div className="mt-1 text-2xl font-semibold">
              {intensityLabels[intensity]}
            </div>
            <div className="mt-2 text-sm text-muted">
              系统会根据学习状态自动调整监督频率。
            </div>
          </div>
          <Timer label="本次监督总时长" minutes={elapsedMinutes} />
          <Timer label="今日剩余额度" minutes={todayRemainingMinutes} />
          <Timer label="账号总剩余额度" minutes={totalRemainingMinutes} />
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">当前专注率</div>
            <div className="mt-1 text-2xl font-semibold">
              {learningInsights.accountableCount > 0 ? `${learningInsights.focusRate}%` : "数据采集中"}
            </div>
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">今日学习评价</div>
            <div className="mt-1 flex items-end gap-2">
              <span className="text-2xl font-semibold">{learningInsights.grade}</span>
              <span className="pb-1 text-sm text-muted">{learningInsights.gradeText}</span>
            </div>
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm font-medium">学习时长拆分</div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <MetricPill label="有效学习" value={`${learningInsights.studyingMinutes}分钟`} />
              <MetricPill label="证据不足" value={`${learningInsights.uncertainMinutes}分钟`} />
              <MetricPill label="离座时长" value={`${learningInsights.abnormalMinutes}分钟`} />
            </div>
            <div className="mt-3 text-xs leading-5 text-muted">
              学习时长根据AI识别结果统计，证据不足状态不计入有效学习或离座时长。
            </div>
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm font-medium">学习状态分布</div>
            <div className="mt-3 space-y-3">
              <ProgressRow label="学习中" value={learningInsights.studyingPercent} color="bg-brand" />
              <ProgressRow label="证据不足" value={learningInsights.uncertainPercent} color="bg-warn" />
              <ProgressRow label="离座" value={learningInsights.awayPercent} color="bg-alert" />
            </div>
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">最近一次提醒</div>
            {lastReminder ? (
              <div className="mt-2 text-sm leading-6">
                <div className="font-medium">{reminderLabels[lastReminder.type]}</div>
                <div className="text-muted">{formatRelativeReminderTime(lastReminder.timestamp)}</div>
                <div className="text-muted">
                  {reminderCooldownRemainingMinutes > 0
                    ? `冷却中：还需等待 ${reminderCooldownRemainingMinutes}分钟`
                    : "可再次提醒"}
                </div>
              </div>
            ) : (
              <div className="mt-2 text-sm text-muted">暂无提醒</div>
            )}
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm font-medium">提醒诊断</div>
            <div className="mt-2 space-y-1 text-sm leading-6 text-muted">
              <div>当前模式：{currentModeLabel}</div>
              <div>最近一次识别时间：{latestRecordTime}</div>
              <div>当前 presence：{presence}</div>
              <div>当前 learning_state：{learningState}</div>
              <div>当前 away 持续时长：{formatDurationSeconds(awayDurationSeconds)}</div>
              <div>是否满足离座提醒条件：{awayCanRemind ? "是" : "否"}</div>
              <div>
                是否处于冷却中：
                {awayCooldownRemainingSeconds > 0
                  ? `是，还需 ${formatDurationSeconds(awayCooldownRemainingSeconds)}`
                  : "否"}
              </div>
              <div>
                最近一次提醒类型：
                {lastReminder ? reminderLabels[lastReminder.type] : "暂无"}
              </div>
              <div>最近一次声音播放结果：{lastAudioResult}</div>
              <div>当前识别间隔：{currentIntervalSeconds}秒</div>
            </div>
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
                    {displayStateText(record)}
                    {record.triggered_reminder ? "，已提醒" : ""}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {record.triggered_reminder ? "已提醒" : "未提醒"}
                    {record.reminder_type && ` / ${reminderLabels[record.reminder_type]}`}
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
      {current && !placementConfirmed && !needsRecoveryDecision && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-md bg-white p-5 shadow-lg">
            <h2 className="text-xl font-semibold">手机摆放确认</h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              为了提高识别准确率，请将手机放在孩子侧前方约45°位置，并尽量拍到：
            </p>
            <ul className="mt-3 list-inside list-disc space-y-1 text-sm leading-6 text-muted">
              <li>孩子上半身</li>
              <li>双手</li>
              <li>桌面</li>
              <li>作业本/书本/屏幕</li>
              <li>笔或文具</li>
            </ul>
            <div className="mt-4 rounded-md bg-panel p-3 text-xs leading-5 text-muted">
              提醒声音会跟随手机或浏览器音量。请关闭静音模式，并把媒体音量调高。
            </div>
            {audioTestMessage && (
              <div className="mt-3 rounded-md bg-panel p-3 text-xs leading-5 text-muted">
                {audioTestMessage}
              </div>
            )}
            <AudioTestSteps steps={audioTestSteps} />
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={testReminderSound}
                className="h-11 rounded-md border border-line px-4 font-medium"
              >
                测试提醒声音
              </button>
              <button
                type="button"
                onClick={() => {
                  window.sessionStorage.setItem(`placement-confirmed-${current.session.id}`, "true");
                  setPlacementConfirmed(true);
                }}
                className="h-11 rounded-md bg-brand px-4 font-semibold text-white"
              >
                我已放好，开始监督
              </button>
            </div>
          </div>
        </div>
      )}
      {current && needsRecoveryDecision && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-md bg-white p-5 shadow-lg">
            <h2 className="text-xl font-semibold">检测到未结束监督</h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              页面刷新前有一段监督尚未结束。你可以恢复监督继续记录，也可以立即结束并结算本次监督。
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => setNeedsRecoveryDecision(false)}
                className="h-11 rounded-md bg-brand px-4 font-semibold text-white"
              >
                恢复监督
              </button>
              <button
                type="button"
                onClick={() => void finish()}
                className="h-11 rounded-md border border-line px-4 font-medium"
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

function reminderTypeForRecord(record: StudyRecord): ReminderType | null {
  const currentPresence = record.presence ?? legacyPresenceFromStatus(record.status);
  const currentLearningState = record.learning_state ?? legacyLearningStateFromStatus(record.status);
  if (currentPresence === "away") return "away";
  if (currentLearningState === "uncertain") return "uncertain";
  return null;
}

function formatRelativeReminderTime(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes === 0) return "刚刚";
  return `${minutes}分钟前`;
}

function formatDurationSeconds(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const restSeconds = safeSeconds % 60;
  if (minutes === 0) return `${restSeconds}秒`;
  return `${minutes}分${restSeconds}秒`;
}

function displayStateText(record: StudyRecord) {
  const currentPresence = record.presence ?? legacyPresenceFromStatus(record.status);
  const currentLearningState = record.learning_state ?? legacyLearningStateFromStatus(record.status);
  if (currentPresence === "away") return "离座";
  if (currentLearningState === "studying") return "在位 · 学习中";
  return "在位 · 证据不足";
}

function legacyPresenceFromStatus(status: StudyStatus): Presence {
  return status === "away" ? "away" : "present";
}

function legacyLearningStateFromStatus(status: StudyStatus): LearningState {
  if (status === "studying") return "studying";
  return "uncertain";
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-panel p-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-semibold">{value}</div>
    </div>
  );
}

function ProgressRow({
  label,
  value,
  color
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-muted">
        <span>{label}</span>
        <span>{value}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-panel">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function AudioTestSteps({ steps }: { steps: AudioTestStep[] }) {
  if (steps.length === 0) return null;

  return (
    <div className="mt-2 space-y-1 rounded-md bg-panel p-2 text-xs leading-5 text-muted">
      {steps.map((step, index) => (
        <div key={`${step.label}-${index}`}>
          <span className="font-medium text-ink">{step.label}</span>
          <span>：{audioStatusLabel(step.status)}</span>
          {step.detail && <span> / {step.detail}</span>}
        </div>
      ))}
    </div>
  );
}

function audioStatusLabel(status: AudioTestStep["status"]) {
  const labels: Record<AudioTestStep["status"], string> = {
    pending: "测试中",
    success: "成功",
    failed: "失败",
    skipped: "未执行"
  };
  return labels[status];
}
