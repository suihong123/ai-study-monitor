import { NextRequest, NextResponse } from "next/server";
import { settleExpiredSessionsForAccessCode } from "@/lib/session-settlement";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logError, validateSessionRequest } from "@/lib/security";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const auth = await validateSessionRequest(request, body);
  if (!auth.ok) return auth.response;

  await settleExpiredSessionsForAccessCode(auth.context.accessCode.id);

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin!
    .from("sessions")
    .update({ last_active_at: now })
    .eq("id", auth.context.session.id)
    .eq("status", "active")
    .is("end_time", null)
    .select("id")
    .maybeSingle();

  if (error) {
    await logError({
      sessionId: auth.context.session.id,
      accessCodeId: auth.context.accessCode.id,
      errorType: "session心跳失败",
      errorMessage: error.message
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "会话已结束，请重新开始监督" }, { status: 409 });
  }

  return NextResponse.json({ ok: true, lastActiveAt: now });
}
