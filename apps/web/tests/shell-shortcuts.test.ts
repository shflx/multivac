import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PANEL_ORDER,
  defaultPanelIndex,
  modifierKeyLabel,
  panelForDigit,
  shellShortcut,
  stepPanelIndex,
  type ShortcutKeyInput,
} from '../src/app/shell-shortcuts.js';

function key(value: string, modifiers: Partial<Omit<ShortcutKeyInput, 'key'>> = {}): ShortcutKeyInput {
  return { key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

test('⌘G / Ctrl+G 打开面板跳转，⌘J / Ctrl+J 叫出或收起 Multivac 侧栏，大小写都认', () => {
  assert.equal(shellShortcut(key('g', { metaKey: true })), 'panel-switcher');
  assert.equal(shellShortcut(key('G', { ctrlKey: true })), 'panel-switcher');
  assert.equal(shellShortcut(key('j', { ctrlKey: true })), 'multivac-sidebar');
  assert.equal(shellShortcut(key('J', { metaKey: true })), 'multivac-sidebar');
  assert.equal(shellShortcut(key('k', { metaKey: true })), 'quick-switcher');
  assert.equal(shellShortcut(key('K', { ctrlKey: true })), 'quick-switcher');
});

test('不带 ⌘ / Ctrl、带 Alt 或 Shift 的组合都不是外壳快捷键（⇧⌘G 留给浏览器的“查找上一个”）', () => {
  assert.equal(shellShortcut(key('g')), null);
  assert.equal(shellShortcut(key('j')), null);
  assert.equal(shellShortcut(key('g', { metaKey: true, shiftKey: true })), null);
  assert.equal(shellShortcut(key('j', { ctrlKey: true, altKey: true })), null);
  assert.equal(shellShortcut(key('k', { metaKey: true, altKey: true })), null);
  assert.equal(shellShortcut(key('\\', { metaKey: true })), null);
});

test('面板跳转按 Multivac、工作区、管理排列，默认选中当前面板的下一个，末尾回到开头', () => {
  assert.deepEqual(PANEL_ORDER, ['assistant', 'workspace', 'management']);
  assert.equal(PANEL_ORDER[defaultPanelIndex('assistant')], 'workspace');
  assert.equal(PANEL_ORDER[defaultPanelIndex('workspace')], 'management');
  assert.equal(PANEL_ORDER[defaultPanelIndex('management')], 'assistant');
});

test('方向键与 ⌘G 在三个面板间循环移动', () => {
  assert.equal(stepPanelIndex(0, 1), 1);
  assert.equal(stepPanelIndex(2, 1), 0);
  assert.equal(stepPanelIndex(0, -1), 2);
  assert.equal(stepPanelIndex(1, -1), 0);
});

test('数字键 1–3 直接对应三个面板，其他按键不跳', () => {
  assert.equal(panelForDigit('1'), 'assistant');
  assert.equal(panelForDigit('2'), 'workspace');
  assert.equal(panelForDigit('3'), 'management');
  assert.equal(panelForDigit('4'), null);
  assert.equal(panelForDigit('0'), null);
  assert.equal(panelForDigit('g'), null);
  assert.equal(panelForDigit('12'), null);
});

test('修饰键按系统显示：macOS 与 iOS 用 ⌘，其余用 Ctrl', () => {
  assert.equal(modifierKeyLabel('MacIntel'), '⌘');
  assert.equal(modifierKeyLabel('iPad'), '⌘');
  assert.equal(modifierKeyLabel('Win32'), 'Ctrl');
  assert.equal(modifierKeyLabel('Linux x86_64'), 'Ctrl');
});
