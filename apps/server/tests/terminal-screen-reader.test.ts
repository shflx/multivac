import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalScreen } from '../src/modules/terminals/terminal-screen.js';
import { TerminalScreenPages, TERMINAL_SCREEN_CACHE_LIMITS } from '../src/application/terminal-screen-pages.js';
import { TRANSCRIPT_PAGE_MAX_LENGTH, TRANSCRIPT_RETURN_MAX_LENGTH } from '../src/application/session-transcript-pages.js';

const flow = { pause() {}, resume() {} };
test('真实 headless：ANSI 不进入纯文本，合并软换行，保留硬换行及宽字、emoji、组合字', async () => {
  const screen = new TerminalScreen({ cols: 10, rows: 4 }, flow);
  try {
    screen.output(Buffer.from('123456789\x1b[31m中文😀e\u0301\x1b[0m\r\n硬换行'));
    const snapshot = await screen.textSnapshot();
    assert.equal(snapshot.text, '123456789中文😀e\u0301\n硬换行\n');
    assert.doesNotMatch(snapshot.text, /\x1b/u);
    screen.output(Buffer.from('\x1b[?1049hALT'));
    const alt = await screen.textSnapshot();
    assert.equal(alt.buffer, 'alternate'); assert.match(alt.text, /ALT/u); assert.doesNotMatch(alt.text, /中文/u);
    screen.output(Buffer.from('\x1b[?1049l'));
    assert.equal((await screen.textSnapshot()).text, snapshot.text);
  } finally { screen.dispose(); }
});

test('纯文本等待 UTF-8、CSI、OSC、DCS 完整边界且不生成 ANSI 快照；读取不改变流控和尺寸', async () => {
  let pauses = 0, resumes = 0, events = 0, inputs = 0;
  const screen = new TerminalScreen({ cols: 10, rows: 4 }, { pause() { pauses++; }, resume() { resumes++; } });
  (screen as unknown as { serializer: { serialize(): string } }).serializer.serialize = () => { throw new Error('纯文本不应序列化 ANSI'); };
  screen.onResize = () => events++; screen.terminal.onData(() => inputs++);
  try {
    for (const [prefix, suffix] of [
      [Buffer.from('中').subarray(0, 2), Buffer.from('中').subarray(2)],
      [Buffer.from('\x1b['), Buffer.from('31m红')],
      [Buffer.from('\x1b]2;title'), Buffer.from('\x07后')],
      [Buffer.from('\x1bP$q'), Buffer.from('m\x1b\\完')],
    ]) {
      screen.output(prefix); await screen.drain();
      let settled = false;
      const pending = screen.textSnapshot().then(value => { settled = true; return value; });
      await screen.drain(); assert.equal(settled, false);
      screen.output(suffix); const snapshot = await pending;
      assert.doesNotMatch(snapshot.text, /title|\x1b/u);
    }
    const before = { pauses, resumes, events, inputs };
    const a = await screen.textSnapshot(), b = await screen.textSnapshot();
    assert.deepEqual(a, b); assert.deepEqual(a.size, { cols: 10, rows: 4 });
    assert.deepEqual({ pauses, resumes, events, inputs }, before);
    screen.output(Buffer.from('\x1b]unfinished'));
    await assert.rejects(screen.textSnapshot(), /SNAPSHOT_TIMEOUT/u);
    screen.output(Buffer.from('\x07结束')); await screen.textSnapshot();
    screen.output(Buffer.from('\x1b[')); const waiting = screen.textSnapshot();
    screen.dispose(); await assert.rejects(waiting, /已释放/u);
    await assert.rejects(screen.textSnapshot(), /已释放/u);
  } finally { screen.dispose(); }
});

test('真实 headless：长软行逆向分页可还原，持续输出和 resize 后仍续读同一快照，签名不可篡改或换实例', async () => {
  const screen = new TerminalScreen({ cols: 80, rows: 4 }, flow);
  const pages = new TerminalScreenPages();
  try {
    screen.output(Buffer.from('头部\r\n' + '中文😀"\\'.repeat(5_000) + '\r\n尾部'));
    const frozen = await screen.textSnapshot();
    const first = await pages.read('terminal', 'instance', undefined, () => screen.textSnapshot());
    assert.ok(first.next); assert.equal(first.range.end, frozen.text.length); assert.equal(first.done, false);
    screen.output(Buffer.from('\r\n新输出'.repeat(1_200))); await screen.resize({ cols: 40, rows: 8 });
    assert.equal((await screen.textSnapshot()).historyTrimmed, true);
    let page = first, text = first.text, count = 0;
    while (page.next) {
      const previous = page;
      page = await pages.read('terminal', 'instance', page.next.cursor, async () => { throw new Error('续页不读新画面'); });
      assert.equal(page.range.end, previous.range.start); assert.equal(page.snapshotId, first.snapshotId);
      assert.equal(page.watermark, frozen.watermark); assert.deepEqual(page.size, frozen.size);
      assert.ok(JSON.stringify(page).length <= TRANSCRIPT_PAGE_MAX_LENGTH);
      assert.ok(JSON.stringify(JSON.stringify(page)).length <= TRANSCRIPT_RETURN_MAX_LENGTH - 5_000);
      assert.doesNotMatch(page.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      text = page.text + text; assert.ok(++count < 100);
    }
    assert.equal(text, frozen.text); assert.equal(page.historyDone, true); assert.equal(page.range.start, 0);
    const cursor = first.next!.cursor;
    for (const modified of [cursor + 'x', cursor + '=', cursor.replace(/.$/u, '!')]) {
      await assert.rejects(pages.read('terminal', 'instance', modified, () => screen.textSnapshot()), /游标已失效/u);
    }
    await assert.rejects(pages.read('other', 'instance', cursor, () => screen.textSnapshot()), /游标已失效/u);
    await assert.rejects(pages.read('terminal', 'new-instance', cursor, () => screen.textSnapshot()), /游标已失效/u);
    await assert.rejects(new TerminalScreenPages().read('terminal', 'instance', cursor, () => screen.textSnapshot()), /游标已失效/u);
    const fresh = await pages.read('terminal', 'instance', undefined, () => screen.textSnapshot());
    assert.notEqual(fresh.snapshotId, first.snapshotId); assert.equal(fresh.historyTrimmed, true);
    assert.ok(fresh.watermark > first.watermark);
    const current = await screen.textSnapshot(); assert.doesNotMatch(current.text, /头部/u); assert.match(current.text, /新输出/u);
  } finally { pages.clear(); screen.dispose(); }
});

test('真实 headless：达到容量不误报裁剪，真正滚动移除后提示；备用屏不声称含正常屏历史', async () => {
  const screen = new TerminalScreen({ cols: 10, rows: 4 }, flow);
  try {
    screen.output(Buffer.from('行\r\n'.repeat(1003)));
    assert.equal((await screen.textSnapshot()).historyTrimmed, false);
    assert.equal(screen.terminal.buffer.normal.length, 1004);
    screen.output(Buffer.from('新行\r\n'));
    assert.equal((await screen.textSnapshot()).historyTrimmed, true);
    screen.output(Buffer.from('\x1b[?1049hALT'));
    assert.equal((await screen.textSnapshot()).historyTrimmed, false);
    screen.output(Buffer.from('\x1b[?1049l'));
    assert.equal((await screen.textSnapshot()).historyTrimmed, true);
  } finally { screen.dispose(); }
});

test('纯文本快照和 resize、输出按队列排序，分页不会推进窗口顺序号', async () => {
  const screen = new TerminalScreen({ cols: 10, rows: 4 }, flow);
  try {
    screen.output(Buffer.from('前'));
    const before = screen.textSnapshot();
    const resize = screen.resize({ cols: 20, rows: 4 });
    screen.output(Buffer.from('后'));
    const after = screen.textSnapshot();
    const [a, , b] = await Promise.all([before, resize, after]);
    assert.equal(a.watermark, Buffer.byteLength('前')); assert.deepEqual(a.size, { cols: 10, rows: 4 });
    assert.doesNotMatch(a.text, /后/u);
    assert.equal(b.watermark, Buffer.byteLength('前后')); assert.deepEqual(b.size, { cols: 20, rows: 4 });
    assert.match(b.text, /前后/u); assert.equal(b.sequence, a.sequence + 2);
    assert.equal((await screen.textSnapshot()).sequence, b.sequence);
  } finally { screen.dispose(); }
});

test('快照缓存按固定 TTL、数量和总长度淘汰，拒绝超大快照，失效后不拼接', async t => {
  const pages = new TerminalScreenPages();
  const capture = async (length = 20_000) => ({ text: 'x'.repeat(length), watermark: 1, sequence: 1, size: { cols: 80, rows: 24 }, historyTrimmed: false, buffer: 'normal' as const });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  try {
    const first = await pages.read('t', 'i', undefined, () => capture());
    t.mock.timers.tick(TERMINAL_SCREEN_CACHE_LIMITS.ttlMillis - 1);
    await pages.read('t', 'i', first.next!.cursor, () => capture());
    t.mock.timers.tick(1);
    await assert.rejects(pages.read('t', 'i', first.next!.cursor, () => capture()), /游标已失效/u);
    const second = await pages.read('t', 'i', undefined, () => capture());
    for (let n = 0; n < TERMINAL_SCREEN_CACHE_LIMITS.snapshots; n++) await pages.read('t', 'i', undefined, () => capture());
    await assert.rejects(pages.read('t', 'i', second.next!.cursor, () => capture()), /游标已失效/u);
    pages.clear();
    const large = await pages.read('t', 'i', undefined, () => capture(2_000_000));
    await pages.read('t', 'i', undefined, () => capture(2_000_000));
    await pages.read('t', 'i', undefined, () => capture());
    await assert.rejects(pages.read('t', 'i', large.next!.cursor, () => capture()), /游标已失效/u);
    await assert.rejects(pages.read('t', 'i', undefined, () => capture(2_000_001)), /超过快照长度上限/u);
    const last = await pages.read('t', 'i', undefined, () => capture()); pages.invalidate('i');
    await assert.rejects(pages.read('t', 'i', last.next!.cursor, () => capture()), /游标已失效/u);
    assert.equal((await pages.read('t', 'i', undefined, () => capture(0))).done, true);
  } finally { pages.clear(); }
});
