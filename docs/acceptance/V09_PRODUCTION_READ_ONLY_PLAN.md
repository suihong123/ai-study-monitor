# v0.9 生产上线前只读预检与回退计划

> 本文件是执行计划，不代表已经检查或迁移生产。  
> v0.9 功能验收已经完成；本文件仅定义 Release Candidate 通过后的生产执行步骤，不代表已经迁移或部署生产。

## 1. 上线门禁

进入生产前必须同时满足：

1. 独立测试站点只连接隔离 Supabase；
2. 测试项目中曾暴露的 secret key 已撤销并轮换；
3. 项目负责人已确认 v0.9 功能验收完成，Known Limitation 已记录并接受为非阻断；
4. 托管迁移、RLS、权限、并发、幂等和回滚继续通过；
5. TypeScript、自动测试、Lint 和生产构建通过；
6. 项目负责人书面确认上线窗口。

## 2. 生产只读预检

先记录生产版本、当前提交、Supabase project ref 和计划窗口。随后在只读事务中执行：

```sql
begin transaction read only;

select now() as database_now, current_setting('TimeZone') as timezone;

select
  count(*) as access_code_count,
  coalesce(sum(total_minutes), 0) as total_minutes,
  coalesce(sum(used_minutes), 0) as used_minutes
from access_codes;

select
  count(*) as session_count,
  count(*) filter (where status = 'active' and end_time is null)
    as active_session_count
from sessions;

select count(*) as record_count from records;

select count(*) as report_count
from ai_call_logs
where model_type like 'report_%'
  and status = 'success';

select
  access_code.code,
  access_code.plan_type,
  access_code.total_minutes,
  access_code.used_minutes,
  greatest(access_code.total_minutes - access_code.used_minutes, 0)
    as remaining_minutes,
  access_code.status,
  access_code.device_id,
  count(distinct sessions.id) as historical_session_count,
  count(distinct sessions.id) filter (
    where sessions.status = 'active' and sessions.end_time is null
  ) as active_session_count
from access_codes as access_code
left join sessions on sessions.access_code_id = access_code.id
group by access_code.id
order by access_code.code;

rollback;
```

实际执行时使用 `scripts/db-acceptance/snapshot.sql` 生成完整 JSON 快照并保存到受限位置。截图和对外记录必须遮盖完整访问码、令牌、IP 和 User-Agent。

## 3. 活跃会话与低峰窗口

- 上线前确认活跃会话数量；
- 优先选择活跃会话为 0 的低峰时段；
- 若仍有活跃会话，不强制中断，推迟迁移；
- 记录迁移负责人、应用部署负责人、回退负责人和观察人；
- 确认数据库备份/PITR 状态和最近可恢复点；
- 准备 v0.8 当前生产部署的可回退版本。

## 4. 正式顺序

1. 再次执行生产只读快照；
2. 确认备份和低峰；
3. 显式执行 `BEGIN` 并设置事务级锁等待/语句超时；
4. 执行 `migration_2026_18_device_rebind_mvp.sql`；
5. 执行 `verify_2026_18_device_rebind_mvp.sql` 或等价关键结构检查；
6. 执行 `migration_2026_19_supervision_request_isolation.sql`；
7. 执行 `verify_2026_19_supervision_request_isolation.sql`；
8. 在同一事务中生成迁移后同结构快照并完成最终一致性检查；
9. 任一迁移、关键 verify 或一致性检查失败时执行 `ROLLBACK`；全部通过时才执行 `COMMIT`；
10. 只有权益、分钟、会话、记录和报告完全一致时才部署 v0.9；
11. 部署后使用专用生产验收码做最小烟雾测试；
12. 观察错误率、重新绑定结果、旧令牌拒绝、会话结算和分钟变化。

任一步失败即停止，不绕过验证。

## 5. 数据库迁移失败

- 迁移文件自身不声明事务；必须由发布执行器显式 `BEGIN`，任一迁移或关键核验失败时执行 `ROLLBACK`；
- 不手工补字段或修改结果；
- 保持 v0.8 应用；
- 保存错误、锁等待和数据库日志；
- 在隔离项目修复迁移并从 v0.8 基线重新完整验证。

## 6. 数据库成功但应用异常

若 migration 18/19 已成功、v0.9 应用异常：

- 立即把应用回退到已记录的 v0.8 部署；
- 保留 migration 18/19 新增的兼容字段、表和函数，不做危险的反向删表；
- v0.8 不使用新增重新绑定结构，可继续原流程；
- 暂停用户自助重新绑定入口；
- 核对活跃会话、分钟和错误日志；
- 修复后仍按“隔离验证 → 测试部署 → 真机验收 → 生产部署”重新走门禁。

## 7. 上线后最小验收

- 原 v0.8 访问码可正常进入，权益和剩余分钟不变；
- 首次环境不计次数；
- 新环境弹窗文案正确；
- 一次重新绑定不扣分钟且旧环境失效；
- 后台可查看原因、来源和前后环境；
- 生产日志中无匿名角色直接执行数据库函数；
- 测试项目和生产项目的 URL、ref、密钥始终互不交叉。

## 8. 已接受的 Known Limitation

真实 Qwen 上游已经开始处理后发生 Abort 时，无法实机证明上游连接立即终止。客户端旧响应隔离和数据库令牌门禁已验证，旧请求不会写识别记录或 AI 调用日志，不会更新提醒、监督状态、报告、计时或套餐权益，也不影响数据库一致性；极端情况下可能多一次模型调用费用。项目负责人已接受该限制，不作为 v0.9 发布阻断项。
