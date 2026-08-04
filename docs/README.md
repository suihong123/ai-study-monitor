# 项目资料中心

这里是项目后续迭代的共同上下文。阅读顺序如下：

1. [项目全景基线](PROJECT_BASELINE.md)：产品定位、用户流程、系统结构、功能边界、数据口径和风险。
2. [业务现状基线](BUSINESS_STATUS.md)：商业模式、套餐、运营闭环、指标能力、业务判断和待验证事项。
3. [迭代与复盘机制](ITERATION_PLAYBOOK.md)：每次优化前如何复盘、沟通、实施和回写。
4. [复盘记录索引](reviews/README.md)：历次优化的背景、决策和结果。
5. [优化前复盘模板](reviews/TEMPLATE.md)：新一轮优化的固定开场文档。
6. [v0.9 隔离数据库验收结果](acceptance/V09_ISOLATED_DATABASE_RESULT.md)：migration 18、19 码快照、事务与并发证据。
7. [v0.9 真机验收记录](acceptance/V09_MANUAL_DEVICE_REBIND_ACCEPTANCE.md)：手机、平板、微信和系统浏览器的执行表。
8. [v0.9 托管 Supabase 验收结果](acceptance/V09_HOSTED_SUPABASE_RESULT.md)：托管迁移、RLS、函数授权、并发和回滚证据。
9. [v0.9 独立测试站点准备](acceptance/V09_STAGING_SETUP.md)：环境隔离、变量分级和负责人接续步骤。
10. [v0.9 生产只读预检与回退计划](acceptance/V09_PRODUCTION_READ_ONLY_PLAN.md)：只读快照、上线门禁和 v0.8 回退方式。
11. [v0.9 生产依赖审计](acceptance/V09_DEPENDENCY_AUDIT.md)：2 个 High 的攻击面、修复版本和跨 major 风险判断。

## 维护原则

- 代码是功能事实的最终依据，线上数据是业务事实的最终依据。
- 文档必须标明“事实、判断、未知”，不以愿景代替现状。
- 产品规则或业务口径变化时，相关代码和基线文档必须在同一轮更新。
- 基线用于减少重复解释，不替代每次优化对当前代码和数据的重新核对。

## 当前基线

- 基线日期：2026-08-04
- 基线版本：1.6
- 生产代码：`98088ff`（v0.8）
- 生产地址：`www.aistudyguard.top`
- 开发状态：v0.9 使用环境重新绑定及监督请求隔离已完成功能、自动化、隔离/托管 PostgreSQL、Preview、真实 Qwen 和核心真机验收；5 个 P1 发布门禁已关闭，Release Candidate 待提交审核，尚未推送、生产迁移或部署
- 线上经营数据：当前仓库未提供，业务量级仍待补充
