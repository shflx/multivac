<img src="apps/web/public/multivac.svg" width="48" height="48" alt="Multivac" />

# Multivac

把注意力还给你。

Multivac 是面向个人使用的本地 AI 工作台。通过对话承接意图、组织任务、延续上下文，让复杂工作更清楚，减少反复切换、交代和盯进度的负担。

日常与 Multivac 对话，需要深入时进入工作区，需要整理时打开管理面板。

管理 · 应用提供支持 TXT、Markdown、PDF、EPUB 的真实书架、逐页读书、书伴及阅读笔记。PDF / EPUB 流式导入，正文分块按需加载。支持桌面和手机，具体来源、范围和限额见 [读书应用](docs/reading.md)。

## 当前状态

项目仍在早期开发，尚未发布里程碑版本，功能与交互持续调整。

- **对话与工作区**：模型配置、流式对话、历史与草稿恢复、多会话并排、聚焦阅读与引用。
- **项目与任务**：工作目录、任务列表与看板、子任务与依赖、执行控制、成果与人工验收。
- **Inbox**：顶栏抽屉与管理页统一处理澄清、目录授权、Git 外发授权、成果验收和恢复确认，保留共享草稿与原位回执。数字表示待处理总数，查看只消除未查看点。
- **运行面板**：跨任务运行与异常、顶栏状态浮层、真实暂停与现场跳转，托管进程日志、停止影响确认及多窗口同步。
- **本地执行**：基于 Pi Coding Agent，保存会话与任务记录，并提供目录外文件访问授权。

后台任务的原生工具隔离目前仅在 macOS 验证，其他平台暂不支持启动这类任务。普通会话的 bash 工作目录不构成安全沙箱。独立成果页面，以及完整的知识与记忆能力仍在规划中。Inbox 支持窄屏抽屉，管理完整页保持桌面边界。

Git 外发通过 `propose_git_publish` 为当前会话仓库的固定 HEAD 申请一次发布，只支持已配置、无内嵌凭据的 HTTPS 远端和新分支；用户在 Inbox 批准后才执行。使用本机 Git 凭据，具体认证账号由远端确认。结果未知只读核对，不自动重推；现有分支、任意外部工具、发布平台 API 不在此适配范围。安全重做要求停止与工具副作用已核对，使用新会话并保留已有目录变更。详见 [Inbox 契约](docs/inbox.md)。

## 运行与后台进程

管理 · 运行与顶栏共用服务端事实；排队不算执行，授权、澄清和验收等待不算异常。全局 Multivac 可查询运行与受控日志、提出停止确认，模型不能代替用户批准。

真实任务会话可用 `start_managed_process` 启动任务目录内的 Node 脚本。目前仅验证 macOS：禁止派生子进程、外连和凭据继承，可声明一个 localhost 监听端口；不支持需要 fork 的 npm/Vite、管道或任意 shell。进程创建不等于服务就绪，端口由实际监听观测给出。

依赖进程随本轮收敛，独立长期进程在任务结束后保留；两者均受时间、输出和并发上限约束。关闭标签页不停止任务，本地服务退出会清理托管进程。缺少可信退出凭据时保留占用并进入恢复核对，不按旧 PID 杀进程、不自动重启。日志按常见敏感模式遮蔽，不能保证识别任意业务秘密，脚本仍应避免输出秘密。

详见 [运行契约](docs/design/runs.md) 与 [执行隔离及限制](docs/task-execution-isolation.md)。真实操作系统进程测试与真实模型测试分别记录，未配置模型时不宣称通过模型执行验收。

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

构建后的服务地址为 `http://127.0.0.1:4317`，同源托管 Web 页面和 API；开发热更新仍使用上面的开发启动方式。

`npm run dev` 默认开启远程对话，自动生成的 token 会显示在启动终端并在后续启动复用。手机可通过 `http://<电脑局域网或 Tailscale 地址>:4317` 输入 token 登录；手机页面使用构建产物，首次使用或前端更新后需先执行 `npm run build`。使用 `npm start` 时，需设置 `MULTIVAC_REMOTE_ENABLED=1` 开启远程访问。

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
