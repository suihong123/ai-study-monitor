"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type {
  HostelLicenseDetailDTO,
  HostelLicenseListItemDTO,
  HostelLicenseOverviewDTO,
  HostelLicensePageDTO,
  HostelLicenseStatus,
  HostelLicenseStatusFilter
} from "@/lib/hostel-admin/types";

const statusLabels: Record<HostelLicenseStatus, string> = {
  unused: "未使用",
  activated: "已激活",
  expired: "已过期",
  revoked: "已撤销"
};

const overviewCards: Array<{
  key: keyof Pick<
    HostelLicenseOverviewDTO,
    "total" | "unused" | "activated" | "expired" | "revoked"
  >;
  label: string;
}> = [
  { key: "total", label: "总 License" },
  { key: "unused", label: "未使用" },
  { key: "activated", label: "已激活" },
  { key: "expired", label: "已过期" },
  { key: "revoked", label: "已撤销" }
];

function statusClass(status: HostelLicenseStatus) {
  const classes: Record<HostelLicenseStatus, string> = {
    unused: "bg-gray-100 text-muted",
    activated: "bg-emerald-50 text-brand",
    expired: "bg-amber-50 text-warn",
    revoked: "bg-red-50 text-alert"
  };
  return classes[status];
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN");
}

function safeErrorMessage(status: number, fallback: string) {
  if (status === 401) return "管理员认证已失效，请重新输入后台密码。";
  if (status === 404) return "未找到对应 License。";
  if (status === 400) return "输入或分页参数无效。";
  return fallback;
}

export default function HostelAdminPanel({
  adminPassword
}: {
  adminPassword: string;
}) {
  const [overview, setOverview] = useState<HostelLicenseOverviewDTO | null>(null);
  const [licenses, setLicenses] = useState<HostelLicenseListItemDTO[]>([]);
  const [statusFilter, setStatusFilter] =
    useState<HostelLicenseStatusFilter>("all");
  const [pageSize, setPageSize] = useState(25);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const [searchResult, setSearchResult] =
    useState<HostelLicenseListItemDTO | null>(null);
  const [selectedLicenseId, setSelectedLicenseId] = useState("");
  const [detail, setDetail] = useState<HostelLicenseDetailDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const adminHeaders = useCallback(
    () => ({ "x-admin-password": adminPassword }),
    [adminPassword]
  );

  const loadOverview = useCallback(async () => {
    const response = await fetch("/api/admin/hostel/overview", {
      headers: adminHeaders(),
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(safeErrorMessage(response.status, "License 概览读取失败。"));
    }
    const result = (await response.json()) as {
      overview: HostelLicenseOverviewDTO;
    };
    setOverview(result.overview);
  }, [adminHeaders]);

  const loadLicenses = useCallback(
    async (cursor: string | null) => {
      const query = new URLSearchParams({
        pageSize: String(pageSize),
        status: statusFilter
      });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/admin/hostel/licenses?${query}`, {
        headers: adminHeaders(),
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(safeErrorMessage(response.status, "License 列表读取失败。"));
      }
      const page = (await response.json()) as HostelLicensePageDTO;
      setLicenses(page.items);
      setCurrentCursor(cursor);
      setNextCursor(page.nextCursor);
    },
    [adminHeaders, pageSize, statusFilter]
  );

  const reload = useCallback(async () => {
    if (!adminPassword) {
      setError("请先在上方输入后台密码。此密码不会保存到 Hostel 面板。 ");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await Promise.all([loadOverview(), loadLicenses(null)]);
      setCursorHistory([]);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "AI民宿只读数据加载失败。"
      );
    } finally {
      setLoading(false);
    }
  }, [adminPassword, loadLicenses, loadOverview]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function changePage(cursor: string | null, history: Array<string | null>) {
    setLoading(true);
    setError("");
    try {
      await loadLicenses(cursor);
      setCursorHistory(history);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "分页读取失败。"
      );
    } finally {
      setLoading(false);
    }
  }

  async function searchLicense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const transientLicenseKey = licenseKey;
    setLicenseKey("");
    setSearchResult(null);
    setSearchMessage("");
    if (!adminPassword) {
      setSearchMessage("请先在上方输入后台密码。");
      return;
    }
    setSearching(true);
    try {
      const response = await fetch("/api/admin/hostel/licenses/search", {
        method: "POST",
        headers: {
          ...adminHeaders(),
          "Content-Type": "application/json"
        },
        cache: "no-store",
        body: JSON.stringify({ licenseKey: transientLicenseKey })
      });
      const result = (await response.json()) as {
        license?: HostelLicenseListItemDTO;
      };
      if (!response.ok || !result.license) {
        setSearchMessage(
          safeErrorMessage(response.status, "License 搜索暂时不可用。")
        );
        return;
      }
      setSearchResult(result.license);
      setSearchMessage("已找到对应 License。输入内容已清除且不会被保存。");
    } catch {
      setSearchMessage("License 搜索暂时不可用。");
    } finally {
      setSearching(false);
    }
  }

  async function loadDetail(licenseId: string) {
    setSelectedLicenseId(licenseId);
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    try {
      const response = await fetch(
        `/api/admin/hostel/licenses/${encodeURIComponent(licenseId)}`,
        {
          headers: adminHeaders(),
          cache: "no-store"
        }
      );
      const result = (await response.json()) as {
        license?: HostelLicenseDetailDTO;
      };
      if (!response.ok || !result.license) {
        setDetailError(
          safeErrorMessage(response.status, "License 详情读取失败。")
        );
        return;
      }
      setDetail(result.license);
    } catch {
      setDetailError("License 详情读取失败。");
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div data-testid="hostel-admin-panel">
      <section className="mb-5 rounded-md border border-line bg-white p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold">AI民宿 License 管理</h2>
            <p className="mt-2 text-sm text-muted">
              查看 License 库存、有效状态和激活设备。本页面不会修改任何 License 数据。
            </p>
          </div>
          <span className="w-fit rounded-md bg-amber-50 px-3 py-2 text-sm font-semibold text-warn">
            当前为只读管理模式
          </span>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading || !adminPassword}
          className="mt-4 h-10 rounded-md border border-line px-4 text-sm font-semibold disabled:opacity-60"
        >
          刷新只读数据
        </button>
      </section>

      {error && (
        <section className="mb-5 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-alert">
          {error}
        </section>
      )}

      <section className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-5">
        {overviewCards.map((card) => (
          <div key={card.key} className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">{card.label}</div>
            <div className="mt-1 text-2xl font-semibold">
              {overview?.[card.key] ?? (loading ? "…" : 0)}
            </div>
          </div>
        ))}
      </section>

      <section className="mb-5 rounded-md border border-line bg-white p-4">
        <h3 className="text-xl font-semibold">License 精确搜索</h3>
        <p className="mt-2 text-sm text-muted">
          输入完整 License Key。输入内容只用于本次服务端 Hash 查询，不会出现在网址或长期存储中。
        </p>
        <form onSubmit={searchLicense} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={licenseKey}
            onChange={(event) => setLicenseKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-11 flex-1 rounded-md border border-line px-3 font-mono outline-none focus:border-brand"
            placeholder="HOSTEL-XXXX-XXXX-XXXX"
            aria-label="完整 License Key"
          />
          <button
            disabled={searching || !licenseKey.trim() || !adminPassword}
            className="h-11 rounded-md bg-ink px-5 font-semibold text-white disabled:opacity-60"
          >
            {searching ? "查询中…" : "精确查询"}
          </button>
        </form>
        {searchMessage && <p className="mt-3 text-sm text-muted">{searchMessage}</p>}
        {searchResult && (
          <div className="mt-4 flex flex-col gap-3 rounded-md bg-panel p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <span className={`rounded-md px-2 py-1 font-semibold ${statusClass(searchResult.status)}`}>
                {statusLabels[searchResult.status]}
              </span>
              <span className="ml-3">License ID：{searchResult.id}</span>
              <span className="ml-3">
                设备：{searchResult.activeActivationCount}/{searchResult.maxActivations}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void loadDetail(searchResult.id)}
              className="h-9 rounded-md border border-line bg-white px-3 text-sm font-semibold"
            >
              查看详情
            </button>
          </div>
        )}
      </section>

      <section className="mb-5 rounded-md border border-line bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-xl font-semibold">License 列表</h3>
            <p className="mt-1 text-sm text-muted">按创建时间倒序，只显示安全字段。</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as HostelLicenseStatusFilter);
                setCursorHistory([]);
              }}
              className="h-10 rounded-md border border-line px-3"
              aria-label="License 状态筛选"
            >
              <option value="all">全部状态</option>
              <option value="unused">未使用</option>
              <option value="activated">已激活</option>
              <option value="expired">已过期</option>
              <option value="revoked">已撤销</option>
            </select>
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setCursorHistory([]);
              }}
              className="h-10 rounded-md border border-line px-3"
              aria-label="每页数量"
            >
              <option value={25}>每页25条</option>
              <option value={50}>每页50条</option>
              <option value={100}>每页100条</option>
            </select>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <thead className="bg-panel text-muted">
              <tr>
                <th className="p-3">状态</th>
                <th className="p-3">套餐</th>
                <th className="p-3">设备</th>
                <th className="p-3">到期时间</th>
                <th className="p-3">创建时间</th>
                <th className="p-3">更新时间</th>
                <th className="p-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {licenses.map((license) => (
                <tr key={license.id} className="border-t border-line">
                  <td className="p-3">
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusClass(license.status)}`}>
                      {statusLabels[license.status]}
                    </span>
                  </td>
                  <td className="p-3">商业版</td>
                  <td className="p-3">
                    {license.activeActivationCount}/{license.maxActivations}
                  </td>
                  <td className="p-3">{formatDate(license.expiresAt)}</td>
                  <td className="p-3">{formatDate(license.createdAt)}</td>
                  <td className="p-3">{formatDate(license.updatedAt)}</td>
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() => void loadDetail(license.id)}
                      className="rounded-md border border-line px-3 py-2 font-semibold"
                    >
                      查看详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && licenses.length === 0 && (
            <div className="p-5 text-center text-sm text-muted">暂无符合条件的 License</div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            disabled={loading || cursorHistory.length === 0}
            onClick={() => {
              const history = cursorHistory.slice(0, -1);
              const previousCursor = cursorHistory.at(-1) ?? null;
              void changePage(previousCursor, history);
            }}
            className="h-10 rounded-md border border-line px-4 text-sm font-semibold disabled:opacity-40"
          >
            上一页
          </button>
          <span className="text-sm text-muted">
            当前 {licenses.length} 条{loading ? " / 加载中…" : ""}
          </span>
          <button
            type="button"
            disabled={loading || !nextCursor}
            onClick={() => {
              if (!nextCursor) return;
              void changePage(nextCursor, [...cursorHistory, currentCursor]);
            }}
            className="h-10 rounded-md border border-line px-4 text-sm font-semibold disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </section>

      {selectedLicenseId && (
        <section className="rounded-md border border-line bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xl font-semibold">License 详情</h3>
            <button
              type="button"
              onClick={() => {
                setSelectedLicenseId("");
                setDetail(null);
                setDetailError("");
              }}
              className="rounded-md border border-line px-3 py-2 text-sm"
            >
              关闭详情
            </button>
          </div>
          {detailLoading && <p className="mt-4 text-sm text-muted">详情加载中…</p>}
          {detailError && <p className="mt-4 text-sm text-alert">{detailError}</p>}
          {detail && (
            <>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <DetailItem label="License ID" value={detail.id} />
                <DetailItem label="有效状态" value={statusLabels[detail.status]} />
                <DetailItem label="套餐" value="商业版" />
                <DetailItem
                  label="设备数量"
                  value={`${detail.activeActivationCount}/${detail.maxActivations}`}
                />
                <DetailItem
                  label="当前可用设备"
                  value={String(detail.usableActivationCount)}
                />
                <DetailItem label="到期时间" value={formatDate(detail.expiresAt)} />
                <DetailItem label="创建时间" value={formatDate(detail.createdAt)} />
                <DetailItem label="更新时间" value={formatDate(detail.updatedAt)} />
              </div>

              <h4 className="mt-6 text-lg font-semibold">激活设备记录</h4>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                  <thead className="bg-panel text-muted">
                    <tr>
                      <th className="p-3">设备名称</th>
                      <th className="p-3">首次激活</th>
                      <th className="p-3">最近验证</th>
                      <th className="p-3">当前状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.activations.map((activation) => (
                      <tr key={activation.id} className="border-t border-line">
                        <td className="p-3">{activation.deviceName}</td>
                        <td className="p-3">{formatDate(activation.activatedAt)}</td>
                        <td className="p-3">{formatDate(activation.lastSeenAt)}</td>
                        <td className="p-3">
                          {activation.isUsable
                            ? "已绑定，可用"
                            : activation.isBound
                              ? "已绑定，License 当前不可用"
                              : `已解绑（${formatDate(activation.revokedAt)}）`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.activations.length === 0 && (
                  <div className="p-4 text-sm text-muted">暂无设备激活记录</div>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-panel p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 break-all text-sm font-semibold">{value}</div>
    </div>
  );
}
