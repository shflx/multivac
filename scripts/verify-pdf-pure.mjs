import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 直接导入实际 TypeScript 实现，Node 的类型擦除不创建编译子进程。
export async function verifyPdfPure() {
  const { mapPdfText, pdfTextPosition, pdfRawRanges } = await import('../apps/web/src/features/reading/reading-pdf-map.ts');
  const { pdfByteRange } = await import('../apps/server/src/modules/reading/pdf-byte-range.ts');
  const results = [];
  function check(name, run) {
    try { run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  }
  const paragraphs = [{ id: 'c1:p1', text: 'Alpha\nBeta😀' }, { id: 'c1:p2', text: 'Gamma' }];
  const raw = '  Alpha\nBeta😀  \n\n Gamma  ';
  const position = (paragraphId, offset) => ({ chapterId: 'c1', paragraphId, offset });
  check('历史规范化：保留单换行、trim、跨段、UTF-16', () => {
    const map = mapPdfText(raw, 'c1', paragraphs); assert.ok(map);
    assert.deepEqual(pdfTextPosition(map, 2, false), position('c1:p1', 0));
    assert.deepEqual(pdfTextPosition(map, 7, true), position('c1:p1', 5));
    assert.deepEqual(pdfTextPosition(map, raw.indexOf('Gamma'), false), position('c1:p2', 0));
  });
  check('代理对中间端点拒绝', () => {
    const map = mapPdfText(raw, 'c1', paragraphs);
    assert.equal(pdfTextPosition(map, raw.indexOf('😀') + 1, false), null);
    assert.equal(pdfTextPosition(map, raw.indexOf('😀') + 1, true), null);
  });
  check('长段切分不拆代理对，兼容跨块段落身份', () => {
    const text = 'x'.repeat(16383) + '😀tail';
    const ps = [{ id: 'p1', text: text.slice(0, 16383) }, { id: 'p2', text: text.slice(16383) }];
    const map = mapPdfText(text, 'c1', ps); assert.ok(map);
    assert.deepEqual(pdfTextPosition(map, 16383, false), position('p2', 0));
    assert.deepEqual(pdfTextPosition(map, 16385, false), position('p2', 2));
  });
  check('控制字符清理后仍映射到原始文字层位置', () => {
    const map = mapPdfText('a\u0000b', 'c1', [{ id: 'p1', text: 'ab' }]); assert.ok(map);
    assert.deepEqual(pdfRawRanges(map, position('p1', 0), position('p1', 2)), [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
  });
  check('控制字符不改变历史切段顺序', () => {
    assert.ok(mapPdfText('a\n\u0000\nb', 'c1', [{ id: 'p1', text: 'a\n\nb' }]));
    assert.equal(mapPdfText('a\n\u0000\nb', 'c1', [{ id: 'p1', text: 'a' }, { id: 'p2', text: 'b' }]), null);
  });
  check('任何正文差异均拒绝映射，不猜测迁移', () => {
    assert.equal(mapPdfText(raw, 'c1', [{ id: 'p1', text: 'Wrong text' }]), null);
    assert.equal(mapPdfText(raw, 'c1', [...paragraphs, { id: 'extra', text: 'extra' }]), null);
  });
  check('跨段引用反向映射不包括 trim 和空行', () => {
    const map = mapPdfText(raw, 'c1', paragraphs); assert.ok(map);
    const ranges = pdfRawRanges(map, position('c1:p1', 6), position('c1:p2', 3));
    assert.equal(ranges.map(r => raw.slice(r.start, r.end)).join('|'), 'Beta😀|Gam');
  });
  check('空文字不为内部扫描占位符伪造文字层', () => { assert.equal(mapPdfText('', 'c1', [{ id: 'p1', text: '\uFFFC' }]), null); });
  check('固定字节范围及末端裁剪', () => { assert.deepEqual(pdfByteRange('bytes=20-200', 100), { start: 20, end: 99 }); });
  check('开放末端及后缀范围', () => {
    assert.deepEqual(pdfByteRange('bytes=20-', 100), { start: 20, end: 99 });
    assert.deepEqual(pdfByteRange('bytes=-15', 100), { start: 85, end: 99 });
    assert.deepEqual(pdfByteRange('bytes=-200', 100), { start: 0, end: 99 });
    assert.equal(pdfByteRange(undefined, 100), null);
  });
  check('错误、多范围、溢出及越界均拒绝', () => {
    for (const value of ['bytes=100-', 'bytes=-0', 'bytes=30-20', 'bytes=-', 'bytes=0-2,5-8', 'bytes=9007199254740992-', 'bytes=0-9007199254740992', 'other=0-1']) assert.throws(() => pdfByteRange(value, 100), RangeError);
  });
  const pkg = JSON.parse(await readFile(new URL('../apps/web/package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  check('PDF.js Web 依赖和锁文件保持相同版本', () => {
    assert.equal(pkg.dependencies['pdfjs-dist'], lock.packages['apps/web'].dependencies['pdfjs-dist']);
    assert.equal(pkg.dependencies['pdfjs-dist'], lock.packages['node_modules/pdfjs-dist'].version);
  });
  return { node: process.version, passed: results.every(r => r.passed), results };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await verifyPdfPure();
  await writeFile(new URL('../pdf-pure-verification.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
