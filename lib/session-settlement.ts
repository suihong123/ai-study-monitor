import { calculateChargeableMinutes } from "@/lib/entitlements";
import { calculateStats, estimateCost } from "@/lib/stats";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { LearningState, StudyRecord, StudySession, StudyStatus } from "@/types";

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
  return "uncertain";
}

function manualCorrectionReasonFromStatus(status: StudyStatus) {
  if (status === "studying") return "用户手动标记：当前正在学习。";
  if (status === "away") return "用户手动标记：当前已离座。";
  if (status === "unknown") return "用户手动标记：当前在位，但学习状态无法判断。";
  return "用户手动标记：当前在位，但未确认学习行为。";
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
  const savedRecords = records.filter((record) => record.id);

  if (savedRecords.length > 0) {
    const results = await Promise.all(
      savedRecords.map((record) => {
        const updateValues: Record<string, unknown> = {
          current_frequency_seconds: record.current_frequency_seconds ?? null,
          frequency_boosted_by_abnormal: record.frequency_boosted_by_abnormal ?? false,
          frequency_lowered_by_focus: record.frequency_lowered_by_focus ?? false,
          triggered_reminder: record.triggered_reminder ?? false,
          reminder_type: record.reminder_type ?? null,
          reminder_text: record.reminder_text ?? null,
          error_message: record.error_message ?? null
        };

        if (record.manual_corrected) {
          updateValues.status = record.status;
          updateValues.presence = record.presence ?? (record.status === "away" ? "away" : "present");
          updateValues.learning_state =
            record.learning_state ?? legacyLearningStateFromStatus(record.status);
          updateValues.reason = record.reason ?? manualCorrectionReasonFromStatus(record.status);
          updateValues.manual_corrected = true;
          updateValues.correction_source = record.correction_source ?? "user";
          updateValues.corrected_at = record.corrected_at ?? new Date().toISOString();
        }

        return supabaseAdmin!
          .from("records")
          .update(updateValues)
          .eq("id", record.id)
          .eq("session_id", sessionId);
      })
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) throw new Error(failed.error.message);
  }
}

export async function settleSession(params: {
  sessionId: string;
  accessCodeId?: string;
  endTime?: string;
  records?: StudyRecord[];
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

    const now = new Date().toISOString();
    const endTime =
      params.status === "expired"
        ? params.endTime ?? session.last_active_at ?? session.start_time
        : now;

    if (params.records !== undefined) {
      await syncSessionRecords(params.sessionId, params.records);
    }

    const [{ data: accessCode, error: accessCodeError }, records, aiCallCount] =
      await Promise.all([
        supabaseAdmin
          .from("access_codes")
          .select("total_minutes, used_minutes")
          .eq("id", session.access_code_id)
          .single(),
        loadSessionRecords(params.sessionId),
        countAiCalls(params.sessionId)
      ]);

    if (accessCodeError || !accessCode) {
      return {
        ok: false,
        error: accessCodeError?.message ?? "访问码不存在"
      };
    }

    const durationMinutes = calculateChargeableMinutes(
      session.start_time,
      endTime,
      accessCode.total_minutes,
      accessCode.used_minutes
    );
    const stats = calculateStats(records, durationMinutes);
    const estimatedCost = estimateCost(aiCallCount, "basic");

    const { data: settlement, error: settlementError } = await supabaseAdmin.rpc(
      "settle_study_session",
      {
        p_session_id: params.sessionId,
        p_end_time: endTime,
        p_focus_rate: stats.focusRate,
        p_ai_call_count: aiCallCount,
        p_estimated_cost: estimatedCost,
        p_status: params.status
      }
    );

    if (settlementError) {
      return { ok: false, error: settlementError.message };
    }

    const settlementResult = settlement as {
      skipped?: boolean;
      durationMinutes?: number;
    } | null;
    if (settlementResult?.skipped) return { ok: true, skipped: true };

    const finalDurationMinutes = Number(
      settlementResult?.durationMinutes ?? durationMinutes
    );
    const finalStats =
      finalDurationMinutes === durationMinutes
        ? stats
        : calculateStats(records, finalDurationMinutes);

    return {
      ok: true,
      skipped: false,
      stats: finalStats,
      aiCallCount,
      estimatedCost
    };
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
