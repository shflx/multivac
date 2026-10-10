# 原型与 dev 的前端对齐记录

基准：远程 `origin/dev`，提交 `dd80dc7c9a99b67f5f197ad0576e497818ced5ef`（上一轮为 `47df325329a0aff4bac8772373c0848e8a6b8240`）。已通过 `git fetch origin dev` 和远程分支查询核对。之后 dev 只新增 `4a58a4b`，修复快捷键返回后的焦点样式，不涉及新功能，本轮未跟进。

用户选择 A：保留原型独有功能；双方已有功能以 dev 为准，补齐 dev 新增的前端交互。

## 第二轮改动（对齐到 `dd80dc7`）

| 范围 | 对齐内容 | dev 参考 |
| --- | --- | --- |
| 图片输入 | Multivac 对话与工作会话输入区左下角“添加图片”，也可粘贴、拖入；最多 4 张、单图 10 MiB、合计 20 MiB；上传中、失败重试、移除；消息缩略图可全屏预览、切换和缩放 | `assistant/image-draft.ts`、`image-input.tsx`、`image-gallery.tsx` |
| 任务执行预算 | 偏好新增“任务执行”卡片，执行时长上限默认 6 小时；继续已暂停任务时提示补充额度，子任务说明父子共享；增加额度用完暂停的示例任务 | `tasks/task-budget.ts`、`preferences/preferences-page.tsx`、`task-panel.tsx` |
| 执行诊断 | 偏好新增“诊断”卡片，执行诊断开关默认开启 | `preferences/preferences-page.tsx` |
| 任务树统一执行 | 子任务由父任务会话统一执行时按“待处理、处理中、已处理，待核对、待继续”显示；拖动与操作改为“查看父任务执行”；父任务说明固定范围与成果候选；父任务暂停时子任务显示待继续 | `task-panel-state.ts`、`task-panel.tsx`、`task-inspector.tsx` |
| 任务会话视图 | 从任务、请求或卡片进入任务会话时以独立视图放大显示，不改写工作区并排数、栏位与当前会话；“返回工作区”回到原现场，当前标签页刷新后保留 | `tasks/task-session-view.tsx` |
| 默认推理等级 | 模型配置新增“默认推理等级”；当前不支持的已保存等级标记“待核对”；只在新会话使用默认模型或主动切换到该模型时应用 | `models/model-profile-form.tsx` |
| 托管进程 | 运行页收录会话启动的进程；显示启动中、停止中、恢复核对等状态与“前台执行”；会话进程可“结束会话运行”，停止该会话全部托管进程 | `runs/processes-section.tsx` |
| 读书 | 书架导入书籍（PDF、EPUB、TXT、Markdown，可取消）；逐本删除书籍并确认；划线按原文位置排序，移除后可撤销 | `reading/reading-import-dialog.tsx`、`reading-app.tsx` |
| 运行失败原因 | 失败轨迹默认展开并显示原因，可手动收起；没有细节时提示“原因未提供。” | `assistant/tool-execution.tsx` |
| 任务目录命名 | 执行目录为“清理后的标题 + 20 位摘要”，worktree 分支带 `multivac-task-` 前缀；会话信息与任务详情显示分支 | `apps/server/src/application/task-directory-names.ts` |

本轮不做：远程访问的 token 登录入口。原型没有登录与访问隔离，无法有意义地模拟。

## 第一轮改动（对齐到 `47df325`）

| 范围 | 对齐内容 | dev 参考 |
| --- | --- | --- |
| 管理外壳 | 页面首次打开后保持挂载；切换页面保留筛选、草稿、滚动位置；项目、模型和偏好采用简洁页头 | `apps/web/src/app/app.tsx`、`management-layout.tsx` |
| 快速跳转 | 管理中的 ⌘K 支持搜索任务及页面，跳转筛选外任务会清除筛选并显示详情 | `apps/web/src/app/quick-switcher.tsx` |
| 任务看板 | 区分排队中；按需显示暂停列；状态筛选只出现在列表；两种视图独立记住完成历史展开状态；详情宽度为 440px | `apps/web/src/features/tasks/task-panel.tsx`、`task-panel-state.ts`、`apps/web/src/styles/base.css` |
| 人工任务 | 创建和详情中的“我来处理”、处理方式筛选、显式标记完成；Agent 启动和拖动不能执行人工任务；前置条件及请求未解决时不能完成 | `new-task-dialog.tsx`、`task-inspector.tsx`、`task-panel.tsx` |
| 任务关系 | 创建子任务、编辑父任务和前置依赖、同项目选择、循环校验、子任务完成统计、树形列表、关联任务导航及返回 | `task-relations.tsx`、`task-relationship-fields.tsx`、`task-tree-state.ts` |
| 执行条件 | 前置任务进入审核中或已完成即满足条件；申请执行后等待依赖；父子关系不自动启动或完成；已结束任务属性只读 | `task-relations.tsx`、`task-panel.tsx` |
| 任务详情 | 当前情况和待处理请求优先；长目标、执行信息与历史按需展开；更多操作中取消、删除；删除保留会话和成果 | `task-inspector.tsx`、`task-panel.tsx` |
| 请求与验收 | 澄清、验收、恢复在任务详情处理；工具授权回到来源会话；要求修改后暂停并保留反馈；停止未确认时禁止继续 | `task-request-card.tsx`、`apps/server/src/application/artifact-service.ts`、`human-request-service.ts` |
| 归档 | 设置组增加归档页；标题搜索、项目筛选、归档时间、恢复、恢复并打开、恢复回执；工作区侧栏提供查看归档入口 | `apps/web/src/features/archive/archive-page.tsx`、`workspace/workspace-rail.tsx` |
| 工作目录 | 已有会话目录固定，修改项目主目录只影响之后创建的会话；任务显示独立目录或 worktree；运行中禁止直接归入项目 | `workspace/working-directory.ts`、`move-to-project.ts` |
| 会话状态 | 处理中、未查看、已查看独立于任务状态；工作区不可见时不消费未查看状态 | `assistant/session-status.ts` |
| 模型 | 连接检查与可用性分离；运行中禁止切换模型及推理等级；不可用模型不能发送；更换模型身份不沿用旧能力；编辑中的未知等级保存后确认；支持 max 等级 | `models/model-profile-view.ts`、`assistant/model-selector.tsx` |
| 偏好 | 临时目录默认 30 天，选项为 7/30/90 天及从不清理；到期移到废纸篓、恢复取消清理；显示原型示例占用 | `preferences/preferences-page.tsx`、`workspace/temp-retention.ts` |

## 按 A 保留

- Inbox 集中决策、运行页、成果页、会话管理页。
- 读书、逐页共读、书签、阅读笔记及笔记应用。
- 能力、智能体、知识与记忆设置。
- 原型的顶部运行提示与 Inbox/成果入口、会话自动归档选项。
- 窄屏读书功能。

Inbox 和任务详情共享请求、草稿与处理结果；验收要求修改后，两处均呈现暂停待修改。

## 原型边界

这轮修改仍使用原型数据与本地状态模拟。没有接入 dev 后端，也不实际执行 Agent、调用模型、移动项目文件或清理临时目录；目录路径、容量及运行记录均是演示内容。后端持久化、多窗口同步、服务端分页及真实文件系统错误不由这些原型测试验证。

第二轮新增的模拟边界：图片上传只在浏览器内生成预览，文件名含 `fail` 的图片首次上传失败，用于体验重试；导入书籍只解析 TXT 与 Markdown，PDF、EPUB 以示例正文代替，导入和删除都不持久化，刷新后书架回到示例书；预算与诊断只保存偏好，不实际计时或采集；目录摘要用简单散列代替 SHA-256。

## 验证

- 单元测试：121 项通过，覆盖已有原型功能，以及第二轮新增的执行预算、任务树统一执行、默认推理等级、图片草稿限制、书籍导入与划线排序、任务目录命名。
- Vite 原型生产构建通过；仍有大于 500 KB 的主包提示。
- Chromium 交互验证三组通过，未记录页面运行异常。
  - 任务流程：人工前置、子任务依赖、等待与恢复执行、详情验收、筛选保留、归档恢复、读书入口。
  - 页面检查：全部管理页、筛选外任务快速跳转、要求修改后暂停、模型离开确认、运行中模型锁定、工作区文件阅读、窄屏返回首页。
  - 第二轮功能：图片发送、预览与数量限制；任务树统一执行与父任务暂停；额度补充提示；独立任务会话与失败原因；预算与诊断偏好；默认推理等级与待核对；结束会话运行；导入与删除书籍。

在仓库根目录运行：

```sh
node --test prototypes/*.test.js
npm exec --no -- vite build --config prototypes/vite.config.js
```

浏览器测试先启动原型服务，再在另一个终端执行脚本（默认 Chromium 已安装）：

```sh
npm exec --no -- vite --config prototypes/vite.config.js --host 127.0.0.1 --port 5179
```

```sh
node prototypes/alignment-flow.e2e.mjs
node prototypes/alignment-pages.e2e.mjs
node prototypes/alignment-features.e2e.mjs
```

其他地址可通过 `PROTOTYPE_URL` 环境变量指定。浏览器截图写入 `.tmp/prototype-alignment/`。
