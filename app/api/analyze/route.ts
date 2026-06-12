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

const qwenPrompt = `你是一名儿童学习状态观察助手。
请根据图片判断孩子当前学习状态。

只判断可见行为，不做人脸识别，不判断身份，不判断情绪。

请优先判断以下问题：

1. 画面中是否有人坐在学习位置？
2. 是否明显离开座位？
3. 是否在看书、写字、看作业、看屏幕学习？
4. 是否存在明显分心行为，例如东张西望、玩玩具、玩手机、摆弄无关物品？
5. 是否趴桌或明显疲劳？

只能返回以下状态之一：
studying：正在学习或保持学习状态
distracted：疑似走神或注意力偏离
away：离开座位或画面中无人
lying：趴桌或明显疲劳
unrelated：玩无关物品、玩手机、明显非学习行为
unknown：画面不清晰或无法判断

返回 JSON：
{
"status": "studying",
"confidence": 0.82,
"reason": "孩子坐在书桌前，视线朝向桌面，未发现明显分心行为"
}

要求：
- 不要返回多余文本
- 不要做身份识别
- 不要描述脸部特征
- 不要判断孩子情绪`;

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

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
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
    })
  });

  if (!response.ok) {
    throw new Error(`Qwen-VL调用失败：${response.status}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  return {
    status: parsed.status as StudyStatus,
    confidence: Number(parsed.confidence ?? 0.5),
    reason: String(parsed.reason ?? "Qwen-VL返回结果。")
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
        analyze_mode: output.analyzeMode,
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
