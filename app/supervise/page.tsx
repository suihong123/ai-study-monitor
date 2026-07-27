"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraPreview } from "@/components/CameraPreview";
import { ReportCard } from "@/components/ReportCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Timer } from "@/components/Timer";
import { reportUrl, saveReportHistory } from "@/lib/report-history";
import { calculateLearningInsights, calculateStats } from "@/lib/stats";
import {
  intensityLabels,
  type AccessCode,
  type GeneratedReport,
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
  away: "已经多次检测到离座，请回到座位继续学习。"
};

const reminderAudioSources: Record<ReminderType, { first: string; repeat: string }> = {
  uncertain: {
    first: "/audio/reminder-uncertain.wav",
    repeat: "/audio/reminder-uncertain-repeat.wav"
  },
  away: {
    first: "/audio/reminder-away.wav",
    repeat: "/audio/reminder-away-repeat.wav"
  }
};

const reminderTestAudioSource = "/audio/reminder-test.wav";
const supervisionStartAudioSource = "/audio/reminder-start.wav";
const supervisionEndAudioSource = "/audio/reminder-end.wav";

const normalReminderCooldownMs = 3 * 60 * 1000;
const stableReminderCooldownMs = 5 * 60 * 1000;
const uncertainMinimumCooldownMs = 90 * 1000;
const awayMinimumCooldownMs = 60 * 1000;
const awayDurationReminderMs = 60 * 1000;
const startupSupervisionMs = 5 * 60 * 1000;

const correctionButtons: Array<{ status: StudyStatus; label: string }> = [
  { status: "studying", label: "我在学习" },
  { status: "unknown", label: "无法判断" },
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
type CameraFacing = "environment" | "user";

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
  const analyzeRef = useRef<() => Promise<void>>(async () => {});
  const finishRef = useRef<() => Promise<void>>(async () => {});
  const intensityUntilRef = useRef(0);
  const abnormalLockRef = useRef(false);
  const aiCallCountRef = useRef(0);
  const analyzeFailureCountRef = useRef(0);
  const frequencyReasonRef = useRef<FrequencyReason>("normal");
  const calibrationAnalyzeTimersRef = useRef<number[]>([]);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const localReminderAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const awayStartAtRef = useRef<number | null>(null);
  const lastReminderAtRef = useRef<Partial<Record<ReminderType, number>>>({});
  const reminderCountByTypeRef = useRef<Partial<Record<ReminderType, number>>>({});
  const reminderPlayingRef = useRef<Partial<Record<ReminderType, boolean>>>({});
  const [current, setCurrent] = useState<CurrentSupervision | null>(null);
  const [status, setStatus] = useState<StudyStatus>("unknown");
  const [presence, setPresence] = useState<Presence>("present");
  const [learningState, setLearningState] = useState<LearningState>("uncertain");
  const [records, setRecords] = useState<StudyRecord[]>([]);
  const [cameraError, setCameraError] = useState("");
  const [cameraErrorType, setCameraErrorType] = useState("");
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>("environment");
  const [cameraRetryKey, setCameraRetryKey] = useState(0);
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
  const [audioReady, setAudioReady] = useState(false);
  const [wakeLockMessage, setWakeLockMessage] = useState("");
  const [, setAwayDurationSeconds] = useState(0);
  const [, setAwayCanRemind] = useState(false);
  const [, setLastAudioResult] = useState("暂无声音播放记录");
  const [completedReport, setCompletedReport] = useState<GeneratedReport | null>(null);
  const [completedReportUrl, setCompletedReportUrl] = useState("");

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const totalRemainingMinutes = Math.max(
    0,
    (current?.totalRemainingMinutes ?? 0) - elapsedMinutes
  );

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
  const currentModeLabel =
    elapsedSeconds < 2 * 60
      ? "启动校准"
      : elapsedSeconds < 5 * 60
      ? "启动强监督"
      : elapsedSeconds < 10 * 60
      ? "动态观察"
      : "正常监督";
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
  const latestRecognitionAt = latestRecord
    ? new Date(latestRecord.timestamp).getTime()
    : 0;
  const recognitionStale =
    latestRecognitionAt > 0 &&
    Date.now() - latestRecognitionAt >
      Math.max(90, currentIntervalSeconds * 2 + 15) * 1000;
  const cameraActive = Boolean(
    streamRef.current?.getVideoTracks().some((track) => track.readyState === "live")
  );
  const cameraFacingLabel = cameraFacing === "environment" ? "后置摄像头" : "前置摄像头";
  const supervisionHealth = !pageActive
    ? "监督已暂停"
    : cameraError
    ? "需要检查"
    : recognitionStale
    ? "识别可能暂停"
    : records.length === 0
    ? "正在建立监督"
    : "监督运行正常";
  const pictureQuality = records.length === 0
    ? "检查中"
    : shouldShowAngleWarning
    ? "建议调整角度"
    : "画面良好";
  const reminderCooldownRemainingSeconds = lastReminder
    ? Math.max(
        0,
        Math.ceil(
          (dynamicReminderCooldownMs(lastReminder.type, records) -
            (Date.now() - lastReminder.timestamp)) /
            1000
        )
      )
    : 0;
  const getLocalReminderAudio = useCallback(() => {
    let audio = localReminderAudioRef.current;
    if (!audio) {
      audio = new Audio(reminderTestAudioSource);
      audio.preload = "auto";
      audio.volume = 1;
      audio.muted = false;
      audio.setAttribute("playsinline", "true");
      localReminderAudioRef.current = audio;
    }
    return audio;
  }, []);

  const unlockLocalReminderAudio = useCallback(async () => {
    const audio = getLocalReminderAudio();
    const previousMuted = audio.muted;
    audio.muted = true;
    try {
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      setAudioReady(true);
      return true;
    } catch (error) {
      console.error("[提醒声音] 本地音频解锁失败", error);
      return false;
    } finally {
      audio.muted = previousMuted;
    }
  }, [getLocalReminderAudio]);

  const playLocalReminderAudio = useCallback(
    async (source: string) => {
      const audio = getLocalReminderAudio();
      audio.pause();
      audio.src = source;
      audio.currentTime = 0;
      audio.muted = false;
      audio.volume = 1;
      audio.load();
      await audio.play();
      setAudioReady(true);
      return true;
    },
    [getLocalReminderAudio]
  );

  const unlockReminderAudio = useCallback(async () => {
    const AudioContextClass =
      window.AudioContext ?? (window as WebAudioWindow).webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }

    let audioContext = audioContextRef.current;
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;
    }

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    return audioContext;
  }, []);

  const playBeep = useCallback(async (pattern: BeepPattern = "single") => {
    const audioContext = await unlockReminderAudio();
    if (!audioContext) return false;

    const beepCount = pattern === "triple" ? 3 : 1;
    const duration = 0.6;
    const gap = 0.2;

    await new Promise<void>((resolve, reject) => {
      let endedCount = 0;
      const finishOne = () => {
        endedCount += 1;
        if (endedCount === beepCount) {
          window.setTimeout(resolve, 50);
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
        reject(error);
      }
    });

    return true;
  }, [unlockReminderAudio]);

  const playInlineWav = useCallback(async (pattern: BeepPattern = "single") => {
    const beepCount = pattern === "triple" ? 3 : 1;
    for (let index = 0; index < beepCount; index += 1) {
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
      if (index < beepCount - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
    }
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!("speechSynthesis" in window)) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(success);
      };
      const timeout = window.setTimeout(() => finish(false), 1500);

      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "zh-CN";
        utterance.rate = 0.95;
        speechUtteranceRef.current = utterance;
        utterance.onstart = () => finish(true);
        utterance.onend = () => {
          if (speechUtteranceRef.current === utterance) {
            speechUtteranceRef.current = null;
          }
          finish(true);
        };
        utterance.onerror = (event) => {
          if (speechUtteranceRef.current === utterance) {
            speechUtteranceRef.current = null;
          }
          console.error("[提醒声音] speechSynthesis 播放失败", event.error);
          finish(false);
        };
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } catch (error) {
        console.error("[提醒声音] speechSynthesis 播放失败", error);
        finish(false);
      }
    });
  }, []);

  const playReminderAudio = useCallback(
    async (reminderType: ReminderType, text: string, repeated: boolean) => {
      const pattern: BeepPattern = reminderType === "away" ? "triple" : "single";
      const localSource = repeated
        ? reminderAudioSources[reminderType].repeat
        : reminderAudioSources[reminderType].first;

      try {
        const localAudioStarted = await playLocalReminderAudio(localSource);
        if (localAudioStarted) {
          setLastAudioResult("本地语音提醒已开始播放");
          return true;
        }
      } catch (error) {
        setLastAudioResult(
          `本地语音播放失败：${error instanceof Error ? error.message : String(error)}`
        );
      }

      let beepPlayed = false;
      try {
        beepPlayed = await playBeep(pattern);
      } catch (error) {
        setLastAudioResult(
          `WebAudio 播放失败：${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (!beepPlayed) {
        try {
          await playInlineWav(pattern);
          beepPlayed = true;
        } catch (error) {
          setLastAudioResult(
            `Audio 标签播放失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (beepPlayed) {
        const beepText =
          reminderType === "away" ? "蜂鸣提示成功（三声）" : "蜂鸣提示成功（单声）";
        setLastAudioResult(`本地语音未启动，${beepText}`);
        return true;
      }

      const speechStarted = await speak(text);
      if (speechStarted) {
        setLastAudioResult("本地语音和蜂鸣失败，TTS 已开始播放");
        return true;
      }

      setLastAudioResult("本地语音、蜂鸣和 TTS 均未启动，请检查媒体音量");
      return false;
    },
    [playBeep, playInlineWav, playLocalReminderAudio, speak]
  );

  const playSupervisionCue = useCallback(
    async (source: string, label: string) => {
      try {
        const localAudioStarted = await playLocalReminderAudio(source);
        if (localAudioStarted) {
          setLastAudioResult(`${label}已开始播放`);
          return true;
        }
      } catch (error) {
        setLastAudioResult(`${label}播放失败，尝试蜂鸣兜底`);
        console.error(`[提醒声音] ${label}播放失败`, error);
      }

      try {
        const beepPlayed = await playBeep("single");
        if (beepPlayed) {
          setLastAudioResult(`${label}本地语音未启动，蜂鸣兜底成功`);
          return true;
        }
      } catch (error) {
        console.error(`[提醒声音] ${label}蜂鸣兜底失败`, error);
      }

      setLastAudioResult(`${label}未能播放，请检查媒体音量`);
      return false;
    },
    [playBeep, playLocalReminderAudio]
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

    console.info("[提醒声音测试] 开始提醒链路测试");
    setAudioTestMessage("");
    setAudioTestSteps([]);
    setLastAudioResult("正在测试提醒声音");
    let localAudioOk = false;
    let webAudioOk = false;
    let audioTagOk = false;
    let speechOk = false;

    try {
      updateStep({ label: "本地语音", status: "pending", detail: "开始播放预置中文提醒音频" });
      localAudioOk = await playLocalReminderAudio(reminderTestAudioSource);
      updateStep({ label: "本地语音", status: "success", detail: "已开始播放" });
      setLastAudioResult("测试：本地语音提醒已开始播放");
    } catch (error) {
      console.error("[提醒声音测试] 本地语音播放失败", error);
      updateStep({
        label: "本地语音",
        status: "failed",
        detail: error instanceof Error ? error.message : String(error)
      });
    }

    if (localAudioOk) {
      updateStep({ label: "WebAudio", status: "skipped", detail: "本地语音已成功，未触发蜂鸣兜底" });
      updateStep({ label: "Audio标签", status: "skipped", detail: "本地语音已成功，未触发蜂鸣兜底" });
      updateStep({ label: "TTS", status: "skipped", detail: "本地语音已成功，未触发 TTS 兜底" });
      setAudioTestMessage("本地语音提醒正常。实际提醒会优先播放同类音频。");
      return;
    }

    try {
      await unlockReminderAudio();
    } catch (error) {
      console.error("[提醒声音测试] WebAudio 解锁失败", error);
    }

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
      updateStep({ label: "TTS", status: "pending", detail: "蜂鸣失败，尝试系统语音兜底" });
      speechOk = await speak("这是学习监督提醒声音，请确认音量合适。");
      updateStep(
        speechOk
          ? { label: "TTS", status: "success", detail: "系统语音已开始播放" }
          : { label: "TTS", status: "failed", detail: "系统语音未启动" }
      );
    } else {
      updateStep({ label: "TTS", status: "skipped", detail: "蜂鸣兜底已成功，未继续测试" });
    }

    setAudioTestMessage(
      webAudioOk || audioTagOk
        ? "本地语音未启动，蜂鸣兜底正常。请检查媒体音量，不是铃声音量。"
        : speechOk
        ? "本地语音和蜂鸣失败，TTS 兜底已启动。"
        : "本地语音、蜂鸣和 TTS 都未成功，请关闭静音模式、调高媒体音量后重试。"
    );
  }, [playBeep, playInlineWav, playLocalReminderAudio, speak, unlockReminderAudio]);

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
    async (reminderType: ReminderType, contextRecords = recordsRef.current) => {
      const lastReminderAt = lastReminderAtRef.current[reminderType] ?? 0;
      const cooldownMs = dynamicReminderCooldownMs(reminderType, contextRecords);
      if (
        Date.now() - lastReminderAt < cooldownMs ||
        reminderPlayingRef.current[reminderType]
      ) {
        return null;
      }

      const reminderCount = reminderCountByTypeRef.current[reminderType] ?? 0;
      const text =
        reminderCount === 0
          ? firstReminderTexts[reminderType]
          : repeatReminderTexts[reminderType];

      reminderPlayingRef.current[reminderType] = true;
      try {
        const played = await playReminderAudio(reminderType, text, reminderCount > 0);
        if (!played) return null;

        const timestamp = Date.now();
        lastReminderAtRef.current[reminderType] = timestamp;
        reminderCountByTypeRef.current[reminderType] = reminderCount + 1;
        const reminder = {
          type: reminderType,
          text,
          timestamp
        };
        setLastReminder(reminder);
        return reminder;
      } finally {
        reminderPlayingRef.current[reminderType] = false;
      }
    },
    [playReminderAudio]
  );

  const maybeRemind = useCallback(
    async (nextRecords: StudyRecord[]) => {
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
        return await triggerReminder("away", nextRecords);
      }

      return await triggerReminder(latestReminderType, nextRecords);
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
        if (result.code === "quota_exhausted") {
          setCameraError("监督时长已用完，正在结束本次监督。");
          void finishRef.current();
          return;
        }
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
      const reminder = await maybeRemind(draftRecords);
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
      const correctionReason = manualCorrectionReasonFromStatus(nextStatus);

      const correctedRecords = recordsRef.current.map((record, index) =>
        index === recordsRef.current.length - 1
          ? {
              ...record,
              status: nextStatus,
              presence: legacyPresenceFromStatus(nextStatus),
              learning_state: legacyLearningStateFromStatus(nextStatus),
              reason: correctionReason,
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

  useEffect(() => {
    analyzeRef.current = analyze;
  }, [analyze]);

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
        if (result.code === "quota_exhausted") {
          setCameraError("监督时长已用完，正在结束本次监督。");
          void finishRef.current();
          return;
        }
        setCameraError(result.error ?? "会话已结束，请重新开始监督。");
      }
    } catch {
      setCameraError("心跳同步失败，请检查网络。");
    }
  }, [current]);

  const switchCameraFacing = useCallback(() => {
    setCameraError("");
    setCameraErrorType("");
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraFacing((currentFacing) =>
      currentFacing === "environment" ? "user" : "environment"
    );
  }, []);

  const retryCamera = useCallback(() => {
    setCameraError("");
    setCameraErrorType("");
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraRetryKey((value) => value + 1);
  }, []);

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
    const reportToken = activeSupervision.session.report_token;

    try {
      const settlementResponse = await fetch("/api/access-code", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "finish-session",
          sessionId: activeSupervision.session.id,
          accessCodeId: activeSupervision.accessCode.id,
          ...(finalRecords.length > 0 ? { records: finalRecords } : {}),
          sessionToken: activeSupervision.session.session_token
        })
      });
      const settlement = await settlementResponse.json();
      if (!settlementResponse.ok) {
        throw new Error(settlement.error ?? "监督结算失败");
      }

      window.sessionStorage.removeItem("current-supervision");
      void releaseWakeLock();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      await playSupervisionCue(supervisionEndAudioSource, "监督结束提示音");

      if (!reportToken) {
        const fallbackStats = calculateStats(finalRecords, durationMinutes);
        const fallbackReport: GeneratedReport = {
          stats: fallbackStats,
          summary: "本次监督已结束，当前为临时报告。",
          conclusion: "本次报告已根据当前监督记录生成。",
          parentAdvice: "建议结合实际学习情况查看。",
          trend: null,
          records: finalRecords,
          reportLevel: activeSupervision.accessCode.report_level,
          provider: "client-fallback",
          session: {
            id: activeSupervision.session.id,
            startTime: startedAtRef.current.toISOString(),
            endTime,
            durationMinutes,
            status: "completed"
          }
        };
        window.sessionStorage.setItem("latest-report", JSON.stringify(fallbackReport));
        setCompletedReportUrl("/report");
        setCurrent(null);
        setCompletedReport(fallbackReport);
        return;
      }

      const historyEntry = {
        sessionId: activeSupervision.session.id,
        reportToken,
        startTime: startedAtRef.current.toISOString(),
        endTime
      };
      saveReportHistory(historyEntry);
      const persistentReportUrl = reportUrl(historyEntry);
      setCompletedReportUrl(persistentReportUrl);

      const reportResponse = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSupervision.session.id,
          reportToken
        })
      });
      if (!reportResponse.ok) {
        router.push(persistentReportUrl);
        return;
      }
      const report = (await reportResponse.json()) as GeneratedReport;

      window.sessionStorage.setItem("latest-report", JSON.stringify(report));
      setCurrent(null);
      setCompletedReport(report);
    } catch (error) {
      finishingRef.current = false;
      setCameraError(error instanceof Error ? error.message : "结束监督失败，请稍后重试。");
    }
  }, [current, playSupervisionCue, releaseWakeLock, router]);

  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);

  useEffect(() => {
    if (!current || finishingRef.current) return;
    const quotaEndAt =
      new Date(current.session.start_time).getTime() +
      current.totalRemainingMinutes * 60_000;
    const remainingMs = quotaEndAt - Date.now();
    if (remainingMs <= 0) {
      void finishRef.current();
      return;
    }
    if (remainingMs > 2_147_000_000) return;
    const timer = window.setTimeout(() => void finishRef.current(), remainingMs);
    return () => window.clearTimeout(timer);
  }, [current]);

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
            facingMode: cameraFacing,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
        if (cancelled) return;
        setCameraError("");
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        calibrationAnalyzeTimersRef.current = [1200, 20_000, 50_000].map((delay) =>
          window.setTimeout(() => void analyzeRef.current(), delay)
        );
      } catch (error) {
        const cameraDiagnosis = buildCameraPermissionDiagnosis(error, cameraFacing);
        setCameraError(cameraDiagnosis.message);
        setCameraErrorType(cameraDiagnosis.issueType);
        void fetch("/api/client-error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessCodeId: activeSupervision.accessCode.id,
            sessionId: activeSupervision.session.id,
            sessionToken: activeSupervision.session.session_token,
            errorType: `摄像头权限失败-${cameraDiagnosis.issueType}`,
            errorMessage: cameraDiagnosis.message,
            stack: JSON.stringify(cameraDiagnosis, null, 2)
          })
        });
      }
    }

    void startCamera();
    return () => {
      cancelled = true;
      calibrationAnalyzeTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      calibrationAnalyzeTimersRef.current = [];
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraFacing, cameraRetryKey, current, needsRecoveryDecision, placementConfirmed]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current.getTime()) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      const audioContext = audioContextRef.current;
      const localAudio = localReminderAudioRef.current;
      audioContextRef.current = null;
      localReminderAudioRef.current = null;
      speechUtteranceRef.current = null;
      if (localAudio) {
        localAudio.pause();
        localAudio.removeAttribute("src");
      }
      window.speechSynthesis?.cancel();
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close();
      }
    };
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
        void triggerReminder("away").then((reminder) => {
          if (reminder) {
            markLatestRecordReminder(reminder);
          }
        });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [current, markLatestRecordReminder, needsRecoveryDecision, pageActive, triggerReminder]);

  useEffect(() => {
    if (!current || abnormalLockRef.current || Date.now() < intensityUntilRef.current) return;
    applyInterval(defaultIntervalForNow(), "normal");
  }, [applyInterval, current, defaultIntervalForNow, elapsedMinutes]);

  useEffect(() => {
    if (current && totalRemainingMinutes <= 0) {
      void finish();
    }
  }, [current, finish, totalRemainingMinutes]);

  if (completedReport) {
    const isMockMode =
      completedReport.records.length === 0 ||
      completedReport.records.some((record) => (record.analyze_mode ?? "mock") === "mock");

    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-5 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">本次监督已完成</h1>
          <div
            className={
              isMockMode
                ? "mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-warn"
                : "mt-4 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm leading-6 text-muted"
            }
          >
            {isMockMode
              ? "当前为测试模式，状态识别为模拟结果，本报告仅用于流程测试，不代表真实学习判断。"
              : "以下是本次监督小结，基于AI视觉识别生成。识别结果仅供参考，可结合实际情况判断。"}
          </div>
          <p className="mt-2 text-muted">本次监督已结束并完成结算。</p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => router.push(completedReportUrl)}
              className="h-11 rounded-md bg-brand px-4 font-semibold text-white"
            >
              查看近期趋势报告
            </button>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="h-11 rounded-md border border-line px-4 font-medium"
            >
              返回首页
            </button>
          </div>
        </div>
        <ReportCard
          stats={completedReport.stats}
          records={completedReport.records}
          habitTrend={completedReport.habitTrend ?? null}
          view="session"
        />
      </main>
    );
  }

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
        学习过程会自动生成报告，包括学习时长、无法判断、离座和提醒记录。
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
          <div className="mt-3 flex flex-col gap-2 rounded-md border border-line bg-white p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="text-muted">当前摄像头：</span>
              <span className="font-medium text-ink">{cameraFacingLabel}</span>
            </div>
            <button
              type="button"
              onClick={switchCameraFacing}
              className="h-10 rounded-md border border-line px-3 font-medium text-ink"
            >
              切换到{cameraFacing === "environment" ? "前置摄像头" : "后置摄像头"}
            </button>
          </div>
          {cameraError && (
            <div className="mt-3 rounded-md border border-alert bg-red-50 p-3 text-sm leading-6 text-alert">
              <div className="font-semibold">相机无法打开</div>
              <div className="mt-1">
                请先点击“重新打开相机”。如果仍失败，建议复制链接，用 Chrome 或手机自带浏览器打开。
              </div>
              {cameraErrorType.includes("安卓") && (
                <div className="mt-2 rounded-md bg-white/70 p-2 text-xs leading-5 text-alert/90">
                  安卓手机如提示“悬浮窗/覆盖层”，请先关闭微信浮窗、录屏按钮或系统悬浮球后重试。
                </div>
              )}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={retryCamera}
                  className="h-10 rounded-md bg-alert px-3 font-semibold text-white"
                >
                  重新打开相机
                </button>
                <button
                  type="button"
                  onClick={switchCameraFacing}
                  className="h-10 rounded-md border border-alert px-3 font-medium text-alert"
                >
                  切换到{cameraFacing === "environment" ? "前置摄像头" : "后置摄像头"}
                </button>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(window.location.href)}
                  className="h-10 rounded-md border border-alert px-3 font-medium text-alert"
                >
                  复制链接，换浏览器打开
                </button>
              </div>
              <div className="mt-2 text-xs leading-5 text-alert/80">仍无法解决时，可临时用电脑浏览器测试。</div>
            </div>
          )}
          {shouldShowAngleWarning && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-warn">
              <div className="font-medium">当前画面无法判断，请调整手机角度。</div>
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
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-muted">监督运行状态</div>
              <div className={`text-sm font-semibold ${supervisionHealth === "监督运行正常" ? "text-brand" : "text-warn"}`}>
                {supervisionHealth}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-panel p-2">
                <div className="text-xs text-muted">摄像头</div>
                <div className="mt-1 font-medium">{cameraActive ? "正常" : "检查中"}</div>
              </div>
              <div className="rounded-md bg-panel p-2">
                <div className="text-xs text-muted">最近检查</div>
                <div className="mt-1 font-medium">{latestRecordTime}</div>
              </div>
              <div className="rounded-md bg-panel p-2">
                <div className="text-xs text-muted">提醒声音</div>
                <div className="mt-1 font-medium">{audioReady ? "已就绪" : "待确认"}</div>
              </div>
              <div className="rounded-md bg-panel p-2">
                <div className="text-xs text-muted">画面质量</div>
                <div className="mt-1 font-medium">{pictureQuality}</div>
              </div>
            </div>
          </div>
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
              {currentModeLabel}
            </div>
            {elapsedSeconds < 2 * 60 && (
              <div className="mt-2 text-sm leading-5 text-muted">
                正在确认人物、拍摄角度和学习画面是否正常。
              </div>
            )}
            {elapsedSeconds >= 2 * 60 && elapsedSeconds < 5 * 60 && (
              <div className="mt-2 text-sm leading-5 text-muted">
                前5分钟保持强监督，帮助孩子进入学习状态。
              </div>
            )}
            {elapsedSeconds >= 5 * 60 && elapsedSeconds < 10 * 60 && (
              <div className="mt-2 text-sm leading-5 text-muted">
                系统正在根据最近学习状态动态调整检查和提醒节奏。
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
              <MetricPill label="无法判断" value={`${learningInsights.uncertainMinutes}分钟`} />
              <MetricPill label="离座时长" value={`${learningInsights.abnormalMinutes}分钟`} />
            </div>
            <div className="mt-3 text-xs leading-5 text-muted">
              学习时长根据AI识别结果统计，无法判断状态不计入有效学习或离座时长。
            </div>
          </div>
          <div className="rounded-md border border-line bg-white p-4">
            <div className="text-sm font-medium">学习状态分布</div>
            <div className="mt-3 space-y-3">
              <ProgressRow label="学习中" value={learningInsights.studyingPercent} color="bg-brand" />
              <ProgressRow label="无法判断" value={learningInsights.uncertainPercent} color="bg-warn" />
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
                  {reminderCooldownRemainingSeconds > 0
                    ? `冷却中：还需等待 ${formatDurationSeconds(reminderCooldownRemainingSeconds)}`
                    : "可再次提醒"}
                </div>
              </div>
            ) : (
              <div className="mt-2 text-sm text-muted">暂无提醒</div>
            )}
          </div>
          <details className="rounded-md border border-line bg-white p-4">
            <summary className="cursor-pointer text-sm font-medium">
              监督详情
              <span className="ml-2 font-normal text-muted">
                {records.length > 0 ? `已完成 ${records.length} 次识别` : "等待首次识别"}
              </span>
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-panel p-2">
                <div className="text-xs text-muted">最近检查</div>
                <div className="mt-1 font-medium">{latestRecordTime}</div>
              </div>
              <div className="rounded-md bg-panel p-2">
                <div className="text-xs text-muted">检查间隔</div>
                <div className="mt-1 font-medium">{currentIntervalSeconds}秒</div>
              </div>
            </div>
            <div className="mt-4 text-sm font-medium">最近动态</div>
            <div className="mt-2 space-y-2 text-sm">
              {records.slice(-5).reverse().map((record, index) => (
                <div key={`${record.timestamp}-${index}`} className="rounded-md bg-panel px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{displayStateText(record)}</span>
                    <span className="text-xs text-muted">
                    {new Date(record.timestamp).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit"
                    })}
                    </span>
                  </div>
                  <div className="mt-1 text-xs leading-5 text-muted">
                    {friendlyRecordDetail(record)}
                  </div>
                  {record.triggered_reminder && (
                    <div className="mt-1 text-xs text-warn">
                      已播放{record.reminder_type ? reminderLabels[record.reminder_type] : "学习提醒"}
                    </div>
                  )}
                  {record.manual_corrected && (
                    <div className="mt-1 text-xs text-brand">用户已手动标记</div>
                  )}
                </div>
              ))}
              {records.length === 0 && <div className="text-muted">暂无记录</div>}
            </div>
          </details>
        </aside>
      </div>
      {current && !placementConfirmed && !needsRecoveryDecision && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-3 py-4 sm:items-center sm:p-4">
          <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-md bg-white shadow-lg">
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
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
              {audioTestSteps.length > 0 && (
                <details className="mt-3 rounded-md bg-panel p-3 text-xs leading-5 text-muted">
                  <summary className="cursor-pointer font-medium text-ink">查看声音测试详情</summary>
                  <AudioTestSteps steps={audioTestSteps} />
                </details>
              )}
            </div>
            <div className="shrink-0 border-t border-line bg-white p-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={testReminderSound}
                  className="h-11 rounded-md border border-line px-4 font-medium sm:flex-1"
                >
                  测试提醒声音
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.sessionStorage.setItem(`placement-confirmed-${current.session.id}`, "true");
                    setPlacementConfirmed(true);
                    void unlockLocalReminderAudio();
                    void unlockReminderAudio();
                    void playSupervisionCue(supervisionStartAudioSource, "监督开始提示音");
                  }}
                  className="h-11 rounded-md bg-brand px-4 font-semibold text-white sm:flex-1"
                >
                  我已放好，开始监督
                </button>
              </div>
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
                onClick={() => {
                  void unlockLocalReminderAudio();
                  void unlockReminderAudio();
                  setNeedsRecoveryDecision(false);
                }}
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

function buildCameraPermissionDiagnosis(error: unknown, cameraFacing: CameraFacing) {
  const cameraLabel = cameraFacing === "environment" ? "后置摄像头" : "前置摄像头";
  const errorName = error instanceof DOMException ? error.name : "";
  const errorMessage = error instanceof Error ? error.message : String(error ?? "");
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const isAndroid = /Android/i.test(userAgent);
  const isEdge = /EdgA|Edge/i.test(userAgent);
  const base = {
    cameraFacing,
    cameraLabel,
    errorName,
    errorMessage,
    userAgent,
    platform: typeof navigator === "undefined" ? "" : navigator.platform,
    vendor: typeof navigator === "undefined" ? "" : navigator.vendor,
    isAndroid,
    isEdge,
    pageUrl: typeof window === "undefined" ? "" : window.location.href,
    occurredAt: new Date().toISOString()
  };

  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    const issueType = isAndroid
      ? "疑似安卓悬浮窗或系统权限拦截"
      : "浏览器相机权限未授权";
    return {
      ...base,
      issueType,
      message: `无法授权${cameraLabel}。${isAndroid ? "安卓系统可能检测到气泡、悬浮窗或小窗模式，导致相机授权被拦截。" : "请检查浏览器相机权限。"}`
    };
  }

  if (errorName === "NotFoundError" || errorName === "OverconstrainedError") {
    return {
      ...base,
      issueType: "未找到指定摄像头",
      message: `未找到可用的${cameraLabel}。请尝试切换前置/后置摄像头，或确认没有其他应用正在占用相机。`
    };
  }

  if (errorName === "NotReadableError") {
    return {
      ...base,
      issueType: "相机被占用或系统读取失败",
      message: `暂时无法读取${cameraLabel}。可能有其他应用正在使用相机，请关闭后重试。`
    };
  }

  return {
    ...base,
    issueType: "未知相机打开失败",
    message: `无法打开${cameraLabel}。请确认浏览器相机权限和 HTTPS 访问，或关闭悬浮窗后重试。`
  };
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

function dynamicReminderCooldownMs(
  reminderType: ReminderType,
  records: StudyRecord[]
) {
  const recentRecords = records.slice(-10);
  const studyingCount = recentRecords.filter(
    (record) =>
      (record.presence ?? legacyPresenceFromStatus(record.status)) === "present" &&
      (record.learning_state ?? legacyLearningStateFromStatus(record.status)) === "studying"
  ).length;
  const relevantAbnormalCount = recentRecords.filter(
    (record) => reminderTypeForRecord(record) === reminderType
  ).length;
  let latestReminderIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.triggered_reminder && record.reminder_type === reminderType) {
      latestReminderIndex = index;
      break;
    }
  }
  const recoveredAfterReminder =
    latestReminderIndex >= 0 &&
    records.slice(latestReminderIndex + 1).some(
      (record) =>
        (record.presence ?? legacyPresenceFromStatus(record.status)) === "present" &&
        (record.learning_state ?? legacyLearningStateFromStatus(record.status)) === "studying"
    );

  if (recoveredAfterReminder || (recentRecords.length >= 8 && studyingCount >= 8)) {
    return stableReminderCooldownMs;
  }
  if (reminderType === "away" && relevantAbnormalCount >= 2) {
    return awayMinimumCooldownMs;
  }
  if (reminderType === "uncertain" && relevantAbnormalCount >= 3) {
    return uncertainMinimumCooldownMs;
  }
  return normalReminderCooldownMs;
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
  return "在位 · 无法判断";
}

function friendlyRecordDetail(record: StudyRecord) {
  const currentPresence = record.presence ?? legacyPresenceFromStatus(record.status);
  const currentLearningState = record.learning_state ?? legacyLearningStateFromStatus(record.status);
  if (record.manual_corrected) return "已按用户标记更新本次状态。";
  if (currentPresence === "away") return "当前画面中没有看到孩子，系统会继续观察。";
  if (currentLearningState === "studying") return "当前看到了较明确的学习动作。";
  return "已看到孩子，暂未看清明确学习动作，系统会继续观察。";
}

function legacyPresenceFromStatus(status: StudyStatus): Presence {
  return status === "away" ? "away" : "present";
}

function legacyLearningStateFromStatus(status: StudyStatus): LearningState {
  if (status === "studying") return "studying";
  return "uncertain";
}

function manualCorrectionReasonFromStatus(status: StudyStatus) {
  if (status === "studying") return "用户手动标记：当前正在学习。";
  if (status === "away") return "用户手动标记：当前已离座。";
  if (status === "unknown") return "用户手动标记：当前在位，但学习状态无法判断。";
  return "用户手动标记：当前在位，但未确认学习行为。";
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
