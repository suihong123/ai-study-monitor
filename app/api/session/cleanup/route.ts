import { NextResponse } from "next/server";
import { settleExpiredSessions } from "@/lib/session-settlement";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await settleExpiredSessions();
  return NextResponse.json(result);
}

export async function POST() {
  const result = await settleExpiredSessions();
  return NextResponse.json(result);
}
