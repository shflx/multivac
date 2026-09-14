# Multivac

Multivac 是面向个人使用的本地 Agent 工作台。当前仓库包含模块化单体、React/Vite Web、原生 HTTP Server，以及服务端 Pi Coding 协调助手运行时边界。

默认 Web 页面提供协调助手 active branch 的只读历史、稳定分页、未发送草稿和阅读位置恢复。消息正文只从 Pi session 读取；SQLite 仅保存全局 session binding 与页面状态，不保存消息正文。

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

应用数据默认写入 `~/.multivac`，包括 `multivac.sqlite` 和专用协调助手 Pi session 目录。可通过 `MULTIVAC_DATA_DIR` 指向其它源码目录之外的位置。

## 仓库结构

```text
apps/web/             React/Vite 工作台
apps/server/          本地 HTTP 服务、应用编排、运行时与 SQLite 存储
packages/contracts/   前后端共享契约
tests/e2e/            Playwright 产品链路测试
docs/                 架构与验证记录
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

架构约束见 [docs/proj.md](docs/proj.md)。
