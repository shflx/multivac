import { expect, type Page } from '@playwright/test';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes } from 'mdast';

export const noteBody = (page: Page) => page.locator('.notes-open-document:visible').getByRole('textbox', { name: '笔记正文', exact: true });

/** 用真实粘贴入口放入 Markdown；富文本框的 fill 只代表输入字面文本。 */
export async function replaceNoteBody(page: Page, source: string) {
  const body = noteBody(page);
  await body.focus(); await body.press('ControlOrMeta+A');
  if (!source) { await body.press('Backspace'); return; }
  await body.evaluate((element, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, source);
}

/** 同时核对原文与真实可见正文，避免仅看到服务端新值而漏掉编辑器未同步。 */
export async function expectNoteBody(page: Page, source: string) {
  await expect(noteBody(page)).toBeVisible();
  function text(node: Nodes): string {
    // 笔记只将无属性换行标签解释为换行；换行元素没有 textContent。
    if (node.type === 'html' && /^(?:<br\s*\/?>)+$/i.test(node.value)) return '';
    if (['html', 'footnoteReference', 'footnoteDefinition', 'definition'].includes(node.type)) return source.slice(node.position?.start.offset, node.position?.end.offset);
    if (node.type === 'image' || node.type === 'imageReference') return `图片 · ${node.alt || '未命名'}`;
    if ('value' in node && typeof node.value === 'string') return node.value;
    return 'children' in node ? node.children.map(text).join('') : '';
  }
  await expect(noteBody(page)).toHaveText(text(fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })));

  await expect.poll(() => page.evaluate(async () => {
    const id = sessionStorage.getItem('multivac:active-note');
    const pointer = sessionStorage.getItem(`multivac:note-draft-pointer:${id}`);
    const draft = pointer && localStorage.getItem(pointer);
    if (draft) return (JSON.parse(draft) as { body: string }).body;
    return (await (await fetch(`/api/notes/${id}`)).json() as { body: string }).body;
  })).toBe(source);
}
