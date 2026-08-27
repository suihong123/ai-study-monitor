# 优化前复盘：Hostel Admin 只读数据禁用缓存

> 日期：2026-08-27
> 状态：代码门禁通过，准备发布
> 负责人：项目负责人 / Codex
> 关联范围：Study Admin 的 Hostel License 五条只读 API

## 1. 当前基线

- Study Production 与 Hostel License Migration 使用同一 Supabase Project。
- Production 数据库中 99 枚 unused License 的 `expires_at` 已为 `NULL`，1 枚 activated License 保留真实到期时间。
- Study Admin 前端已具备 `expires_at = NULL` 的 DTO 与展示兼容，列表响应也已设置 `Cache-Control: private, no-store`。
- 同一 Production Deployment 中，不同 Supabase 查询签名返回了不一致数据：25 条全状态查询仍返回旧到期时间，而 100 条全状态查询及 unused 筛选返回当前 `NULL`。

## 2. 触发问题

- Study Admin 的 Hostel 专用 API 复用了 Study 全局 Supabase Service Role 客户端。
- 该客户端未显式禁止底层服务端 `fetch` 缓存，导致历史查询签名可能继续读取 Migration 前的旧响应。
- 数据库、Repository 映射、API DTO、前端 NULL 展示、Vercel 当前 Deployment 与浏览器 Service Worker 均已只读排除。

## 3. 本次目标

- 为 Hostel Admin 新增独立的服务端 Supabase 客户端，其网络读取统一强制 `cache: "no-store"`。
- 仅将五条 Hostel Admin 只读 API 切换到该客户端。
- 保持 Study 全局 Supabase 客户端、Study 业务链路、Hostel 数据库和 Hostel Production 不变。

## 4. 明确不做

- 不修改或再次执行任何数据库 Migration。
- 不写入 Study 或 Hostel License 数据。
- 不增加生成、撤销、恢复、解绑或其他 License 管理能力。
- 不修改 Hostel Production，不扩大到 Study 其他 Supabase 调用。

## 5. 验收标准

- 99 枚 unused License 统一显示“首次激活后开始计算”。
- 1 枚 activated License 继续显示真实到期时间。
- 精确搜索、详情、Activation 列表及 Study 原后台、用户侧页面正常。
- TypeScript、ESLint、自动测试、Production Build 与 Secret Scan 通过。
- 发布前后 Study 与 Hostel 数据库基线不变，无额外写入。

## 6. 回滚方式

- 如 Production 回归失败，仅回滚本次 Study 代码 Deployment；数据库无需回滚。
- 禁止通过修改数据库数据掩盖缓存问题。

## 7. 实施后回写

- 实际改动：新增 Hostel Admin 专用 Supabase 服务端客户端，在底层 `fetch` 强制使用 `cache: "no-store"`；五条 Hostel Admin 只读 API 改用该客户端。Study 全局客户端和 Repository 均未修改。
- 验证结果：TypeScript、ESLint、79 项全量自动测试（含 16 项 Hostel Admin 专项测试）与 Production Build 全部通过；Secret Scan 未发现受版本控制的真实密钥或私有密钥。
- Production 回归：待本次代码提交发布后执行；数据库不需要也不得修改。
- 最终状态：代码门禁通过，准备发布 Study Production。
