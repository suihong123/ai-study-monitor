# v0.9 独立测试站点准备

> 目标：部署一个不继承生产变量、只连接隔离 Supabase 的 v0.9 测试站点。  
> 当前状态：托管数据库、测试 secret 轮换、独立 Vercel Preview、真实 Qwen 和项目负责人确认的核心真机验收已完成；生产环境未修改。

## 1. 隔离边界

- 新建独立 Vercel 项目，建议名称：`ai-study-monitor-v09-staging`；
- 不链接现有生产 Vercel 项目；
- 不从生产项目复制环境变量；
- 只连接 Supabase 测试 project ref：`STAGING_PROJECT_REF_REDACTED`；
- 测试站点必须显示“v0.9 测试环境”横幅；
- 测试数据只能使用脱敏访问码和专用真机测试码。
- 固定验收地址：`https://STAGING_URL_REDACTED`；
- 独立 Vercel 项目：`ai-study-monitor-v09-staging`；
- 隔离 Supabase project ref：`STAGING_PROJECT_REF_REDACTED`。

代码已增加双重防误连：服务端和浏览器端都校验实际 Supabase project ref、预期测试 ref 和禁止连接的生产 ref。变量缺失或不一致时，staging 构建/运行会直接失败。

## 2. 环境变量分级

### 浏览器可见

| 变量 | 测试值/说明 |
| --- | --- |
| `NEXT_PUBLIC_APP_ENV` | `staging` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://STAGING_PROJECT_REF_REDACTED.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 测试项目 Publishable/anon key |
| `NEXT_PUBLIC_EXPECTED_SUPABASE_PROJECT_REF` | `STAGING_PROJECT_REF_REDACTED` |
| `NEXT_PUBLIC_FORBIDDEN_SUPABASE_PROJECT_REF` | 生产 project ref |

### 仅服务端

| 变量 | 测试值/说明 |
| --- | --- |
| `APP_ENV` | `staging` |
| `SUPABASE_URL` | `https://STAGING_PROJECT_REF_REDACTED.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | 测试项目专用 service role/secret；绝不使用生产值 |
| `EXPECTED_SUPABASE_PROJECT_REF` | `STAGING_PROJECT_REF_REDACTED` |
| `FORBIDDEN_SUPABASE_PROJECT_REF` | 生产 project ref |
| `ADMIN_PASSWORD` | 单独生成的测试后台密码 |
| `ANALYZE_MODE` | 基础流程可先用 `mock`；识别验收再使用测试模型配置 |
| `QWEN_API_KEY` 等 | 仅在真实识别验收需要时配置，保持服务端可见 |

不得把数据库密码、service role/secret、后台密码或模型密钥写进 `NEXT_PUBLIC_*`、Git、截图或验收文档。

## 3. 已完成的测试部署

- 测试 secret 已轮换，最终 key 仅保存在 Supabase 测试项目和 Vercel Preview 加密变量；
- Preview 配置 12 项测试变量，Development 与 Production 作用域均为空；
- 页面横幅公开显示测试环境，并以 `data-supabase-project-ref` 标记测试 project ref；
- 服务端后台接口已成功读取测试数据库及数据库来源的重新绑定配置；
- 测试项目未接入生产域名，未修改生产 Vercel 项目或生产 Supabase。

## 4. 专用真机测试码

已通过测试后台新建一个只用于本轮的访问码，并确认：

- 状态为 active；
- `device_id` 为空；
- 没有历史重新绑定日志；
- 没有活跃会话；
- 不使用 `ISO001`～`ISO019` 数据库验收夹具；
- 验收前记录总分钟、已用分钟和剩余分钟。

实际初始状态为 120/0/120 分钟、未绑定、0 次成功重新绑定、0 条重新绑定日志、0 个会话、无异常标记。访问码仅单独交给项目负责人，不写入仓库。

验收结束后可在测试后台停用该码；不要把它复制到生产。

## 5. 开始真机验收前的停点

以下内容是当时开始真机验收前使用的停点，作为可审计记录保留：

- 测试横幅不存在；
- Supabase project ref 不是本次隔离验收使用的 `STAGING_PROJECT_REF_REDACTED`；
- 页面出现生产访问码或生产数据；
- 浏览器环境中存在 service role/secret；
- 测试 secret key 尚未完成撤销/轮换；
- 专用测试码不是未绑定状态；
- 手机、平板、微信或系统浏览器条件不齐。

## 6. 验收结论与 Known Limitation

v0.9 功能验收已结束。同环境恢复、Mac→手机重新绑定、手机再次进入、监督中被新环境接管、真实 Qwen、原子结算、并发、事务、幂等和数据一致性均已确认。

真实 Qwen 上游已经开始处理后发生 Abort 时，无法实机证明连接立即终止。旧响应不会更新数据、提醒、监督状态、报告、计时或套餐权益；极端情况下可能多一次模型调用费用。项目负责人已接受该限制，不作为发布阻断项。
