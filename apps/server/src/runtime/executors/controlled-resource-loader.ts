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
  if (contexts.length === 0) {
    return ['本次会话没有注入任何已授权资料。'];
  }

  return [
    [
      '# 已授权资料',
      '以下内容是本次调用允许使用的完整资料上限。不要尝试读取未列出的文件、目录、技能或全局配置。',
      ...contexts.flatMap((context) => [
        `## ${context.label} (${context.referenceId})`,
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
    // 协调助手不接受 extension 动态扩展资源，授权快照是唯一资料来源。
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
