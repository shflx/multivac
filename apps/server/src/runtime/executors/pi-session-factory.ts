import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CoordinatorDiagnostic,
  CoordinatorErrorCode,
  CoordinatorRuntimeConfig,
  CoordinatorThinkingLevel,
} from '@multivac/contracts';
import {
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

export type PiCoordinatorModel = NonNullable<ReturnType<ModelRuntime['getModel']>>;

export interface PiCoordinatorAgentSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly model: PiCoordinatorModel | undefined;
  readonly thinkingLevel: CoordinatorThinkingLevel;
  readonly isStreaming: boolean;
  getActiveBranch(): SessionEntry[];
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: AgentSessionEventListener): () => void;
  getActiveToolNames(): string[];
  setModel(model: PiCoordinatorModel): Promise<void>;
  setThinkingLevel(level: CoordinatorThinkingLevel): void;
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
}

export interface PiCoordinatorSessionFactoryInput {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  config: CoordinatorRuntimeConfig;
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
      'MODEL_NOT_FOUND' | 'MODEL_AUTH_UNAVAILABLE' | 'INVALID_CONFIGURATION'
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

/**
 * Pi 会把无 assistant message 的新会话延迟到首次回复再落盘。只读页面不会产生回复，
 * 因此先创建空占位，再由公开的 SessionManager.open() 写入合法 session header。
 */
export function ensurePersistedSessionManager(
  sessionManager: SessionManager,
  input: Pick<PiCoordinatorSessionFactoryInput, 'cwd' | 'sessionDir'>,
): SessionManager {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) {
    throw new Error('Pi SessionManager 未提供可持久化的 session path。');
  }
  if (existsSync(sessionFile)) {
    return sessionManager;
  }

  let createdPlaceholder = false;
  try {
    const descriptor = openSync(sessionFile, 'wx');
    closeSync(descriptor);
    createdPlaceholder = true;
    return SessionManager.open(sessionFile, input.sessionDir, input.cwd);
  } catch (error) {
    if (createdPlaceholder) {
      try {
        unlinkSync(sessionFile);
      } catch {
        // 仅清理本函数创建且 Pi 未能初始化的空占位；原始错误更有诊断价值。
      }
    }
    throw error;
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
    this.createModelRuntime = options.createModelRuntime ?? ((runtimeOptions) => ModelRuntime.create(runtimeOptions));
    this.createSettingsManager =
      options.createSettingsManager ??
      ((cwd, agentDir, settingsOptions) =>
        SettingsManager.create(cwd, agentDir, settingsOptions));
  }

  create(input: PiCoordinatorSessionFactoryInput): Promise<PiCoordinatorSessionResources> {
    return this.createFromSessionManager(
      input,
      SessionManager.create(input.cwd, input.sessionDir),
      true,
    );
  }

  open(input: PiCoordinatorOpenSessionFactoryInput): Promise<PiCoordinatorSessionResources> {
    return this.createFromSessionManager(
      input,
      SessionManager.open(input.sessionPath, input.sessionDir, input.cwd),
      false,
    );
  }

  continue(input: PiCoordinatorSessionFactoryInput): Promise<PiCoordinatorSessionResources> {
    return this.createFromSessionManager(
      input,
      SessionManager.continueRecent(input.cwd, input.sessionDir),
      true,
    );
  }

  private async createFromSessionManager(
    input: PiCoordinatorSessionFactoryInput,
    sessionManager: SessionManager,
    ensurePersisted: boolean,
  ): Promise<PiCoordinatorSessionResources> {
    const preparedSessionManager = ensurePersisted
      ? ensurePersistedSessionManager(sessionManager, input)
      : sessionManager;
    const { settingsManager, diagnostics } = await createCoordinatorSettingsManager(
      input,
      this.createSettingsManager,
    );
    const modelRuntime = await this.createModelRuntime({
      authPath: this.options.authPath ?? join(input.agentDir, 'auth.json'),
      modelsPath:
        this.options.modelsPath === undefined
          ? join(input.agentDir, 'models.json')
          : this.options.modelsPath,
      allowModelNetwork: false,
    });
    const model = modelRuntime.getModel(input.config.model.provider, input.config.model.modelId);

    if (!model) {
      throw new PiCoordinatorSessionFactoryError(
        'MODEL_NOT_FOUND',
        `未找到模型 ${input.config.model.provider}/${input.config.model.modelId}。`,
      );
    }

    if (!modelRuntime.hasConfiguredAuth(model.provider)) {
      throw new PiCoordinatorSessionFactoryError(
        'MODEL_AUTH_UNAVAILABLE',
        `模型提供方 ${model.provider} 没有可用认证。`,
      );
    }

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
    const result = await this.createPiAgentSession({
      cwd: input.cwd,
      agentDir: input.agentDir,
      modelRuntime,
      model,
      thinkingLevel: input.config.model.thinkingLevel,
      settingsManager,
      sessionManager: preparedSessionManager,
      resourceLoader,
      noTools: 'all',
      tools: [...COORDINATOR_TOOL_ALLOWLIST],
      customTools,
    });

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
      result.session.dispose();
      throw new PiCoordinatorSessionFactoryError(
        'INVALID_CONFIGURATION',
        'Pi 实际启用工具与协调助手 allowlist 不一致。',
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
      getActiveBranch: () => result.session.sessionManager.getBranch(),
      prompt: (text) => result.session.prompt(text),
      steer: (text) => result.session.steer(text),
      followUp: (text) => result.session.followUp(text),
      abort: () => result.session.abort(),
      subscribe: (listener) => result.session.subscribe(listener),
      getActiveToolNames: () => result.session.getActiveToolNames(),
      setModel: (model) => result.session.setModel(model),
      setThinkingLevel: (level) => result.session.setThinkingLevel(level),
      dispose: () => result.session.dispose(),
    };

    return {
      session,
      modelRuntime,
      diagnostics,
    };
  }
}
