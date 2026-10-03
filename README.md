# Multivac

Multivac 是面向个人使用的本地 Agent 工作台。当前仓库包含模块化单体、React/Vite Web、原生 HTTP Server，以及服务端 Pi Coding Agent 运行时边界。

默认 Web 页面提供 Multivac 会话 active branch 的只读历史、稳定分页、未发送草稿和阅读位置恢复。消息正文以 Pi session 为来源；SQLite 保存会话绑定、任务与运行事实、页面状态等应用数据。

## 开始开发

要求 Node.js 22.19 或更高版本。

```bash
npm install
npm run dev
```

开发地址：

- Web：`http://127.0.0.1:5173`
- Server：`http://127.0.0.1:4317`

构建并启动本地服务：

```bash
npm run build
npm start
```

服务地址默认为 `http://127.0.0.1:4317`，可通过 `MULTIVAC_PORT` 调整端口。

应用数据默认写入 `~/.multivac`，包括 `multivac.sqlite` 和专用 Multivac Pi session 目录。可通过 `MULTIVAC_DATA_DIR` 指向其它源码目录之外的位置。

会话的工作文件默认放在 `~/Multivac`，与内部数据分根：`multivac/` 是全局 Multivac 的工作目录，`sessions/<日期>-<会话名>-<短 id>/` 是不属于项目的工作会话各自的临时目录，`projects/<项目名>/` 是没有挂载目录的项目的托管目录（项目中的会话共用项目目录，挂载的项目使用挂载目录）。不属于项目的会话可以在界面上“归入项目…”（`POST /api/sessions/:id/move-to-project`）：会话 id 与对话历史不变，之后在项目目录中继续；只在会话空闲时进行，临时目录中的文件可选择一并移入，同名的不覆盖。会话归档时空的临时目录直接删除，有文件的按“设置 · 偏好”的保留时长（7 / 30 / 90 天或从不，默认 30 天，`/api/preferences`）保留，到期移到废纸篓（默认系统废纸篓，`MULTIVAC_TRASH_DIR` 可指定目录），到期前恢复会话则取消；归入项目后留在原处的临时目录从归入时起同样计时。清理只在服务运行时进行，启动时补做一次到期检查；Multivac 工作目录与项目目录永不自动清理。可通过 `MULTIVAC_WORK_ROOT`（绝对路径）调整；它与数据目录互相包含时服务拒绝启动。每个会话的 Agent 都以自己的工作目录执行命令与读写文件，服务的启动目录不作为任何会话的工作目录。文件工具（read / edit / write）只能直接访问本会话工作目录内的路径（按真实路径判定，包括经 `..` 与符号链接解析后的位置）；目录外的访问会生成授权请求并等待用户批准（仅这一次、本会话内或本项目内）或拒绝，等待期间本轮保持运行；批准后执行前会重新核对目标，等待期间目标发生变化（例如符号链接被改指）时不执行；选择本会话内或本项目内时，程序记住对目标所在目录（含子目录）的读取或修改，之后同一范围内的同类访问直接放行，本会话内的可在会话标题栏菜单的“授权”、工作目录说明或“设置 · 归档”的授权入口查看与撤销，本项目内的在“设置 · 项目”详情的“权限”中（`/api/authorization-grants`；授权窗口另列本会话最近的授权请求，`/api/authorization-requests?sessionId=`）；全局 Multivac 不记住授权，只能单次批准；停止本轮即取消请求，等待超过 30 分钟（`MULTIVAC_TOOL_AUTHORIZATION_TIMEOUT_MS` 可调）请求过期、本轮结束，服务重启前未决的请求一律失效、不会再被放行。授权请求可经 `/api/sessions/:id/authorizations`（全局 Multivac 为 `/api/assistant/authorizations`）查询与决定。bash 在工作目录中执行，不做命令分级。全局 Multivac 另外带服务端内部工具（查询项目、工作区与会话，新建、改名、归档、恢复会话，项目改名与修改默认约束，以及应用户明确要求切换发起窗口的工作区、栏位与管理页），它们只注入全局 Multivac、不读写文件、不产生授权请求；扩大权限的操作（新建项目、挂载 / 卸载目录、设主目录、会话归入项目）只能由它在对话中提出确认卡（与界面上的同一张），由用户在卡上确认后执行（`POST /api/assistant/proposals/:id/decision`）。开发模式同样使用这两个默认目录，不会写进仓库。

服务端向界面推送只有一条通道：每个窗口一条全局事件流 `GET /api/events?after=<全局游标>&windowId=<窗口 id>`（SSE），承载所有会话的正文等公共事件（按会话 id 分发）与工作台变更（会话、项目、工作区现场、记住的授权与提议的变化），断线后按全局游标续传。某个会话需要补齐一段事件时用补漏读取 `GET /api/sessions/:id/events?after=&until=`（全局 Multivac 为 `/api/assistant/events?…`），返回 JSON。发送、停止、授权与确认等命令都是普通 HTTP 请求；不使用 WebSocket。

## 仓库结构

```text
apps/web/             React/Vite 工作台
apps/server/          本地 HTTP 服务、应用编排、运行时与 SQLite 存储
packages/contracts/   前后端共享契约
tests/e2e/            Playwright 产品链路测试
scripts/              工程脚本
```

管理中的“待办”已接入共享任务服务：创建、服务端搜索及项目/状态筛选、看板与列表、列表和进展分页、直属子任务创建与完整进度、父任务与多前置关系编辑、关系导航与列表展开、优先级调整、启动/暂停/继续/取消、详情删除、澄清和恢复请求、成果阅读与验收。任务、运行、人工请求、成果版本和命令回执持久化在 SQLite，通过全局事件流同步。新建只记录任务；同一输入的失败重试沿用命令 ID。删除保留会话、成果与历史，必须先停止执行并处理待办关系。

详情内的直属子任务按完整集合统计已完成和已取消，可分页读取与继续创建；子任务项目固定跟随父任务，包括不关联项目的日常任务。父任务可设置、更换或解除，多个前置任务按稳定 ID 搜索选择；只有已完成满足条件。父子关系不隐含依赖、执行顺序、自动启动或自动完成，编辑复用停止确认、项目、循环、历史树预算与 revision 校验。冲突保留草稿，重新核对后保存；同内容失败重试沿用命令 ID。列表展开按身份去重，筛选外子任务标明关系上下文；看板保持平铺，展示父任务、子任务进度及执行条件。

任务查询使用 `/api/tasks`；`parentTaskId` 查询直属子任务，`dependencyId` 查询直接后续任务，`topLevel=true` 查询根任务，`ids` 批量核对共享对象，`includeRelations=true` 一次读取当前页的完整直属统计与前置条件摘要。候选使用 `parentCandidateFor` 或 `dependencyCandidateFor` 绑定当前任务，服务端限定同项目并在分页前排除循环；`excludeIds` 排除已选身份。`GET /api/tasks/:id/relations?ancestorOffset=` 提供分页祖先、完整前置对象、聚合统计和当前编辑限制；关系读取与主面板共用缓存，但独立维护成员、数量与分页。

Multivac 自然语言操作复用 `propose_create_task`、`update_task`、`list_tasks` 与 `get_task`：创建先确认，修改核对 revision 与预算边界，查询提供完整直属统计、前置状态及可继续读取的分页入口。

任务查询的 `viewStatus` 按看板状态筛选，原始 `status`/`statuses` 仍供业务查询使用，筛选先于 `limit`/`offset` 分页。`/api/task-requests` 支持 `taskId`、`status`、`limit`、`offset`，返回总数与下一页；业务门禁核对完整待处理请求。成果验收绑定当前固定版本，旧版本与历史仍可读取。

任务执行使用独立目录：Git 项目从固定 HEAD 建 worktree，非 Git 项目建立有预算的快照。当前原生工具隔离在 macOS 验证，其他平台拒绝启动；任务工具限制目录外访问、网络与派生子进程，不能视为任意 shell 环境。Inbox、运行和成果的独立页面、资料与记忆完整产品能力尚未接入。

## 工程检查

```bash
npm run check
npm test
npm run build
npm run test:e2e
```

工作区只处理未归档会话；左侧“查看归档”打开“设置 · 归档”并筛选当前工作区（“最近”打开全部）。归档面板跨工作区按标题查找已归档工作会话，支持恢复及恢复并打开；临时目录已经清理时先展示移走时间、废纸篓位置与目录恢复说明，再提供继续打开入口。归档会话无需恢复即可查看和撤销本会话授权。原管理“会话”页已移除，正常工作区、栈式会话与服务端会话管理能力保留。
