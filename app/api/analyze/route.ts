import { NextRequest, NextResponse } from "next/server";
import { costConfig } from "@/lib/costs";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  checkRateLimit,
  logAiCall,
  logError,
  validateSessionRequest
} from "@/lib/security";
import type { LearningState, Presence, StudyStatus } from "@/types";

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

const validPresence: Presence[] = ["present", "away"];
const validLearningStates: LearningState[] = [
  "studying",
  "thinking",
  "suspected_distracted",
  "unknown"
];

const awayCorrectionTerms = [
  "人物",
  "上半身",
  "面部",
  "坐在",
  "镜头前",
  "画面中有人"
];

const qwenPrompt = `你是儿童学习监督助手。

你的任务不是寻找走神证据，而是优先判断：

1. 人是否仍在学习位置
2. 是否存在明确学习行为
3. 是否只是思考状态
4. 是否真的出现持续分心

仅判断当前可见行为。

不要识别人脸。
不要判断身份。
不要判断年龄。
不要判断情绪。

判断原则：
检测到人物时，禁止返回 away。
看到人脸或上半身时，presence=present。
手托头、停笔思考、凝视桌面，优先 thinking。
单次看向镜头，不能判定为走神。
单次抬头，不能判定为走神。
缺少桌面、双手、作业本等关键信息，优先 unknown。
宁可 unknown，不要把在位学生错误判定为离座或走神。

第一层 presence 只能返回：
present：检测到人脸、上半身、头肩区域，或人物仍在学习位置附近
away：画面无人、座位空了、人物明显离开学习区域

第二层 learning_state 只能返回：
studying：看到写字、阅读、书桌、作业本、书本、键盘输入、学习工具
thinking：人在位置，手托头、停笔思考、凝视桌面、短暂发呆、数学题思考、阅读理解思考
suspected_distracted：持续东张西望、持续看镜头、持续玩无关物品、持续偏离学习区域
unknown：画面过近、仅有人脸、看不到桌面、看不到双手、看不到学习区域、光线差、遮挡严重

如果 presence=away，learning_state 必须为 unknown。

JSON格式：
{
  "presence": "present",
  "learning_state": "thinking",
  "confidence": 0.85,
  "reason": "人物仍在座位上，手托头，未见玩手机或离座行为，可能处于思考状态。"
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
      presence: "present" as Presence,
      learning_state: "studying" as LearningState,
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
    presence: nextStatus === "away" ? "away" as Presence : "present" as Presence,
    learning_state: legacyLearningStateFromStatus(nextStatus),
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

  let presence: Presence = validPresence.includes(parsed.presence) ? parsed.presence : "present";
  let learningState: LearningState = validLearningStates.includes(parsed.learning_state)
    ? parsed.learning_state
    : legacyLearningStateFromStatus(parsed.status);
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5)));
  let reason = String(parsed.reason ?? "Qwen-VL返回结果。").slice(0, 160);

  if (presence === "away" && awayCorrectionTerms.some((term) => reason.includes(term))) {
    presence = "present";
    learningState = "unknown";
    reason = `${reason} 系统修正：画面中有人，不能判定为离座。`;
  }

  if (presence === "away") {
    learningState = "unknown";
  }

  return {
    status: legacyStatusFromState(presence, learningState),
    presence,
    learning_state: learningState,
    confidence,
    reason
  };
}

function legacyLearningStateFromStatus(status: unknown): LearningState {
  if (status === "studying") return "studying";
  if (status === "distracted" || status === "unrelated") return "suspected_distracted";
  return "unknown";
}

function legacyStatusFromState(presence: Presence, learningState: LearningState): StudyStatus {
  if (presence === "away") return "away";
  if (learningState === "studying" || learningState === "thinking") return "studying";
  if (learningState === "suspected_distracted") return "distracted";
  return "unknown";
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
    presence: analyzed.presence,
    learning_state: analyzed.learning_state,
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
        presence: output.presence,
        learning_state: output.learning_state,
        timestamp: new Date().toISOString(),
        confidence: output.confidence,
        reason: output.reason,
        analyze_mode: output.analyze_mode,
        current_frequency_seconds: Number(body.currentFrequencySeconds ?? 0) || null,
        frequency_boosted_by_abnormal: Boolean(body.frequencyBoostedByAbnormal),
        frequency_lowered_by_focus: Boolean(body.frequencyLoweredByFocus),
        reminder_type: null,
        reminder_text: null,
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
