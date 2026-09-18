import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  CoordinatorDiagnostic,
  CoordinatorErrorCode,
  CoordinatorRuntimeConfig,
  CoordinatorThinkingLevel,
  ModelProfileInput,
} from '@multivac/contracts';
import {
  buildSessionContext,
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEventListener,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type CreateModelRuntimeOptions,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { createControlledResourceLoader } from './controlled-resource-loader.js';
import { COORDINATOR_TOOL_ALLOWLIST, createCoordinatorTools } from './coordinator-tools.js';
import { buildPiModelsConfig, refreshPiModelCatalog } from './pi-model-settings-catalog.js';
import { resolvePiRequestEndpoint, type PiResolvedRequestEndpoint } from './pi-model-auth.js';
import { securePiAuthFile } from './pi-credential-security.js';
import {
  equalModelEndpoints,
  safeModelEndpoint,
  safeModelProtocol,
  isPiNativeDynamicEndpoint,
} from '../../modules/sessions/model-selection-recovery.js';
import type {
  CoordinatorModelSelectionRecoveryInput,
  CoordinatorSessionRecoveryIdentity,
} from './coordinator-adapter.js';

export type PiCoordinatorModel = NonNullable<ReturnType<ModelRuntime['getModel']>>;

const sessionOperationTails = new Map<string, Promise<void>>();

function serializeSessionOperation<T>(
  input: Pick<PiCoordinatorSessionFactoryInput, 'cwd' | 'agentDir' | 'sessionDir'>,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(SessionManager.create(input.cwd, input.sessionDir).getSessionDir());
  const previous = sessionOperationTails.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  sessionOperationTails.set(key, tail);
  void tail.then(() => {
    if (sessionOperationTails.get(key) === tail) sessionOperationTails.delete(key);
  });
  return result;
}

export interface PiCoordinatorAgentSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly model: PiCoordinatorModel | undefined;
  readonly thinkingLevel: CoordinatorThinkingLevel;
  readonly isStreaming: boolean;
  readonly isIdle?: boolean;
  getActiveBranch(): SessionEntry[];
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: AgentSessionEventListener): () => void;
  getActiveToolNames(): string[];
  setModel(model: PiCoordinatorModel): Promise<void>;
  setThinkingLevel(level: CoordinatorThinkingLevel): void;
  getAvailableThinkingLevels?(): CoordinatorThinkingLevel[];
  dispose(): void;
}

export interface PiCoordinatorModelRuntime {
  getModel(providerId: string, modelId: string): PiCoordinatorModel | undefined;
  hasConfiguredAuth(providerId: string): boolean;
}

export interface PiCoordinatorSessionResources {
  session: PiCoordinatorAgentSession;
  modelRuntime: PiCoordinatorModelRuntime;
  diagnostics: CoordinatorDiagnostic[];
  resumedExistingSession: boolean;
  appliedModelConfig: CoordinatorRuntimeConfig['model'];
  prepareModel?: (config: CoordinatorRuntimeConfig['model']) => Promise<{
    model: PiCoordinatorModel;
    config: CoordinatorRuntimeConfig['model'];
    activate: () => void;
    rollback: () => void;
  }>;
}

export interface PiCoordinatorSessionFactoryInput {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  config: CoordinatorRuntimeConfig;
  resolveNewSessionConfig?: () => Promise<CoordinatorRuntimeConfig>;
  resolveRecoveredSessionConfig?: (
    identity: CoordinatorSessionRecoveryIdentity,
  ) => Promise<CoordinatorRuntimeConfig | null>;
  persistModelSelectionRecovery?: (
    input: CoordinatorModelSelectionRecoveryInput,
  ) => Promise<void>;
}

export interface PiCoordinatorOpenSessionFactoryInput extends PiCoordinatorSessionFactoryInput {
  sessionPath: string;
}

export interface PiCoordinatorSessionFactory {
  create(input: PiCoordinatorSessionFactoryInput): Promise<PiCoordinatorSessionResources>;
  open(input: PiCoordinatorOpenSessionFactoryInput): Promise<PiCoordinatorSessionResources>;
  continue(input: PiCoordinatorSessionFactoryInput): Promise<PiCoordinatorSessionResources>;
}

export class PiCoordinatorSessionFactoryError extends Error {
  constructor(
    readonly code: Extract<
      CoordinatorErrorCode,
      'MODEL_NOT_FOUND' | 'MODEL_AUTH_UNAVAILABLE' | 'INVALID_CONFIGURATION' |
      'MODEL_SELECTION_RECOVERY_REQUIRED'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'PiCoordinatorSessionFactoryError';
  }
}

export interface DefaultPiCoordinatorSessionFactoryOptions {
  authPath?: string;
  modelsPath?: string | null;
  createAgentSession?: (
    options: CreateAgentSessionOptions,
  ) => Promise<CreateAgentSessionResult>;
  createModelRuntime?: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
  createSettingsManager?: (
    cwd: string,
    agentDir: string,
    options: { projectTrusted: boolean },
  ) => SettingsManager;
}

export interface SessionPlaceholderOperations {
  openSession: typeof SessionManager.open;
  stat: (path: string) => BigIntStats;
  read: (path: string) => string;
  unlink: (path: string) => void;
}

const PLACEHOLDER_OPERATIONS: SessionPlaceholderOperations = {
  openSession: (path, directory, cwd) => SessionManager.open(path, directory, cwd),
  stat: (path) => statSync(path, { bigint: true }),
  read: (path) => readFileSync(path, 'utf8'),
  unlink: (path) => unlinkSync(path),
};

/**
 * Pi 会把无 assistant message 的新会话延迟到首次回复再落盘。只读页面不会产生回复，
 * 因此在初始化意图持久化后发布既有 header，再用 SessionManager.open() 保留原身份。
 */
interface PersistedSessionPreparation {
  sessionManager: SessionManager;
  createdPlaceholder?: {
    path: string;
    sessionId: string;
    content: string;
    device: bigint;
    inode: bigint;
  };
}

function preparePersistedSessionManager(
  sessionManager: SessionManager,
  input: Pick<PiCoordinatorSessionFactoryInput, 'cwd' | 'sessionDir'>,
  operations: SessionPlaceholderOperations = PLACEHOLDER_OPERATIONS,
): PersistedSessionPreparation {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    throw new Error('Pi SessionManager 未提供可持久化的 session path。');
  }
  if (existsSync(sessionFile)) {
    return { sessionManager };
  }

  const preparation: PersistedSessionPreparation = { sessionManager };
  try {
    const descriptor = openSync(sessionFile, 'wx');
    try {
      const stats = fstatSync(descriptor, { bigint: true });
      const content = `${JSON.stringify(sessionManager.getHeader())}\n`;
      preparation.createdPlaceholder = {
        path: sessionFile,
        sessionId: sessionManager.getSessionId(),
        content,
        device: stats.dev,
        inode: stats.ino,
      };
      writeFileSync(descriptor, content, 'utf8');
    } finally {
      closeSync(descriptor);
    }
    preparation.sessionManager = operations.openSession(sessionFile, input.sessionDir, input.cwd);
    const stats = operations.stat(sessionFile);
    if (stats.dev !== preparation.createdPlaceholder!.device ||
      stats.ino !== preparation.createdPlaceholder!.inode ||
      operations.read(sessionFile) !== preparation.createdPlaceholder!.content) {
      throw new Error('Pi 占位文件在准备阶段发生变化。');
    }
    return preparation;
  } catch (error) {
    cleanupIncompletePlaceholder(preparation, operations);
    throw error;
  }
}

export function ensurePersistedSessionManager(
  sessionManager: SessionManager,
  input: Pick<PiCoordinatorSessionFactoryInput, 'cwd' | 'sessionDir'>,
  operations: SessionPlaceholderOperations = PLACEHOLDER_OPERATIONS,
): SessionManager {
  return preparePersistedSessionManager(sessionManager, input, operations).sessionManager;
}

function cleanupIncompletePlaceholder(
  preparation: PersistedSessionPreparation,
  operations: SessionPlaceholderOperations = PLACEHOLDER_OPERATIONS,
): void {
  const placeholder = preparation.createdPlaceholder;
  if (
    !placeholder ||
    preparation.sessionManager.getSessionFile() !== placeholder.path ||
    preparation.sessionManager.getSessionId() !== placeholder.sessionId ||
    preparation.sessionManager.getBranch().length > 0 ||
    !existsSync(placeholder.path)
  ) return;
  try {
    const before = operations.stat(placeholder.path);
    const content = operations.read(placeholder.path);
    const lines = content.split(/\r?\n/u).filter(Boolean);
    if (
      before.dev !== placeholder.device ||
      before.ino !== placeholder.inode ||
      content !== placeholder.content ||
      lines.length !== 1
    ) return;
    const header = JSON.parse(lines[0]!) as { type?: unknown; id?: unknown };
    if (header.type !== 'session' || header.id !== placeholder.sessionId) return;
    const after = operations.stat(placeholder.path);
    if (
      after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeNs !== before.mtimeNs
    ) return;
    operations.unlink(placeholder.path);
  } catch {
    // 初始化失败时保留原始错误；后续重试仍会重新核验该目录。
  }
}

function runtimeSettings(config: CoordinatorRuntimeConfig) {
  return {
    retry: { ...config.retry },
    compaction: { ...config.compaction },
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    defaultTools: [],
  };
}

function settingsDiagnostics(
  settingsManager: SettingsManager,
  code: 'SETTINGS_LOAD_FAILED' | 'SETTINGS_PERSIST_FAILED',
): CoordinatorDiagnostic[] {
  return settingsManager.drainErrors().map((error) => ({
    code,
    message: `Pi ${error.scope} 配置${code === 'SETTINGS_LOAD_FAILED' ? '读取' : '持久化'}失败${error.path ? `：${error.path}` : ''}。`,
  }));
}

function appendUniqueDiagnostics(
  target: CoordinatorDiagnostic[],
  additions: readonly CoordinatorDiagnostic[],
): void {
  const existing = new Set(target.map((diagnostic) => JSON.stringify(diagnostic)));
  for (const diagnostic of additions) {
    const key = JSON.stringify(diagnostic);
    if (!existing.has(key)) {
      target.push(diagnostic);
      existing.add(key);
    }
  }
}

export function thinkingLevelDiagnostic(
  requested: CoordinatorThinkingLevel,
  actual: CoordinatorThinkingLevel,
): CoordinatorDiagnostic | undefined {
  if (requested === actual) {
    return undefined;
  }

  return {
    code: 'THINKING_LEVEL_ADJUSTED',
    message: `请求的 thinking level ${requested} 已按模型能力调整为 ${actual}。`,
    requestedThinkingLevel: requested,
    actualThinkingLevel: actual,
  };
}

export async function createCoordinatorSettingsManager(
  input: PiCoordinatorSessionFactoryInput,
  createSettingsManager: NonNullable<
    DefaultPiCoordinatorSessionFactoryOptions['createSettingsManager']
  > = (cwd, agentDir, options) => SettingsManager.create(cwd, agentDir, options),
): Promise<{ settingsManager: SettingsManager; diagnostics: CoordinatorDiagnostic[] }> {
  const settingsManager = createSettingsManager(input.cwd, input.agentDir, {
    projectTrusted: false,
  });
  const diagnostics = settingsDiagnostics(settingsManager, 'SETTINGS_LOAD_FAILED');

  settingsManager.applyOverrides(runtimeSettings(input.config));

  await settingsManager.flush();
  appendUniqueDiagnostics(
    diagnostics,
    settingsDiagnostics(settingsManager, 'SETTINGS_PERSIST_FAILED'),
  );

  return { settingsManager, diagnostics };
}

/** 默认 factory 只装配 Pi 服务，所有会话执行、队列、重试和压缩仍由 Pi 自己管理。 */
export class DefaultPiCoordinatorSessionFactory implements PiCoordinatorSessionFactory {
  private readonly createPiAgentSession: NonNullable<
    DefaultPiCoordinatorSessionFactoryOptions['createAgentSession']
  >;
  private readonly createModelRuntime: NonNullable<
    DefaultPiCoordinatorSessionFactoryOptions['createModelRuntime']
  >;
  private readonly createSettingsManager: NonNullable<
    DefaultPiCoordinatorSessionFactoryOptions['createSettingsManager']
  >;

  constructor(private readonly options: DefaultPiCoordinatorSessionFactoryOptions = {}) {
    this.createPiAgentSession = options.createAgentSession ?? createAgentSession;
    this.createModelRuntime = options.createModelRuntime ?? (async (runtimeOptions) => {
      await securePiAuthFile(runtimeOptions.authPath!);
      return ModelRuntime.create(runtimeOptions);
    });
    this.createSettingsManager =
      options.createSettingsManager ??
      ((cwd, agentDir, settingsOptions) =>
        SettingsManager.create(cwd, agentDir, settingsOptions));
  }

  create(input: PiCoordinatorSessionFactoryInput): Promise<PiCoordinatorSessionResources> {
    return serializeSessionOperation(input, () => this.createFromSessionManager(
      input,
      SessionManager.create(input.cwd, input.sessionDir),
      true,
      false,
    ));
  }

  open(input: PiCoordinatorOpenSessionFactoryInput): Promise<PiCoordinatorSessionResources> {
    return this.createFromSessionManager(
      input,
      SessionManager.open(input.sessionPath, input.sessionDir, input.cwd),
      false,
      true,
    );
  }

  async continue(input: PiCoordinatorSessionFactoryInput): Promise<PiCoordinatorSessionResources> {
    return serializeSessionOperation(input, () => this.continueUnlocked(input));
  }

  private async continueUnlocked(
    input: PiCoordinatorSessionFactoryInput,
  ): Promise<PiCoordinatorSessionResources> {
    const sessionManager = SessionManager.continueRecent(input.cwd, input.sessionDir);
    const sessionFile = sessionManager.getSessionFile();
    const resumedExistingSession = Boolean(sessionFile && existsSync(sessionFile));
    const historicalModel = resumedExistingSession
      ? buildSessionContext(sessionManager.getBranch()).model
      : null;
    const recoveredConfig = resumedExistingSession && input.resolveRecoveredSessionConfig
      ? await input.resolveRecoveredSessionConfig({
          piSessionId: sessionManager.getSessionId(),
          piSessionPath: sessionFile!,
        })
      : null;
    if (resumedExistingSession && input.resolveRecoveredSessionConfig && !recoveredConfig) {
      throw new PiCoordinatorSessionFactoryError(
        'MODEL_SELECTION_RECOVERY_REQUIRED',
        historicalModel
          ? 'Pi 历史只有 provider/modelId，缺少受控协议和端点恢复记录。'
          : 'Pi session 缺少模型选择恢复记录。',
      );
    }
    if (recoveredConfig && historicalModel && (
      recoveredConfig.model.provider !== historicalModel.provider ||
      recoveredConfig.model.modelId !== historicalModel.modelId
    )) {
      throw new PiCoordinatorSessionFactoryError(
        'MODEL_SELECTION_RECOVERY_REQUIRED',
        'Pi 历史模型与初始化意图记录不一致。',
      );
    }
    const config = resumedExistingSession
      ? recoveredConfig ?? (historicalModel
        ? {
            ...input.config,
            model: {
              ...input.config.model,
              provider: historicalModel.provider,
              modelId: historicalModel.modelId,
            },
          }
        : input.config)
      : input.resolveNewSessionConfig
        ? await input.resolveNewSessionConfig()
        : input.config;
    return this.createFromSessionManager(
      { ...input, config },
      sessionManager,
      true,
      resumedExistingSession,
    );
  }

  private async createFromSessionManager(
    input: PiCoordinatorSessionFactoryInput,
    sessionManager: SessionManager,
    ensurePersisted: boolean,
    resumedExistingSession: boolean,
  ): Promise<PiCoordinatorSessionResources> {
    let preparation: PersistedSessionPreparation = { sessionManager };
    let createdAgentSession: CreateAgentSessionResult['session'] | undefined;
    let appliedModelConfig = input.config.model;
    try {
      const { settingsManager, diagnostics } = await createCoordinatorSettingsManager(
        input,
        this.createSettingsManager,
      );
      const source = input.config.model.source ?? 'base';
      const selected = input.config.model;
      const nativeEndpointRequested = selected.endpointMode === 'pi-native-dynamic';
      if ((source !== 'base' && source !== 'controlled') ||
        (source === 'base' && selected.profileId !== undefined) ||
        (selected.endpointMode !== undefined && selected.endpointMode !== 'fixed' && !nativeEndpointRequested) ||
        (nativeEndpointRequested && (source !== 'base' ||
          !isPiNativeDynamicEndpoint(selected.protocol) ||
          selected.endpoint === undefined || selected.resolvedEndpoint !== null)) ||
        (selected.protocol !== undefined && !safeModelProtocol(selected.protocol)) ||
        (selected.endpoint != null && !safeModelEndpoint(selected.endpoint)) ||
        (selected.resolvedEndpoint !== undefined && !nativeEndpointRequested && !safeModelEndpoint(selected.resolvedEndpoint)) ||
        (source === 'controlled' && (
          !selected.profileId?.trim() || !selected.resolvedEndpoint ||
          !['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(selected.protocol ?? '')
        ))) {
        throw new PiCoordinatorSessionFactoryError('INVALID_CONFIGURATION', '模型配置来源或关联字段无效。');
      }
      let delegatedRuntime = await this.createRuntimeForConfig(input);
      // SDK stream 与 setter 共用同一代理；切换运行配置不重建会话或触碰消息。
      const modelRuntime = new Proxy(delegatedRuntime, {
        get: (_target, property) => {
          const value = Reflect.get(delegatedRuntime, property, delegatedRuntime) as unknown;
          return typeof value === 'function' ? value.bind(delegatedRuntime) : value;
        },
      });
      const model = modelRuntime.getModel(input.config.model.provider, input.config.model.modelId);

      if (!model) {
        throw new PiCoordinatorSessionFactoryError(
          'MODEL_NOT_FOUND',
          `未找到模型 ${input.config.model.provider}/${input.config.model.modelId}。`,
        );
      }

      if (model.provider !== selected.provider || model.id !== selected.modelId ||
        (selected.protocol && model.api !== selected.protocol) ||
        (selected.endpoint && !(source === 'base' && isPiNativeDynamicEndpoint(model.api)) &&
          (!safeModelEndpoint(model.baseUrl) ||
          !equalModelEndpoints(model.baseUrl, selected.endpoint)))) {
        throw new PiCoordinatorSessionFactoryError(
          'INVALID_CONFIGURATION',
          'Pi 最终模型的协议或端点与固定模型选择不一致。',
        );
      }

      if (!modelRuntime.hasConfiguredAuth(model.provider) && !resumedExistingSession) {
        throw new PiCoordinatorSessionFactoryError(
          'MODEL_AUTH_UNAVAILABLE',
          `模型提供方 ${model.provider} 没有可用认证。`,
        );
      }
      let resolved: PiResolvedRequestEndpoint | undefined;
      try {
        resolved = await resolvePiRequestEndpoint(
          modelRuntime, model, source === 'controlled' ? selected.endpoint ?? null : null,
          source,
        );
      } catch {
        throw new PiCoordinatorSessionFactoryError(
          'INVALID_CONFIGURATION', 'Pi 认证解析后的端点与固定模型选择不一致。',
        );
      }
      if (!resolved) {
        if (!resumedExistingSession || selected.resolvedEndpoint === undefined) {
          throw new PiCoordinatorSessionFactoryError('MODEL_AUTH_UNAVAILABLE', 'Pi 当前无法解析有效模型认证。');
        }
        // 认证失效的既有会话仍可只读恢复；不新发请求、不改变固定端点来源。
        resolved = selected.endpointMode === 'pi-native-dynamic'
          ? { mode: 'pi-native-dynamic', endpoint: null, fallback: selected.endpoint ?? null }
          : { mode: 'fixed', endpoint: selected.resolvedEndpoint! };
      }
      if ((selected.endpointMode !== undefined && selected.endpointMode !== resolved.mode) ||
        (nativeEndpointRequested && resolved.mode === 'pi-native-dynamic' &&
          (selected.endpoint === null ? resolved.fallback !== null :
            resolved.fallback === null || !equalModelEndpoints(selected.endpoint!, resolved.fallback))) ||
        (selected.resolvedEndpoint && (resolved.mode !== 'fixed' ||
          !equalModelEndpoints(resolved.endpoint, selected.resolvedEndpoint)))) {
        throw new PiCoordinatorSessionFactoryError(
          'INVALID_CONFIGURATION', 'Pi 认证解析后的端点与固定模型选择不一致。',
        );
      }
      if (!safeModelProtocol(model.api) || (resolved.mode === 'fixed' && !safeModelEndpoint(model.baseUrl))) {
        throw new PiCoordinatorSessionFactoryError('INVALID_CONFIGURATION', 'Pi 模型的协议或目录端点不安全。');
      }
      appliedModelConfig = {
        ...selected,
        source,
        protocol: model.api,
        endpoint: resolved.mode === 'pi-native-dynamic'
          ? resolved.fallback : source === 'controlled' ? selected.endpoint ?? null : model.baseUrl,
        resolvedEndpoint: resolved.endpoint,
        ...(resolved.mode === 'pi-native-dynamic' ? { endpointMode: resolved.mode } : {}),
      };

      const resourceLoader = await createControlledResourceLoader({
        settingsManager,
        systemPrompt: input.config.systemPrompt,
        authorizedContext: input.config.authorizedContext,
        retry: input.config.retry,
        compaction: input.config.compaction,
      });
      appendUniqueDiagnostics(
        diagnostics,
        settingsDiagnostics(settingsManager, 'SETTINGS_LOAD_FAILED'),
      );
      settingsManager.applyOverrides(runtimeSettings(input.config));
      await settingsManager.flush();
      appendUniqueDiagnostics(
        diagnostics,
        settingsDiagnostics(settingsManager, 'SETTINGS_PERSIST_FAILED'),
      );

      const customTools = createCoordinatorTools(input.config.authorizedContext);
      if (input.persistModelSelectionRecovery) {
        // 意图先可靠落盘，之后才允许 header 与 SDK 初始化记录发布到 sessions 目录。
        await input.persistModelSelectionRecovery({
          piSessionId: sessionManager.getSessionId(),
          piSessionPath: sessionManager.getSessionFile()!,
          model: appliedModelConfig,
        });
      }
      preparation = ensurePersisted
        ? preparePersistedSessionManager(sessionManager, input)
        : { sessionManager };
      const result = await this.createPiAgentSession({
        cwd: input.cwd,
        agentDir: input.agentDir,
        modelRuntime,
        model,
        // 既有 Pi transcript 的等级优先；显式传入初始等级会覆盖 SDK 历史恢复。
        ...(resumedExistingSession
          ? preparation.sessionManager.getBranch().some((entry) => entry.type === 'thinking_level_change')
            ? { thinkingLevel: buildSessionContext(preparation.sessionManager.getBranch()).thinkingLevel as CoordinatorThinkingLevel }
            : {}
          : { thinkingLevel: input.config.model.thinkingLevel }),
        settingsManager,
        sessionManager: preparation.sessionManager,
        resourceLoader,
        noTools: 'all',
        tools: [...COORDINATOR_TOOL_ALLOWLIST],
        customTools,
      });
      createdAgentSession = result.session;
      if (input.persistModelSelectionRecovery && (
        result.session.sessionId !== sessionManager.getSessionId() ||
        result.session.sessionFile !== sessionManager.getSessionFile()
      )) {
        throw new PiCoordinatorSessionFactoryError(
          'INVALID_CONFIGURATION',
          'Pi SDK 返回的 session 身份与初始化意图不一致。',
        );
      }

      if (result.modelFallbackMessage) {
        diagnostics.push({ code: 'MODEL_FALLBACK', message: result.modelFallbackMessage });
      }

      const thinkingDiagnostic = thinkingLevelDiagnostic(
        input.config.model.thinkingLevel,
        result.session.thinkingLevel,
      );
      if (thinkingDiagnostic) {
        appendUniqueDiagnostics(diagnostics, [thinkingDiagnostic]);
      }

      const activeToolNames = result.session.getActiveToolNames().sort();
      const expectedToolNames = [...COORDINATOR_TOOL_ALLOWLIST].sort();
      if (activeToolNames.join('\0') !== expectedToolNames.join('\0')) {
        throw new PiCoordinatorSessionFactoryError(
          'INVALID_CONFIGURATION',
          'Pi 实际启用工具与 Multivac allowlist 不一致。',
        );
      }

      const session: PiCoordinatorAgentSession = {
        get sessionId() {
          return result.session.sessionId;
        },
        get sessionFile() {
          return result.session.sessionFile;
        },
        get model() {
          return result.session.model;
        },
        get thinkingLevel() {
          return result.session.thinkingLevel;
        },
        get isStreaming() {
          return result.session.isStreaming;
        },
        get isIdle() { return result.session.isIdle && !result.session.isRetrying; },
        getActiveBranch: () => result.session.sessionManager.getBranch(),
        prompt: (text) => result.session.prompt(text),
        steer: (text) => result.session.steer(text),
        followUp: (text) => result.session.followUp(text),
        abort: () => result.session.abort(),
        subscribe: (listener) => result.session.subscribe(listener),
        getActiveToolNames: () => result.session.getActiveToolNames(),
        setModel: (model) => result.session.setModel(model),
        setThinkingLevel: (level) => result.session.setThinkingLevel(level),
        getAvailableThinkingLevels: () => result.session.getAvailableThinkingLevels(),
        dispose: () => result.session.dispose(),
      };

      return {
        session,
        modelRuntime,
        diagnostics,
        resumedExistingSession,
        appliedModelConfig,
        prepareModel: async (config) => {
          const candidate = await this.createRuntimeForConfig({ ...input, config: { ...input.config, model: config } });
          const next = candidate.getModel(config.provider, config.modelId);
          if (!next || (config.protocol && next.api !== config.protocol)) {
            throw new PiCoordinatorSessionFactoryError('MODEL_NOT_FOUND', 'Pi 当前未找到目标模型或协议不一致。');
          }
          const [auth, available] = await Promise.all([
            candidate.checkAuth(next.provider), candidate.getAvailable(next.provider),
          ]);
          if (!auth || !available.some((item) => item.id === next.id && item.api === next.api)) {
            throw new PiCoordinatorSessionFactoryError('MODEL_AUTH_UNAVAILABLE', 'Pi 当前未将目标模型判定为已认证且可用。');
          }
          const source = config.source ?? 'base';
          const resolved = await resolvePiRequestEndpoint(candidate, next, source === 'controlled' ? config.endpoint ?? null : null, source);
          if (!resolved || !safeModelProtocol(next.api) ||
            (config.resolvedEndpoint && (resolved.mode !== 'fixed' || !equalModelEndpoints(resolved.endpoint, config.resolvedEndpoint)))) {
            throw new PiCoordinatorSessionFactoryError('INVALID_CONFIGURATION', 'Pi 目标模型的实际端点与选择快照不一致。');
          }
          const previous = delegatedRuntime;
          return {
            model: next,
            config: { ...config, protocol: next.api, resolvedEndpoint: resolved.endpoint },
            activate: () => { delegatedRuntime = candidate; },
            rollback: () => { delegatedRuntime = previous; },
          };
        },
      };
    } catch (error) {
      try {
        createdAgentSession?.dispose();
      } catch {
        // 不用 dispose 的次生异常覆盖初始化失败事实。
      }
      cleanupIncompletePlaceholder(preparation);
      throw error;
    }
  }

  private async createRuntimeForConfig(
    input: PiCoordinatorSessionFactoryInput,
  ): Promise<ModelRuntime> {
    const baseOptions: CreateModelRuntimeOptions = {
      authPath: this.options.authPath ?? join(input.agentDir, 'auth.json'),
      modelsPath:
        this.options.modelsPath === undefined
          ? join(input.agentDir, 'models.json')
          : this.options.modelsPath,
      allowModelNetwork: false,
    };
    const { endpoint, protocol } = input.config.model;
    if ((input.config.model.source ?? 'base') === 'base') return this.createModelRuntime(baseOptions);

    const directory = await mkdtemp(join(tmpdir(), 'multivac-session-model-'));
    try {
      const basePath = join(directory, 'base-models.json');
      await writeFile(basePath, '{"providers":{}}\n', { encoding: 'utf8', mode: 0o600 });
      const baseRuntime = await this.createModelRuntime({
        ...baseOptions,
        modelsPath: basePath,
        modelsStorePath: join(input.agentDir, 'models-store.json'),
        refreshOnCreate: true,
      });
      const profile: ModelProfileInput = {
        profileId: 'active-default',
        displayName: input.config.model.modelId,
        provider: input.config.model.provider,
        modelId: input.config.model.modelId,
        protocol: protocol as ModelProfileInput['protocol'],
        endpoint: endpoint ?? null,
      };
      await refreshPiModelCatalog(baseRuntime, [profile]);
      const { config } = buildPiModelsConfig([profile], baseRuntime);
      const candidatePath = join(directory, 'candidate-models.json');
      await writeFile(candidatePath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return await this.createModelRuntime({
        ...baseOptions,
        modelsPath: candidatePath,
        modelsStorePath: join(input.agentDir, 'models-store.json'),
        refreshOnCreate: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
