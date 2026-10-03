import { access, lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSyntheticSourceInfo,
  type Extension,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import type { InternalToolEffect } from '../../modules/internal-tools/internal-tool.js';
import { isPathWithin } from '../../modules/sessions/working-directory.js';
import type {
  CoordinatorPathToolName,
  CoordinatorToolAuthorizationDecision,
} from './coordinator-adapter.js';
import type { CoordinatorToolName } from './pi-session-factory.js';

/**
 * 每个开放工具的目录边界规则：
 * - target-path：按目标路径判定，工作目录内直接执行，目录外转为授权请求；
 * - working-directory：以会话工作目录为 cwd 执行，不做命令分级（bash 越出目录的影响是已知风险）。
 * Record 覆盖 COORDINATOR_TOOL_ALLOWLIST 的全部工具：新开放的工具必须先在这里声明规则，
 * 运行时遇到未声明的工具一律拦截。
 */
const TOOL_BOUNDARY_RULES: Record<CoordinatorToolName, 'target-path' | 'working-directory'> = {
  read: 'target-path',
  edit: 'target-path',
  write: 'target-path',
  bash: 'working-directory',
};

/**
 * 全局 Multivac 内部工具的规则：不走路径判定（只调用限定的业务接口，不接受任意文件读写），按效果类别处理：
 * - query、manage：直接放行执行；
 * - propose：放行，但它的执行函数只能生成待用户确认的提议，放行本身不带来任何权限扩大。
 * 只有本会话实际注入的内部工具才有规则；工作会话没有内部工具，调用同名工具一律拦截。
 */
const INTERNAL_TOOL_BOUNDARY_RULES: Record<InternalToolEffect, 'allow'> = {
  query: 'allow',
  manage: 'allow',
  propose: 'allow',
};

/** 本会话注入的内部工具及其效果类别（工具名 → 类别）。 */
export type InternalToolBoundary = Readonly<Record<string, InternalToolEffect>>;

/** 目录外访问请求中由边界判定得出的部分；会话 id 与工作目录记录由适配器补齐。 */
export interface OutsideWorkingDirectoryAccess {
  toolName: CoordinatorPathToolName;
  toolCallId: string;
  /** Agent 在工具参数中给出的原始路径。 */
  requestedPath: string;
  /** 解析后的真实绝对路径：已展开 `~`、消去 `..`、跟随符号链接。 */
  targetPath: string;
}

export type OutsideWorkingDirectoryAuthorizer = (
  access: OutsideWorkingDirectoryAccess,
  signal: AbortSignal,
) => Promise<CoordinatorToolAuthorizationDecision>;

export type ToolBoundaryVerdict =
  /** 路径类工具附带目标的真实路径，放行时据此钉住参数；bash 与内部工具没有目标路径。 */
  | { type: 'allow'; targetPath?: string }
  | ({ type: 'outside' } & Omit<OutsideWorkingDirectoryAccess, 'toolCallId'>)
  | { type: 'block'; reason: string };

const UNICODE_SPACES = /[  -   　]/gu;
const MAX_SYMBOLIC_LINKS = 40;
const TOOL_BOUNDARY_EXTENSION_PATH = '<inline:multivac-tool-boundary>';
const CANCELLED_REASON = '本轮已取消，操作未执行。';

/**
 * 与 Pi 文件工具（resolveToCwd）一致地把参数中的路径解析为绝对路径：统一 Unicode 空格、
 * 去掉开头的 `@`、展开 `~` 与 `file://`，相对路径相对会话工作目录，并按字面消去 `..`。
 * 判定的路径必须与工具实际访问的路径同源，否则边界可以被写法差异绕开。
 */
export function resolveToolInputPath(input: string, cwd: string): string {
  let path = input.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);

  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  else if (/^file:\/\//u.test(path)) path = fileURLToPath(path);

  return resolve(cwd, path);
}

/**
 * read 在路径不存在时会依次尝试 macOS 截图文件名的几种写法（AM/PM 前的窄空格、NFD、弯引号），
 * 读取第一个存在的变体。判定按同样的顺序选出实际会被读取的路径。
 */
async function resolveReadVariant(path: string): Promise<string> {
  const nfd = path.normalize('NFD');
  const variants = [
    path,
    path.replace(/ (AM|PM)\./giu, ' $1.'),
    nfd,
    path.replace(/'/gu, '’'),
    nfd.replace(/'/gu, '’'),
  ];
  for (const variant of variants) {
    try {
      await access(variant);
      return variant;
    } catch {
      // 不存在，继续尝试下一种写法。
    }
  }
  return path;
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 解析路径的真实位置：沿途跟随符号链接，包括指向尚不存在位置的悬空链接。
 * 目标尚不存在时，以最近的已存在祖先的真实路径为准，再接上尚不存在的部分。
 * 已存在部分取系统 realpath，大小写不敏感的文件系统上也得到与工作目录一致的写法。
 */
export async function resolveRealTargetPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  const { root } = parse(path);
  const pending = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name === '.') continue;
    if (name === '..') {
      current = dirname(current);
      continue;
    }

    const next = join(current, name);
    let stats;
    try {
      stats = await lstat(next);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return join(await realpath(current), name, ...pending);
    }

    if (stats.isSymbolicLink()) {
      links += 1;
      if (links > MAX_SYMBOLIC_LINKS) throw new Error('符号链接层级过多。');
      const target = await readlink(next);
      pending.unshift(...target.split(sep).filter(Boolean));
      if (isAbsolute(target)) current = parse(target).root;
      continue;
    }
    current = next;
  }
  return realpath(current);
}

/**
 * 路径类工具实际会访问的真实路径：先按 Pi 的写法得到绝对路径（read 另选文件名变体），再跟随符号链接。
 * 无法解析时抛错。
 */
async function resolveToolTargetPath(toolName: string, requestedPath: string, cwd: string): Promise<string> {
  const absolutePath = resolveToolInputPath(requestedPath, cwd);
  const accessedPath = toolName === 'read' ? await resolveReadVariant(absolutePath) : absolutePath;
  return resolveRealTargetPath(accessedPath);
}

/**
 * 判定一次工具调用是否在会话工作目录的边界内。工作目录本身也取真实路径，
 * 两边在同一基准上比较；无法确认时（工作目录不可用、路径无法解析）直接拦截。
 */
export async function judgeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  internalTools: InternalToolBoundary = {},
): Promise<ToolBoundaryVerdict> {
  const rule = Object.hasOwn(TOOL_BOUNDARY_RULES, toolName)
    ? TOOL_BOUNDARY_RULES[toolName as CoordinatorToolName]
    : undefined;
  if (!rule) {
    const effect = Object.hasOwn(internalTools, toolName) ? internalTools[toolName] : undefined;
    if (effect && INTERNAL_TOOL_BOUNDARY_RULES[effect] === 'allow') return { type: 'allow' };
    return { type: 'block', reason: `工具 ${toolName} 没有目录边界规则，调用未执行。` };
  }
  if (rule === 'working-directory') return { type: 'allow' };

  const requestedPath = input.path;
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    return { type: 'block', reason: `${toolName} 缺少目标路径，调用未执行。` };
  }

  let workingDirectory: string;
  try {
    workingDirectory = await realpath(cwd);
  } catch {
    return { type: 'block', reason: `会话工作目录 ${cwd} 当前不可用，${toolName} 未执行。` };
  }

  let targetPath: string;
  try {
    targetPath = await resolveToolTargetPath(toolName, requestedPath, cwd);
  } catch {
    return {
      type: 'block',
      reason: `无法确认 ${requestedPath} 是否位于会话工作目录内，${toolName} 未执行。`,
    };
  }

  return isPathWithin(workingDirectory, targetPath)
    ? { type: 'allow', targetPath }
    : { type: 'outside', toolName: toolName as CoordinatorPathToolName, requestedPath, targetPath };
}

/**
 * 放行时把工具参数中的路径改写为已核对的真实绝对路径（钉住目标）。Pi 允许在 tool_call 钩子中原地修改
 * `event.input`，执行时直接使用改写后的参数，不再重新解析原始写法中的符号链接，从而缩小“核对之后、
 * 执行之前”目标被改指的窗口。运行轨迹与 transcript 使用模型给出的原始参数（Pi 在钩子前已复制一份），
 * 展示不受影响。
 * 只在 Pi 按字面处理这个路径后仍得到它本身时改写：真实路径中含有 Pi 会改写的字符（如 Unicode 空格）时，
 * 改写反而会让 Pi 访问别的位置，这时保持原参数。
 */
function pinTargetPath(input: Record<string, unknown>, targetPath: string, cwd: string): void {
  if (resolveToolInputPath(targetPath, cwd) === targetPath) input.path = targetPath;
}

/**
 * 没有接入授权通道时的决定：目录外的访问一律不执行，并告诉 Agent 原因。
 */
export function denyOutsideWorkingDirectory(cwd: string): OutsideWorkingDirectoryAuthorizer {
  return async (access) => ({
    allowed: false,
    reason: `目标路径 ${access.targetPath} 位于会话工作目录 ${cwd} 之外，访问需要用户授权。` +
      `本次 ${access.toolName} 未获授权，没有执行。如确需访问，请向用户说明路径与用途。`,
  });
}

export interface ToolBoundaryExtensionOptions {
  /** 会话工作目录（绝对路径），取自 Multivac 会话记录。 */
  cwd: string;
  /** 目录外访问的授权决定；缺省时一律拒绝。 */
  authorizeOutsideAccess?: OutsideWorkingDirectoryAuthorizer;
  /** 本会话注入的内部工具（只有全局 Multivac 有）；缺省时没有内部工具，调用一律拦截。 */
  internalTools?: InternalToolBoundary;
}

/**
 * 服务端内置的目录边界扩展：只挂 tool_call 钩子，在工具执行前判定并决定是否放行。
 * 以内存中的 Extension 对象直接提供给受控 ResourceLoader，不经过 Pi 的扩展发现与加载。
 */
export function createToolBoundaryExtension(options: ToolBoundaryExtensionOptions): Extension {
  const authorize = options.authorizeOutsideAccess ?? denyOutsideWorkingDirectory(options.cwd);

  const onToolCall = async (
    event: ToolCallEvent,
    context: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> => {
    const verdict = await judgeToolCall(event.toolName, event.input, options.cwd, options.internalTools);
    if (verdict.type === 'allow') {
      // 工作目录内的访问同样钉住：判定之后工具不一定立即执行（同批调用要等全部放行才一起执行，
      // 其间可能等待其他调用的授权），目录内的链接在此期间被改指到目录外时，仍访问判定时的位置。
      if (verdict.targetPath) pinTargetPath(event.input, verdict.targetPath, options.cwd);
      return undefined;
    }
    if (verdict.type === 'block') return { block: true, reason: verdict.reason };

    // 等待授权期间 Turn 保持运行；取消本轮时 Pi 中止这个 signal，授权方应随之结束等待。
    const signal = context.signal ?? new AbortController().signal;
    if (signal.aborted) return { block: true, reason: CANCELLED_REASON };
    let decision: CoordinatorToolAuthorizationDecision;
    try {
      decision = await authorize({
        toolName: verdict.toolName,
        toolCallId: event.toolCallId,
        requestedPath: verdict.requestedPath,
        targetPath: verdict.targetPath,
      }, signal);
    } catch {
      decision = { allowed: false, reason: `授权请求没有完成，${verdict.toolName} 未执行。` };
    }
    if (signal.aborted) return { block: true, reason: CANCELLED_REASON };
    if (!decision.allowed) return { block: true, reason: decision.reason };

    // 批准（包括仅这一次与按记住的授权自动放行）之后重新核对：等待期间路径中的符号链接可能已被改指，
    // Pi 执行时按原始参数重新解析，会访问到用户没有批准的位置。目标与授权时不一致就不执行。
    const currentTarget = await resolveToolTargetPath(verdict.toolName, verdict.requestedPath, options.cwd)
      .catch(() => null);
    if (signal.aborted) return { block: true, reason: CANCELLED_REASON };
    if (currentTarget !== verdict.targetPath) {
      return {
        block: true,
        reason: `${verdict.requestedPath} 的实际目标在等待授权期间发生了变化（授权的是 ${verdict.targetPath}` +
          `${currentTarget ? `，现在指向 ${currentTarget}` : '，现在无法确认'}），${verdict.toolName} 未执行。` +
          '如仍需访问，请重新发起这次调用，由用户按新的目标确认。',
      };
    }
    pinTargetPath(event.input, verdict.targetPath, options.cwd);
    return undefined;
  };

  return {
    path: TOOL_BOUNDARY_EXTENSION_PATH,
    resolvedPath: TOOL_BOUNDARY_EXTENSION_PATH,
    sourceInfo: createSyntheticSourceInfo(TOOL_BOUNDARY_EXTENSION_PATH, { source: 'inline' }),
    handlers: new Map([['tool_call', [onToolCall as (...args: unknown[]) => Promise<unknown>]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}
