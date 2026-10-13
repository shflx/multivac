# 项目约束审查记录（基于 63cc374）

本轮仅调整文档，不修改业务行为、权限或测试。原文完整保存在 [审查前快照](project-constraints-before-review-63cc374.md)，当前规则以 [PROJECT_CONSTRAINTS.md](../../PROJECT_CONSTRAINTS.md) 为准。本记录解释精简依据，不作为额外强制约束。

## 审查结论

主要问题是具体 UI 决策、常量和阶段说明不断追加到跨模块约束，造成重复与阅读成本；不是现有安全限制普遍过时。本轮保留权限、真实状态、幂等、恢复、停止、来源核对及数据不丢失等边界，将布局与参数留给专项文档、契约和实现。

| 原内容 | 处理 | 核对依据 |
| --- | --- | --- |
| 默认或继承设置失效时阻止恢复；末尾又要求既有会话不受默认推理等级变化影响 | 合并并区分默认配置与实际选择。默认等级用于新建/主动选模，既有会话按 Pi 实际模型与等级恢复，认证和配置身份仍核对 | `apps/server/src/application/new-session-runtime-config.ts` 及 `session-model-selection-service.ts` 使用 `applyDefaultThinking: false`；`model-settings-service.ts` 按调用场景校验默认等级 |
| 读书“不新增独立笔记页” | 收窄为书内讨论、阅读笔记不冒充独立工作会话或笔记应用，不作为禁止未来独立笔记产品的规则 | `docs/reading.md` 的“本功能仅增加…”限定了读书功能范围；近期独立笔记讨论未授权合并两种对象 |
| 每五秒刷新、四列列表、深色日志、浮层按钮位置等 | 主文保留事实同步、停止与生命周期边界，移除具体呈现约束 | `docs/design/runs.md`、`apps/web/src/features/runs/` |
| 任务六小时默认、目录标题清理规则、旧摘要名称、具体字段和状态文案 | 主文保留共享预算、不自动续充、稳定目录身份及子项候选不等于交付；细节留给契约与专项说明 | `packages/contracts/src/task.ts`、`preferences.ts`、`docs/design/task-tree-single-session.md` |
| 图片格式白名单、数量/像素/大小/回收时限、预览控件 | 主文保留内容验证、资源预算、会话归属、模型能力、幂等及附件保留，移除具体常量和控件清单 | `packages/contracts/src/` 图片契约与 `apps/server/src/application/image-service.ts`；原值保存在快照 |
| 书籍导入数值、正文块大小、解析预算、三行/四行折叠、按钮左右位置、排版 DOM 等 | 主文保留有界读取、不可变原文、稳定位置、不执行书内代码、草稿和来源保护；格式及 UI 细节引用专项设计 | `docs/reading.md`、`docs/reading-pdf.md`；发现专项文档有更新细节，不将快照提升为现行规格 |
| 末尾追加的书伴当前页、引用类型、默认推理等级和模型恢复规则 | 合并回对应的读书与模型章节 | 现有书伴/模型设计与实现 |
| 统计页宽度、卡片位置、文案显示位置及每日一句开关/固定句子/位置 | 移出跨模块约束。统计保留独立采集账本、不回补历史及准确聚合边界，具体呈现由实现维护 | `apps/server/src/application/usage-statistics-service.ts`、`apps/web/src/app/management-nav.ts`、`daily-quote.tsx`、`packages/contracts/src/preferences.ts` |
| 幂等、旧回执不能覆盖新状态、共享缓存、不能凭模型文字判完成等多处重复 | 按事实一致性、执行、草稿及 UI 主题合并，保留各自特有边界 | 原文与对应业务服务 |
| 普通 bash 可访问本机免登录 API 的已知限制 | 保留，并明确是本机入口，不因增加远程 token 就声称修复 | `apps/server/src/adapters/http/remote-access.ts` 的 `identify()` 对 `localRequest` 返回已认证本机身份；任务隔离仍是另一层保护 |

## 明确保留的行为

- 一次启动父任务，由同一会话执行固定任务树；子项进度与交付分开，停止核对不可绕过。
- 每个有代码改动的任务工作项默认本地提交，用户明确策略优先，不自动推送。
- “我来处理”仅由用户明确决定；review/done 满足依赖，候选不满足树外依赖。
- 目录授权、提议确认、真实停止证明、未知结果只读对账、凭据不公开。
- 文件和阅读来源不可猜测迁移，图片不静默降级，草稿及附件不被旧回执覆盖。
- 统计使用新采集账本，不因旧任务草案曾建议回补历史而改变当前已实现边界。

## 验证

核对精简前快照与 Git HEAD 原文逐字一致，并记录 SHA-256；检查主文及本记录的本地 Markdown 文件链接、差异空白。纯文档改动不运行应用全量测试。
