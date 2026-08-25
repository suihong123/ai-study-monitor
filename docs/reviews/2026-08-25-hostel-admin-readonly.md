# 优化前复盘：Study Admin × Hostel License 只读管理

> 日期：2026-08-25
> 状态：本地验证通过，待 Preview 验收
> 负责人：项目负责人 / Codex
> 关联范围：`/admin`、`/api/admin/hostel/*`、Hostel 只读数据访问、自动测试、Preview

## 1. 当前基线

- 当前产品阶段：AI 学习监督 v0.9.1 已在 Production 稳定运行；本轮仅扩展内部管理界面，不改变 Study 或 Hostel 客户端授权系统。
- 当前代码/版本：分支 `codex/hostel-admin-readonly`，起始 Commit `10d3d107cad036e7e517bca0c4023ce2b298c39a`，起始工作树干净。
- 当前 Production：Vercel 项目 `ai-study-monitor`，Deployment `dpl_8QD1BubMkZnKMNppfwBeeJM1fU4d` 为 Ready；`/` 与 `/admin` 均为 HTTP 200。
- Study 数据基线：`access_codes=20`、`sessions=80`；核心 Schema Signature 为 `70df9a14c22c0ad1bc3920d124471fdceb9d0097584fbffd942cbeeb5b5158d1`；会话结算、请求隔离、重新绑定和管理员重置 5 个核心 RPC 均存在。
- Hostel 数据基线：`hostel_licenses=100`、原始/有效状态均为 `unused=99`、`activated=1`；`hostel_license_activations=1`、未解绑记录 `1`；两张表 Schema Signature 为 `a5c9b7219ce538e54ddf847cc57b4df23be3fb5688ede4e7f8b35fe750bc2b34`。
- 已确认事实：Study 与 Hostel 使用同一个 Production Supabase Project；Hostel 两张表字段与前置专项审计一致；本轮基线只执行 SELECT 和元数据查询，没有调用激活/验证 RPC。
- 判断或假设：当前约 100 枚 License 适合采用 25 条默认分页和批量 activation 统计，无需新增索引。
- 未知项：Preview 环境是否已具备读取 Production Hostel 表的正确服务端配置，需要部署前核对，不能从本地配置推断。

## 2. 触发问题

- 发生了什么：目前 Study 与 Hostel 的 License 管理入口分散，负责人希望在现有 Study `/admin` 中统一查看两个产品，但不合并授权系统。
- 证据来源：Study Admin 与 Hostel License 两份专项审计，以及负责人明确批准的第一阶段只读实施范围。
- 影响的角色：唯一管理员。
- 影响的核心流程：License 库存查询、精确搜索、状态核对和激活设备排查。
- 影响的业务/质量指标：后台排查效率、敏感 License 数据保护、Study Production 稳定性。
- 不处理的后果：管理员仍需在不同入口切换，Hostel License 状态与激活记录缺少统一的只读视图。

## 3. 本次目标

- 目标：在 `/admin` 增加“AI学习监督 / AI民宿”产品切换，并提供 Hostel License 概览、分页列表、精确 Hash 搜索、详情和激活记录。
- 成功标准：Hostel API 每次验证 `ADMIN_PASSWORD`，只执行 SELECT；所有 DTO 不含 `key_hash`、`owner_id`、`device_hash`；Study 默认模式行为和 `/api/admin/overview` 响应保持不变。
- 本次范围：独立 Hostel Admin 组件、独立 `/api/admin/hostel/*`、服务端只读 repository、Hash 规范化与测试、Preview 验收。
- 明确不做：任何 Schema、RPC 或数据库数据修改；撤销、恢复、解绑、清空设备、改到期、备注、统一 License Server 或管理员账号系统。

## 4. 规则与口径

- `effectiveStatus`：`revoked` 优先；原始 `expired` 或 `expires_at <= now()` 为 `expired`；其余保持 `unused` 或 `activated`。
- Hash 规范：`trim()`、大写、删除全部 whitespace、保留 `-`、UTF-8、SHA-256、lowercase hex。
- 激活数：`revoked_at is null`；License 有效状态为 expired/revoked 时 `usableActivationCount=0`。
- 分页：默认 25、最大 100，按 `created_at DESC, id DESC` 使用 `created_at + id` Cursor；activation 数量使用第二次批量查询，避免 N+1。
- 隐私与安全：完整 License 只存在临时 React state 和认证后的 POST 请求体；不进入 URL、浏览器持久存储、日志或 API 响应。

## 5. 方案摘要

- 建议方案：保留单一路由 `/admin`，只在已验证后的 Admin 页面增加产品切换；Hostel 面板独立组件并在首次切换后按需加载。
- 数据边界：Hostel repository 只能访问 `hostel_licenses` 和 `hostel_license_activations`，所有查询使用字段白名单。
- 备选方案：`/admin/hostel`。当前认证密码仅保存在 `/admin` React state，会扩大认证和路由改造范围，本轮不采用。
- 主要风险：现有 Admin 页面较大、service role 权限范围广、精确搜索明文泄露、effectiveStatus 口径分叉、列表 N+1。
- 回滚/降级方式：回退单个应用 Commit 或恢复上一 Preview/Production Deployment；本轮无数据库变更，因此无需数据库回滚。

## 6. 验收与观察

- 功能验收：认证、概览、有效状态、筛选、Cursor 分页、精确搜索、详情、设备记录、独立 loading/empty/error。
- 异常路径：无/错密码 401；非法格式 400；未找到 404；数据库错误返回脱敏 500；Hostel 错误不影响 Study 面板。
- 数据验证：实施与 Preview 前后重复读取 Study/Hostel 行数和 Schema Signature，必须完全一致。
- 设备/浏览器验证：Preview `/admin` 默认 Study；未切换时不请求 Hostel API；切换后才加载；Console 无敏感信息和错误。
- 上线后观察指标：本轮不进入 Production；只在 Preview 观察 API 401/4xx/5xx、加载时延和敏感字段。
- 观察窗口：Preview 验收完成后停止，等待负责人决定 Production Go Live。

## 7. 待确认项

- [x] 负责人确认第一阶段只读范围和 Hash/effectiveStatus 口径。
- [x] 生产只读基线正常，Hostel 表字段与专项审计一致。
- [x] Production `service_role` 对两张 Hostel 表具备 SELECT 权限；Preview 环境变量作用域包含同一组服务端 Supabase 配置，仍需通过实际 Preview API 验证。

## 8. 实施后回写

- 实际改动：新增五个 `/api/admin/hostel/*` 只读接口、独立 repository/Hash/DTO 模块、Hostel Admin 错误边界和管理面板；`/admin` 增加产品切换，默认仍为 Study；新增 13 项专项测试。
- 验证结果：`git diff --check`、76 项测试、TypeScript、ESLint、Production Build 全部通过；Build 保留 Study 原路由并新增 5 个动态 Hostel API。
- 与原方案的差异：未拆分三个 UI 子组件，当前第一阶段集中在一个独立 `HostelAdminPanel`，避免扩大现有 Study Admin 改动；异常隔离仍由单独 Error Boundary 保证。
- 遗留问题：需在 Preview 验证真实 Supabase SELECT、精确搜索、分页、详情、激活记录、Console 和数据库前后零修改。
- 基线文档更新：复盘与索引已更新；项目/业务基线将在 Preview 验收后同步为“已完成 Preview、未上线 Production”。
- 最终状态：本地 Release Candidate 验证通过，待 Commit 与 Preview。
