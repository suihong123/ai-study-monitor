import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const supervisePage = readFileSync(
  resolve(process.cwd(), "app/supervise/page.tsx"),
  "utf8"
);
const analyzeRoute = readFileSync(
  resolve(process.cwd(), "app/api/analyze/route.ts"),
  "utf8"
);
const heartbeatRoute = readFileSync(
  resolve(process.cwd(), "app/api/session-heartbeat/route.ts"),
  "utf8"
);
const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migration_2026_19_supervision_request_isolation.sql"
  ),
  "utf8"
).toLowerCase();
const schema = readFileSync(
  resolve(process.cwd(), "supabase/schema.sql"),
  "utf8"
).toLowerCase();

function functionDefinition(sql: string) {
  const start = sql.indexOf(
    "create or replace function persist_analysis_result_if_session_current"
  );
  const end = sql.indexOf(
    "revoke all on function persist_analysis_result_if_session_current",
    start
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end).replace(/\s+/g, " ").trim();
}

describe("supervision request cancellation contracts", () => {
  it("分析、心跳、报告和纠错请求均保存取消控制器", () => {
    expect(supervisePage).toContain("analyzeAbortControllerRef");
    expect(supervisePage).toContain("heartbeatAbortControllerRef");
    expect(supervisePage).toContain("reportAbortControllerRef");
    expect(supervisePage).toContain("correctionAbortControllerRef");
    expect(supervisePage).toContain("signal: controller.signal");
    expect(supervisePage).toContain("signal: reportController.signal");
  });

  it("结束、接管和卸载都会取消监督请求", () => {
    expect(supervisePage).toContain("cancelMonitoringRequests();");
    expect(supervisePage).toContain(
      "analyzeAbortControllerRef.current?.abort()"
    );
    expect(supervisePage).toContain(
      "heartbeatAbortControllerRef.current?.abort()"
    );
    expect(supervisePage).toContain(
      "reportAbortControllerRef.current?.abort()"
    );
  });

  it("AbortError 静默返回且不会累计分析失败", () => {
    const abortBranch = supervisePage.indexOf("isAbortError(error)");
    const failureMessage = supervisePage.indexOf(
      'setCameraError("AI识别失败，请检查网络后继续。")',
      abortBranch
    );
    expect(abortBranch).toBeGreaterThanOrEqual(0);
    expect(failureMessage).toBeGreaterThan(abortBranch);
    expect(supervisePage.slice(abortBranch, failureMessage)).toContain(
      "return;"
    );
  });

  it("旧分析响应在提醒和本地状态更新前都要通过当前请求校验", () => {
    expect(supervisePage).toContain(
      "analyzeLifecycleRef.current.isCurrent(requestSnapshot)"
    );
    expect(supervisePage).toContain(
      "const reminder = await maybeRemind(draftRecords, isStillCurrent)"
    );
    expect(supervisePage).toContain("if (!isStillCurrent()) return;");
  });
});

describe("server-side stale analysis isolation", () => {
  it("Qwen 调用继承客户端取消信号且取消不会回退 Mock", () => {
    expect(analyzeRoute).toContain(
      "await analyzeWithQwen(body.image, visionConfig, request.signal)"
    );
    expect(analyzeRoute).toContain("signal");
    expect(analyzeRoute).toContain(
      "request.signal.aborted || isAbortError(error)"
    );
    expect(analyzeRoute).toContain(
      "return new NextResponse(null, { status: 499 })"
    );
  });

  it("Qwen 生产日志不记录请求正文、图片、提示词或原始响应", () => {
    expect(analyzeRoute).not.toContain('[Qwen-VL] request');
    expect(analyzeRoute).not.toContain('[Qwen-VL] response');
    expect(analyzeRoute).not.toContain("body: responseBody");
    expect(analyzeRoute).not.toContain("base64 image omitted");
    expect(analyzeRoute).toContain('[Qwen-VL] completed');
    expect(analyzeRoute).toContain('provider: "qwen"');
    expect(analyzeRoute).toContain("requestId: upstreamRequestId");
    expect(analyzeRoute).toContain("status: response.status");
    expect(analyzeRoute).toContain("latencyMs:");
    expect(analyzeRoute).toContain("fallback: !response.ok");
  });

  it("分析路由不再直接写 records 或独立写成功 AI 日志", () => {
    expect(analyzeRoute).not.toContain('.from("records").insert');
    expect(analyzeRoute).not.toContain("await logAiCall");
    expect(analyzeRoute).toContain(
      '.rpc("persist_analysis_result_if_session_current"'
    );
  });

  it("心跳持久化时仍要求当前会话令牌匹配", () => {
    expect(heartbeatRoute).toContain(
      '.eq("session_token", body.sessionToken)'
    );
  });

  it("数据库在同一事务中锁定会话、校验令牌并写记录和 AI 日志", () => {
    const definition = functionDefinition(migration);
    expect(definition).toContain("for update");
    expect(definition).toContain(
      "current_session.session_token is distinct from p_session_token"
    );
    expect(definition).toContain("insert into records");
    expect(definition).toContain("insert into ai_call_logs");
    expect(definition).toContain("'persisted', false");
  });

  it("隔离函数不会创建会话、扣时长或生成报告", () => {
    const definition = functionDefinition(migration);
    expect(definition).not.toContain("insert into sessions");
    expect(definition).not.toContain("update sessions");
    expect(definition).not.toContain("update access_codes");
    expect(definition).not.toContain("report_");
  });

  it("完整 schema 与增量迁移中的隔离函数一致", () => {
    expect(functionDefinition(schema)).toBe(functionDefinition(migration));
  });
});
