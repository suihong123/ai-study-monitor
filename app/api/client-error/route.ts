import { NextRequest, NextResponse } from "next/server";
import { logError, validateSessionRequest } from "@/lib/security";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const auth = await validateSessionRequest(request, body);
  if (!auth.ok) return auth.response;

  await logError({
    sessionId: auth.context.session.id,
    accessCodeId: auth.context.accessCode.id,
    errorType: body.errorType ?? "前端错误",
    errorMessage: body.errorMessage ?? "未知前端错误",
    stack: body.stack ?? null
  });

  return NextResponse.json({ ok: true });
}
