import test from 'node:test';
import assert from 'node:assert/strict';
// 两个无依赖位置算法也能在受控 Node 环境中单独验证。
import { verifyPdfPure } from '../../../scripts/verify-pdf-pure.mjs';

test('PDF 历史文字映射、Unicode、字节范围与锁文件一致性', async () => {
  const report = await verifyPdfPure();
  assert.equal(report.passed, true, JSON.stringify(report.results.filter((result: { passed: boolean }) => !result.passed)));
});
