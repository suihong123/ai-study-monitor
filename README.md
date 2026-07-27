# AI学习监督助手（MVP版）

面向中国家庭的小学生学习监督系统。定位是 AI学习监督员，只做学习监督、状态分析、状态提醒、学习报告和访问码管理。

## 项目资料入口

后续优化统一先从项目基线复盘开始：

- [项目资料中心](docs/README.md)
- [项目全景基线](docs/PROJECT_BASELINE.md)
- [业务现状基线](docs/BUSINESS_STATUS.md)
- [迭代与优化前复盘机制](docs/ITERATION_PLAYBOOK.md)
- [历次复盘记录](docs/reviews/README.md)

当前基线日期为 2026-07-27，代码基准为 `07f7d42`。仓库只能证明产品能力，不能证明线上用户、收入、转化或留存；这些经营数据目前统一标记为待补充。

## 已实现范围

- 首页输入访问码后开始监督
- 手机浏览器调用摄像头，使用 `getUserMedia()`
- 摄像头准备后立即做一次状态分析，之后按套餐、学习时长和状态动态调整识别频率
- 底层兼容六种历史状态，当前用户侧统一表达为“学习中”“离座”“无法判断”
- 离座或无法判断达到条件后播放语音/蜂鸣提醒，并动态调整提醒冷却
- 结束监督后写入 `sessions`、`records`，扣减访问码时长
- 所有套餐暂时统一生成基于真实记录统计的基础报告
- 访问码设备绑定和永久有效的总时长权益
- `/admin` 后台创建访问码、查看额度、查看使用记录、禁用访问码和解绑设备

## 套餐

- `trial` 2小时体验版：总额度 120 分钟，基础识别 90 秒，最低 60 秒，基础报告
- `basic_monthly` 月卡：总额度 3600 分钟，基础识别 90 秒，最低 60 秒，基础报告
- `standard_monthly` 季卡：总额度 10800 分钟，基础识别 60 秒，最低 30 秒，基础报告
- `pro_monthly` 年卡：总额度 43200 分钟，基础识别 30 秒，最低 15 秒，基础报告

所有套餐和体验卡都不设置日期有效期。成功创建监督会话后开始计算时长，不使用时不扣减；总时长用完后停止访问。

## 页面

- `/` 首页
- `/supervise` 监督页
- `/report` 学习报告页
- `/admin` 管理后台

## API

- `POST /api/analyze`：根据后台配置执行 Mock 或 Qwen 视觉分析
- `POST /api/report`：根据真实监督记录生成基础报告
- `GET /api/access-code`：后台查看访问码
- `POST /api/access-code`：验证、创建、禁用、解绑访问码
- `PATCH /api/access-code`：结束监督、保存记录、扣减时长
- `POST /api/access-code/verify`：访问码验证兼容入口
- `POST /api/session/start`：开始监督兼容入口
- `POST /api/session/end`：结束监督兼容入口
- `POST /api/client-error`：记录摄像头权限等前端错误
- `GET/POST /api/admin/model-config`：后台查看和更新视觉模型配置

## Supabase 建表

新项目在 Supabase SQL Editor 执行：

```sql
-- 见 supabase/schema.sql
```

文件路径：`supabase/schema.sql`

如果已经执行过旧版 SQL，再执行：

```sql
-- 见 supabase/migration_2026_06_plan_reports.sql
```

文件路径：`supabase/migration_2026_06_plan_reports.sql`

本轮识别质量字段迁移：

```sql
-- 见 supabase/migration_2026_07_records_accuracy.sql
```

文件路径：`supabase/migration_2026_07_records_accuracy.sql`

新增观测和风控表：

- `error_logs`：错误日志
- `ai_call_logs`：AI调用日志和成本
- `suspicious_logs`：可疑访问、限流、多设备和无效访问记录
- `sessions.session_token`：本次监督会话令牌
- `records.current_frequency_seconds`、`triggered_reminder`、`ai_called`、`error_message`：单次识别时间线调试字段
- `records.confidence`、`reason`、`analyze_mode`、`manual_corrected`、`correction_source`、`corrected_at`：识别质量评估和手动纠错字段

视觉模型后台配置迁移：

```sql
-- 见 supabase/migration_2026_15_ai_model_configs.sql
```

文件路径：`supabase/migration_2026_15_ai_model_configs.sql`

- `ai_model_configs`：当前启用的视觉模型、接口地址和预估单次识别成本

第一轮产品地基迁移：

```text
supabase/migration_2026_17_permanent_entitlements_settlement.sql
```

该迁移会清空访问码日期有效期、统一基础报告、增加隐私说明确认字段，并建立原子会话结算函数。部署新版应用前必须先执行。

## 环境变量

在 Vercel Project Settings 里配置：

```bash
NEXT_PUBLIC_SUPABASE_URL=你的Supabase项目URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=你的Supabase anon key
SUPABASE_URL=你的Supabase项目URL
SUPABASE_SERVICE_ROLE_KEY=你的Supabase service role key
ADMIN_PASSWORD=后台管理密码
QWEN_API_KEY=Qwen服务端密钥
QWEN_API_URL=Qwen接口地址
QWEN_MODEL=Qwen模型名
ANALYZE_MODE=mock
DEEPSEEK_API_KEY=预留的DeepSeek服务端密钥
```

说明：

- 浏览器不直接读写 Supabase 表。
- API Routes 使用 `SUPABASE_SERVICE_ROLE_KEY` 写入访问码、会话和记录。
- `ADMIN_PASSWORD` 用于保护 `/admin` 的接口操作。
- AI API Key 只能放在服务端环境变量里，不得写入前端代码。
- `ANALYZE_MODE` 默认为 `mock`；设置为 `qwen` 时尝试调用 Qwen-VL，Qwen 环境变量缺失会自动回退 Mock 并写入错误日志。
- 后台“视觉模型配置”会优先于 `ANALYZE_MODE`、`QWEN_API_URL`、`QWEN_MODEL` 生效；如果未执行模型配置迁移或未配置后台模型，则自动回退环境变量。

## 后台使用

访问 `/admin`，输入 `ADMIN_PASSWORD` 后可查看：

- 今日新增访问码、监督次数、监督分钟数、AI调用次数、预估成本、报告次数、错误次数、可疑访问次数
- 所有 sessions 列表和单次监督详情
- 错误日志、AI调用日志、风险记录
- 按访问码统计的调用次数、预估成本、平均每小时成本、平均每次监督成本、报告成本
- 访问码禁用、解绑设备、总时长补偿和扣减
- 视觉模型配置：可在 `qwen3.6-flash` 稳定模型和 `qwen3-vl-flash` 低成本候选之间切换，也可以填写自定义模型名和预估单次识别成本

## Rate Limit

MVP 阶段使用内存版限流，后续可替换为 Redis。

- 单个访问码：`analyze` 每分钟最多 6 次
- 单个访问码：`report` 每分钟最多 2 次
- 单个访问码：访问码验证每分钟最多 10 次
- 单个 IP：访问码验证每分钟最多 10 次
- 单个 IP：`analyze` 每分钟最多 20 次

触发限流会返回 `429`，并写入 `suspicious_logs` 和 `error_logs`。

## 安全机制

- 开始监督时后端生成 `session_token`
- `/api/analyze`和结束监督接口必须携带 `accessCodeId`、`sessionId`、`sessionToken`
- 结束监督后 `session_token` 失效
- 已结束报告使用独立的 `report_token` 只读访问，不能用于调用监督接口
- 访问码首次使用绑定 `device_id`
- 换设备使用会提示“该访问码已绑定其他设备，请联系客服解绑。”
- 服务端不采用前端提交的持续时长、AI调用次数、套餐、报告等级和额度字段
- analyze 和心跳会检查访问码状态、总剩余时长和 session 有效性
- 会话结束和总时长扣减通过数据库函数原子完成，同一会话重复结算不会重复扣减
- 多设备尝试、无效访问码、限流、额度不足继续调用、session_token 错误都会记录风险日志

## 访问码生命周期

访问码状态：

- `active`：正常使用
- `watch`：观察中，允许继续使用，后台标红并继续记录所有日志
- `paused`：暂停使用，禁止开始监督和调用核心 API
- `refunded`：退款冻结，禁止继续使用，保留历史数据
- `expired`：历史兼容状态；新业务不再按日期自动过期
- `disabled`：永久禁用，禁止继续使用，不建议恢复
- `blacklist`：黑名单，禁止继续使用，并写入风险日志

后台 `/admin` 可直接处理：

- 退款冻结：找到访问码，点击“退款冻结”，填写原因，状态立即变为 `refunded`
- 额度补偿：点击“加额度”，输入补偿分钟数和原因
- 扣减额度：点击“减额度”，输入分钟数和原因
- 修改总额度
- 套餐调整：点击“改套餐”，选择 `trial`、`basic_monthly`、`standard_monthly`、`pro_monthly`，可选择是否重置已用额度
- 备注：点击“备注”，写入后台运营说明

所有后台操作都会写入 `admin_actions`，包括修改前数据、修改后数据、操作类型和原因。

## Vercel 部署步骤

1. 把代码推送到 GitHub。
2. 在 Supabase 新建项目。
3. 在 Supabase SQL Editor 执行 `supabase/schema.sql`。
4. 在 Vercel 导入 GitHub 仓库。
5. 在 Vercel 配置环境变量。
6. 部署完成后访问线上网址。
7. 打开 `/admin`，输入 `ADMIN_PASSWORD`，选择套餐并创建访问码。
8. 回到首页输入访问码，点击开始监督。

### v0.6 报告迁移

已有项目升级到 v0.6 时，需在 Supabase SQL Editor 执行：

```text
supabase/migration_2026_14_report_access.sql
```

该迁移为 Session 新增独立报告访问令牌，使报告可以在监督结束后刷新和重新打开。

## 手机摄像头要求

- 必须通过 HTTPS 访问。
- Vercel 默认提供 HTTPS，可直接在 iPhone 和 Android 浏览器打开。
- 浏览器首次访问监督页时需要允许摄像头权限。

## 隐私声明

- 不做人脸识别
- 不进行身份识别
- 不保存视频或截图
- 仅分析学习状态
- Qwen 模式会把单帧图片发送给配置的第三方模型
- 保存监督记录和学习报告数据，用于历史报告和习惯趋势

首页默认展示并勾选上述说明；会话保存说明版本和确认时间。当前实现不持久保存截图，因此不存在等待 24 小时删除的图片副本。

## 本地验证

```bash
npm ci
npm run typecheck
npm test
npm run build
```

GitHub Actions 会对每次推送和拉取请求执行相同的类型检查、测试和生产构建。

## 后续候选功能（尚未实现）

- 周报
- 月报
- 微信通知
- 多孩子管理
- 小程序版本
- 订单、支付和自动发码
- 家庭账户与跨设备报告
- DeepSeek 或其他正式高级报告模型接入
