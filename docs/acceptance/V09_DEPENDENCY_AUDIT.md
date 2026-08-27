# v0.9 Release Candidate 生产依赖审计

> 审计日期：2026-08-04  
> 命令：`npm audit --omit=dev`  
> 结果：2 个 High；项目负责人已于 2026-08-04 接受 v0.9 本次发布风险。本轮未执行 `npm audit fix --force`，未修改依赖或锁文件。

## 1. Next.js

| 项目 | 结论 |
| --- | --- |
| package | `next` |
| 当前版本 | `14.2.35` |
| 依赖关系 | 应用直接生产依赖 |
| advisory | GHSA-9g9p-9gw9-jx7f、GHSA-h25m-26qc-wcjf、GHSA-ggv3-7p47-pfv8、GHSA-3x4c-7xq6-9pq8、GHSA-q4gf-8mx6-v5v3、GHSA-8h8q-6873-q5fj、GHSA-3g8h-86w9-wvmq、GHSA-ffhc-5mcf-pf4q、GHSA-vfv6-92ff-j949、GHSA-gx5p-jg67-6x7h、GHSA-h64f-5h5j-jqjh、GHSA-c4j6-fc7j-m34r、GHSA-wfc6-r584-vfw7、GHSA-36qx-fr4f-26g5、GHSA-m99w-x7hq-7vfj、GHSA-89xv-2m56-2m9x、GHSA-68g3-v927-f742、GHSA-4633-3j49-mh5q、GHSA-4c39-4ccg-62r3、GHSA-p9j2-gv94-2wf4、GHSA-955p-x3mx-jcvp |
| 漏洞类型 | RSC/Server Actions DoS、缓存混淆/投毒、rewrite 请求走私或 SSRF、Image Optimizer DoS、特定配置下 XSS、WebSocket SSRF、函数端点信息披露等 |
| 当前攻击面 | 应用使用 App Router 和 React Server Components，因此 RSC 相关 DoS/缓存类风险不能排除。当前没有 `next/image`、remotePatterns、rewrites、middleware/i18n、CSP nonce、`beforeInteractive` 非可信输入、WebSocket 自定义升级、custom server 或 `use server` Server Actions，因此这些特定路径未在当前代码中启用。 |
| 官方修复路径 | 当前 `npm audit` 只提供 `next@16.3.0` 作为能够清除聚合结果的修复版本。没有提供 Next.js 14 同 major 修复。 |
| 是否需要升级 Next.js | 是，若要清除该 High；当前审计结果要求升级至 16.3.0。 |
| 是否跨 major | 是，从 14 跨到 16。 |
| 对 v0.9 的潜在影响 | 高。涉及 Next/React 兼容、构建、Lint、App Router、API Routes、Vercel 运行时和全链路真机回归，不适合作为 Release Candidate 清理中的自动修复。 |
| 推荐动作 | **本次发布风险已由项目负责人接受；另开“Next.js 16 安全升级与完整回归测试”。** 不执行 `npm audit fix --force`。该风险已存在于当前生产 v0.8 的同一 `next@14.2.35`，不是 v0.9 新增依赖，但 App Router 相关残余风险真实存在。 |

## 2. PostCSS

| 项目 | 结论 |
| --- | --- |
| package | `postcss` |
| 当前版本 | Next.js 内嵌生产依赖为 `8.4.31`；仓库直接开发依赖解析为 `8.5.23`，后者不在当前受影响范围 |
| 依赖关系 | `next@14.2.35` 的 transitive production dependency，且被 Next 精确固定为 `8.4.31` |
| advisory | GHSA-qx2v-qp2m-jg93、GHSA-6g55-p6wh-862q、GHSA-r28c-9q8g-f849、GHSA-fxqj-rqcc-2cmp |
| 漏洞类型 | CSS stringify XSS、恶意 `sourceMappingURL` 导致任意 `.map` 文件读取/信息泄露和路径遍历 |
| 当前攻击面 | 应用不接收或运行时解析用户提交的 CSS；PostCSS 只在 Vercel 构建阶段处理受信任仓库样式，公网用户不能直接提供 CSS/source map，因此当前生产运行时暴露面低。构建供应链或不受信任代码进入仓库时风险仍存在。 |
| 官方修复版本 | `postcss >= 8.5.23`。但当前不安全实例来自 Next.js 精确固定的嵌套 `8.4.31`。 |
| 是否需要升级 Next.js | 按 `npm audit` 提供的受支持清零路径，需要升级到 `next@16.3.0`。单独使用 package override 可能替换嵌套 PostCSS，但不是 Next.js 14 官方依赖组合，而且不能清除 Next.js 自身 High。 |
| 是否跨 major | 按受支持路径，是。 |
| 对 v0.9 的潜在影响 | 单独 override 的直接代码影响可能较小，但属于未经当前 Next.js 版本声明支持的依赖组合；完整修复仍会触发高风险框架升级。 |
| 推荐动作 | **本次发布风险已由项目负责人接受。** 不为清零审计结果单独增加 override，不执行强制升级；与 Next.js 16 安全升级一起验证。 |

## 3. 最小升级方案判断

- 当前没有 `npm audit` 认可的 Next.js 14 同 major 修复版本。
- PostCSS 单独提升到 8.5.23 不能解决 Next.js 自身 High，且 Next 14.2.35 精确声明依赖 8.4.31；不建议在缺少兼容回归时强制 override。
- `npm audit fix --force` 将安装 Next.js 16.3.0，属于跨两个 major 的 breaking change，本轮按负责人要求停止，不执行。
- 因生产 v0.8 已使用相同 Next/PostCSS 版本，v0.9 没有新增该依赖风险；项目负责人已于 2026-08-04 书面接受短期残余风险，允许 v0.9 发布。

## 4. 风险接受决定

- 接受日期：2026-08-04。
- 决定：接受当前依赖风险，允许 v0.9 发布；该接受不是永久豁免。
- 后续事项：单独建立“Next.js 16 安全升级与完整回归测试”，在独立测试环境覆盖构建、自动测试、Supabase、Session、摄像头、Qwen、报告、真机监督和 Vercel 后再进入生产。
- 升级完成前约束：保持 Qwen、访问码和 session 日志脱敏；持续观察 Vercel 500、异常请求、DoS 和缓存异常；不新增 rewrites、middleware、Server Actions 等未评估攻击面；不使用 `npm audit fix --force`；不对 Next 内嵌 PostCSS 做非官方 override。
