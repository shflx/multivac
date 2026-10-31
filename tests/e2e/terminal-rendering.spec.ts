import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

interface TerminalWindow extends Window {
  Terminal: typeof Terminal;
  FitAddon: { FitAddon: typeof FitAddon };
  terminal: Terminal;
}

const root = new URL('../../', import.meta.url);
const source = (path: string) => readFile(new URL(path, root), 'utf8');

async function openTerminal(page: Page, format: 'js' | 'mjs') {
  const [baseCss, terminalCss, xtermCss, bundle, fit] = await Promise.all([
    source('apps/web/src/styles/base.css'),
    source('apps/web/src/features/terminals/terminals.css'),
    source('node_modules/@xterm/xterm/css/xterm.css'),
    source(`node_modules/@xterm/xterm/lib/xterm.${format}`),
    source('node_modules/@xterm/addon-fit/lib/addon-fit.js'),
  ]);
  await page.setContent('<div class="terminal-view" style="width:960px;height:700px"><div class="terminal-canvas"><div class="terminal-host"></div></div></div>');
  await page.addStyleTag({ content: `${xtermCss}\n${baseCss}\n${terminalCss}` });
  if (format === 'js') await page.addScriptTag({ content: bundle });
  else await page.evaluate(async url => {
    (window as unknown as TerminalWindow).Terminal = (await import(url)).Terminal;
  }, `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`);
  await page.addScriptTag({ content: fit });
  await page.evaluate(() => {
    const target = window as unknown as TerminalWindow;
    // 与终端视图使用同一字号和字体回退，保留真实的小数字符宽度。
    target.terminal = new target.Terminal({
      fontSize: 13, lineHeight: 1.2, allowProposedApi: true,
      fontFamily: '"SF Mono", SFMono-Regular, Menlo, Monaco, "MesloLGS NF", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", "Symbols Nerd Font Mono", monospace',
    });
    target.terminal.open(document.querySelector<HTMLElement>('.terminal-host')!);
  });
}

async function draw(page: Page, width: number) {
  return page.evaluate(async width => {
    const target = window as unknown as TerminalWindow;
    const term = target.terminal;
    document.querySelector<HTMLElement>('.terminal-view')!.style.width = `${width}px`;
    const fit = new target.FitAddon.FitAddon();
    term.loadAddon(fit);
    const size = fit.proposeDimensions()!;
    term.resize(Math.min(240, size.cols), size.rows);
    const n = term.cols;
    const patterns = [
      'W'.repeat(n),
      Array.from({ length: n }, (_, i) => `\x1b[3${i % 7}mW`).join(''),
      '中'.repeat(Math.floor(n / 2)) + 'W'.repeat(n % 2),
      'A中'.repeat(Math.floor(n / 3)) + 'W'.repeat(n % 3),
      'e\u0301'.repeat(n),
      '\x1b[1m' + 'W'.repeat(n),
    ];
    let data = '\x1b[2J';
    for (const [index, pattern] of patterns.entries()) data += `\x1b[${index + 1};1H\x1b[0m${pattern}`;
    data += '\x1b[0m\x1b[10;1H';
    await new Promise<void>(resolve => term.write(data, resolve));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return { cols: n, lines: patterns.length };
  }, width);
}

for (const format of ['js', 'mjs'] as const) {
  test(`${format}：调整宽度与聚焦后，行尾和宽字符仍对齐终端网格`, async ({ page }) => {
    await openTerminal(page, format);
    for (const width of [960, 440, 2010]) {
      const { lines } = await draw(page, width);
      for (const focused of [false, true]) {
        const failures = await page.evaluate(async ({ lines, focused }) => {
          const term = (window as unknown as TerminalWindow).terminal;
          if (focused) term.focus(); else term.blur();
          await new Promise(requestAnimationFrame);
          const rows = [...document.querySelectorAll<HTMLElement>('.xterm-rows > div')].slice(0, lines);
          const failures: string[] = [];
          for (const [rowIndex, row] of rows.entries()) {
            const bounds = row.getBoundingClientRect();
            const cellWidth = bounds.width / term.cols;
            const buffer = term.buffer.active.getLine(rowIndex)!;
            // 使用文本 Range 测量每个实际字形，允许实现合并文本节点，不依赖补丁的节点数量。
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode(); let offset = 0;
            for (let col = 0; col < term.cols; col++) {
              const cell = buffer.getCell(col)!;
              if (!cell.getWidth()) continue;
              const chars = cell.getChars() || ' ';
              while (node && offset >= node.textContent!.length) { node = walker.nextNode(); offset = 0; }
              if (!node) { failures.push(`row ${rowIndex}: missing column ${col}`); break; }
              const range = document.createRange();
              range.setStart(node, offset); range.setEnd(node, offset + chars.length);
              const glyph = range.getBoundingClientRect();
              const expectedLeft = bounds.left + col * cellWidth;
              const expectedRight = expectedLeft + cell.getWidth() * cellWidth;
              if (Math.abs(glyph.left - expectedLeft) > 0.5 || glyph.right > expectedRight + 0.5) {
                failures.push(`row ${rowIndex}, col ${col}: left drift ${glyph.left - expectedLeft}, right overflow ${glyph.right - expectedRight}`);
              }
              offset += chars.length;
            }
          }
          return failures.slice(0, 5);
        }, { lines, focused });
        expect(failures, `width=${width}, focused=${focused}`).toEqual([]);
      }
    }
  });

  test(`${format}：行尾光标、选区与复制保持列坐标`, async ({ page }) => {
    await openTerminal(page, format);
    for (const width of [960, 440]) {
      await draw(page, width);
      const result = await page.evaluate(async () => {
        const term = (window as unknown as TerminalWindow).terminal;
        term.focus();
        await new Promise<void>(resolve => term.write(`\x1b[1;${term.cols}H\x1b[?25h`, resolve));
        term.select(term.cols - 4, 0, 4);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const row = document.querySelector<HTMLElement>('.xterm-rows > div')!.getBoundingClientRect();
        const cursor = document.querySelector<HTMLElement>('.xterm-cursor')!.getBoundingClientRect();
        const selection = document.querySelector<HTMLElement>('.xterm-selection > div')!.getBoundingClientRect();
        const cellWidth = row.width / term.cols;
        return {
          copied: term.getSelection(),
          cursorError: cursor.left - (row.right - cellWidth),
          selectionStartError: selection.left - (row.right - 4 * cellWidth),
          selectionEndError: selection.right - row.right,
        };
      });
      expect(result.copied).toBe('WWWW');
      expect(Math.abs(result.cursorError)).toBeLessThan(0.1);
      expect(Math.abs(result.selectionStartError)).toBeLessThan(0.1);
      expect(Math.abs(result.selectionEndError)).toBeLessThan(0.1);
    }
  });
}
