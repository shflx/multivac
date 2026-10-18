# 运行配置契约

运行模式必须是 `development` 或 `production`。`NODE_ENV` 不决定数据归属。

| 配置 | 生产默认值 | 开发默认值 | 显式配置 |
| --- | --- | --- | --- |
| 模式 | `production` | `development` | `MULTIVAC_MODE` |
| 内部数据 | `~/.multivac` | `~/.multivac-dev` | `MULTIVAC_DATA_DIR` |
| 工作文件根 | `~/Multivac` | `~/Multivac-dev` | `MULTIVAC_WORK_ROOT` |
| API | `4317` | `4318` | `MULTIVAC_PORT` |
| Vite | 不使用 | `5173` | 由 Vite 参数配置 |
| 执行器 | `pi` | `pi` | `MULTIVAC_HARNESS`（`MULTIVAC_FAKE_ASSISTANT=1` 等同 `fake`）；未登记的名称拒绝启动 |

`npm start` 要求生产模式；`npm run dev` 与 server 工作区的 `dev` 要求开发模式。显式模式与入口冲突会报错。直接执行服务入口且未指定模式时，保留生产默认值。

解析集中在 `apps/server/src/runtime-config.ts`。启动器解析后，将模式、绝对数据路径、绝对工作根和实际端口传给 API 与 Vite；业务启动同样使用该解析器。显式目录和端口优先于默认值，空字符串按未设置处理。为保留旧行为，数据目录的相对路径按启动 cwd 解析；建议使用绝对路径。工作根必须是绝对路径。

端口必须为 1 至 65535 的十进制整数；拒绝尾缀、小数和越界值。开发 API 不得占用默认 Vite 端口 5173。占用中的监听端口由操作系统拒绝，不自动切换至另一服务。数据目录与工作根必须互不包含，核对字面与已有祖先的真实路径；开发目录还不得与默认生产数据、生产工作根或 Pi 全局目录重叠。配置解析不创建目录。

实例身份由模式和数据目录真实路径生成，不包含凭据，端口变化不改变身份。默认生产数据目录保留 `multivac_remote` Cookie 名，以兼容历史配置；其他实例使用带实例身份的 Cookie 名。鉴权只读取、签发和清除本实例的名称，另一实例 Cookie 不影响本机身份判断。Cookie 仍为 HttpOnly、SameSite=Strict、Path=/，HTTPS 登录继续设置 Secure；不设置跨域 Domain。token 轮换、退出和重启只撤销当前服务内的登录及连接。

开发 Vite 默认 5173，`/api` 的 HTTP、事件流和升级代理统一指向解析后的开发 API，保留浏览器 Host 与原有事件流断开转发处理。显式 `MULTIVAC_PORT` 同时作用于服务与代理；单独启动 web 工作区也默认使用开发配置。Vite 端口占用会报错，不自动换端口。E2E 专用的 `MULTIVAC_E2E_API_PORT` 保持兼容，但与 `MULTIVAC_PORT` 同时指定且不一致时拒绝启动；Playwright 显式传入测试目标端口。

持久状态位置（`<data>` 表示本实例数据目录）：

| 状态 | 位置 |
| --- | --- |
| SQLite、业务记录、迁移、运行与进程登记 | `<data>/multivac.sqlite` 及 SQLite 辅助文件 |
| 迁移前备份（已有数据的库执行新迁移前自动生成） | `<data>/multivac.sqlite.v<旧版本>-<时间>.bak` |
| Pi 对话与工作会话 | `<data>/assistant-sessions/`、其中的 `work/` |
| 模型设置与认证检查记录 | `<data>/model-settings.json`、`model-access.json` |
| 模型选择恢复 | `<data>/model-selection-recovery/` |
| 模型候选与临时运行配置 | `<data>/model-runtime-candidates/` |
| 图片、书籍、固定成果 | `<data>/images/`、`books/`、`artifacts/` |
| 诊断、进程日志与退出凭据 | `<data>/diagnostics/`、`managed-processes/` |
| 自动远程 token | `<data>/remote-access-token` |
| 开发 Pi 配置、认证和模型缓存 | `<data>/pi/settings.json`、`auth.json`、`models.json`、`models-store.json` |
| 生产 Pi 配置、认证和缓存 | 保留 Pi 原有 `getAgentDir()` 路径（通常 `~/.pi/agent`，包括既有显式配置） |

开发首次启动不会复制生产配置或凭据。会话、模型目录校验、认证增删、连接检查均使用同一个开发 Pi 根；缺少认证时返回原有“没有可用认证”提示，不回退到生产或 Pi 全局文件。开发 Pi 根不能通过符号链接逃出本实例数据目录。生产保留原有 Pi 认证兼容路径；两个自定义生产实例仍可能主动共用旧 Pi 配置，本功能的默认并行组合是一个生产实例与一个开发实例。

显式传给进程的模型环境变量属于用户配置，Pi 仍按原协议解释；需要不同认证时，应分别设置环境并在各自的模型管理中配置。不要把生产密钥放入共享的 shell 启动配置后再期望进程环境自动隔离。

工作文件由 `<work>`（本实例工作根）派生：全局会话位于 `multivac/`，临时会话位于 `sessions/`，托管项目位于 `projects/`，任务执行目录位于 `tasks/`。归档、保留期清理和恢复使用本实例数据库与工作根；清理只接受本实例 `sessions/` 的直接子目录，无法归属的历史计划会取消。开发实例创建和恢复托管目录时，还须核对真实路径处于本实例工作根内，拒绝外链及悬空链接。生产既有会话登记路径继续沿用，调整工作根不搬迁历史会话；全局会话仍按原规则使用当前根。

用户挂载的外部项目不按托管目录补建或自动清理。两个实例明确挂载同一外部目录时会共享真实文件，但各自的授权、会话和业务记录仍独立；工作文件隔离不表示文件系统沙箱或自动扩大目录权限。

自定义目录不应被不同实例复用。已有同数据目录服务的单实例锁继续生效。两个不同自定义数据目录若人为指定同一个工作根，无法从另一个尚未运行的配置自动发现冲突，需由使用者保证独立。

## 针对性回归

在有依赖的正常开发环境中运行：

```bash
npm ci
npm run check
node --test scripts/runtime-config.test.mjs
node --import tsx --test apps/server/tests/environment.test.ts apps/server/tests/pi-instance-isolation.test.ts apps/server/tests/work-root-isolation.test.ts apps/server/tests/remote-instance-cookie.test.ts apps/server/tests/runtime-instance-integration.test.ts apps/server/tests/session-working-directories.test.ts apps/server/tests/temp-directory-lifecycle.test.ts apps/server/tests/remote-access-http.test.ts
```

新增集成测试以临时数据和工作根同时创建两个完整应用，检查会话同ID隔离、草稿、模型设置文件、工作文件、独立token与Cookie、实际Vite代理和开发单独重建。使用 Fake 模型，避免真实模型请求；Pi 原生凭据测试另行检查两套测试认证文件的增删，不向模型服务发请求。它们不替代真实浏览器、旧版本数据库样本升级或操作系统任务隔离验证。

无依赖受控环境可运行 `node artifacts/verify-isolation.mjs`。该入口通过原生类型擦除执行目录内源码，注入测试HOME、内存会话/清理计划及HTTP对象，操作真实测试文件。结果写入 `artifacts/validation-summary.json`，明确列出未验证项；它不是应用集成测试或类型检查。

## 双实例人工核对

先在正常开发环境完成 `npm run build`。生产部署建议使用单独检出目录；Vite构建不解析开发实例配置，允许在生产模式环境中构建。

为避免操作真实资料，在仓库 `.tmp/` 下创建一个全新的空测试根，并在两个终端设置相同的 `checkRoot` 路径。以下命令只使用测试样本；Fake 模型用于验证实例业务状态，不能作为真实模型调用证据。

生产终端：

```bash
checkRoot="/absolute/path/to/new-empty-instance-check"
PI_CODING_AGENT_DIR="$checkRoot/production-pi" MULTIVAC_DATA_DIR="$checkRoot/production-data" MULTIVAC_WORK_ROOT="$checkRoot/production-work" MULTIVAC_PORT=4417 MULTIVAC_FAKE_ASSISTANT=1 MULTIVAC_REMOTE_ENABLED=1 npm start
```

开发终端：

```bash
checkRoot="/absolute/path/to/new-empty-instance-check"
MULTIVAC_DATA_DIR="$checkRoot/development-data" MULTIVAC_WORK_ROOT="$checkRoot/development-work" MULTIVAC_PORT=4418 MULTIVAC_FAKE_ASSISTANT=1 npm run dev
```

核对并记录启动输出中的模式、目录和API端口。不要把token加入截图、测试报告或提交。

1. 在同一浏览器打开生产 `http://127.0.0.1:4417` 和开发 Vite `http://127.0.0.1:5173`。各建会话并写入不同草稿、工作文件；开发 Network 中的 `/api` 请求保持5173同源，Vite目标为4418。记录实际事件流归属。
2. 在两个模型管理页面分别修改测试配置；检查两套数据库、Pi会话文件、模型设置、图片/书籍/成果/日志位置。开发未配置真实认证时应提示缺少认证，不能拿生产或Pi全局认证通过检查。
3. 本机回环入口按原规则免登录。验证Cookie登录需在同一浏览器使用同一个局域网或Tailscale主机名访问 `:4417` 与 `:4418` 的构建页面，分别使用各自终端token登录；检查两条不同名称的HttpOnly Cookie。开发退出、轮换token并重启后，生产登录和连接应保留。保留原同源拒绝及远程功能限制。
4. 在开发样本中归档、到期清理和恢复会话，检查生产文件与记录不变；分别停止/重启服务。外部共享只使用显式挂载的测试目录，记录共享文件这一例外。旧生产样本升级须另用脱敏副本，不能迁移真实生产目录来完成验收。
5. 先正常停止两端服务并核对其进程退出，再删除本次新建的测试根。不要使用模糊进程名停止其他实例，也不要在服务未停时删除目录。

验收时保存实际双页面、请求目标、状态变化及清理证据。已写测试或操作说明不能替代通过记录。

## 诊断与兼容限制

- 启动出现模式冲突：移除与入口冲突的 `MULTIVAC_MODE`，或选择对应入口。仅设置 `NODE_ENV` 不会切换数据。
- 目录冲突：检查有效绝对路径、符号链接和悬空链接；开发不能使用默认生产根。不要用复制生产数据库或认证文件绕过初始化。
- `EADDRINUSE`：按启动输出核对端口与所属进程；显式选择独立API端口，Vite代理随之更新。Vite默认5173被占用时直接报错。
- 页面连接错实例：核对启动器、单独启动的Vite和API是否使用同一模式及 `MULTIVAC_PORT`；清除遗留的 `MULTIVAC_E2E_API_PORT` 或修正冲突值。
- 缺少认证：在目标实例的模型管理中配置，检查其私有Pi路径。开发不读取Pi全局认证；显式环境密钥需由用户分别设置。
- 生产的默认应用目录、端口、历史会话路径、Pi原有配置与认证保持兼容；已有浏览器登录本来就会在服务重启后失效，本功能不迁移内存登录。
- 独立配置不构成普通会话bash的文件系统沙箱。同一外部挂载目录的文件、同一个源码检出目录的构建产物，以及用户显式复用的模型环境变量仍可能共享。
- 验证范围与失败/未验证项以实际报告为准。受控脚本生成 `artifacts/validation-summary.json`；完整类型检查、真实Pi、旧样本升级、Vite与浏览器实测需在支持的环境完成。

