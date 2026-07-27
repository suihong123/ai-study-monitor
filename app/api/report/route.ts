import { NextRequest, NextResponse } from "next/server";
import { estimateReportCost } from "@/lib/costs";
import { checkRateLimit, logAiCall, logError } from "@/lib/security";
import { calculateStats, normalizeRecordState } from "@/lib/stats";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { HabitTrend, HabitTrendSession, ReportLevel, ReportPayload, StudyRecord } from "@/types";

function buildBasicConclusion(stats: ReturnType<typeof calculateStats>) {
  if (stats.focusRate >= 80) return "本次明确学习行为占比较高，学习过程整体稳定。";
  if (stats.focusRate >= 60) return "本次学习有一定明确学习行为，也存在部分证据不足记录。";
  if (stats.focusRate >= 40) return "本次明确学习行为占比偏低，建议缩短单次学习时间并优化拍摄角度。";
  return "本次离座或证据不足较多，建议家长关注学习环境、拍摄角度和任务难度。";
}

function buildParentAdvice(stats: ReturnType<typeof calculateStats>) {
  const advice: string[] = [];
  if (stats.awayCount >= 2) {
    advice.push("本次离座识别记录较多，建议家长关注学习前是否准备充分，例如水杯、文具、作业材料。");
  }
  if (stats.uncertainCount >= 3) {
    advice.push("本次证据不足记录较多，建议调整手机角度，确保能看到孩子上半身、双手和作业区域。");
  }
  const unknownRate =
    stats.studyingCount +
      stats.awayCount +
      stats.uncertainCount ===
    0
      ? 0
      : stats.uncertainCount /
        (stats.studyingCount +
          stats.awayCount +
          stats.uncertainCount);
  if (unknownRate > 0.2) {
    advice.push("建议调整手机角度，确保画面能看到孩子上半身、桌面和双手。");
  }
  if (stats.focusRate >= 80) {
    advice.push("建议保持当前的学习节奏和桌面环境。");
  }
  if (stats.reminderCount >= 2 && (stats.reminderResponseRate ?? 0) < 50) {
    advice.push("本次提醒后恢复学习的比例偏低，建议检查任务是否过难，或学习环境是否存在持续干扰。");
  }
  if (advice.length === 0) {
    advice.push("建议保持当前学习安排，结束后用简短复盘帮助孩子确认完成情况。");
  }
  return advice.join("\n");
}

function focusSegmentsFromRecords(records: StudyRecord[]) {
  const sorted = [...records].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const segments: number[] = [];
  let currentSeconds = 0;

  sorted.forEach((record, index) => {
    const timestamp = new Date(record.timestamp).getTime();
    const nextTimestamp =
      index < sorted.length - 1 ? new Date(sorted[index + 1].timestamp).getTime() : NaN;
    const expectedInterval = Math.min(
      300,
      Math.max(15, Number(record.current_frequency_seconds ?? 60))
    );
    const rawSeconds =
      Number.isFinite(timestamp) && Number.isFinite(nextTimestamp)
        ? (nextTimestamp - timestamp) / 1000
        : expectedInterval;
    const seconds = Math.max(
      0,
      Math.min(Number.isFinite(rawSeconds) ? rawSeconds : expectedInterval, Math.max(60, expectedInterval * 1.5))
    );
    const state = normalizeRecordState(record);

    if (state.presence === "present" && state.learningState === "studying") {
      currentSeconds += seconds;
      return;
    }

    if (currentSeconds > 0) {
      segments.push(currentSeconds);
      currentSeconds = 0;
    }
  });

  if (currentSeconds > 0) {
    segments.push(currentSeconds);
  }

  return segments.map((seconds) => Number((seconds / 60).toFixed(1)));
}

function countInterruptions(records: StudyRecord[]) {
  let count = 0;
  let previousWasInterrupted = false;

  records.forEach((record) => {
    const state = normalizeRecordState(record);
    const interrupted = !(state.presence === "present" && state.learningState === "studying");
    if (interrupted && !previousWasInterrupted) {
      count += 1;
    }
    previousWasInterrupted = interrupted;
  });

  return count;
}

function buildHabitTrendSession(params: {
  sessionId: string;
  startTime: string;
  durationMinutes: number | null;
  records: StudyRecord[];
}): HabitTrendSession {
  const stats = calculateStats(params.records, params.durationMinutes ?? undefined);
  const segments = focusSegmentsFromRecords(params.records);
  const averageFocusMinutes =
    segments.length === 0
      ? 0
      : Number((segments.reduce((sum, minutes) => sum + minutes, 0) / segments.length).toFixed(1));

  return {
    sessionId: params.sessionId,
    startTime: params.startTime,
    durationMinutes: stats.totalMinutes,
    averageFocusMinutes,
    longestFocusMinutes: stats.longestFocusMinutes,
    interruptionCount: countInterruptions(params.records),
    reminderCount: stats.reminderCount,
    reminderResponseRate: stats.reminderResponseRate,
    dataCoverageRate: stats.dataCoverageRate
  };
}

function average(values: number[]) {
  const validValues = values.filter((value) => Number.isFinite(value));
  if (validValues.length === 0) return 0;
  return Number((validValues.reduce((sum, value) => sum + value, 0) / validValues.length).toFixed(1));
}

function buildHabitTrendSummary(params: {
  sampleCount: number;
  requiredSampleCount: number;
  direction: HabitTrend["direction"];
  currentAverageFocusMinutes: number;
  previousAverageFocusMinutes: number | null;
  averageReminderResponseRate: number;
}) {
  if (params.sampleCount < params.requiredSampleCount) {
    return `趋势分析需要至少 ${params.requiredSampleCount} 次有效监督记录。当前已有 ${params.sampleCount} 次，继续积累后可观察平均连续学习时间是否提升、提醒后恢复是否变快。`;
  }

  if (params.direction === "improving") {
    return `最近几次平均连续学习时间从 ${params.previousAverageFocusMinutes ?? 0} 分钟提升到 ${params.currentAverageFocusMinutes} 分钟，习惯培养有改善迹象。`;
  }

  if (params.direction === "declining") {
    return `最近几次平均连续学习时间从 ${params.previousAverageFocusMinutes ?? 0} 分钟下降到 ${params.currentAverageFocusMinutes} 分钟，建议关注任务难度、学习环境和监督节奏。`;
  }

  return `最近几次平均连续学习时间基本稳定，提醒后恢复率约 ${params.averageReminderResponseRate}%。建议继续观察是否能逐步延长连续学习时间。`;
}

function buildHabitTrend(sessions: HabitTrendSession[]): HabitTrend {
  const requiredSampleCount = 3;
  const chronological = [...sessions].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );
  const latest = chronological[chronological.length - 1];
  const recent = chronological.slice(-3);
  const previous = chronological.slice(-6, -3);
  const currentAverageFocusMinutes = average(recent.map((item) => item.averageFocusMinutes));
  const previousAverageFocusMinutes =
    previous.length > 0 ? average(previous.map((item) => item.averageFocusMinutes)) : null;
  const averageReminderResponseRate = average(
    recent.map((item) => item.reminderResponseRate)
  );

  let direction: HabitTrend["direction"] = "insufficient";
  if (chronological.length >= requiredSampleCount) {
    if (previousAverageFocusMinutes === null) {
      const first = chronological[0]?.averageFocusMinutes ?? 0;
      const last = latest?.averageFocusMinutes ?? 0;
      direction = last >= first + 2 ? "improving" : last <= first - 2 ? "declining" : "stable";
    } else {
      direction =
        currentAverageFocusMinutes >= previousAverageFocusMinutes + 2
          ? "improving"
          : currentAverageFocusMinutes <= previousAverageFocusMinutes - 2
          ? "declining"
          : "stable";
    }
  }

  return {
    sampleCount: chronological.length,
    requiredSampleCount,
    isEnoughData: chronological.length >= requiredSampleCount,
    direction,
    summary: buildHabitTrendSummary({
      sampleCount: chronological.length,
      requiredSampleCount,
      direction,
      currentAverageFocusMinutes,
      previousAverageFocusMinutes,
      averageReminderResponseRate
    }),
    currentAverageFocusMinutes,
    previousAverageFocusMinutes,
    currentLongestFocusMinutes: latest?.longestFocusMinutes ?? 0,
    averageReminderResponseRate,
    sessions: chronological.slice(-7)
  };
}

async function loadHabitTrend(accessCodeId: string): Promise<HabitTrend | null> {
  if (!supabaseAdmin) return null;

  const { data: sessions, error: sessionsError } = await supabaseAdmin
    .from("sessions")
    .select("id, start_time, duration_minutes")
    .eq("access_code_id", accessCodeId)
    .in("status", ["completed", "expired"])
    .order("end_time", { ascending: false })
    .limit(7);

  if (sessionsError || !sessions || sessions.length === 0) {
    return null;
  }

  const sessionIds = sessions.map((item) => item.id);
  const { data: records, error: recordsError } = await supabaseAdmin
    .from("records")
    .select("*")
    .in("session_id", sessionIds)
    .order("timestamp", { ascending: true });

  if (recordsError) {
    return null;
  }

  const recordsBySession = ((records ?? []) as StudyRecord[]).reduce<Record<string, StudyRecord[]>>(
    (acc, record) => {
      if (!record.session_id) return acc;
      acc[record.session_id] ??= [];
      acc[record.session_id].push(record);
      return acc;
    },
    {}
  );

  const trendSessions = sessions
    .map((session) =>
      buildHabitTrendSession({
        sessionId: session.id,
        startTime: session.start_time,
        durationMinutes: session.duration_minutes,
        records: recordsBySession[session.id] ?? []
      })
    )
    .filter((item) => item.durationMinutes >= 3 && item.dataCoverageRate > 0);

  return buildHabitTrend(trendSessions);
}

async function generateReport(
  request: NextRequest,
  params: Partial<ReportPayload>,
  logGeneration: boolean
) {
  const startedAt = Date.now();
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase环境变量未配置" }, { status: 500 });
  }
  if (!params.sessionId || !params.reportToken) {
    return NextResponse.json({ error: "报告访问参数无效" }, { status: 400 });
  }

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("id", params.sessionId)
    .eq("report_token", params.reportToken)
    .maybeSingle();
  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }
  if (!session || !session.end_time || !["completed", "expired"].includes(session.status)) {
    return NextResponse.json({ error: "报告不存在或监督尚未结束" }, { status: 404 });
  }

  const [{ data: recordsData, error: recordsError }, { data: accessCode, error: codeError }] =
    await Promise.all([
      supabaseAdmin
        .from("records")
        .select("*")
        .eq("session_id", session.id)
        .order("timestamp", { ascending: true }),
      supabaseAdmin
        .from("access_codes")
        .select("id, report_level")
        .eq("id", session.access_code_id)
        .single()
    ]);
  if (recordsError || codeError) {
    return NextResponse.json(
      { error: recordsError?.message ?? codeError?.message ?? "报告数据读取失败" },
      { status: 500 }
    );
  }

  if (logGeneration) {
    const limited = await checkRateLimit({
      request,
      kind: "report",
      accessCodeId: accessCode.id
    });
    if (!limited.ok) {
      return NextResponse.json({ error: "报告生成过于频繁" }, { status: 429 });
    }
  }

  const records = (recordsData ?? []) as StudyRecord[];
  const stats = calculateStats(records, session.duration_minutes ?? undefined);
  const reportLevel: ReportLevel = "basic";
  const isMockMode = records.length === 0 || records.some((record) => (record.analyze_mode ?? "mock") === "mock");
  const insufficientData =
    stats.totalMinutes < 10 || records.length < 5 || stats.dataCoverageRate < 50;
  const conclusion = insufficientData
    ? "数据量或数据覆盖不足，当前不生成明确学习占比结论和学习诊断。"
    : isMockMode
    ? "当前为测试数据，本次报告仅用于验证监督流程。正式接入 AI 视觉识别后，将根据真实学习状态生成分析。"
    : buildBasicConclusion(stats);
  const parentAdvice = insufficientData
    ? "建议先完成一段不少于10分钟的监督，确认摄像头角度、识别记录和报告生成流程稳定后，再参考学习建议。"
    : isMockMode
    ? "当前为测试数据，建议先重点测试摄像头角度、监督流程和报告展示效果。"
    : buildParentAdvice(stats);
  const trend = null;
  const habitTrend = await loadHabitTrend(session.access_code_id);

  const summary = [
    records.length >= 5
      ? `本次监督${stats.totalMinutes}分钟，明确学习${stats.effectiveMinutes}分钟，明确学习占比${stats.focusRate}%。`
      : `本次监督${stats.totalMinutes}分钟，当前数据量不足。`,
    conclusion,
    parentAdvice
  ].join("\n");

  const output = {
    summary,
    conclusion,
    parentAdvice,
    trend,
    habitTrend,
    stats,
    records,
    reportLevel,
    provider: "template",
    session: {
      id: session.id,
      startTime: session.start_time,
      endTime: session.end_time,
      durationMinutes: session.duration_minutes,
      status: session.status
    }
  };

  if (logGeneration) {
    try {
      await logAiCall({
        sessionId: session.id,
        accessCodeId: session.access_code_id,
        modelType: `report_${reportLevel}`,
        status: "success",
        inputSize: JSON.stringify(records).length,
        outputSize: JSON.stringify(output).length,
        estimatedCost: estimateReportCost(reportLevel),
        latencyMs: Date.now() - startedAt
      });
    } catch (error) {
      await logError({
        sessionId: session.id,
        accessCodeId: session.access_code_id,
        errorType: "report接口失败",
        errorMessage: error instanceof Error ? error.message : "报告调用日志写入失败"
      });
    }
  }

  return NextResponse.json(output);
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Partial<ReportPayload>;
  return generateReport(request, body, true);
}

export async function GET(request: NextRequest) {
  return generateReport(
    request,
    {
      sessionId: request.nextUrl.searchParams.get("session_id") ?? undefined,
      reportToken: request.nextUrl.searchParams.get("token") ?? undefined
    },
    false
  );
}
