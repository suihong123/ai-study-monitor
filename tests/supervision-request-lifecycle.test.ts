import { describe, expect, it } from "vitest";
import {
  isAbortError,
  replaceAbortController,
  SupervisionRequestLifecycle
} from "@/lib/supervision-request-lifecycle";

const oldSession = {
  sessionId: "session-1",
  sessionToken: "old-token"
};
const newSession = {
  sessionId: "session-1",
  sessionToken: "new-token"
};

describe("supervision request lifecycle", () => {
  it("分析进行中被接管后，旧请求立即失效", () => {
    const lifecycle = new SupervisionRequestLifecycle();
    lifecycle.activate(oldSession);
    const oldRequest = lifecycle.begin(oldSession);

    lifecycle.invalidate();

    expect(lifecycle.isCurrent(oldRequest)).toBe(false);
  });

  it("AbortError 可被静默识别，不应进入网络错误路径", () => {
    const error = new DOMException("aborted", "AbortError");
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new Error("network failed"))).toBe(false);
  });

  it("旧请求晚返回时不能覆盖当前会话状态", () => {
    const lifecycle = new SupervisionRequestLifecycle();
    lifecycle.activate(oldSession);
    const oldRequest = lifecycle.begin(oldSession);
    const newerRequest = lifecycle.begin(oldSession);

    expect(lifecycle.isCurrent(oldRequest)).toBe(false);
    expect(lifecycle.isCurrent(newerRequest)).toBe(true);
  });

  it("新环境使用轮换后的令牌可以正常继续监督", () => {
    const lifecycle = new SupervisionRequestLifecycle();
    lifecycle.activate(oldSession);
    const oldRequest = lifecycle.begin(oldSession);
    lifecycle.invalidate();
    lifecycle.activate(newSession);
    const newRequest = lifecycle.begin(newSession);

    expect(lifecycle.isCurrent(oldRequest)).toBe(false);
    expect(lifecycle.isCurrent(newRequest)).toBe(true);
  });

  it("新请求开始前取消上一请求", () => {
    const previous = new AbortController();
    const current = replaceAbortController(previous);

    expect(previous.signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(false);
  });
});
