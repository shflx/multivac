<img src="apps/web/public/multivac.svg" width="48" height="48" alt="Multivac" />

# Multivac

把注意力还给你。

Multivac 是面向个人使用的本地 AI 工作台。通过对话承接意图、组织任务、延续上下文，让复杂工作更清楚，减少反复切换、交代和盯进度的负担。

日常与 Multivac 对话，需要深入时进入工作区，需要整理时打开管理面板。

## 当前状态

项目仍在早期开发，尚未发布里程碑版本，功能与交互持续调整。

- **对话与工作区**：模型配置、流式对话、历史与草稿恢复、多会话并排、聚焦阅读与引用。
- **项目与任务**：工作目录、任务列表与看板、子任务与依赖、执行控制、成果与人工验收。
- **本地执行**：基于 Pi Coding Agent，保存会话与任务记录，并提供目录外文件访问授权。

后台任务的原生工具隔离目前仅在 macOS 验证，其他平台暂不支持启动这类任务。普通会话的 bash 工作目录不构成安全沙箱。独立的 Inbox、运行与成果页面，以及完整的知识与记忆能力仍在规划中。

## 本地运行

需要 **Node.js 22.19 或更高版本**。

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>，在「管理 → 模型」中配置模型服务与认证。本地 API 服务默认使用端口 `4317`。

单独运行构建后的 API 服务：

```bash
npm run build
npm start
```

服务地址为 `http://127.0.0.1:4317`；`npm start` 不托管 Web 页面，体验工作台请使用上面的开发启动方式。

应用数据默认保存在 `~/.multivac`，会话工作文件默认保存在 `~/Multivac`；挂载项目使用你指定的目录。两类默认目录均位于仓库之外，开发模式也会使用它们。

可通过 `MULTIVAC_DATA_DIR` 和 `MULTIVAC_WORK_ROOT` 调整数据与工作文件位置，两者须为互不包含的独立目录。其他配置项见 [.env.example](.env.example)。

## 开发

采用 TypeScript、React / Vite、本地 HTTP 服务、SQLite 与 Pi Coding Agent。

```text
apps/web/            Web 工作台
apps/server/         本地服务与 Agent 运行时
packages/contracts/  前后端共享契约
tests/e2e/           Playwright 端到端测试
scripts/             工程脚本
```

`npm run check` 检查类型，`npm run build` 构建项目。修改时按范围选择测试；`npm test` 和 `npm run test:e2e` 分别运行工作区测试与端到端测试。

参与开发前请阅读 [开发规范](AGENTS.md) 和 [项目约束](PROJECT_CONSTRAINTS.md)。
