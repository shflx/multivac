# 原型与 dev 的前端对齐记录

基准：远程 `origin/dev`，提交 `47df325329a0aff4bac8772373c0848e8a6b8240`。已通过 `git fetch origin dev` 和远程分支查询核对。

用户选择 A：保留原型独有功能；双方已有功能以 dev 为准，补齐 dev 新增的前端交互。

## 本轮改动

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

## 验证

- 单元测试：108 项通过，覆盖已有原型功能以及新增关系约束、人工任务、依赖条件和会话阅读状态。
- Vite 原型生产构建通过；仍有大于 500 KB 的主包提示。
- Chromium 交互验证两组通过，未记录页面运行异常。
  - 任务流程：人工前置、子任务依赖、等待与恢复执行、详情验收、筛选保留、归档恢复、读书入口。
  - 页面检查：全部管理页、筛选外任务快速跳转、要求修改后暂停、模型离开确认、运行中模型锁定、工作区文件阅读、窄屏返回首页。

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
```

其他地址可通过 `PROTOTYPE_URL` 环境变量指定。浏览器截图写入 `.tmp/prototype-alignment/`。
