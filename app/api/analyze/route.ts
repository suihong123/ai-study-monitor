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
  { status: "unknown", weight: 20, reason: "模拟结果：证据不足，无法确认正在学习。" },
  { status: "away", weight: 10, reason: "模拟结果：疑似离开座位。" }
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
  "uncertain"
];

const awayCorrectionTerms = [
  "人物",
  "上半身",
  "面部",
  "人脸",
  "头部",
  "头肩",
  "肩膀",
  "手臂",
  "双手",
  "身体",
  "坐在",
  "镜头前",
  "画面中有人"
];

const personEvidenceTerms = [
  "人物",
  "人脸",
  "头部",
  "上半身",
  "头肩",
  "肩膀",
  "手臂",
  "双手",
  "手部",
  "身体",
  "孩子",
  "学生",
  "有人",
  "人在"
];

const noPersonTerms = [
  "没有人",
  "无人",
  "未检测到人物",
  "未见人物",
  "未看到人物",
  "没有看到人物",
  "未检测到人",
  "未看到人",
  "画面中无人",
  "座位空",
  "空座位"
];

const studyObjectTerms = [
  "桌面",
  "书桌",
  "纸",
  "笔",
  "作业本",
  "书本",
  "屏幕",
  "学习用品",
  "文具"
];

const qwenPrompt = `你是儿童学习监督助手。

你的任务不是寻找走神证据，也不要判断孩子是否发呆。只判断：

1. 画面中是否有人
2. 是否存在明确学习行为
3. 如果证据不足，统一返回 uncertain

仅判断当前可见行为。

不要识别人脸。
不要判断身份。
不要判断年龄。
不要判断情绪。

判断原则：
检测到人物时，禁止返回 away。
只有看到人物身体部位，才可以返回 presence=present，例如：人脸、头部、上半身、肩膀、手臂、双手、身体部分。
如果只看到桌面、纸、笔、作业本、书本、屏幕、文具等学习用品，但没有看到任何人物身体部位，必须返回 presence=away，learning_state=uncertain。
不允许把桌面、书本、纸、笔、作业本、屏幕作为 presence=present 的证据。
看到人脸、头部、上半身、肩膀、手臂、双手或身体部分时，presence=present。
手托头、看镜头、停笔、抬头、发呆、身体部分被遮挡、无法确认正在学习，统一返回 learning_state=uncertain。
不要返回 thinking。
不要返回 suspected_distracted。
不要主动判断走神。
宁可 uncertain，不要给孩子贴走神标签。

第一层 presence 只能返回：
present：检测到人脸、头部、上半身、头肩区域、肩膀、手臂、双手或身体部分
away：画面无人、座位空了、人物明显离开学习区域，或只看到学习用品但没有任何人物身体部位

第二层 learning_state 只能返回：
studying：presence=present，且看到写字、阅读、作业本、书本、键盘输入或学习工具使用行为
uncertain：presence=present，但没有明确学习行为证据，包括手托头、看镜头、停笔、抬头、发呆、遮挡或画面信息不足

如果 presence=away，learning_state 必须为 uncertain。
如果只看到学习用品但没有人，reason 必须写：画面中未检测到人物，仅看到桌面或学习用品。

JSON格式：
{
  "presence": "present",
  "learning_state": "uncertain",
  "confidence": 0.85,
  "reason": "人物仍在座位上，但未见明确写字、阅读或学习操作，证据不足。"
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

  const hasPersonEvidence = personEvidenceTerms.some((term) => reason.includes(term));
  const hasNoPersonEvidence = noPersonTerms.some((term) => reason.includes(term));
  const hasOnlyStudyObjects =
    studyObjectTerms.some((term) => reason.includes(term)) && !hasPersonEvidence;

  if (
    presence === "away" &&
    !hasNoPersonEvidence &&
    awayCorrectionTerms.some((term) => reason.includes(term))
  ) {
    presence = "present";
    learningState = "uncertain";
    reason = `${reason} 系统修正：画面中有人，不能判定为离座。`;
  }

  if (presence === "present" && (hasNoPersonEvidence || hasOnlyStudyObjects)) {
    presence = "away";
    learningState = "uncertain";
    reason = "画面中未检测到人物，仅看到桌面或学习用品。";
  }

  if (presence === "away") {
    learningState = "uncertain";
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
  return "uncertain";
}

function legacyStatusFromState(presence: Presence, learningState: LearningState): StudyStatus {
  if (presence === "away") return "away";
  if (learningState === "studying") return "studying";
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
