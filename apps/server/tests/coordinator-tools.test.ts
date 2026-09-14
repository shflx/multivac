import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DefaultResourceLoader,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createControlledResourceLoader } from '../src/runtime/executors/controlled-resource-loader.js';
import {
  COORDINATOR_TOOL_ALLOWLIST,
  createCoordinatorTools,
} from '../src/runtime/executors/coordinator-tools.js';

async function execute(tool: ToolDefinition, toolCallId: string, params: unknown) {
  return tool.execute(toolCallId, params as never, undefined, undefined, {} as never);
}

test('受控 ResourceLoader 关闭自动发现且只注入授权快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-resource-loader-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const installMarker = join(root, 'package-install-marker');
  const extensionMarker = join(root, 'extension-marker');
  const installer = join(root, 'installer.mjs');
  const extension = join(root, 'untrusted-extension.mjs');
  const skill = join(root, 'untrusted-skill');
  const prompt = join(root, 'untrusted-prompt.md');
  const theme = join(root, 'untrusted-theme.json');
  await mkdir(skill, { recursive: true });
  await mkdir(join(agentDir, 'skills', 'auto-discovered'), { recursive: true });
  await mkdir(join(cwd, '.pi', 'skills', 'auto-discovered'), { recursive: true });
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
  await mkdir(join(cwd, '.pi', 'themes'), { recursive: true });
  await writeFile(installer, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(installMarker)}, 'installed');`);
  await writeFile(extension, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(extensionMarker)}, 'loaded');`);
  await writeFile(join(skill, 'SKILL.md'), 'UNAUTHORIZED_SKILL');
  await writeFile(join(agentDir, 'skills', 'auto-discovered', 'SKILL.md'), 'UNAUTHORIZED_GLOBAL_SKILL');
  await writeFile(join(cwd, '.pi', 'skills', 'auto-discovered', 'SKILL.md'), 'UNAUTHORIZED_PROJECT_SKILL');
  await writeFile(join(cwd, '.pi', 'extensions', 'auto.mjs'), `import ${JSON.stringify(extension)};`);
  await writeFile(join(cwd, '.pi', 'prompts', 'auto.md'), 'UNAUTHORIZED_AUTO_PROMPT');
  await writeFile(join(cwd, '.pi', 'themes', 'auto.json'), '{}');
  await writeFile(prompt, 'UNAUTHORIZED_PROMPT');
  await writeFile(theme, '{}');
  const discoveredSettings = {
    npmCommand: [process.execPath, installer],
    packages: ['npm:multivac-untrusted-package'],
    extensions: [extension],
    skills: [skill],
    prompts: [prompt],
    themes: [theme],
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 2 },
  };
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(discoveredSettings));
  await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify(discoveredSettings));
  await writeFile(join(cwd, 'AGENTS.md'), 'UNAUTHORIZED_PROJECT_CONTEXT');
  await writeFile(join(root, 'AGENTS.md'), 'UNAUTHORIZED_PARENT_CONTEXT');
  await writeFile(join(agentDir, 'SYSTEM.md'), 'UNAUTHORIZED_GLOBAL_CONTEXT');

  try {
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const loader = await createControlledResourceLoader({
      settingsManager,
      systemPrompt: 'SYSTEM_PROMPT',
      authorizedContext: [{ referenceId: 'approved', label: '批准资料', content: 'AUTHORIZED' }],
      retry: { enabled: true, maxRetries: 4, baseDelayMs: 250 },
      compaction: { enabled: false, reserveTokens: 3_000, keepRecentTokens: 5_000 },
    });

    assert.equal(loader instanceof DefaultResourceLoader, false);
    assert.equal(loader.getSystemPrompt(), 'SYSTEM_PROMPT');
    assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
    assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
    assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
    assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
    assert.equal(loader.getExtensions().extensions.length, 0);
    const appended = loader.getAppendSystemPrompt().join('\n');
    assert.equal(appended.includes('AUTHORIZED'), true);
    assert.equal(appended.includes('UNAUTHORIZED'), false);
    assert.deepEqual(settingsManager.getRetrySettings(), {
      enabled: true,
      maxRetries: 4,
      baseDelayMs: 250,
    });
    assert.deepEqual(settingsManager.getCompactionSettings(), {
      enabled: false,
      reserveTokens: 3_000,
      keepRecentTokens: 5_000,
    });

    await loader.reload();
    assert.deepEqual(settingsManager.getRetrySettings(), {
      enabled: true,
      maxRetries: 4,
      baseDelayMs: 250,
    });
    await assert.rejects(access(installMarker));
    await assert.rejects(access(extensionMarker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('协调工具 allowlist 仅包含授权快照读取和无副作用提案', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-tools-'));
  const marker = join(root, 'marker.txt');
  await writeFile(marker, 'unchanged');

  try {
    const tools = createCoordinatorTools([
      { referenceId: 'approved', label: '批准资料', content: 'Alpha\nBeta alpha' },
    ]);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...COORDINATOR_TOOL_ALLOWLIST],
    );
    assert.equal(tools.some((tool) => ['bash', 'powershell', 'edit', 'write'].includes(tool.name)), false);

    const readTool = tools.find((tool) => tool.name === 'read_authorized_context');
    assert.ok(readTool);
    const unauthorized = await execute(readTool, 'call-read', { referenceId: 'missing' });
    assert.deepEqual(unauthorized.details, { code: 'CONTEXT_NOT_AUTHORIZED' });

    const searchTool = tools.find((tool) => tool.name === 'search_authorized_context');
    assert.ok(searchTool);
    const search = await execute(searchTool, 'call-search', { query: 'ALPHA' });
    const matches = JSON.parse(search.content[0]?.type === 'text' ? search.content[0].text : '[]');
    assert.deepEqual(matches, [
      { referenceId: 'approved', lineNumber: 1, text: 'Alpha' },
      { referenceId: 'approved', lineNumber: 2, text: 'Beta alpha' },
    ]);

    const proposalTool = tools.find((tool) => tool.name === 'propose_task');
    assert.ok(proposalTool);
    const proposal = await execute(proposalTool, 'proposal-1', {
      title: '新增任务',
      priority: 'high',
    });
    assert.deepEqual(proposal.details, {
      proposal: {
        kind: 'task.create',
        proposalId: 'proposal-1',
        title: '新增任务',
        priority: 'high',
      },
    });
    assert.equal(await readFile(marker, 'utf8'), 'unchanged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
