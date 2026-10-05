import {test,expect} from '@playwright/test';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPanel} from './test-state.js';
test('真实 Skill 导入、预览取消、键盘确认、停用与窄容器',async({page},info)=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skill-e2e-'))),source=join(root,'review-notes');mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'---\nname: review-notes\ndescription: 为已有资料整理审阅提纲\n---\n# 审阅\n先列出证据，再写结论。');
 try {
  await page.goto('/');await openPanel(page,'management');await page.getByRole('complementary',{name:'管理导航'}).getByRole('button',{name:'能力',exact:true}).click();
  await expect(page.getByText('还没有 Skill。选择包含 SKILL.md 的目录，预览后确认导入。')).toBeVisible();
  await page.getByText('从 Claude Code / Codex 来源导入',{exact:true}).click();await page.getByLabel('来源目录',{exact:true}).fill(root);await page.getByRole('button',{name:'列出候选',exact:true}).click();await page.getByRole('button',{name:'选择并预览',exact:true}).click();await expect(page.getByLabel('本地包目录')).toHaveValue(source);await page.getByLabel('显示名称（可选）').fill('资料审阅');await page.getByRole('button',{name:'预览导入',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'确认导入 Skill'})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByLabel('本地包目录')).toHaveValue(source);
  await page.getByRole('button',{name:'预览导入',exact:true}).click();await page.getByRole('button',{name:'确认登记',exact:true}).press('Enter');
  await expect(page.getByRole('heading',{name:'资料审阅',exact:true})).toBeVisible();await page.getByText('正文预览 · SKILL.md').click();await expect(page.locator('.skills-detail pre')).toContainText('先列出证据');
  await page.locator('.skills-toolbar').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('skills-desktop.png')});
  const downloadEvent=page.waitForEvent('download');await page.getByRole('link',{name:'导出标准包'}).click();expect((await downloadEvent).suggestedFilename()).toBe('review-notes.zip');
  await page.getByRole('button',{name:'停用',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();await expect(page.getByRole('button',{name:'启用',exact:true})).toBeVisible();
  await page.setViewportSize({width:1080,height:780});await page.screenshot({path:info.outputPath('skills-narrow.png')});
  expect(await page.locator('.skills-page').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBeTruthy();
 }finally{rmSync(root,{recursive:true,force:true});}
});
