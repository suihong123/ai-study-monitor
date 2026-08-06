# 优化前复盘：Supabase Free Plan 每日只读保活

> 日期：2026-08-06
> 状态：Release Candidate 验证完成，Production 发布已获确认
> 负责人：项目负责人 / Codex
> 关联范围：内部 API、Vercel Cron、环境变量、自动测试、运维文档

## 1. 当前基线

- 当前产品阶段：v0.9 已完成生产数据库迁移、Production Deploy 和最终真机烟雾测试，生产发布通过。
- 当前代码/版本：`codex/device-rebind-mvp`，Release Candidate `68ed8d42e97cd4b8a9d08e8f62b14f89a4ff306f`，应用版本 `0.9.0`，工作树干净。
- 与本次相关的现有流程：Vercel 已配置每日会话超时清理 Cron；服务端通过 Supabase service role 访问生产数据库。
- 已确认事实：Supabase 生产项目使用 Free Plan；项目负责人希望通过每天一次极轻量只读请求降低连续低活跃导致项目自动暂停的风险。
- 判断或假设：每天一次读取 `access_codes.id limit 1` 足以形成最低成本的数据库活动信号；该操作不承诺覆盖 Supabase 将来可能调整的暂停策略。
- 未知项：Vercel Hobby Cron 在指定小时内可能存在最多约 59 分钟调度偏差，不影响每日一次保活目标。

## 2. 触发问题

- 发生了什么：低活跃生产项目存在被 Supabase Free Plan 自动暂停的运维风险。
- 证据来源：当前生产套餐信息与项目负责人明确要求；不以改写业务数据作为活跃信号。
- 影响的角色：系统维护者，以及依赖服务可用性的家庭用户。
- 影响的核心流程：生产环境持续可用性。
- 影响的业务/质量指标：服务可用性、人工恢复成本。
- 不处理的后果：长期低活跃期间可能需要人工恢复 Supabase，造成短时不可用。

## 3. 本次目标

- 目标：新增受 `CRON_SECRET` 保护的内部只读保活接口，并由 Vercel 每天调用一次。
- 成功标准：未授权返回 401；授权且只读查询成功返回且仅返回 `{ "ok": true }`；查询失败返回 500并只记录脱敏错误；测试证明不调用写方法。
- 本次范围：`/api/cron/keep-alive`、每日 Cron、`CRON_SECRET` 配置说明、最小自动测试、版本与基线文档。
- 明确不做：不修改监督、重新绑定、计时、Qwen、报告、数据库结构、RLS、访问码权益或任何业务数据。

## 4. 规则与口径

- 业务规则不变化；保活请求不属于用户行为、会话、监督或 AI 调用。
- 不新增或更新时间字段，不创建会话、识别记录、AI 日志、报告、错误业务记录或重新绑定日志。
- 不需要数据库迁移；继续使用现有 `access_codes` 表和服务端 Supabase 客户端。
- `CRON_SECRET` 缺失或 Authorization 不匹配时失败关闭；响应不返回数据库、访问码、项目或密钥信息。

## 5. 方案摘要

- 建议方案：Vercel 通过 `Authorization: Bearer $CRON_SECRET` 调用 GET 路由；路由仅执行 `from("access_codes").select("id").limit(1)`。
- Cron：每天 UTC 19:00 运行一次，即北京时间次日约 03:00；Hobby 环境可能在该小时内调度。
- 备选方案：写入专用 heartbeat 表。因会新增结构和写流量，不符合本轮只读最小改动，拒绝。
- 主要风险：Secret 未配置导致 401；数据库不可用导致 500；Vercel Cron 调度存在小时级偏差。
- 回滚/降级方式：从 `vercel.json` 移除该 Cron 和删除独立 API 路由；不涉及数据库回滚。

## 6. 验收与观察

- 功能验收：Preview 手动以 Vercel Cron 同款 Authorization 调用，确认 200 和精确响应体。
- 异常路径：错误 Secret 返回 401；模拟 Supabase 查询失败返回 500；失败日志仅包含安全错误码。
- 数据验证：调用前后访问码、分钟、会话、识别、AI 日志和报告计数不变。
- 设备/浏览器验证：不涉及用户页面或浏览器。
- 上线后观察指标：Cron 200/401/500、Supabase 项目可用状态；每天一次即可。
- 观察窗口：Preview 验证通过后再由负责人决定是否发布 v0.9.1 Production。

## 7. 待确认项

- [x] 项目负责人确认仅做每日只读保活，先在 Preview 验证，不直接部署 Production。

## 8. 实施后回写

- 实际改动：新增 `/api/cron/keep-alive`、只读查询与鉴权辅助模块、5 项自动测试；`vercel.json` 增加每日 UTC 19:00 Cron；新增 `CRON_SECRET` 示例；应用版本更新为 0.9.1。
- 验证结果：`git diff --check`、63 项测试、TypeScript、Lint、Production Build 全部通过；最新 staging Preview Deployment 为 Ready。未授权实测 401，授权实测 200 且响应精确为 `{ "ok": true }`；调用前后 8 张业务/日志表计数、23 个测试访问码完整快照、总分钟 245880、已用分钟 1033 和活跃会话 0 全部一致。Preview 日志只有一条 401 和一条 200，无 500。
- 与原方案的差异：无。Cron 选择 `0 19 * * *`，对应北京时间约 03:00；Hobby 调度可能在该小时内执行。
- 遗留问题：每天一次只读请求用于降低低活跃暂停风险，不构成对 Supabase 将来暂停策略的永久保证；Production 必须使用独立 `CRON_SECRET` 并完成首次人工调用验收。
- 基线文档更新：已同步 README、项目资料中心、项目基线、业务状态、迭代机制和复盘索引。
- 最终状态：v0.9.1 Release Candidate 验证完成，Production 发布已获负责人确认；按当前发布任务执行。
