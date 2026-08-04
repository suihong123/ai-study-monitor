# v0.9 托管 Supabase 验收结果

> 执行日期：2026-07-30  
> 数据库结论：通过  
> 后续状态（2026-08-04）：独立 Preview、密钥轮换、真实 Qwen 和核心真机验收已完成；当前进入 Release Candidate 整理，尚未迁移或部署生产。

## 1. 隔离环境

- Supabase 组织：`ai-study-monitor-v09-staging`
- 最终验收项目：`ai-study-monitor-v09-final-test`
- project ref：`STAGING_PROJECT_REF_REDACTED`
- 项目 URL：`https://STAGING_PROJECT_REF_REDACTED.supabase.co`
- 区域：Canada Central（连接池为 `ca-central-1`）
- 连接：Supabase session pooler，PostgreSQL 17.6，数据库时区 UTC
- 数据：19 个脱敏构造访问码，不含生产访问码、儿童画面、真实 IP 或真实 User-Agent
- 初始化基线：生产 v0.8 对应提交 `98088ff` 中的 `supabase/schema.sql`
- 生产连接：未执行、未迁移、未写入

第一次测试项目验证出函数授权问题后已删除；该项目仅包含脱敏测试结构与数据，不具备恢复价值。最终结果来自重新创建的全新项目，不是手工修补后的数据库。

## 2. 迁移执行

| 项目 | 结果 |
| --- | --- |
| 迁移文件 | `supabase/migration_2026_18_device_rebind_mvp.sql` |
| 开始时间 | 2026-07-30T02:24:59.118Z |
| 结束时间 | 2026-07-30T02:25:00.513Z |
| 耗时 | 1,395 ms |
| 是否成功 | 是 |
| 是否回滚 | 否 |
| 锁等待 | 未观察到 |
| WARNING | 0 |
| NOTICE | 1 条预期兼容提示：删除 v0.8 中不存在的旧约束时使用 `if exists` |
| 字段、约束、索引或函数创建失败 | 0 |

初次托管验证发现：Supabase 会给新函数显式授予 `anon` 和 `authenticated` 执行权，只撤销 `public` 不能阻止这两个角色调用。最终迁移与完整 schema 已改为同时撤销 `public`、`anon`、`authenticated`，然后仅授予 `service_role`；该修复已在全新项目重新完整验证。

## 3. 只读验证与权限

- `supabase/verify_2026_18_device_rebind_mvp.sql` 共 9 条查询，全部通过；
- 新字段、配置表、日志表和 3 个数据库函数均存在；
- 函数定义与 `supabase/schema.sql` 一致；
- 旧字段 `free_rebind_count`、`rebind_cost_minutes` 不存在；
- 默认规则为 15 天、10 次、60 秒；
- 11 张业务表全部启用 RLS；
- 3 个重新绑定函数均为 `security definer`，固定 `search_path=public`；
- `service_role` 可执行，`anon` 和 `authenticated` 均不可执行；
- 匿名和登录用户在 RLS 下读取访问码数量均为 0，`service_role` 可读取 19；
- 可用扩展包括 `pg_stat_statements`、`pgcrypto`、`plpgsql`、`supabase_vault`、`uuid-ossp`。

## 4. 迁移前后权益

| 数据 | 迁移前 | 迁移后 | 结论 |
| --- | ---: | ---: | --- |
| 访问码 | 19 | 19 | 一致 |
| 历史会话 | 16 | 16 | 一致 |
| 活跃会话 | 6 | 6 | 一致 |
| 监督记录 | 48 | 48 | 一致 |
| 报告成功记录 | 10 | 10 | 一致 |

逐访问码 JSON 快照深度比较完全一致，包括套餐、总分钟、已用分钟、剩余分钟、状态、原 `device_id`、会话、记录和报告数量。允许新增的环境字段、配置、日志和异常标记不影响原权益。

## 5. 真实数据库规则

| 场景 | 结果 | 核心证据 |
| --- | --- | --- |
| 首次绑定 | 通过 | `first_activated`；窗口次数 0；分钟不变 |
| 同环境进入 | 通过 | `already_active`；不记次数；不触发 60 秒 |
| 第一次重新绑定 | 通过 | `rebound`；0 → 1；旧令牌失效；分钟不变 |
| 60 秒限制 | 通过 | 第三个环境返回 `rate_limited`；计数不变 |
| 第 10 次 | 通过 | 允许，窗口次数变为 10 |
| 第 11 次 | 通过 | `window_limit_reached`；返回 `nextAvailableAt`；次数不增加 |
| 滚动 15 天恢复 | 通过 | 超出窗口的最早记录退出统计；下一次允许 |
| 幂等 | 通过 | 相同请求 ID 返回 `replayed: true`；不重复切换或轮换 |
| 事务回滚 | 通过 | 中途强制失败后环境、令牌、日志、次数和分钟全部恢复 |
| 管理员重置 | 通过 | 原令牌失效；原因留痕；不占用户次数；分钟不变 |

所有时间边界均由数据库 `now()` 计算，没有依赖客户端时间。

## 6. 托管并发

- 两个独立连接在 `2026-07-30T02:25:19.489Z` 同时发起不同环境的重新绑定；
- 一个返回 `rebound`，另一个根据锁释放后的最新状态返回 `rate_limited`；
- 只新增 1 条用户成功日志，窗口次数只增加 1；
- 最终环境为成功端 `hosted-concurrent-a`；
- 请求完成约 456 ms，无死锁、无超时、监督分钟不变。

这证明托管 Supabase session pooler 下，访问码行锁和事务边界按设计生效。

## 7. 网络与延迟

- 首次简单查询往返约 224 ms；
- 迁移和业务规则在远程连接池上完成；
- 未出现连接中断、锁超时或语句超时；
- 该数据只代表本次测试时段和区域，不等同于中国大陆真机端到端延迟。

## 8. 已修复问题

| 问题 | 影响 | 修复文件 |
| --- | --- | --- |
| Supabase 默认向 `anon`/`authenticated` 授予函数执行权 | 浏览器角色可能绕过服务端直接调用高权限数据库函数 | `supabase/migration_2026_18_device_rebind_mvp.sql`、`supabase/schema.sql`、`tests/device-rebind.test.ts` |
| 测试部署可能误连生产 Supabase | 测试操作可能污染生产数据 | `lib/environment-safety.ts`、`lib/supabase/server.ts`、`lib/supabase/client.ts`、`tests/environment-safety.test.ts` |
| 测试站点缺少显著标识 | 真机验收可能误把测试站点当生产 | `app/layout.tsx` |

## 9. 初次托管验收时的未完成项与后续结果

- 2026-07-30 初次托管数据库验收结束时，独立 Vercel 测试站点、真机和测试 secret 轮换尚未完成；这是历史时点，不代表当前状态。
- 后续已创建独立 Preview 和固定验收地址，测试 secret 已撤销并轮换，Development 与 Production 未配置测试变量。
- 后续已完成同环境恢复、Mac→手机重新绑定、再次进入稳定、监督中被新环境接管及真实 Qwen 调用等核心真机验收。
- 已接受 Known Limitation：Qwen 上游已经开始处理后发生 Abort 时，无法实机证明上游连接立即终止；旧请求零业务影响，极端情况下可能多一次模型调用费用。

## 10. 工程回归

文案缺口修复后重新执行：

| 检查 | 结果 |
| --- | --- |
| TypeScript | 通过 |
| 自动测试 | Release Candidate 整理后 6 个测试文件、58 项测试全部通过 |
| Lint | 通过，无 warning/error |
| 生产构建 | 通过，20 个路由/页面生成完成 |
| `git diff --check` | 通过 |

构建仅出现 Next.js/Tailwind 依赖链的 CommonJS/ESM 实验性提示，没有编译、类型或页面生成失败。

## 11. 当前结论

托管数据库部分通过：迁移、权限、RLS、19 码权益、事务、并发、幂等、回滚和管理员重置均达到要求。

托管数据库验收通过，后续测试部署和核心真机功能验收也已完成。当前不再存在功能验收阻断项，但仍须先完成并审核可复现 Release Candidate；本文不代表已经执行生产迁移、部署、主分支合并或远程推送。
