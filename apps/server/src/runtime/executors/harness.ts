import type { CoordinatorHarnessId } from '@multivac/contracts';
import type { ExecutionDiagnostics } from '../../application/execution-diagnostics.js';
import type { ModelAccessBackend } from '../../modules/model-settings/model-access.js';
import type { ModelSettingsCatalogFactory, StoredModelSettingsState } from '../../modules/model-settings/model-settings.js';
import type { CoordinatorAdapter, CoordinatorToolAuthorizer } from '../../modules/sessions/coordinator-adapter.js';
import type { ModelUsageRecorder } from '../../modules/usage/model-usage.js';
import type { MultivacRuntimeConfig } from '../../runtime-config.js';
import type { MultivacDataPaths } from '../../storage/data-paths.js';
import type { BashExecutionPort } from './managed-bash-tool.js';

/**
 * 一个执行器（harness）向 Multivac 提供的全部运行时能力。
 *
 * 新增 harness 时实现一个工厂并在 harness-registry 中登记：适配器负责会话、事件与工具注入，
 * 模型目录与访问后端负责该 harness 的模型、能力与凭据。上层只依赖这里的端口，不感知具体 harness。
 */
export interface HarnessRuntime {
  readonly id: CoordinatorHarnessId;
  readonly adapter: CoordinatorAdapter;
  readonly modelSettingsCatalog: ModelSettingsCatalogFactory;
  readonly modelAccess: ModelAccessBackend;
  /** 是否发起真实模型调用（据此记录用量）；夹具为 false。 */
  readonly recordsUsage: boolean;
  /** 模型设置文件尚不存在时的初始内容；缺省时使用空设置。 */
  readonly initialModelSettings?: StoredModelSettingsState;
  /** 模型连接检查使用的时钟；缺省为系统时钟。 */
  readonly accessClock?: () => number;
}

/** 装配 harness 时由 Multivac 提供的依赖。 */
export interface HarnessContext {
  readonly environment: NodeJS.ProcessEnv;
  readonly instance: MultivacRuntimeConfig;
  readonly paths: MultivacDataPaths;
  /** 目录外访问的授权决定；执行器在工具执行前调用。 */
  readonly authorizeToolCall: CoordinatorToolAuthorizer;
  /** 托管 bash：命令在服务端登记的进程中执行。 */
  readonly bashProcesses: BashExecutionPort;
  /** 模型调用用量记账；装配期间尚未就绪时也可传入延迟转发的实现。 */
  readonly usageRecorder: ModelUsageRecorder;
  readonly executionDiagnostics: ExecutionDiagnostics;
}

export type HarnessFactory<T extends HarnessRuntime = HarnessRuntime> = (context: HarnessContext) => T;
