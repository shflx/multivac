import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import {
  createToolBoundaryExtension,
  judgeToolCall,
  resolveToolInputPath,
  type OutsideWorkingDirectoryAccess,
} from '../src/runtime/executors/pi-tool-boundary.js';

/**
 * 目录边界判定的边界情况：路径写法、`..`、符号链接（含目标尚不存在与悬空链接）、
 * 工作目录本身经过符号链接、read 的文件名变体，以及钩子与授权决定之间的约定。
 */

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-tool-boundary-')));
  const cwd = join(root, 'work');
  const outside = join(root, 'outside');
  await mkdir(join(cwd, 'sub'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(cwd, 'inside.txt'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  return { root, cwd, outside, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const verdictOf = async (toolName: string, path: unknown, cwd: string) =>
  judgeToolCall(toolName, { path }, cwd);

test('路径写法与 Pi 文件工具一致：相对路径相对工作目录，展开 ~、@ 前缀、file:// 与 Unicode 空格', () => {
  const cwd = '/work/session';
  assert.equal(resolveToolInputPath('a.txt', cwd), '/work/session/a.txt');
  assert.equal(resolveToolInputPath('./sub/../a.txt', cwd), '/work/session/a.txt');
  assert.equal(resolveToolInputPath('../other/a.txt', cwd), '/work/other/a.txt');
  assert.equal(resolveToolInputPath('/etc/hosts', cwd), '/etc/hosts');
  assert.equal(resolveToolInputPath('/work/session/../../etc/hosts', cwd), '/etc/hosts');
  assert.equal(resolveToolInputPath('~', cwd), homedir());
  assert.equal(resolveToolInputPath('~/notes.md', cwd), join(homedir(), 'notes.md'));
  // `~user` 与中间的 `~` 不展开，按普通文件名处理。
  assert.equal(resolveToolInputPath('~other/a', cwd), '/work/session/~other/a');
  assert.equal(resolveToolInputPath('@/etc/hosts', cwd), '/etc/hosts');
  assert.equal(resolveToolInputPath('@a.txt', cwd), '/work/session/a.txt');
  assert.equal(resolveToolInputPath('file:///etc/hosts', cwd), '/etc/hosts');
  assert.equal(resolveToolInputPath('a b.txt', cwd), '/work/session/a b.txt');
});

test('工作目录内的路径直接放行：相对、绝对、尚不存在的文件与目录、工作目录本身', async () => {
  const { cwd, cleanup } = await fixture();
  try {
    for (const path of [
      'inside.txt', join(cwd, 'inside.txt'), 'new.txt', 'new/dir/file.txt', '.', cwd,
      'sub/../inside.txt', `${cwd}/`, 'inside.txt/child',
    ]) {
      for (const tool of ['read', 'edit', 'write']) {
        assert.deepEqual(await verdictOf(tool, path, cwd), { type: 'allow' }, `${tool} ${path}`);
      }
    }
  } finally {
    await cleanup();
  }
});

test('目录外的路径转为授权请求：绝对路径、.. 绕出、~、同前缀的兄弟目录', async () => {
  const { root, cwd, outside, cleanup } = await fixture();
  const previousHome = process.env.HOME;
  try {
    await mkdir(`${cwd}-other`);
    process.env.HOME = join(root, 'home');
    await mkdir(process.env.HOME);
    const cases: Array<[string, string]> = [
      [join(outside, 'secret.txt'), join(outside, 'secret.txt')],
      ['../outside/secret.txt', join(outside, 'secret.txt')],
      ['sub/../../outside/new.txt', join(outside, 'new.txt')],
      [`${cwd}/../outside/new/deep.txt`, join(outside, 'new', 'deep.txt')],
      ['..', root],
      [`${cwd}-other/a.txt`, join(`${cwd}-other`, 'a.txt')],
      ['~/notes.md', join(root, 'home', 'notes.md')],
      [pathToFileURL(join(outside, 'secret.txt')).href, join(outside, 'secret.txt')],
    ];
    for (const [requestedPath, targetPath] of cases) {
      for (const toolName of ['read', 'edit', 'write']) {
        assert.deepEqual(
          await verdictOf(toolName, requestedPath, cwd),
          { type: 'outside', toolName, requestedPath, targetPath },
          `${toolName} ${requestedPath}`,
        );
      }
    }
  } finally {
    process.env.HOME = previousHome;
    await cleanup();
  }
});

test('符号链接按真实位置判定：指向目录外的链接（含目标尚不存在、悬空、多级链接）转为授权请求', async () => {
  const { cwd, outside, cleanup } = await fixture();
  try {
    await symlink(outside, join(cwd, 'link-dir'));
    await symlink(join(outside, 'secret.txt'), join(cwd, 'link-file'));
    await symlink('../outside/created-by-link.txt', join(cwd, 'dangling'));
    await symlink('link-dir', join(cwd, 'chain'));
    await symlink(join(cwd, 'sub'), join(cwd, 'link-inside'));
    await symlink('missing/../../outside/x.txt', join(cwd, 'dangling-through-missing'));

    const expectOutside = async (requestedPath: string, targetPath: string) => {
      for (const toolName of ['read', 'edit', 'write']) {
        assert.deepEqual(
          await verdictOf(toolName, requestedPath, cwd),
          { type: 'outside', toolName, requestedPath, targetPath },
          `${toolName} ${requestedPath}`,
        );
      }
    };
    await expectOutside('link-dir/secret.txt', join(outside, 'secret.txt'));
    await expectOutside('link-dir/not-yet.txt', join(outside, 'not-yet.txt'));
    await expectOutside('link-dir/new/deep/file.txt', join(outside, 'new', 'deep', 'file.txt'));
    await expectOutside('link-file', join(outside, 'secret.txt'));
    // 悬空链接：write 会穿过链接在目录外创建文件。
    await expectOutside('dangling', join(outside, 'created-by-link.txt'));
    await expectOutside('chain/secret.txt', join(outside, 'secret.txt'));
    // 链接目标中有不存在的中间目录：真实访问会失败，判定仍不放行。
    await expectOutside('dangling-through-missing', join(outside, 'x.txt'));

    // 指向工作目录内的链接照常放行。
    assert.deepEqual(await verdictOf('write', 'link-inside/new.txt', cwd), { type: 'allow' });
    // Pi 先按字面消去 `..` 再访问：link-dir/../x 实际访问的是目录内的 x，不经过链接。
    assert.deepEqual(await verdictOf('read', 'link-dir/../inside.txt', cwd), { type: 'allow' });

    await symlink('loop-b', join(cwd, 'loop-a'));
    await symlink('loop-a', join(cwd, 'loop-b'));
    const loop = await verdictOf('write', 'loop-a', cwd);
    assert.equal(loop.type, 'block');
  } finally {
    await cleanup();
  }
});

test('工作目录本身经过符号链接时两边都取真实路径比较', async () => {
  const { root, cwd, outside, cleanup } = await fixture();
  try {
    const linkedCwd = join(root, 'work-link');
    await symlink(cwd, linkedCwd);
    assert.deepEqual(await verdictOf('write', 'new.txt', linkedCwd), { type: 'allow' });
    assert.deepEqual(await verdictOf('read', join(cwd, 'inside.txt'), linkedCwd), { type: 'allow' });
    assert.deepEqual(await verdictOf('read', join(linkedCwd, 'inside.txt'), cwd), { type: 'allow' });
    assert.deepEqual(await verdictOf('read', '../outside/secret.txt', linkedCwd), {
      type: 'outside', toolName: 'read', requestedPath: '../outside/secret.txt', targetPath: join(outside, 'secret.txt'),
    });
  } finally {
    await cleanup();
  }
});

test('read 按实际会读取的文件名变体判定', async () => {
  const { cwd, outside, cleanup } = await fixture();
  try {
    // 只有弯引号写法的链接存在：read "it's" 会读到它（指向目录外），write "it's" 则在目录内新建文件。
    await symlink(join(outside, 'secret.txt'), join(cwd, 'it’s'));
    assert.deepEqual(await verdictOf('read', "it's", cwd), {
      type: 'outside', toolName: 'read', requestedPath: "it's", targetPath: join(outside, 'secret.txt'),
    });
    assert.deepEqual(await verdictOf('write', "it's", cwd), { type: 'allow' });
  } finally {
    await cleanup();
  }
});

test('bash 在工作目录内一律放行；未声明规则的工具、缺少路径与工作目录不可用时直接拦截', async () => {
  const { root, cwd, cleanup } = await fixture();
  try {
    assert.deepEqual(await judgeToolCall('bash', { command: 'cat /etc/hosts && cd .. && ls' }, cwd), { type: 'allow' });
    for (const toolName of ['grep', 'find', 'ls', 'toString', '__proto__']) {
      const verdict = await judgeToolCall(toolName, { path: 'inside.txt' }, cwd);
      assert.equal(verdict.type, 'block', toolName);
    }
    for (const path of [undefined, '', '   ', 42]) {
      assert.equal((await verdictOf('read', path, cwd)).type, 'block');
    }
    const missingCwd = await verdictOf('read', 'inside.txt', join(root, 'missing'));
    assert.equal(missingCwd.type, 'block');
    assert.match(missingCwd.type === 'block' ? missingCwd.reason : '', /工作目录.*不可用/u);
  } finally {
    await cleanup();
  }
});

test('内部工具不走路径判定：只有本会话注入的内部工具按效果类别放行，其余（含工作会话中的同名工具）一律拦截', async () => {
  const { cwd, outside, cleanup } = await fixture();
  try {
    const internal = { list_workspaces: 'query', rename_session: 'manage', propose_project: 'propose' } as const;
    // 三类都放行，且与参数中的路径无关（内部工具不读写文件，不产生授权请求）。
    for (const toolName of Object.keys(internal)) {
      assert.deepEqual(await judgeToolCall(toolName, { path: join(outside, 'secret.txt') }, cwd, internal), { type: 'allow' });
    }
    // 工作会话没有内部工具：同名调用被拦截。
    const inWorkSession = await judgeToolCall('list_workspaces', {}, cwd);
    assert.equal(inWorkSession.type, 'block');
    assert.match(inWorkSession.type === 'block' ? inWorkSession.reason : '', /没有目录边界规则，调用未执行/u);
    // 声明了内部工具，未声明的工具仍一律拦截；内置工具仍按路径判定。
    for (const toolName of ['mount_directory', 'grep', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal((await judgeToolCall(toolName, {}, cwd, internal)).type, 'block', toolName);
    }
    assert.equal((await judgeToolCall('write', { path: join(outside, 'x.txt') }, cwd, internal)).type, 'outside');

    // 扩展按注入的内部工具放行，不调用授权决定。
    let authorizations = 0;
    const extension = createToolBoundaryExtension({
      cwd, internalTools: internal, authorizeOutsideAccess: async () => { authorizations += 1; return { allowed: true }; },
    });
    const [handler] = extension.handlers.get('tool_call')!;
    const signal = new AbortController().signal;
    assert.equal(await handler!(toolCall('list_workspaces', {}), context(signal)), undefined);
    assert.equal(await handler!(toolCall('propose_project', { path: '/' }), context(signal)), undefined);
    const blocked = await handler!(toolCall('mount_directory', { path: '/' }), context(signal)) as { block: boolean };
    assert.equal(blocked.block, true);
    assert.equal(authorizations, 0);
  } finally {
    await cleanup();
  }
});

function toolCall(toolName: string, input: Record<string, unknown>, toolCallId = 'call-1'): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as ToolCallEvent;
}

function context(signal: AbortSignal | undefined): ExtensionContext {
  return { signal } as ExtensionContext;
}

test('边界扩展只挂 tool_call：目录内不请求授权，目录外缺省拒绝并说明原因', async () => {
  const { cwd, outside, cleanup } = await fixture();
  try {
    const extension = createToolBoundaryExtension({ cwd });
    assert.deepEqual([...extension.handlers.keys()], ['tool_call']);
    const [handler] = extension.handlers.get('tool_call')!;
    const signal = new AbortController().signal;

    assert.equal(await handler!(toolCall('write', { path: 'a.txt', content: 'x' }), context(signal)), undefined);
    assert.equal(await handler!(toolCall('bash', { command: 'rm -rf ../outside' }), context(signal)), undefined);

    const denied = await handler!(toolCall('edit', { path: join(outside, 'secret.txt'), edits: [] }), context(signal)) as {
      block: boolean; reason: string;
    };
    assert.equal(denied.block, true);
    assert.match(denied.reason, new RegExp(`${join(outside, 'secret.txt')}.*位于会话工作目录 ${cwd} 之外`, 'u'));
    assert.match(denied.reason, /需要用户授权/u);
    assert.match(denied.reason, /edit 未获授权，没有执行/u);
  } finally {
    await cleanup();
  }
});

test('目录外访问交给授权决定：请求带工具调用信息与本轮 signal，批准放行、拒绝回传原因、异常与取消一律拦截', async () => {
  const { cwd, outside, cleanup } = await fixture();
  try {
    const requests: Array<{ access: OutsideWorkingDirectoryAccess; signal: AbortSignal }> = [];
    let decide: (access: OutsideWorkingDirectoryAccess, signal: AbortSignal) => Promise<
      { allowed: true } | { allowed: false; reason: string }
    > = async () => ({ allowed: true });
    const extension = createToolBoundaryExtension({
      cwd,
      authorizeOutsideAccess: (access, signal) => {
        requests.push({ access, signal });
        return decide(access, signal);
      },
    });
    const [handler] = extension.handlers.get('tool_call')!;
    const turn = new AbortController();

    // 目录内不产生授权请求。
    await handler!(toolCall('read', { path: 'inside.txt' }), context(turn.signal));
    assert.equal(requests.length, 0);

    assert.equal(await handler!(toolCall('read', { path: '../outside/secret.txt' }, 'call-approve'), context(turn.signal)), undefined);
    assert.deepEqual(requests[0]?.access, {
      toolName: 'read', toolCallId: 'call-approve', requestedPath: '../outside/secret.txt',
      targetPath: join(outside, 'secret.txt'),
    });
    assert.equal(requests[0]?.signal, turn.signal);

    decide = async () => ({ allowed: false, reason: '用户拒绝了这次访问。' });
    assert.deepEqual(
      await handler!(toolCall('write', { path: join(outside, 'x.txt'), content: '' }), context(turn.signal)),
      { block: true, reason: '用户拒绝了这次访问。' },
    );

    decide = async () => { throw new Error('存储不可用'); };
    const failed = await handler!(toolCall('write', { path: join(outside, 'x.txt'), content: '' }), context(turn.signal)) as {
      block: boolean; reason: string;
    };
    assert.equal(failed.block, true);
    assert.match(failed.reason, /授权请求没有完成/u);

    // 等待中取消本轮：即使授权方随后给出批准，也不执行。
    let waitingStarted!: () => void;
    const started = new Promise<void>((resolve) => { waitingStarted = resolve; });
    decide = (_access, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ allowed: true }), { once: true });
      waitingStarted();
    });
    const waiting = handler!(toolCall('edit', { path: join(outside, 'secret.txt'), edits: [] }), context(turn.signal));
    await started;
    turn.abort();
    const cancelled = await waiting as { block: boolean; reason: string };
    assert.equal(cancelled.block, true);
    assert.match(cancelled.reason, /已取消/u);

    // 本轮已取消后才到达的越界调用不再发出授权请求。
    const requestCount = requests.length;
    const afterAbort = await handler!(toolCall('read', { path: join(outside, 'secret.txt') }), context(turn.signal)) as {
      block: boolean; reason: string;
    };
    assert.equal(afterAbort.block, true);
    assert.equal(requests.length, requestCount);

    // Pi 不在流式运行时 signal 为空：授权方仍收到一个可监听的 signal。
    decide = async () => ({ allowed: true });
    await handler!(toolCall('read', { path: join(outside, 'secret.txt') }), context(undefined));
    assert.equal(requests.at(-1)?.signal instanceof AbortSignal, true);
  } finally {
    await cleanup();
  }
});
