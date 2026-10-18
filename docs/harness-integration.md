# 接入新的执行器（harness）

Multivac 的会话由执行器（harness）运行，目前登记了 `pi`（生产）与 `fake`（演示与 E2E）。接入 Codex、Claude Code、OpenCode 等新执行器时，按本文实现一个适配器与工厂并登记；会话运行时、命令回执、内部工具、目录外授权、事件契约、数据库与前端不需要改动。

## 会话身份

- 绑定（`CoordinatorSessionBinding`）由 `harness`、`runtimeSessionId` 与 `runtimeSessionRef` 组成。`runtimeSessionRef` 是由所属执行器解释的不透明引用（Pi 为会话文件路径，服务形态的执行器可以是服务端会话 id），上层只保存与回传。
- 消息与条目身份使用 `runtimeEntryId`；阅读锚点、引用来源与命令回执都以它定位消息，必须在该会话内稳定。
- 会话只能由创建它的执行器续接：`continueSession`、`readPersistedHistory`、`readPersistedModelSelection` 遇到其他 harness 的身份时返回 `SESSION_BINDING_MISMATCH`。切换 `MULTIVAC_HARNESS` 后，其他执行器创建的会话不能打开，这是预期行为。
- 执行器之外不得出现以具体执行器命名的身份字段（`tests/static-runtime-dependencies.test.ts` 检查）。

## 接入步骤

1. **适配器**：在 `apps/server/src/runtime/executors/` 实现 `CoordinatorAdapter`（`modules/sessions/coordinator-adapter.ts`）。
   - `harness`：执行器标识，写入它创建的每个绑定。
   - `capabilities`：如实声明单轮执行配置、图片输入、运行中引导、工具停止证明与 Skill；声明不支持时对应方法返回失败，上层据此禁用而不是静默降级。
   - `protectedPaths`：执行器自己的凭据与会话目录，任务目录、Git 通道与托管进程不会触及。
   - 事件：把执行器的事件映射为 Coordinator 事件（参考 `pi-event-mapper.ts`），正文、工具、运行终态按真实身份与顺序发布。
   - 内部工具：无论以进程内注册还是外部协议（如 MCP 服务）注入，调用都回到 `CoordinatorInternalTools.invoke`，经同一幂等账本。
   - 目录外授权：文件工具执行前调用 `authorizeToolCall` 并等待决定。执行器无法在执行前拦截时，不开放对应工具，不以事后记录代替授权。
   - `bindTaskLease`、`bindSkills`：不支持任务执行或 Skill 时实现为空操作，并在 `capabilities` 中声明。
2. **端口契约测试**：把新适配器加入 `apps/server/tests/coordinator-adapter-contract.test.ts` 的 `subjects`，与 Pi、Fake 通过同一套用例。
3. **模型目录与访问后端**：实现 `ModelSettingsCatalogFactory`（可选模型、能力与推理等级）与 `ModelAccessBackend`（凭据保存与连接检查），凭据只交给执行器自己的存储。
4. **工厂与登记**：新建 `<name>-harness.ts` 实现 `HarnessFactory`（`runtime/executors/harness.ts`），在 `harness-registry.ts` 的 `HARNESSES` 中登记；`MULTIVAC_HARNESS=<name>` 启动。bootstrap 只经注册表引用执行器实现。
5. **SDK 边界**：新执行器 SDK 的导入只允许出现在 `runtime/executors/` 内部，为它补充与 Pi SDK 相同的静态检查。

## 接入时再确定的事项

以下内容取决于具体执行器的形态，接入第一个新执行器时结合实际差异设计，不提前抽象：

- **端口拆分**：按会话生命周期、对话、历史读取、模型选择与工具注入拆成更小的接口。
- **同一实例多执行器并存**：目前一个实例只装配一个执行器；并存时按绑定的 `harness` 选择适配器，模型设置按执行器分别提供。
- **界面与错误文案**：运行状态（如“消息已交给 Pi”，`apps/web/src/features/assistant/command-feedback.ts`）、模型设置页的认证与目录说明，以及服务端约 25 处错误说明写的是 Pi；需按会话所属执行器显示名称（会话页带上绑定的 `harness`）。
- **Pi 命名的协议值**：命令阶段 `handed_to_pi`、端点模式 `pi-native-dynamic` 仍以 Pi 命名，改名需要同时迁移库内 CHECK 约束与事件记录。
- **Skill 包解析**：`pi-skill-parser.ts` 解析 Skill 包的 frontmatter，属于 Skill 管理而非会话执行；新执行器按自己的方式装载已登记的 Skill（`bindSkills`）。
