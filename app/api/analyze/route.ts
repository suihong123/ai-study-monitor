import { NextRequest, NextResponse } from "next/server";
import { costConfig } from "@/lib/costs";
import {
  checkRateLimit,
  logAiCall,
  logError,
  validateSessionRequest
} from "@/lib/security";
import type { StudyStatus } from "@/types";

const statuses: StudyStatus[] = [
  "studying",
  "distracted",
  "away",
  "lying",
  "unrelated",
  "unknown"
];

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const body = await request.json();
  const auth = await validateSessionRequest(request, body);
  if (!auth.ok) return auth.response;

  const limited = await checkRateLimit({
    request,
    kind: "analyze",
    accessCodeId: auth.context.accessCode.id
  });
  if (!limited.ok) {
    return NextResponse.json({ error: "AI识别调用过于频繁" }, { status: 429 });
  }

  const status = statuses[Math.floor(Math.random() * statuses.length)];
  const output = {
    status,
    confidence: Number((0.72 + Math.random() * 0.22).toFixed(2)),
    provider: "mock"
  };

  try {
    await logAiCall({
      sessionId: auth.context.session.id,
      accessCodeId: auth.context.accessCode.id,
      modelType: "vision_mock",
      status: "success",
      inputSize: typeof body.image === "string" ? body.image.length : 0,
      outputSize: JSON.stringify(output).length,
      estimatedCost: costConfig.visionAnalyzeCost,
      latencyMs: Date.now() - startedAt
    });
  } catch (error) {
    await logError({
      sessionId: auth.context.session.id,
      accessCodeId: auth.context.accessCode.id,
      errorType: "analyze接口失败",
      errorMessage: error instanceof Error ? error.message : "AI调用日志写入失败"
    });
  }

  return NextResponse.json(output);
}
