import type {
  CoordinatorAuthorizedContext,
  CoordinatorCompactionConfig,
  CoordinatorRetryConfig,
} from '@multivac/contracts';
import {
  createExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';

export interface ControlledResourceLoaderInput {
  settingsManager: SettingsManager;
  systemPrompt: string;
  authorizedContext: readonly CoordinatorAuthorizedContext[];
  retry: CoordinatorRetryConfig;
  compaction: CoordinatorCompactionConfig;
}

function renderAuthorizedContext(contexts: readonly CoordinatorAuthorizedContext[]): string[] {
  return [
    [
      '# 资料读取范围',
      '默认只使用下面注入的已授权资料，不主动读取其他本地文件、目录、技能或全局配置。工具可用不等于资料读取已获授权。',
      '如果用户在当前请求中明确要求读取特定文件或目录，可以为完成该请求读取指定范围内的文件；不要扩展到其他路径，也不要把这次授权沿用到后续请求。',
      '需要额外资料但用户没有明确指定文件或目录时，先询问具体路径。',
      contexts.length === 0 ? '本次会话没有注入任何已授权资料。' : '## 已授权资料',
      ...contexts.flatMap((context) => [
        `### ${context.label} (${context.referenceId})`,
        context.content,
      ]),
    ].join('\n\n'),
  ];
}

function applyRuntimeOverrides(input: ControlledResourceLoaderInput): void {
  input.settingsManager.applyOverrides({
    retry: { ...input.retry },
    compaction: { ...input.compaction },
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    defaultTools: [],
  });
}

/**
 * 纯内存 ResourceLoader 不接触 DefaultResourceLoader 的包管理器和目录发现逻辑。
 * reload 只刷新公开 SettingsManager，并立即恢复本次调用的 runtime overrides。
 */
class ControlledResourceLoader implements ResourceLoader {
  private readonly extensions: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  private readonly appendSystemPrompt: string[];

  constructor(private readonly input: ControlledResourceLoaderInput) {
    this.appendSystemPrompt = renderAuthorizedContext(input.authorizedContext);
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensions;
  }

  getSkills() {
    return { skills: [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  getSystemPrompt(): string {
    return this.input.systemPrompt;
  }

  getSystemPromptSource(): undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    return [...this.appendSystemPrompt];
  }

  getAppendSystemPromptSources(): [] {
    return [];
  }

  extendResources(): void {
    // 不通过 extension 自动发现资料；用户当次指定的读取范围由提示词约束。
  }

  async reload(): Promise<void> {
    await this.input.settingsManager.reload();
    applyRuntimeOverrides(this.input);
  }
}

export async function createControlledResourceLoader(
  input: ControlledResourceLoaderInput,
): Promise<ResourceLoader> {
  const loader = new ControlledResourceLoader(input);

  await loader.reload();
  return loader;
}
