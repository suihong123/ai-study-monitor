# 优化前复盘：Hostel License 首次激活后计时

> 日期：2026-08-27
> 状态：Preview 已完成，待 Production Migration 审批
> 负责人：项目负责人 / Codex
> 关联范围：Study Admin 只读展示 / Hostel License Schema、RPC、生成脚本与 Preview

## 1. 当前基线

- 当前产品阶段：AI 学习监督 Production 稳定运行；Study Admin 已上线 Hostel License 只读查看。AI 民宿 v1.2.0 已上线，经营数据保持 Local First。
- 当前代码/版本：Study `02524f7`；Hostel `f48850b`。
- 与本次相关的现有流程：Hostel License 在库存生成时写入固定 `expires_at`，首次激活只改变状态并创建设备激活记录；Study Admin 假设 `expires_at` 永不为空。
- 已确认事实：Hostel Production 当前有 100 枚 License（99 unused、1 activated）和 1 条 activation；Study 与 Hostel 共用 Supabase 基础设施但表、RPC 隔离。
- 判断或假设：未使用 License 在售出前消耗有效期不符合“一年版从首次激活开始”的商业口径。
- 未知项：Production Migration 的最终执行窗口与操作人尚未确认。

## 2. 触发问题

- 发生了什么：未使用 License 的有效期从库存生成时间开始，可能在交付客户前已经缩短。
- 证据来源：Hostel `database/license-schema.sql`、License 生成脚本及 Study Admin DTO/展示实现。
- 影响的角色：购买 AI 民宿 License 的客户与查看库存的管理员。
- 影响的核心流程：库存生成、首次激活、远端复验、后台到期时间展示。
- 影响的业务/质量指标：客户实际可用天数、售后解释成本、License 状态可信度。
- 不处理的后果：长期库存无法保证客户从首次激活日起获得完整 365 天。

## 3. 本次目标

- 目标：Hostel unused License 不开始计时，首次成功激活在同一事务内设置 365 天到期时间；Study Admin 安全兼容空到期时间。
- 成功标准：并发首次激活只设置一次到期时间；同设备重复激活和第二设备不延长；失败事务不开始计时；异常 `activated + NULL` 被拒绝；Preview 验收通过。
- 本次范围：Study Admin nullable DTO/筛选/展示；Hostel Schema、RPC、生成器、Migration、测试与 Preview。
- 明确不做：不执行 Production Migration；不修改 Production 100 枚库存；不新增 revoke/restore/unbind/修改到期时间；不改变 License Key/Hash；不改变 Study 权益或数据；不改 Hostel IndexedDB 模型。

## 4. 规则与口径

- 需要确认的业务规则：Hostel License 固定为首次成功激活后 365 天，最多 2 台设备；revoked 判断优先。
- 会变化的数据/指标口径：unused 的 `expires_at` 改为 `NULL`；Admin 统一展示“首次激活后开始计算”。
- 兼容旧数据的方式：Study Admin 先兼容旧的非空 unused 和新的空 unused；Migration 仅把 unused 行置空，已激活 License 原到期时间保持不变。
- 隐私、安全或权益影响：不读取或输出明文 License/Hash；不触碰 Study 数据；经营数据继续仅保存在客户 IndexedDB。

## 5. 方案摘要

- 建议方案：采用方案 A，在现有 Hostel License 行锁和事务中首次写入 `expires_at = now() + interval '365 days'`。
- 备选方案：增加 first_activated_at/duration_days；本次不采用，避免扩表和超前设计。
- 选择理由：改动最小，保持现有 API、Cookie、HMAC、设备限制与远端复验行为。
- 主要风险：旧 Admin 不接受 NULL；并发首次激活重复计时；异常 activated+NULL 被误放行；Production Migration 中断。
- 回滚/降级方式：Migration 使用单事务和前后断言，执行失败自动回滚；执行前保存 Hostel 到期字段快照。若 Migration 后尚无新激活，可用快照恢复旧到期值和旧 RPC；一旦有新规则激活，停止语义回滚并采用前滚修复。

## 6. 验收与观察

- 功能验收：unused NULL、首次激活 365 天、重复/第二设备不延长、异常 NULL 拒绝、revoked 优先。
- 异常路径：无效 Key、第三设备、过期、撤销、事务回滚、并发首次激活。
- 数据验证：仅创建/修改隔离测试 License；Production 只做只读基线核验。
- 设备/浏览器验证：Study Admin Preview 展示 NULL 文案，列表、详情、搜索和原 Study Admin 不回归。
- 上线后观察指标：首次激活返回非空到期时间；activated+NULL 数量恒为 0；unused+非空数量恒为 0。
- 观察窗口：Production Migration 后首个内部测试 License 与首位客户交付。

## 7. 待确认项

- [x] 方案 A 与业务规则已由项目负责人确认。
- [ ] Preview 全量验收完成后，由项目负责人单独批准 Production Migration。

## 8. 实施后回写

- 实际改动：Study Admin 的 Hostel `expires_at` DTO 改为 nullable；Repository 同时兼容旧 unused 非空到期时间与新 unused NULL；列表和详情统一显示“首次激活后开始计算”；异常 activated/expired + NULL 返回数据库值异常。Hostel 代码线另行完成 Schema、RPC、生成脚本、单事务 Migration 与隔离 PostgreSQL 验收。
- 验证结果：Study TypeScript、ESLint、78 项测试与 Production Build 全部通过；其中 Hostel Admin 15 项专项测试通过。Preview `dpl_9HL5Bsk2uUDDH3LKjviVnrvDJxp8` 构建为 READY，公开部署资源已确认包含 NULL 到期文案。Production 只读基线仍为 Study 20 access_codes / 80 sessions，Hostel 100 License / 1 activation。
- 与原方案的差异：Preview 数据库仍是尚未迁移的 Production 旧基线，因此页面真实列表只能回归旧非空到期时间；NULL 展示由自动测试、构建产物和隔离数据库验证，不创建或激活正式库存。
- 遗留问题：Production Migration 本轮明确不执行；执行前仍需负责人单独确认并保存安全快照。
- 基线文档更新：本复盘与 Hostel Migration Runbook；Study 永久时长权益不变。
- 最终状态：代码与 Preview 验收完成，等待 Production Migration 审批。
