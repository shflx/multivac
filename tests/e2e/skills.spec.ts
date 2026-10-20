import { test, expect } from '@playwright/test';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPanel } from './test-state.js';
test('真实 Skill 导入、预览取消、键盘确认、停用与窄容器', async ({ page }, info) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-e2e-'))),
    source = join(root, 'review-notes');
  mkdirSync(source);
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: review-notes\ndescription: 为已有资料整理审阅提纲\n---\n# 审阅\n先列出证据，再写结论。',
  );
  try {
    await page.goto('/');
    await openPanel(page, 'management');
    await page
      .getByRole('complementary', { name: '管理导航' })
      .getByRole('button', { name: '能力', exact: true })
      .click();
    await page.getByRole('navigation', { name: '能力类型' }).getByRole('button', { name: 'Skill', exact: true }).click();
    await expect(page.getByText('还没有 Skill。选择包含 SKILL.md 的目录，预览后确认导入。')).toBeVisible();
    await page.getByText('从 Claude Code / Codex 来源导入', { exact: true }).click();
    await page.getByLabel('来源目录', { exact: true }).fill(root);
    await page.getByRole('button', { name: '列出候选', exact: true }).click();
    await page.getByRole('button', { name: '选择并预览', exact: true }).click();
    await expect(page.getByLabel('本地包目录')).toHaveValue(source);
    await page.getByLabel('显示名称（可选）').fill('资料审阅');
    await page.getByRole('button', { name: '预览导入', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '确认导入 Skill' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('本地包目录')).toHaveValue(source);
    await page.getByRole('button', { name: '预览导入', exact: true }).click();
    await page.getByRole('button', { name: '确认登记', exact: true }).press('Enter');
    await expect(page.getByRole('heading', { name: '资料审阅', exact: true })).toBeVisible();
    await page.getByText('正文预览 · SKILL.md').click();
    await expect(page.locator('.skills-detail pre')).toContainText('先列出证据');
    await page.locator('.skills-page').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('skills-desktop.png') });
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '导出标准包' }).click();
    expect((await downloadEvent).suggestedFilename()).toBe('review-notes.zip');
    await page.getByRole('button', { name: '更多 Skill 操作', exact: true }).click();
    await page.getByRole('button', { name: '停用', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.locator('.skills-head .skill-tag')).toHaveText('已停用');
    await page.getByRole('button', { name: '更多 Skill 操作', exact: true }).click();
    await expect(page.getByRole('button', { name: '启用', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1080, height: 780 });
    await page.screenshot({ path: info.outputPath('skills-narrow.png') });
    expect(await page.locator('.skills-page').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('输入区键盘选择 Skill 只保存草稿，刷新后保留身份', async ({ page, request }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-picker-'))),
    source = join(root, 'compose-notes');
  mkdirSync(source);
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: compose-notes\ndescription: 整理笔记\n---\n先给出提纲。',
  );
  try {
    const api = `http://127.0.0.1:${process.env.MULTIVAC_E2E_API_PORT ?? '4317'}`;
    const p = await (
      await request.post(api + '/api/skills/preview', {
        data: { source, displayName: '笔记方法', projectId: null },
      })
    ).json();
    await request.post(api + '/api/skills/confirm', {
      data: { commandId: 'picker-import', previewId: p.previewId },
    });
    await page.goto('/');
    const draft = page.getByRole('textbox', { name: 'Multivac 草稿' });
    await draft.fill('/笔记');
    await expect(page.getByRole('listbox', { name: '选择 Skill' })).toBeVisible();
    await page.getByText('调整此会话的 Skill', { exact: true }).click();
    await page.getByRole('checkbox', { name: '笔记方法', exact: true }).click();
    await expect(page.getByRole('option', { name: /笔记方法/ })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('checkbox', { name: '笔记方法', exact: true }).click();
    await expect(page.getByRole('option', { name: /笔记方法/ })).toHaveAttribute('aria-disabled', 'false');
    await draft.press('Enter');
    await expect(page.getByText('Skill · 笔记方法', { exact: true })).toBeVisible();
    await expect(draft).toHaveValue('');
    await draft.fill('整理今日笔记');
    await expect
      .poll(async () => {
        const r = await request.get(api + '/api/assistant/page-state');
        return (await r.json()).draft;
      })
      .toContain('/Skill ');
    await page.reload();
    await expect(page.getByText('Skill · 笔记方法', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Multivac 草稿' })).toHaveValue('整理今日笔记');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('对话 Skill 草案确认卡预览后登记真实包', async ({ page, request }, info) => {
  const api = `http://127.0.0.1:${process.env.MULTIVAC_E2E_API_PORT ?? '4317'}`;
  const payload = {
    displayName: '复盘流程',
    projectId: null,
    files: {
      'SKILL.md':
        '---\nname: retrospective\ndescription: 用户指定的复盘步骤\nallowed-tools: ""\n---\n先列事实，再总结下一步。',
    },
  };
  await page.goto('/');
  const draft = page.getByRole('textbox', { name: 'Multivac 草稿' });
  if (await page.getByRole('button', { name: '移除 Skill', exact: true }).isVisible())
    await page.getByRole('button', { name: '移除 Skill', exact: true }).click();
  await draft.fill('内部工具：propose_skill ' + JSON.stringify(payload));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认登记', exact: true })).toBeVisible();
  expect(
    (await (await request.get(api + '/api/skills')).json()).some(
      (r: { name: string }) => r.name === 'retrospective',
    ),
  ).toBe(false);
  await page.getByRole('button', { name: '确认登记', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('skill-proposal.png') });
  await page.getByRole('button', { name: '确认登记', exact: true }).click();
  await expect
    .poll(async () =>
      (await (await request.get(api + '/api/skills')).json()).some(
        (r: { name: string }) => r.name === 'retrospective',
      ),
    )
    .toBe(true);
});
