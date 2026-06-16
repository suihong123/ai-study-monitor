import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { validateSessionRequest } from "@/lib/security";
import type { LearningState, Presence, StudyStatus } from "@/types";

const validStatuses: StudyStatus[] = [
  "studying",
  "distracted",
  "away",
  "lying",
  "unrelated",
  "unknown"
];

function presenceFromStatus(status: StudyStatus): Presence {
  return status === "away" ? "away" : "present";
}

function learningStateFromStatus(status: StudyStatus): LearningState {
  if (status === "studying") return "studying";
  return "uncertain";
}

function correctionReasonFromStatus(status: StudyStatus) {
  if (status === "studying") return "用户手动标记：当前正在学习。";
  if (status === "away") return "用户手动标记：当前已离座。";
  if (status === "unknown") return "用户手动标记：当前在位，但学习状态证据不足。";
  return "用户手动标记：当前在位，但未确认学习行为。";
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const auth = await validateSessionRequest(request, body);
  if (!auth.ok) return auth.response;

  if (!body.recordId || !validStatuses.includes(body.status)) {
    return NextResponse.json({ error: "纠错参数无效" }, { status: 400 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase环境变量未配置" }, { status: 500 });
  }

  const { data: record, error: readError } = await supabaseAdmin
    .from("records")
    .select("id, session_id")
    .eq("id", body.recordId)
    .maybeSingle();

  if (readError || !record || record.session_id !== auth.context.session.id) {
    return NextResponse.json({ error: "记录不属于当前会话" }, { status: 403 });
  }

  const { data, error } = await supabaseAdmin
    .from("records")
    .update({
      status: body.status,
      presence: presenceFromStatus(body.status),
      learning_state: learningStateFromStatus(body.status),
      reason: correctionReasonFromStatus(body.status),
      manual_corrected: true,
      correction_source: "user",
      corrected_at: new Date().toISOString()
    })
    .eq("id", body.recordId)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ record: data });
}
