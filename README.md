# Multivac

Multivac 是面向个人使用的本地 Agent 工作台。当前仓库包含模块化单体、React/Vite Web、原生 HTTP Server，以及服务端 Pi Coding Agent 运行时边界。

默认 Web 页面提供 Multivac 会话 active branch 的只读历史、稳定分页、未发送草稿和阅读位置恢复。消息正文只从 Pi session 读取；SQLite 仅保存全局 session binding 与页面状态，不保存消息正文。

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

会话的工作文件默认放在 `~/Multivac`，与内部数据分根：`multivac/` 是全局 Multivac 的工作目录，`sessions/<日期>-<会话名>-<短 id>/` 是不属于项目的工作会话各自的临时目录，`projects/<项目名>/` 是没有挂载目录的项目的托管目录（项目中的会话共用项目目录，挂载的项目使用挂载目录）。可通过 `MULTIVAC_WORK_ROOT`（绝对路径）调整；它与数据目录互相包含时服务拒绝启动。每个会话的 Agent 都以自己的工作目录执行命令与读写文件，服务的启动目录不作为任何会话的工作目录。文件工具（read / edit / write）只能直接访问本会话工作目录内的路径（按真实路径判定，包括经 `..` 与符号链接解析后的位置）；目录外的访问会生成授权请求并等待用户批准（仅这一次）或拒绝，等待期间本轮保持运行；停止本轮即取消请求，等待超过 30 分钟（`MULTIVAC_TOOL_AUTHORIZATION_TIMEOUT_MS` 可调）请求过期、本轮结束，服务重启前未决的请求一律失效、不会再被放行。授权请求可经 `/api/sessions/:id/authorizations`（全局 Multivac 为 `/api/assistant/authorizations`）查询与决定。bash 在工作目录中执行，不做命令分级。开发模式同样使用这两个默认目录，不会写进仓库。

## 仓库结构

```text
apps/web/             React/Vite 工作台
apps/server/          本地 HTTP 服务、应用编排、运行时与 SQLite 存储
packages/contracts/   前后端共享契约
tests/e2e/            Playwright 产品链路测试
scripts/              工程脚本
```

当前尚未实现消息发送、SSE、任务、调度、Inbox、成果、资料或记忆等完整产品能力。

## 工程检查

```bash
npm run check
npm test
npm run build
npm run test:e2e
```
