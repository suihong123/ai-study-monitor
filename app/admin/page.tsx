"use client";

import { FormEvent, Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AccessCode, AccessCodeStatus, PlanType } from "@/types";
import { statusLabels } from "@/lib/access-code-status";
import { defaultQwenApiUrl, visionModelOptions } from "@/lib/model-options";
import { appVersion } from "@/lib/version";

type AdminAccessCode = AccessCode & {
  sessions?: Array<{
    id: string;
    start_time: string;
    end_time: string | null;
    duration_minutes: number | null;
    focus_rate: number | null;
  }>;
};

type AdminSession = {
  id: string;
  access_code_id: string;
  start_time: string;
  end_time: string | null;
  duration_minutes: number | null;
  ai_call_count: number | null;
  estimated_cost: number | null;
  focus_rate: number | null;
  report_level: string | null;
  status: string | null;
  last_active_at?: string | null;
  access_codes?: { code?: string; plan_type?: string } | null;
};

type AdminLog = {
  id: string;
  session_id?: string | null;
  access_code_id?: string | null;
  error_type?: string;
  error_message?: string;
  stack?: string | null;
  event_type?: string;
  message?: string;
  model_type?: string;
  action_type?: string;
  reason?: string;
  status?: string;
  estimated_cost?: number;
  latency_ms?: number;
  ip?: string;
  user_agent?: string;
  created_at: string;
  access_codes?: { code?: string; plan_type?: string } | null;
};

type AdminOverview = {
  dashboard?: Record<string, number>;
  modelConfig?: {
    id?: string;
    mode: "mock" | "qwen";
    provider: "qwen";
    model: string;
    apiUrl: string;
    estimatedCostPerCall: number;
    notes?: string | null;
    source: "database" | "environment";
    updatedAt?: string | null;
  };
  accessCodes?: AdminAccessCode[];
  sessions?: AdminSession[];
  aiCallLogs?: AdminLog[];
  errorLogs?: AdminLog[];
  suspiciousLogs?: AdminLog[];
  adminActions?: AdminLog[];
  costByAccessCode?: Array<{
    accessCode: string;
    planType: string;
    aiCalls: number;
    estimatedCost: number;
    reportCount: number;
    reportCost: number;
    sessionCount: number;
    supervisionMinutes: number;
    averageHourlyCost: number;
    averageSessionCost: number;
  }>;
  sessionDetail?: {
    session: AdminSession | null;
    records: Array<{
      id: string;
      timestamp: string;
      status: string;
      presence?: string | null;
      learning_state?: string | null;
      current_frequency_seconds?: number | null;
      frequency_boosted_by_abnormal?: boolean | null;
      frequency_lowered_by_focus?: boolean | null;
      triggered_reminder?: boolean | null;
      ai_called?: boolean | null;
      error_message?: string | null;
      analyze_mode?: string | null;
      confidence?: number | null;
      reason?: string | null;
      manual_corrected?: boolean | null;
      correction_source?: string | null;
      corrected_at?: string | null;
    }>;
    aiCalls: AdminLog[];
    errors: AdminLog[];
  } | null;
};

type AdminSectionKey = "overview" | "access-codes" | "sessions" | "logs" | "costs" | "model" | "actions";

const planLabels: Record<PlanType, string> = {
  trial: "2小时体验版",
  basic_monthly: "月卡（30天）",
  standard_monthly: "季卡（90天）",
  pro_monthly: "年卡（365天）"
};

const planDescriptions: Record<PlanType, string[]> = {
  trial: ["总额度120分钟", "适合首次体验"],
  basic_monthly: ["每日180分钟", "总额度5400分钟"],
  standard_monthly: ["每日180分钟", "总额度16200分钟"],
  pro_monthly: ["每日180分钟", "总额度65700分钟"]
};

const dashboardLabels: Record<string, string> = {
  todayNewAccessCodes: "今日新增访问码数量",
  todaySessions: "今日监督次数",
  todaySupervisionMinutes: "今日总监督分钟数",
  todayAiCalls: "今日AI调用次数",
  todayEstimatedAiCost: "今日预估AI成本",
  todayReports: "今日报告生成次数",
  todayErrors: "今日错误次数",
  todaySuspicious: "今日可疑访问次数",
  mockAnalyzeCount: "Mock识别次数",
  qwenAnalyzeCount: "Qwen识别次数",
  qwenTotalCalls: "Qwen总调用次数",
  qwenTotalCost: "Qwen总成本",
  qwenAverageCost: "Qwen平均单次成本",
  qwenTodayCost: "Qwen今日成本",
  qwenSevenDayCost: "Qwen最近7天成本",
  manualCorrectionCount: "手动纠错次数",
  manualCorrectionRate: "手动纠错率"
};

const adminSections: Array<{ key: AdminSectionKey; title: string; description: string }> = [
  { key: "overview", title: "总览", description: "今日用量、成本和异常概览" },
  { key: "access-codes", title: "访问码管理", description: "创建、搜索、额度和状态处理" },
  { key: "sessions", title: "监督记录", description: "查看单次监督和识别明细" },
  { key: "logs", title: "风险与错误", description: "排查授权、风控和接口问题" },
  { key: "costs", title: "成本统计", description: "按访问码查看AI成本" },
  { key: "model", title: "模型配置", description: "切换视觉识别模型和成本参数" },
  { key: "actions", title: "操作日志", description: "查看后台运营操作记录" }
];

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [isVerified, setIsVerified] = useState(false);
  const [planType, setPlanType] = useState<PlanType>("trial");
  const [overview, setOverview] = useState<AdminOverview>({});
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [activeSection, setActiveSection] = useState<AdminSectionKey>("overview");
  const [accessCodeSearch, setAccessCodeSearch] = useState("");
  const [accessStatusFilter, setAccessStatusFilter] = useState<"all" | AccessCodeStatus>("all");
  const [accessPlanFilter, setAccessPlanFilter] = useState<"all" | PlanType>("all");
  const [accessCodeLimit, setAccessCodeLimit] = useState(20);
  const [expandedAccessCodeId, setExpandedAccessCodeId] = useState("");
  const [modelForm, setModelForm] = useState({
    mode: "qwen" as "mock" | "qwen",
    model: "qwen3.6-flash",
    apiUrl: defaultQwenApiUrl,
    estimatedCostPerCall: "0.003",
    notes: ""
  });

  async function loadAdmin(adminPassword = password, sessionId = selectedSessionId) {
    if (!adminPassword) return;
    setLoading(true);
    setMessage("");
    try {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      const response = await fetch(`/api/admin/overview${query}`, {
        headers: { "x-admin-password": adminPassword }
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(response.status === 401 ? "验证失败" : result.error ?? "读取失败");
        return;
      }
      setOverview(result);
      syncModelForm(result.modelConfig);
    } finally {
      setLoading(false);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (Date.now() < lockedUntil) {
      setMessage("尝试次数过多，请稍后再试。");
      return;
    }
    if (!password) return;

    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/overview", {
        headers: { "x-admin-password": password }
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status !== 401) {
          setMessage(result.error ?? "读取失败");
          return;
        }
        const failedCount = Number(window.sessionStorage.getItem("admin_failed_count") ?? "0") + 1;
        window.sessionStorage.setItem("admin_failed_count", String(failedCount));
        if (failedCount >= 5) {
          const nextLockedUntil = Date.now() + 10 * 60 * 1000;
          window.sessionStorage.setItem("admin_locked_until", String(nextLockedUntil));
          setLockedUntil(nextLockedUntil);
          setMessage("尝试次数过多，请稍后再试。");
          return;
        }
        setMessage("验证失败");
        return;
      }

      window.sessionStorage.setItem("admin_verified", "true");
      window.sessionStorage.removeItem("admin_failed_count");
      window.sessionStorage.removeItem("admin_locked_until");
      setLockedUntil(0);
      setIsVerified(true);
      setOverview(result);
      syncModelForm(result.modelConfig);
    } finally {
      setLoading(false);
    }
  }

  function syncModelForm(config?: AdminOverview["modelConfig"]) {
    if (!config) return;
    setModelForm({
      mode: config.mode,
      model: config.model,
      apiUrl: config.apiUrl,
      estimatedCostPerCall: String(config.estimatedCostPerCall),
      notes: config.notes ?? ""
    });
  }

  async function updateModelConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/model-config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": password
        },
        body: JSON.stringify({
          mode: modelForm.mode,
          model: modelForm.model,
          apiUrl: modelForm.apiUrl,
          estimatedCostPerCall: Number(modelForm.estimatedCostPerCall),
          notes: modelForm.notes
        })
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(response.status === 401 ? "验证失败" : result.error ?? "保存模型配置失败");
        return;
      }
      setMessage("视觉模型配置已更新");
      setOverview((current) => ({ ...current, modelConfig: result.modelConfig }));
      syncModelForm(result.modelConfig);
      await loadAdmin();
    } finally {
      setLoading(false);
    }
  }

  async function createCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/access-code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": password
        },
        body: JSON.stringify({ action: "create", planType })
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(response.status === 401 ? "验证失败" : result.error ?? "创建失败");
        return;
      }
      setMessage(`已创建访问码：${result.accessCode.code}`);
      await loadAdmin();
    } finally {
      setLoading(false);
    }
  }

  async function updateCode(
    id: string,
    payload:
      | { action: "disable" | "unbind" | "reset-today"; reason?: string }
      | { action: "set-status"; status: AccessCodeStatus; reason?: string }
      | { action: "adjust-minutes"; mode: "add" | "reduce" | "set-total" | "set-daily"; minutes: number; reason?: string }
      | { action: "update-plan"; planType: PlanType; resetUsed?: boolean; reason?: string }
      | { action: "update-admin-notes"; adminNotes: string; reason?: string }
  ) {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/access-code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": password
        },
        body: JSON.stringify({ ...payload, id })
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(response.status === 401 ? "验证失败" : result.error ?? "操作失败");
        return;
      }
      await loadAdmin();
    } finally {
      setLoading(false);
    }
  }

  function requireReason(label: string) {
    const reason = window.prompt(label);
    return reason?.trim() || "";
  }

  function updateStatus(item: AdminAccessCode, status: AccessCodeStatus) {
    if (status === "disabled" && !window.confirm("确认永久禁用该访问码？")) return;
    const needReason = status === "refunded" || status === "blacklist" || status === "paused";
    const reason = needReason ? requireReason("请输入原因") : "";
    if (needReason && !reason) return;
    void updateCode(item.id, { action: "set-status", status, reason });
  }

  function adjustQuota(item: AdminAccessCode, mode: "add" | "reduce" | "set-total" | "set-daily") {
    const value = window.prompt("请输入分钟数");
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0) return;
    const reason = requireReason("请输入调整原因");
    void updateCode(item.id, { action: "adjust-minutes", mode, minutes, reason });
  }

  function changePlan(item: AdminAccessCode) {
    const planType = window.prompt(
      "请输入套餐：trial / basic_monthly / standard_monthly / pro_monthly",
      item.plan_type
    ) as PlanType | null;
    if (!planType || !Object.keys(planLabels).includes(planType)) return;
    const resetUsed = window.confirm("是否重置已用额度？");
    const reason = requireReason("请输入套餐调整原因");
    void updateCode(item.id, { action: "update-plan", planType, resetUsed, reason });
  }

  function updateNotes(item: AdminAccessCode) {
    const adminNotes = window.prompt("请输入后台备注", item.admin_notes ?? "");
    if (adminNotes === null) return;
    void updateCode(item.id, {
      action: "update-admin-notes",
      adminNotes,
      reason: "修改备注"
    });
  }

  function selectSession(id: string) {
    setSelectedSessionId(id);
    void loadAdmin(password, id);
  }

  useEffect(() => {
    setIsVerified(window.sessionStorage.getItem("admin_verified") === "true");
    setLockedUntil(Number(window.sessionStorage.getItem("admin_locked_until") ?? "0"));
  }, []);

  if (!isVerified) {
    const isLocked = Date.now() < lockedUntil;
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md items-center px-4 py-6">
        <form onSubmit={login} className="w-full rounded-md border border-line bg-white p-5">
          <h1 className="text-2xl font-bold">管理后台</h1>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-4 h-11 w-full rounded-md border border-line px-3 outline-none focus:border-brand"
            placeholder="请输入管理密码"
            disabled={isLocked || loading}
          />
          <button
            disabled={isLocked || loading || !password}
            className="mt-3 h-11 w-full rounded-md bg-brand px-4 font-semibold text-white disabled:opacity-60"
          >
            进入后台
          </button>
          {message && (
            <div className="mt-3 rounded-md border border-line bg-panel p-3 text-sm text-muted">
              {message}
            </div>
          )}
        </form>
      </main>
    );
  }

  const accessCodes = overview.accessCodes ?? [];
  const sessions = overview.sessions ?? [];
  const suspiciousLogs = overview.suspiciousLogs ?? [];
  const searchText = accessCodeSearch.trim().toLowerCase();
  const filteredAccessCodes = accessCodes.filter((item) => {
    const matchesSearch =
      !searchText ||
      item.code.toLowerCase().includes(searchText) ||
      item.device_id?.toLowerCase().includes(searchText) ||
      item.admin_notes?.toLowerCase().includes(searchText);
    const matchesStatus = accessStatusFilter === "all" || item.status === accessStatusFilter;
    const matchesPlan = accessPlanFilter === "all" || item.plan_type === accessPlanFilter;
    return matchesSearch && matchesStatus && matchesPlan;
  });
  const visibleAccessCodes = filteredAccessCodes.slice(0, accessCodeLimit);

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1500px] px-4 py-6">
      <div className="mb-5">
        <h1 className="text-3xl font-bold">管理后台</h1>
        <p className="mt-2 text-muted">用量观测、成本统计、错误定位和风险记录。</p>
        <div className="mt-3 rounded-md border border-line bg-white p-3 text-sm leading-6 text-muted">
          <span className="font-semibold text-ink">{appVersion.version}</span>
          <span className="ml-3">更新时间：{appVersion.updatedAt}</span>
          <span className="ml-3">{appVersion.summary}</span>
        </div>
      </div>

      <section className="mb-5 rounded-md border border-line bg-white p-4">
        <label className="block text-sm font-medium" htmlFor="password">
          ADMIN_PASSWORD
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-11 flex-1 rounded-md border border-line px-3 outline-none focus:border-brand"
            placeholder="请输入后台密码"
          />
          <button
            onClick={() => void loadAdmin()}
            className="h-11 rounded-md bg-brand px-4 font-semibold text-white"
          >
            刷新看板
          </button>
        </div>
      </section>

      {message && (
        <div className="mb-4 rounded-md border border-line bg-white p-3 text-sm">
          {message}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <nav className="rounded-md border border-line bg-white p-2">
            {adminSections.map((section) => (
              <button
                key={section.key}
                onClick={() => setActiveSection(section.key)}
                className={`mb-1 w-full rounded-md px-3 py-3 text-left transition ${
                  activeSection === section.key ? "bg-ink text-white" : "text-ink hover:bg-panel"
                }`}
              >
                <div className="font-semibold">{section.title}</div>
                <div className={`mt-1 text-xs ${activeSection === section.key ? "text-white/75" : "text-muted"}`}>
                  {section.description}
                </div>
              </button>
            ))}
          </nav>
        </aside>

        <div className="min-w-0">
          {activeSection === "overview" && (
            <>
              <section className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
                {Object.entries(dashboardLabels).map(([key, label]) => (
                  <div key={key} className="rounded-md border border-line bg-white p-4">
                    <div className="text-sm text-muted">{label}</div>
                    <div className="mt-1 text-2xl font-semibold">{overview.dashboard?.[key] ?? 0}</div>
                  </div>
                ))}
              </section>
              <div className="grid gap-5 xl:grid-cols-2">
                <LogSection title="最近风险记录" rows={suspiciousLogs.slice(0, 5)} compact />
                <LogSection title="最近错误日志" rows={(overview.errorLogs ?? []).slice(0, 5)} compact />
              </div>
            </>
          )}

          {activeSection === "access-codes" && (
            <>
              <form
                onSubmit={createCode}
                className="mb-5 flex flex-col gap-3 rounded-md border border-line bg-white p-4 sm:flex-row sm:items-start"
              >
                <div className="flex-1">
                  <select
                    value={planType}
                    onChange={(event) => setPlanType(event.target.value as PlanType)}
                    className="h-11 w-full rounded-md border border-line px-3 outline-none focus:border-brand"
                  >
                    {Object.entries(planLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="mt-2 rounded-md bg-panel p-3 text-sm leading-6 text-muted">
                    <div className="font-medium text-ink">{planLabels[planType]}</div>
                    {planDescriptions[planType].map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </div>
                </div>
                <button
                  disabled={loading || !password}
                  className="h-11 rounded-md bg-ink px-4 font-semibold text-white disabled:opacity-60"
                >
                  创建访问码
                </button>
              </form>

              <Section title="访问码管理">
                <div className="mb-4 grid gap-3 lg:grid-cols-[1fr_180px_180px_140px]">
                  <input
                    value={accessCodeSearch}
                    onChange={(event) => setAccessCodeSearch(event.target.value)}
                    className="h-11 rounded-md border border-line px-3 outline-none focus:border-brand"
                    placeholder="搜索访问码、设备ID或备注"
                  />
                  <select
                    value={accessStatusFilter}
                    onChange={(event) => setAccessStatusFilter(event.target.value as "all" | AccessCodeStatus)}
                    className="h-11 rounded-md border border-line px-3 outline-none focus:border-brand"
                  >
                    <option value="all">全部状态</option>
                    {(Object.keys(statusLabels) as AccessCodeStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {statusLabels[status]}
                      </option>
                    ))}
                  </select>
                  <select
                    value={accessPlanFilter}
                    onChange={(event) => setAccessPlanFilter(event.target.value as "all" | PlanType)}
                    className="h-11 rounded-md border border-line px-3 outline-none focus:border-brand"
                  >
                    <option value="all">全部套餐</option>
                    {(Object.keys(planLabels) as PlanType[]).map((plan) => (
                      <option key={plan} value={plan}>
                        {planLabels[plan]}
                      </option>
                    ))}
                  </select>
                  <select
                    value={accessCodeLimit}
                    onChange={(event) => setAccessCodeLimit(Number(event.target.value))}
                    className="h-11 rounded-md border border-line px-3 outline-none focus:border-brand"
                  >
                    <option value={20}>显示20条</option>
                    <option value={50}>显示50条</option>
                    <option value={100}>显示100条</option>
                  </select>
                </div>

                <div className="mb-3 text-sm text-muted">
                  共 {filteredAccessCodes.length} 个访问码，当前显示 {visibleAccessCodes.length} 个。
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[980px] border-collapse text-left text-sm">
                    <thead className="bg-panel text-muted">
                      <tr>
                        <th className="p-3">访问码</th>
                        <th className="p-3">状态</th>
                        <th className="p-3">套餐</th>
                        <th className="p-3">今日额度</th>
                        <th className="p-3">总额度</th>
                        <th className="p-3">风险</th>
                        <th className="p-3">设备</th>
                        <th className="p-3">最近使用</th>
                        <th className="p-3">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleAccessCodes.map((item) => {
                        const riskCount = suspiciousLogs.filter((log) => log.access_code_id === item.id).length;
                        const latestSession = sessions
                          .filter((session) => session.access_code_id === item.id)
                          .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime())[0];
                        const isExpanded = expandedAccessCodeId === item.id;
                        return (
                          <Fragment key={item.id}>
                            <tr
                              className={`border-t border-line align-top ${
                                item.status === "watch" || item.status === "blacklist" ? "bg-red-50" : ""
                              }`}
                            >
                              <td className="p-3 font-semibold">
                                {item.code}
                                {item.admin_notes && (
                                  <div className="mt-1 max-w-[220px] text-xs font-normal text-muted">
                                    {item.admin_notes}
                                  </div>
                                )}
                              </td>
                              <td className="p-3">
                                <span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusClass(item.status)}`}>
                                  {statusLabels[item.status]}
                                </span>
                                {item.freeze_reason && (
                                  <div className="mt-1 max-w-[180px] text-xs text-muted">{item.freeze_reason}</div>
                                )}
                              </td>
                              <td className="p-3">{planLabels[item.plan_type]}</td>
                              <td className="p-3">
                                {item.used_minutes_today} / {Math.max(item.daily_minutes - item.used_minutes_today, 0)}分钟
                              </td>
                              <td className="p-3">
                                {item.used_minutes} / {Math.max(item.total_minutes - item.used_minutes, 0)}分钟
                              </td>
                              <td className="p-3">{riskCount > 0 ? `${riskCount}条` : "无"}</td>
                              <td className="p-3">{item.device_id ? "已绑定" : "未绑定"}</td>
                              <td className="p-3">{formatDate(latestSession?.start_time)}</td>
                              <td className="p-3">
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    onClick={() => setExpandedAccessCodeId(isExpanded ? "" : item.id)}
                                    className="rounded-md border border-line px-3 py-2"
                                  >
                                    {isExpanded ? "收起" : "详情"}
                                  </button>
                                  <button
                                    onClick={() => updateStatus(item, item.status === "paused" ? "active" : "paused")}
                                    className="rounded-md border border-line px-3 py-2"
                                  >
                                    {item.status === "paused" ? "恢复" : "暂停"}
                                  </button>
                                  <details className="relative">
                                    <summary className="cursor-pointer rounded-md border border-line px-3 py-2 marker:content-none">
                                      更多操作
                                    </summary>
                                    <div className="absolute right-0 z-10 mt-2 grid w-56 gap-2 rounded-md border border-line bg-white p-3 shadow-lg">
                                      <button onClick={() => void updateCode(item.id, { action: "unbind", reason: "后台解绑设备" })} className="rounded-md border border-line px-3 py-2 text-left">
                                        解绑设备
                                      </button>
                                      <button onClick={() => void updateCode(item.id, { action: "reset-today", reason: "后台重置今日额度" })} className="rounded-md border border-line px-3 py-2 text-left">
                                        重置今日额度
                                      </button>
                                      <button onClick={() => updateStatus(item, "watch")} className="rounded-md border border-warn px-3 py-2 text-left text-warn">
                                        设置观察
                                      </button>
                                      <button onClick={() => updateStatus(item, "refunded")} className="rounded-md border border-brand px-3 py-2 text-left text-brand">
                                        退款冻结
                                      </button>
                                      <button onClick={() => updateStatus(item, "blacklist")} className="rounded-md border border-alert px-3 py-2 text-left text-alert">
                                        加入黑名单
                                      </button>
                                      <button onClick={() => updateStatus(item, "active")} className="rounded-md border border-line px-3 py-2 text-left">
                                        恢复正常
                                      </button>
                                      <button onClick={() => updateStatus(item, "disabled")} className="rounded-md border border-muted px-3 py-2 text-left text-muted">
                                        永久禁用
                                      </button>
                                      <button onClick={() => adjustQuota(item, "add")} className="rounded-md border border-line px-3 py-2 text-left">
                                        加额度
                                      </button>
                                      <button onClick={() => adjustQuota(item, "reduce")} className="rounded-md border border-line px-3 py-2 text-left">
                                        减额度
                                      </button>
                                      <button onClick={() => adjustQuota(item, "set-total")} className="rounded-md border border-line px-3 py-2 text-left">
                                        改总额度
                                      </button>
                                      <button onClick={() => adjustQuota(item, "set-daily")} className="rounded-md border border-line px-3 py-2 text-left">
                                        改日额度
                                      </button>
                                      <button onClick={() => changePlan(item)} className="rounded-md border border-line px-3 py-2 text-left">
                                        改套餐
                                      </button>
                                      <button onClick={() => updateNotes(item)} className="rounded-md border border-line px-3 py-2 text-left">
                                        修改备注
                                      </button>
                                    </div>
                                  </details>
                                </div>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="border-t border-line bg-panel/60">
                                <td colSpan={9} className="p-4">
                                  <div className="grid gap-3 md:grid-cols-3">
                                    <InfoItem label="设备ID" value={item.device_id ?? "未绑定"} />
                                    <InfoItem label="今日额度" value={`已用${item.used_minutes_today} / 剩余${Math.max(item.daily_minutes - item.used_minutes_today, 0)}分钟`} />
                                    <InfoItem label="总额度" value={`已用${item.used_minutes} / 剩余${Math.max(item.total_minutes - item.used_minutes, 0)}分钟`} />
                                    <InfoItem label="基础识别频率" value={`${item.base_interval_seconds}秒`} />
                                    <InfoItem label="最快识别频率" value={`${item.min_interval_seconds}秒`} />
                                    <InfoItem label="报告等级" value={item.report_level} />
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>
            </>
          )}

          {activeSection === "sessions" && (
            <>
              <Section title="监督记录">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1150px] border-collapse text-left text-sm">
                    <thead className="bg-panel text-muted">
                      <tr>
                        <th className="p-3">session_id</th>
                        <th className="p-3">访问码</th>
                        <th className="p-3">套餐</th>
                        <th className="p-3">开始时间</th>
                        <th className="p-3">结束时间</th>
                        <th className="p-3">最近心跳</th>
                        <th className="p-3">分钟</th>
                        <th className="p-3">AI次数</th>
                        <th className="p-3">成本</th>
                        <th className="p-3">专注率</th>
                        <th className="p-3">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((session) => (
                        <tr key={session.id} className="border-t border-line">
                          <td className="max-w-[160px] break-all p-3">
                            <button className="text-brand underline" onClick={() => selectSession(session.id)}>
                              {session.id}
                            </button>
                          </td>
                          <td className="p-3">{session.access_codes?.code ?? "-"}</td>
                          <td className="p-3">
                            {session.access_codes?.plan_type
                              ? planLabels[session.access_codes.plan_type as PlanType]
                              : "-"}
                          </td>
                          <td className="p-3">{formatDate(session.start_time)}</td>
                          <td className="p-3">{formatDate(session.end_time)}</td>
                          <td className="p-3">{formatDate(session.last_active_at)}</td>
                          <td className="p-3">{session.duration_minutes ?? 0}</td>
                          <td className="p-3">{session.ai_call_count ?? 0}</td>
                          <td className="p-3">{session.estimated_cost ?? 0}</td>
                          <td className="p-3">{session.focus_rate ?? 0}%</td>
                          <td className="p-3">{sessionStatusLabel(session.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              {overview.sessionDetail?.session && (
                <Section title="单次监督详情">
                  {(() => {
                    const frequencyStats = buildFrequencyStats(overview.sessionDetail?.records ?? []);
                    return (
                      <div className="grid gap-3 md:grid-cols-4">
                        {[
                          ["session_id", overview.sessionDetail.session.id],
                          ["访问码", overview.sessionDetail.session.access_codes?.code ?? "-"],
                          [
                            "套餐",
                            overview.sessionDetail.session.access_codes?.plan_type
                              ? planLabels[overview.sessionDetail.session.access_codes.plan_type as PlanType]
                              : "-"
                          ],
                          ["Session状态", sessionStatusLabel(overview.sessionDetail.session.status)],
                          ["最近心跳", formatDate(overview.sessionDetail.session.last_active_at)],
                          ["总时长", `${overview.sessionDetail.session.duration_minutes ?? 0}分钟`],
                          ["AI调用", `${overview.sessionDetail.session.ai_call_count ?? 0}次`],
                          ["平均识别间隔", `${frequencyStats.average}秒`],
                          ["最短识别间隔", `${frequencyStats.min}秒`],
                          ["最长识别间隔", `${frequencyStats.max}秒`],
                          ["预估成本", `${overview.sessionDetail.session.estimated_cost ?? 0}元`],
                          ["专注率", `${overview.sessionDetail.session.focus_rate ?? 0}%`],
                          ["报告等级", overview.sessionDetail.session.report_level ?? "-"]
                        ].map(([label, value]) => (
                          <div key={label} className="rounded-md bg-panel p-3">
                            <div className="text-sm text-muted">{label}</div>
                            <div className="mt-1 break-all font-semibold">{value}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  <div className="mt-4 max-h-80 overflow-auto">
                    {(overview.sessionDetail.records ?? []).map((record) => (
                      <div key={record.id} className="mb-2 rounded-md bg-panel p-3 text-sm">
                        {formatDate(record.timestamp)} / {record.presence ?? "-"} / {record.learning_state ?? record.status} / 频率
                        {record.current_frequency_seconds ?? "-"}秒 / 提醒
                        {record.triggered_reminder ? "是" : "否"} / 调AI
                        {record.ai_called === false ? "否" : "是"} / 错误
                        {record.error_message ?? "无"}
                        <div className="mt-1 text-xs text-muted">
                          模式 {record.analyze_mode ?? "-"} / 置信度 {record.confidence ?? "-"} / 原因 {record.reason ?? "-"}
                        </div>
                        <div className="mt-1 text-xs text-muted">
                          {record.frequency_boosted_by_abnormal ? "异常后提频" : "未因异常提频"} /{" "}
                          {record.frequency_lowered_by_focus ? "连续专注降频" : "未因连续专注降频"}
                        </div>
                        {record.manual_corrected && (
                          <div className="mt-1 text-xs text-alert">
                            已手动纠正 / 来源 {record.correction_source ?? "-"} / {formatDate(record.corrected_at)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}

          {activeSection === "logs" && (
            <>
              <LogSection title="风险记录" rows={suspiciousLogs} />
              <LogSection title="错误日志" rows={overview.errorLogs ?? []} />
            </>
          )}

          {activeSection === "costs" && (
            <>
              <Section title="成本统计">
                <div className="grid gap-3 md:grid-cols-2">
                  {(overview.costByAccessCode ?? []).map((item) => (
                    <div key={item.accessCode} className="rounded-md bg-panel p-4 text-sm">
                      <div className="font-semibold">
                        {item.accessCode} / {item.planType}
                      </div>
                      <div className="mt-2 text-muted">
                        AI调用{item.aiCalls}次，预估成本{item.estimatedCost}元，报告
                        {item.reportCount}次，报告成本{item.reportCost}元
                        <br />
                        平均每小时{item.averageHourlyCost}元，平均每次监督{item.averageSessionCost}元
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
              <LogSection title="AI调用日志" rows={overview.aiCallLogs ?? []} />
            </>
          )}

          {activeSection === "model" && (
            <Section title="视觉模型配置">
              <form onSubmit={updateModelConfig} className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md bg-panel p-3 text-sm leading-6 text-muted md:col-span-2">
                  <div className="font-semibold text-ink">
                    当前模型：{overview.modelConfig?.mode === "mock" ? "Mock测试模式" : overview.modelConfig?.model ?? "-"}
                  </div>
                  <div>
                    配置来源：
                    {overview.modelConfig?.source === "database" ? "后台配置" : "环境变量"}
                    {overview.modelConfig?.updatedAt ? ` / 更新时间：${formatDate(overview.modelConfig.updatedAt)}` : ""}
                  </div>
                  <div>说明：普通用户页面不会展示模型和 API 信息；这里仅用于运营控制成本和测试模型效果。</div>
                </div>

                <label className="text-sm font-medium">
                  识别模式
                  <select
                    value={modelForm.mode}
                    onChange={(event) =>
                      setModelForm((current) => ({ ...current, mode: event.target.value as "mock" | "qwen" }))
                    }
                    className="mt-1 h-11 w-full rounded-md border border-line px-3 outline-none focus:border-brand"
                  >
                    <option value="qwen">真实AI识别（Qwen）</option>
                    <option value="mock">测试模式（Mock）</option>
                  </select>
                </label>

                <label className="text-sm font-medium">
                  常用模型
                  <select
                    value={visionModelOptions.some((item) => item.value === modelForm.model) ? modelForm.model : "custom"}
                    onChange={(event) => {
                      const selected = visionModelOptions.find((item) => item.value === event.target.value);
                      if (!selected) return;
                      setModelForm((current) => ({
                        ...current,
                        model: selected.value,
                        estimatedCostPerCall: String(selected.estimatedCostPerCall)
                      }));
                    }}
                    className="mt-1 h-11 w-full rounded-md border border-line px-3 outline-none focus:border-brand"
                  >
                    {visionModelOptions.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                    <option value="custom">自定义模型名</option>
                  </select>
                </label>

                <label className="text-sm font-medium">
                  模型名称
                  <input
                    value={modelForm.model}
                    onChange={(event) => setModelForm((current) => ({ ...current, model: event.target.value }))}
                    className="mt-1 h-11 w-full rounded-md border border-line px-3 outline-none focus:border-brand"
                    placeholder="例如 qwen3-vl-flash"
                  />
                </label>

                <label className="text-sm font-medium">
                  Qwen接口地址
                  <input
                    value={modelForm.apiUrl}
                    onChange={(event) => setModelForm((current) => ({ ...current, apiUrl: event.target.value }))}
                    className="mt-1 h-11 w-full rounded-md border border-line px-3 outline-none focus:border-brand"
                    placeholder={defaultQwenApiUrl}
                  />
                </label>

                <label className="text-sm font-medium">
                  预估单次识别成本（元）
                  <input
                    value={modelForm.estimatedCostPerCall}
                    onChange={(event) =>
                      setModelForm((current) => ({ ...current, estimatedCostPerCall: event.target.value }))
                    }
                    className="mt-1 h-11 w-full rounded-md border border-line px-3 outline-none focus:border-brand"
                    inputMode="decimal"
                    placeholder="0.001"
                  />
                </label>

                <label className="text-sm font-medium md:col-span-2">
                  运营备注
                  <input
                    value={modelForm.notes}
                    onChange={(event) => setModelForm((current) => ({ ...current, notes: event.target.value }))}
                    className="mt-1 h-11 w-full rounded-md border border-line px-3 outline-none focus:border-brand"
                    placeholder="例如：低成本模型灰度测试"
                  />
                </label>

                <button
                  disabled={loading || !password}
                  className="h-11 rounded-md bg-ink px-4 font-semibold text-white disabled:opacity-60 md:w-48"
                >
                  保存模型配置
                </button>
              </form>
            </Section>
          )}

          {activeSection === "actions" && <LogSection title="后台操作日志" rows={overview.adminActions ?? []} />}
        </div>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5 rounded-md border border-line bg-white p-4">
      <h2 className="mb-3 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function InfoItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md bg-white p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 break-all text-sm font-semibold">{value}</div>
    </div>
  );
}

function LogSection({ title, rows, compact = false }: { title: string; rows: AdminLog[]; compact?: boolean }) {
  return (
    <Section title={title}>
      <div className={compact ? "max-h-80 overflow-auto" : "max-h-96 overflow-auto"}>
        {rows.length === 0 ? (
          <div className="text-sm text-muted">暂无记录</div>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="mb-2 rounded-md bg-panel p-3 text-sm">
              <div className="font-semibold">
                {formatDate(row.created_at)} / {row.access_codes?.code ?? row.access_code_id ?? "-"}
              </div>
              <div className="mt-1 text-muted">
                {row.action_type ?? row.event_type ?? row.error_type ?? row.model_type ?? "-"} /{" "}
                {row.reason ?? row.message ?? row.error_message ?? row.status ?? "-"} / 成本
                {row.estimated_cost ?? 0} / 延迟{row.latency_ms ?? 0}ms
              </div>
              {(row.ip || row.user_agent) && (
                <div className="mt-1 break-all text-xs text-muted">
                  {row.ip ?? "-"} / {row.user_agent ?? "-"}
                </div>
              )}
              {row.stack && (
                <details className="mt-2 text-xs text-muted">
                  <summary className="cursor-pointer font-medium text-ink">查看诊断详情</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2">
                    {row.stack}
                  </pre>
                </details>
              )}
            </div>
          ))
        )}
      </div>
    </Section>
  );
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN");
}

function sessionStatusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    active: "active",
    completed: "completed",
    expired: "expired",
    ended: "completed"
  };
  return status ? labels[status] ?? status : "-";
}

function buildFrequencyStats(records: Array<{ current_frequency_seconds?: number | null }>) {
  const intervals = (records ?? [])
    .map((record) => Number(record.current_frequency_seconds ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (intervals.length === 0) {
    return { average: 0, min: 0, max: 0 };
  }

  const total = intervals.reduce((sum, value) => sum + value, 0);
  return {
    average: Math.round(total / intervals.length),
    min: Math.min(...intervals),
    max: Math.max(...intervals)
  };
}

function statusClass(status: AccessCodeStatus) {
  const classes: Record<AccessCodeStatus, string> = {
    active: "bg-emerald-50 text-brand",
    watch: "bg-amber-50 text-warn",
    paused: "bg-gray-100 text-muted",
    refunded: "bg-blue-50 text-brand",
    expired: "bg-gray-100 text-muted",
    disabled: "bg-gray-200 text-ink",
    blacklist: "bg-red-50 text-alert"
  };
  return classes[status];
}
