import { getTodayKey } from "@/lib/plans";
import { calculateStats, estimateCost } from "@/lib/stats";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { LearningState, ReportLevel, StudyRecord, StudySession, StudyStatus } from "@/types";

export const heartbeatIntervalSeconds = 60;
export const sessionTimeoutSeconds = 180;

type SettlementStatus = "completed" | "expired";

type SettlementResult =
  | {
      ok: true;
      skipped: boolean;
      stats?: ReturnType<typeof calculateStats>;
      aiCallCount?: number;
      estimatedCost?: number;
    }
  | { ok: false; error: string };

function legacyLearningStateFromStatus(status: StudyStatus): LearningState {
  if (status === "studying") return "studying";
  if (status === "distracted" || status === "unrelated") return "suspected_distracted";
  return "unknown";
}

function minutesBetween(startTime: string, endTime: string) {
  return Math.max(
    1,
    Math.ceil((new Date(endTime).getTime() - new Date(startTime).getTime()) / 60_000)
  );
}

async function loadSessionRecords(sessionId: string) {
  const { data, error } = await supabaseAdmin!
    .from("records")
    .select("*")
    .eq("session_id", sessionId)
    .order("timestamp", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as StudyRecord[];
}

async function countAiCalls(sessionId: string) {
  const { count, error } = await supabaseAdmin!
    .from("ai_call_logs")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);

  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function syncSessionRecords(sessionId: string, records: StudyRecord[]) {
  const unsavedRecords = records.filter((record) => !record.id);
  const savedRecords = records.filter((record) => record.id);

  if (savedRecords.length > 0) {
    await Promise.all(
      savedRecords.map((record) =>
        supabaseAdmin!
          .from("records")
          .update({
            presence: record.presence ?? (record.status === "away" ? "away" : "present"),
            learning_state: record.learning_state ?? legacyLearningStateFromStatus(record.status),
            current_frequency_seconds: record.current_frequency_seconds ?? null,
            frequency_boosted_by_abnormal: record.frequency_boosted_by_abnormal ?? false,
            frequency_lowered_by_focus: record.frequency_lowered_by_focus ?? false,
            triggered_reminder: record.triggered_reminder ?? false,
            reminder_type: record.reminder_type ?? null,
            reminder_text: record.reminder_text ?? null,
            error_message: record.error_message ?? null,
            manual_corrected: record.manual_corrected ?? false,
            correction_source: record.correction_source ?? null,
            corrected_at: record.corrected_at ?? null
          })
          .eq("id", record.id)
          .eq("session_id", sessionId)
      )
    );
  }

  if (unsavedRecords.length === 0) return;

  const { error } = await supabaseAdmin!.from("records").insert(
    unsavedRecords.map((record) => ({
      session_id: sessionId,
      status: record.status,
      presence: record.presence ?? (record.status === "away" ? "away" : "present"),
      learning_state: record.learning_state ?? legacyLearningStateFromStatus(record.status),
      timestamp: record.timestamp,
      confidence: record.confidence ?? null,
      reason: record.reason ?? null,
      analyze_mode: record.analyze_mode ?? "mock",
      current_frequency_seconds: record.current_frequency_seconds ?? null,
      frequency_boosted_by_abnormal: record.frequency_boosted_by_abnormal ?? false,
      frequency_lowered_by_focus: record.frequency_lowered_by_focus ?? false,
      triggered_reminder: record.triggered_reminder ?? false,
      reminder_type: record.reminder_type ?? null,
      reminder_text: record.reminder_text ?? null,
      ai_called: record.ai_called ?? true,
      error_message: record.error_message ?? null,
      manual_corrected: record.manual_corrected ?? false,
      correction_source: record.correction_source ?? null,
      corrected_at: record.corrected_at ?? null
    }))
  );

  if (error) throw new Error(error.message);
}

export async function settleSession(params: {
  sessionId: string;
  accessCodeId?: string;
  endTime?: string;
  durationMinutes?: number;
  records?: StudyRecord[];
  aiCallCount?: number;
  reportLevel?: ReportLevel;
  status: SettlementStatus;
}): Promise<SettlementResult> {
  if (!supabaseAdmin) return { ok: false, error: "Supabase环境变量未配置" };

  try {
    const { data: session, error: sessionLoadError } = await supabaseAdmin
      .from("sessions")
      .select("*")
      .eq("id", params.sessionId)
      .maybeSingle();

    if (sessionLoadError) return { ok: false, error: sessionLoadError.message };
    if (!session) return { ok: false, error: "Session不存在" };
    if (params.accessCodeId && session.access_code_id !== params.accessCodeId) {
      return { ok: false, error: "Session与访问码不匹配" };
    }
    if (session.status !== "active" || session.end_time) {
      return { ok: true, skipped: true };
    }

    const endTime =
      params.endTime ??
      session.last_active_at ??
      session.start_time ??
      new Date().toISOString();
    const durationMinutes =
      params.durationMinutes ?? minutesBetween(session.start_time, endTime);
    const records =
      params.records === undefined ? await loadSessionRecords(params.sessionId) : params.records;
    const stats = calculateStats(records, durationMinutes);
    const reportLevel = params.reportLevel ?? session.report_level ?? "basic";
    const aiCallCount = params.aiCallCount ?? (await countAiCalls(params.sessionId));
    const estimatedCost = estimateCost(aiCallCount, reportLevel);

    if (params.records !== undefined) {
      await syncSessionRecords(params.sessionId, records);
    }

    const { data: settledSession, error: sessionUpdateError } = await supabaseAdmin
      .from("sessions")
      .update({
        end_time: endTime,
        duration_minutes: stats.totalMinutes,
        focus_rate: stats.focusRate,
        ai_call_count: aiCallCount,
        estimated_cost: estimatedCost,
        report_level: reportLevel,
        session_token: null,
        status: params.status,
        last_active_at: endTime
      })
      .eq("id", params.sessionId)
      .eq("status", "active")
      .is("end_time", null)
      .select("id")
      .maybeSingle();

    if (sessionUpdateError) return { ok: false, error: sessionUpdateError.message };
    if (!settledSession) return { ok: true, skipped: true };

    const { data: accessCode, error: codeError } = await supabaseAdmin
      .from("access_codes")
      .select("used_minutes, used_minutes_today, last_reset_date")
      .eq("id", session.access_code_id)
      .single();

    if (codeError) return { ok: false, error: codeError.message };

    const today = getTodayKey();
    const usedToday =
      accessCode.last_reset_date === today ? accessCode.used_minutes_today : 0;

    const { error: updateError } = await supabaseAdmin
      .from("access_codes")
      .update({
        used_minutes: accessCode.used_minutes + stats.totalMinutes,
        used_minutes_today: usedToday + stats.totalMinutes,
        last_reset_date: today
      })
      .eq("id", session.access_code_id);

    if (updateError) return { ok: false, error: updateError.message };

    return { ok: true, skipped: false, stats, aiCallCount, estimatedCost };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Session结算失败"
    };
  }
}

export function isSessionTimedOut(session: Pick<StudySession, "start_time" | "last_active_at">) {
  const lastActive = new Date(session.last_active_at ?? session.start_time).getTime();
  return Date.now() - lastActive > sessionTimeoutSeconds * 1000;
}

export async function settleExpiredSessionsForAccessCode(accessCodeId: string) {
  if (!supabaseAdmin) return { settled: 0 };

  const { data } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("access_code_id", accessCodeId)
    .eq("status", "active")
    .is("end_time", null);

  const expiredSessions = (data ?? []).filter(isSessionTimedOut);
  let settled = 0;
  for (const session of expiredSessions) {
    const result = await settleSession({
      sessionId: session.id,
      accessCodeId,
      endTime: session.last_active_at ?? session.start_time,
      status: "expired"
    });
    if (result.ok && !result.skipped) settled += 1;
  }
  return { settled };
}

export async function settleExpiredSessions() {
  if (!supabaseAdmin) return { settled: 0 };

  const { data } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("status", "active")
    .is("end_time", null);

  const expiredSessions = (data ?? []).filter(isSessionTimedOut);
  let settled = 0;
  for (const session of expiredSessions) {
    const result = await settleSession({
      sessionId: session.id,
      accessCodeId: session.access_code_id,
      endTime: session.last_active_at ?? session.start_time,
      status: "expired"
    });
    if (result.ok && !result.skipped) settled += 1;
  }
  return { settled };
}
