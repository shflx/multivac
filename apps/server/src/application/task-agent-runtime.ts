import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, CoordinatorModelConfig, CoordinatorRuntimeConfig } from '@multivac/contracts';
import type { ModelSettingsService } from './model-settings-service.js';
import { createNewSessionRuntimeConfigResolver } from './new-session-runtime-config.js';

/** 注入执行约定的 AGENTS.md 上限；超出部分截断并注明，避免挤占任务上下文。 */
export const TASK_AGENTS_FILE_MAX_BYTES = 16 * 1024;

export interface TaskConventions {
  agentName: string;
  instructions: string;
  projectConstraints: string;
  /** 项目资料的索引与常驻全文，见 ProjectResourceService.context；没有资料时为空字符串。 */
  projectResources?: string;
  agentsFile: { content: string; truncated: boolean } | null;
}

/** 只读工作目录根下的 AGENTS.md 普通文件；不存在、是链接或读取失败时视为没有。 */
export function readWorkingDirectoryAgentsFile(directory: string): TaskConventions['agentsFile'] {
  const path = join(directory, 'AGENTS.md');
  try {
    if (!lstatSync(path).isFile()) return null;
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(size, TASK_AGENTS_FILE_MAX_BYTES));
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      // 截断点可能落在多字节字符中间，解码后去掉替换字符。
      const content = buffer.subarray(0, length).toString('utf8').replace(/\uFFFD+$/, '').trim();
      return content ? { content, truncated: size > TASK_AGENTS_FILE_MAX_BYTES } : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 任务执行会话的执行约定：智能体指令、项目默认约束、项目资料、工作目录 AGENTS.md 依次并列，互不覆盖。
 * 空的部分省略；全部为空时返回空字符串。
 */
export function renderTaskConventions(input: TaskConventions): string {
  const sections = [
    input.instructions.trim() && `### 执行智能体「${input.agentName}」的指令\n${input.instructions.trim()}`,
    input.projectConstraints.trim() && `### 项目默认约束\n${input.projectConstraints.trim()}`,
    input.projectResources?.trim(),
    input.agentsFile && `### 工作目录的 AGENTS.md\n${input.agentsFile.content}${input.agentsFile.truncated ? `\n\n（文件超过 ${TASK_AGENTS_FILE_MAX_BYTES / 1024} KB，以上为开头部分；需要时可直接读取原文件。）` : ''}`,
  ].filter(Boolean);
  if (!sections.length) return '';
  return [
    '## 本任务的执行约定',
    '以下各部分同时适用、互不覆盖，只约定做法，不扩大工具、目录与授权边界；与系统规则冲突时以系统规则为准。',
    ...sections,
  ].join('\n\n');
}

/** 执行会话的模型：智能体跟随全局默认时返回 null；引用的模型不可用时抛错，不回退到其他模型。 */
export async function resolveTaskAgentModel(
  settings: Pick<ModelSettingsService, 'getModelProfileRuntimeConfig'>,
  agent: Pick<Agent, 'name' | 'modelProfileId' | 'thinkingLevel'>,
  fallbackThinking: CoordinatorModelConfig['thinkingLevel'],
): Promise<CoordinatorModelConfig | null> {
  if (agent.modelProfileId === null) return null;
  try {
    const configured = await settings.getModelProfileRuntimeConfig(agent.modelProfileId, { applyDefaultThinking: agent.thinkingLevel === null });
    return { thinkingLevel: fallbackThinking, ...configured, ...(agent.thinkingLevel === null ? {} : { thinkingLevel: agent.thinkingLevel }) };
  } catch (error) {
    throw new Error(`执行智能体「${agent.name}」的模型当前不可用：${error instanceof Error ? error.message : '配置或认证无法核对。'}请到设置中修复模型或更换智能体后重试。`);
  }
}

/** 任务执行会话的运行配置：系统提示追加执行约定；新建 Pi 会话时按智能体选模型，跟随默认时沿用新会话默认模型。 */
export function taskAgentRuntimeConfig(input: {
  base: CoordinatorRuntimeConfig;
  settings: ModelSettingsService;
  agent: Agent;
  conventions: string;
}): { runtimeConfig: CoordinatorRuntimeConfig; resolveNewSessionRuntimeConfig: () => Promise<CoordinatorRuntimeConfig> } {
  const runtimeConfig = input.conventions
    ? { ...input.base, systemPrompt: `${input.base.systemPrompt}\n\n${input.conventions}` }
    : input.base;
  const followDefault = createNewSessionRuntimeConfigResolver(input.settings, runtimeConfig);
  return {
    runtimeConfig,
    resolveNewSessionRuntimeConfig: async () => {
      const model = await resolveTaskAgentModel(input.settings, input.agent, runtimeConfig.model.thinkingLevel);
      return model ? { ...runtimeConfig, model } : followDefault();
    },
  };
}
