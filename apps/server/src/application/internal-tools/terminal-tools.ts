import { Type } from 'typebox';
import { WORKSPACE_MAX_PARALLEL, type TerminalPreset } from '@multivac/contracts';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { defineInternalTool } from './internal-tool-service.js';
import { clip, detailOf, projectLink, projectRef, summaryOf, workspaceById, workspaceRef } from './tool-text.js';
import { navigateOrigin } from './workspace-tools.js';

/** 一轮对话中最多启动的终端数：防止被网页或文件中夹带的指令诱导反复启动。 */
const TERMINALS_PER_TURN = 3;
const launchedPerTurn = new Map<string, number>();

const PRESET_LABELS = { blank: '空白终端', claude: 'Claude Code', codex: 'Codex' } as const;

/**
 * 在项目中启动终端：只能用固定预设（空白终端、Claude Code、Codex），不能带命令或参数；
 * 不读取终端画面，也不向终端输入。只接受本机界面发起的一轮（远程对话不携带当前视图）。
 * 启动后在发起窗口中打开：给出栏位时放进并排的第 N 栏（只在该窗口生效），否则单独查看。
 */
export const openTerminalTool = defineInternalTool({
  name: 'open_terminal',
  effect: 'manage',
  changesView: true,
  description: '在项目中启动一个终端，并在用户发出这条消息的窗口中打开它（与项目旁“+”菜单中新建终端相同，直接执行）。' +
    'preset 只能是 blank（空白终端，运行用户的登录 shell）、claude（Claude Code）或 codex（Codex），不能指定命令或参数。' +
    '终端是外部程序，Multivac 不管控；你不能读取终端画面，也不能向终端输入，启动后由用户在终端中操作。' +
    '给出 slot 时放进并排的第 slot 栏（不超过当前并排数），不给时单独查看。只在本机界面中可用，手机等远程对话中不可用。' +
    `一轮最多启动 ${TERMINALS_PER_TURN} 个。只在用户明确要求打开终端、Claude Code 或 Codex 时调用。`,
  parameters: Type.Object(
    {
      projectId: Type.String({ minLength: 1, maxLength: 128, description: '项目 id（项目的工作区与项目同 id）；先用 list_projects 查到。' }),
      preset: Type.Union([Type.Literal('blank'), Type.Literal('claude'), Type.Literal('codex')], { description: '终端预设：blank、claude 或 codex。' }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: '终端名称；不给时用预设名。' })),
      slot: Type.Optional(Type.Integer({ minimum: 1, maximum: WORKSPACE_MAX_PARALLEL, description: '放进并排的第几栏（从 1 起）；不给时单独查看。' })),
    },
    { additionalProperties: false },
  ),
  async execute(params, context) {
    const terminals = context.services.terminals;
    if (!terminals) throw new InternalToolError('没有启动终端：这个 Multivac 实例不支持项目终端。');
    // 远程对话不携带当前视图；终端只开放给本机界面。
    if (!context.originView || !context.originWindowId) {
      throw new InternalToolError('没有启动终端：终端只能从本机的 Multivac 界面中启动，远程对话（如手机）中不可用。请照实告诉用户。');
    }
    if (context.originView.narrow) throw new InternalToolError('没有启动终端：发起窗口处于窄屏，工作区不可用。请照实告诉用户在更宽的窗口中操作。');
    const workspace = workspaceById(context.services, params.projectId);
    const project = workspace?.project;
    if (!workspace || !project) throw new InternalToolError(`没有启动终端：没有 id 为 ${params.projectId} 的项目。可以先用 list_projects 查看项目 id。`);
    const { parallelCount } = context.services.sessions.presentedScene(workspace.workspaceId).scene;
    if (params.slot !== undefined && params.slot > parallelCount) {
      throw new InternalToolError(`没有启动终端：项目「${project.name}」的工作区现在并排 ${parallelCount} 栏，没有第 ${params.slot} 栏。` +
        `可以放进第 1–${parallelCount} 栏；用户要求更多栏时，先用 set_parallel_count 调整并排数。`);
    }
    const turn = context.turnCommandId ?? context.commandId;
    const launched = launchedPerTurn.get(turn) ?? 0;
    if (launched >= TERMINALS_PER_TURN) throw new InternalToolError(`没有启动终端：这一轮已启动 ${launched} 个终端，达到上限。请向用户确认是否继续。`);
    launchedPerTurn.set(turn, launched + 1);
    if (launchedPerTurn.size > 100) launchedPerTurn.delete(launchedPerTurn.keys().next().value!);

    const preset: TerminalPreset = params.preset === 'blank' ? { kind: 'blank' } : { kind: params.preset, argv: [] };
    let terminal;
    try {
      terminal = await terminals.open({ projectId: project.projectId, preset, ...(params.title ? { title: params.title } : {}), size: { cols: 80, rows: 24 } });
    } catch (error) {
      throw new InternalToolError(`没有启动终端：${error instanceof Error ? error.message : '终端启动失败。'}`);
    }
    const delivery = navigateOrigin(context, {
      kind: 'terminal', workspaceId: workspace.workspaceId, terminalId: terminal.terminalId, slot: params.slot ?? null,
    });
    const label = PRESET_LABELS[params.preset];
    const place = params.slot !== undefined ? `放进第 ${params.slot} 栏` : '单独查看';
    const headline = `已在「${project.name}」启动${label}「${terminal.title}」`;
    return {
      content: [
        `已在项目 ${projectLink(project)} 的主目录启动${label}终端「${terminal.title}」（终端 id: ${terminal.terminalId}）。`,
        delivery === 'shown' ? `已在发起窗口中打开，${place}。` : '发起窗口没有切换（窗口已关闭、刷新或处于窄屏），终端已在项目侧栏中，请照实告诉用户。',
        '终端由用户自己操作：你看不到终端画面，也不能向终端输入。',
      ].join('\n'),
      result: {
        summary: summaryOf(headline),
        refs: [projectRef(project), workspaceRef(workspace)],
        receipt: {
          headline: clip(headline, 119),
          detail: detailOf([delivery === 'shown' ? place : '窗口未切换', '外部程序，不受管控']),
          actions: [{ kind: 'open-workspace', workspaceId: workspace.workspaceId }],
        },
      },
    };
  },
});
