"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { getDeviceId } from "@/lib/device";

export default function HomePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/access-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "validate",
          code,
          deviceId: getDeviceId()
        })
      });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "访问码验证失败");
        return;
      }

      window.sessionStorage.setItem(
        "current-supervision",
        JSON.stringify({
          accessCode: result.accessCode,
          session: result.session,
          totalRemainingMinutes: result.totalRemainingMinutes,
          todayRemainingMinutes: result.todayRemainingMinutes
        })
      );
      router.push("/supervise");
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 py-8">
      <section className="flex flex-1 flex-col justify-center">
        <div className="mb-8">
          <h1 className="text-4xl font-bold tracking-normal text-ink">
            AI学习监督助手
          </h1>
          <p className="mt-3 text-lg leading-8 text-muted">
            自动记录孩子作业状态
            <br />
            生成学习专注报告
          </p>
        </div>

        <div className="mb-5 grid gap-2 rounded-md border border-line bg-white p-4 text-sm text-muted">
          <div>记录真实学习时长</div>
          <div>统计有效学习时间</div>
          <div>发现走神高发时段</div>
          <div>生成每日学习报告</div>
          <div>帮家长判断孩子是真学了，还是坐着耗时间</div>
        </div>

        <form onSubmit={start} className="rounded-md border border-line bg-white p-5">
          <label className="block text-sm font-medium text-ink" htmlFor="code">
            访问码
          </label>
          <input
            id="code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            className="mt-2 h-12 w-full rounded-md border border-line px-4 text-lg outline-none focus:border-brand"
            autoCapitalize="characters"
            placeholder="请输入访问码"
            required
          />
          {error && <p className="mt-3 text-sm text-alert">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="mt-5 h-12 w-full rounded-md bg-brand px-4 font-semibold text-white disabled:opacity-60"
          >
            {loading ? "正在验证" : "开始监督"}
          </button>
        </form>
      </section>

      <section className="mb-4 rounded-md border border-line bg-white p-4 text-sm leading-7 text-muted">
        <div className="font-semibold text-ink">隐私声明</div>
        <p>本系统不做人脸识别，不进行身份识别，不保存视频。</p>
        <p>仅分析学习状态，不对外共享图片，用户可删除记录。</p>
        <p>图片默认24小时自动删除。</p>
      </section>
    </main>
  );
}
