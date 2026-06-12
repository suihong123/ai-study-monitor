import { NextRequest, NextResponse } from "next/server";
import { costConfig } from "@/lib/costs";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  checkRateLimit,
  logAiCall,
  logError,
  validateSessionRequest
} from "@/lib/security";
import type { StudyStatus } from "@/types";

const statusWeights: Array<{ status: StudyStatus; weight: number; reason: string }> = [
  { status: "studying", weight: 70, reason: "模拟结果：孩子保持学习状态。" },
  { status: "distracted", weight: 15, reason: "模拟结果：疑似注意力偏离。" },
  { status: "unknown", weight: 5, reason: "模拟结果：画面信息不足，无法稳定判断。" },
  { status: "away", weight: 5, reason: "模拟结果：疑似离开座位。" },
  { status: "unrelated", weight: 3, reason: "模拟结果：疑似接触无关物品。" },
  { status: "lying", weight: 2, reason: "模拟结果：疑似趴桌或疲劳。" }
];

const recentStatuses = new Map<string, StudyStatus[]>();

const validStatuses: StudyStatus[] = [
  "studying",
  "distracted",
  "away",
  "lying",
  "unrelated",
  "unknown"
];

const qwenPrompt = `你是一名儿童学习监督助手。

请根据图片判断当前学习状态。

仅判断当前可见行为。

不要识别人脸。
不要判断身份。
不要判断年龄。
不要判断情绪。

请判断：

1. 是否有人在学习位置
2. 是否离开座位
3. 是否在看书、写字、阅读、学习
4. 是否存在明显走神行为
5. 是否在玩手机
6. 是否在玩与学习无关的物品
7. 是否趴桌

只返回：

studying
distracted
away
lying
unrelated
unknown

同时返回：

confidence

0~1

同时返回：

reason

简短说明。

JSON格式：
{
"status": "studying",
"confidence": 0.92,
"reason": "孩子位于书桌前，视线朝向桌面。"
}

不要返回其它内容。`;

function pickMockStatus(sessionId: string) {
  const previous = recentStatuses.get(sessionId) ?? [];
  const lastTwo = previous.slice(-2);
  const unstable = ["away", "unrelated", "lying"];
  const repeatedHardStatus =
    lastTwo.length === 2 && lastTwo.every((status) => status === lastTwo[0]) && unstable.includes(lastTwo[0]);

  if (repeatedHardStatus) {
    return {
      status: "studying" as StudyStatus,
      confidence: 0.86,
      reason: "模拟结果：连续异常后恢复为学习状态。"
    };
  }

  const total = statusWeights.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * total;
  const selected =
    statusWeights.find((item) => {
      random -= item.weight;
      return random <= 0;
    }) ?? statusWeights[0];

  const nextStatus = selected.status;
  recentStatuses.set(sessionId, [...previous.slice(-4), nextStatus]);

  return {
    status: nextStatus,
    confidence: Number((0.78 + Math.random() * 0.16).toFixed(2)),
    reason: selected.reason
  };
}

async function analyzeWithQwen(image: string) {
  const apiKey = process.env.QWEN_API_KEY;
  const apiUrl = process.env.QWEN_API_URL;
  const model = process.env.QWEN_MODEL;

  if (!apiKey || !apiUrl || !model) {
    throw new Error("Qwen-VL环境变量未完整配置，已回退Mock");
  }

  const requestBody = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: qwenPrompt },
          { type: "image_url", image_url: { url: image } }
        ]
      }
    ],
    response_format: { type: "json_object" }
  };

  console.info("[Qwen-VL] request", {
    url: apiUrl,
    model,
    body: {
      ...requestBody,
      messages: requestBody.messages.map((message) => ({
        ...message,
        content: message.content.map((item) =>
          item.type === "image_url"
            ? {
                type: "image_url",
                image_url: {
                  url: `[base64 image omitted, length=${image.length}]`
                }
              }
            : item
        )
      }))
    }
  });

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  const responseBody = await response.text();
  console.info("[Qwen-VL] response", {
    url: apiUrl,
    model,
    status: response.status,
    ok: response.ok,
    body: responseBody
  });

  if (!response.ok) {
    throw new Error(`Qwen-VL调用失败：${response.status}`);
  }

  const result = JSON.parse(responseBody);
  const content = result.choices?.[0]?.message?.content;
  const parsed = typeof content === "string" ? JSON.parse(content) : content;

  const status = validStatuses.includes(parsed.status) ? parsed.status : "unknown";
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5)));
  const reason = String(parsed.reason ?? "Qwen-VL返回结果。").slice(0, 160);

  return {
    status,
    confidence,
    reason
  };
}

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

  const requestedMode = process.env.ANALYZE_MODE === "qwen" ? "qwen" : "mock";
  let analyzeMode = requestedMode;
  let analyzed;

  try {
    analyzed =
      requestedMode === "qwen"
        ? await analyzeWithQwen(body.image)
        : pickMockStatus(auth.context.session.id);
  } catch (error) {
    analyzeMode = "mock";
    await logError({
      sessionId: auth.context.session.id,
      accessCodeId: auth.context.accessCode.id,
      errorType: "analyze接口失败",
      errorMessage: error instanceof Error ? error.message : "Qwen-VL调用失败"
    });
    analyzed = pickMockStatus(auth.context.session.id);
  }

  const output = {
    status: analyzed.status,
    confidence: analyzed.confidence,
    reason: analyzed.reason,
    analyzeMode,
    analyze_mode: analyzeMode,
    provider: analyzeMode === "qwen" ? "qwen-vl" : "mock"
  };

  let recordId: string | null = null;
  if (supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from("records")
      .insert({
        session_id: auth.context.session.id,
        status: output.status,
        timestamp: new Date().toISOString(),
        confidence: output.confidence,
        reason: output.reason,
        analyze_mode: output.analyze_mode,
        current_frequency_seconds: Number(body.currentFrequencySeconds ?? 0) || null,
        frequency_boosted_by_abnormal: Boolean(body.frequencyBoostedByAbnormal),
        frequency_lowered_by_focus: Boolean(body.frequencyLoweredByFocus),
        ai_called: true
      })
      .select("id")
      .single();
    recordId = data?.id ?? null;
  }

  try {
    await logAiCall({
      sessionId: auth.context.session.id,
      accessCodeId: auth.context.accessCode.id,
      modelType: analyzeMode === "qwen" ? "vision_qwen" : "vision_mock",
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

  return NextResponse.json({ ...output, recordId });
}
