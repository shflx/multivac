import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeApiRoot, openPanel, resetE2eState } from './test-state.js';

test('常见语言文件高亮、多行作用域、原文查找与纯文本回退', async ({ page, request }, testInfo) => {
  await resetE2eState(request);
  const sessionId = crypto.randomUUID();
  const created = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId, title: '常见语言预览' } });
  const root = (await created.json()).workingDirectory.path as string;
  const files = {
    'main.js': '/* 跨行注释\n  第二行仍是注释\n*/\nexport const text = "原文目标";\n',
    'main.py': 'def main():\n    return "原文目标"\n', 'main.go': 'package main\nfunc main() {}', 'main.rs': 'fn main() {}',
    'Main.java': 'public class Main {}', 'main.cpp': 'int main() { return 0; }', 'Main.cs': 'public class Main {}',
    'query.sql': 'SELECT id FROM users;', 'run.sh': 'echo "hello"', 'style.css': 'body { color: red; }',
    'config.json': '{"value": 1}', 'config.yaml': 'value: true', 'Dockerfile': 'FROM node:22\nRUN npm install',
    'notes.txt': '普通文本 <script>不会执行</script>', 'source.xml': '<script>parent.syntaxExecuted = true</script>',
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  await page.goto('/'); await openPanel(page, 'workspace');
  await page.getByRole('button', { name: '查看文件', exact: true }).click();
  const browser = page.getByRole('region', { name: '工作目录文件浏览' });
  for (const [path, text] of Object.entries(files)) {
    await browser.getByRole('button', { name: path, exact: true }).click();
    const article = browser.getByRole('article');
    await expect(article.locator('.content-line')).toHaveCount(text.split('\n').length);
    expect(await article.locator('.content-line code').allTextContents()).toEqual(text.split('\n').map((line) => line || (path === 'notes.txt' ? ' ' : '')));
    if (path !== 'notes.txt') expect(await article.locator('span[class*="hljs-"]').count()).toBeGreaterThan(0);
    else await expect(article.locator('span[class*="hljs-"]')).toHaveCount(0);
    if (path === 'main.js') {
      await expect(article.locator('[data-line="2"] .hljs-comment')).toHaveText('  第二行仍是注释');
      await browser.getByRole('button', { name: '查找原文', exact: true }).click();
      await browser.getByLabel('原文内查找').fill('原文目标');
      await expect(browser.locator('.content-find-bar')).toContainText('1/1');
      await browser.getByLabel('原文内查找').press('Escape');
    }
    if (['main.js', 'main.py', 'Dockerfile'].includes(path)) await page.screenshot({ path: testInfo.outputPath(`${path}.png`) });
  }
  expect(await page.evaluate(() => (window as unknown as { syntaxExecuted?: boolean }).syntaxExecuted)).toBeUndefined();
  await expect(browser.getByRole('article').locator('script')).toHaveCount(0);
});
