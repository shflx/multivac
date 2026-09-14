# Multivac

Multivac 是面向个人使用的本地 Agent 工作台。当前仓库包含模块化单体项目骨架、基础 Web/Server 入口和服务端 Pi Coding 协调助手运行时边界。

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

## 仓库结构

```text
apps/web/             React/Vite 工作台
apps/server/          本地 HTTP 服务及后续领域模块、运行时、存储位置
packages/contracts/   前后端共享契约位置
tests/e2e/            后续 Playwright 产品链路位置
docs/                 架构与验证记录
scripts/              工程脚本
```

当前尚未实现任务、调度、SQLite、SSE、Inbox、成果、资料或记忆等完整产品能力。

## 工程检查

```bash
npm run check
npm run build
```

架构约束见 [docs/proj.md](docs/proj.md)。
