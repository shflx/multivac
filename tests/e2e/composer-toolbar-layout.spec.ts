import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { McpManagementDetail, McpScopeEntry, McpService } from '@multivac/contracts';
import { fakeApiRoot, openCreationDialog, openPanel, resetE2eState, setWorkspaceMode } from './test-state.js';

const widths = [540, 460, 430, 400, 360, 320];
const longName = '用于验证窄容器的超长模型名称 GPT Fixture Extended Reasoning';
type McpState = 'hidden' | 'ready' | 'attention';

/** 只模拟 MCP 的读取响应，不连接服务；由真实 McpSessionTools 渲染数量和待处理橙点。 */
async function mockMcp(page: Page, state: McpState) {
  const sessions = new Set<string>();
  const timestamp = '2026-01-01T00:00:00.000Z';
  const service: McpService = {
    serviceId: 'toolbar-ready', revision: 1, name: '布局工具', source: 'layout-fixture',
    transport: { kind: 'streamable-http', url: 'https://example.invalid/mcp' }, configVersion: 'config-1',
    enabled: true, removed: false, createdAt: timestamp, updatedAt: timestamp,
  };
  const account = {
    accountId: 'toolbar-account', serviceId: service.serviceId, revision: 1, label: '测试账号',
    credentialRef: null, auth: 'none' as const, state: 'ready' as const, createdAt: timestamp, updatedAt: timestamp,
  };
  const tools = Array.from({ length: 12 }, (_, index) => ({
    toolId: `tool-${index}`, name: `read_${index}`, description: '布局测试', inputSchema: {}, outputSchema: null,
    definitionVersion: 'definition-1', annotations: {},
  }));
  await page.route('**/api/mcp/scope?**', async route => {
    const sessionId = new URL(route.request().url()).searchParams.get('id')!;
    sessions.add(sessionId);
    const entries: McpScopeEntry[] = state === 'hidden' ? [] : [{
      service, accounts: [account], rule: null, availability: null, reason: null, editable: false,
    }];
    if (state === 'attention') entries.push({
      service: { ...service, serviceId: 'toolbar-pending', name: '待连接服务' },
      accounts: [], rule: null, availability: null, reason: null, editable: false,
    });
    await route.fulfill({ json: entries });
  });
  await page.route('**/api/mcp/detail?**', async route => {
    const detail: McpManagementDetail = {
      service, accounts: [account], rules: [], calls: [],
      connections: [...sessions].map(sessionId => ({ usable: true, connection: {
        connectionId: `connection-${sessionId}`, sessionId, serviceId: service.serviceId,
        accountId: account.accountId, accountRevision: 1, configVersion: service.configVersion, revision: 1,
        state: 'connected', protocolVersion: '2025-03-26', capabilities: { tools: true, resources: false, resourceTemplates: false },
        errorCode: null, updatedAt: timestamp,
      } })),
      catalogs: [{ current: true, catalog: {
        catalogId: 'toolbar-catalog', serviceId: service.serviceId, accountId: account.accountId,
        accountRevision: 1, configVersion: service.configVersion, version: 'catalog-1', revision: 1,
        tools, resources: [], resourceTemplates: [], discoveredAt: timestamp,
      } }],
      classifications: tools.map(tool => ({
        classificationId: `classification-${tool.toolId}`, revision: 1, serviceId: service.serviceId,
        accountId: account.accountId, accountRevision: 1, configVersion: service.configVersion,
        catalogVersion: 'catalog-1', toolId: tool.toolId, definitionVersion: tool.definitionVersion,
        effects: ['read'], sourceDecisionId: 'layout-fixture', confirmedAt: timestamp, revokedAt: null,
      })),
    };
    // 待连接服务没有连接，须经真实组件计算橙点，不能手工插入标记。
    if (new URL(route.request().url()).searchParams.get('serviceId') === 'toolbar-pending') detail.connections = [];
    await route.fulfill({ json: detail });
  });
}

async function useLongModelName(page: Page) {
  await page.route(/\/api\/(?:assistant|sessions\/[^/]+)\/model-selection$/, async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.options = data.options.map((option: { displayName: string }) => ({ ...option, displayName: longName }));
    await route.fulfill({ response, json: data });
  });
}

async function setCardWidth(composer: Locator, width: number) {
  // 页面保持 1800px，只修改真实输入卡片的 border-box 宽度。
  await composer.evaluate((element, width) => {
    const card = element as HTMLElement;
    card.style.width = `${width}px`;
    card.style.maxWidth = 'none';
    card.style.marginLeft = 'auto';
    card.style.marginRight = 'auto';
  }, width);
  await expect.poll(async () => Math.round((await composer.boundingBox())!.width)).toBe(width);
}

async function measure(composer: Locator) {
  return composer.evaluate(card => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, cy: rect.top + rect.height / 2 };
    };
    const bar = card.querySelector('.composer-bar')!;
    const left = bar.querySelector('.composer-meta')!;
    const right = bar.querySelector('.composer-submit-actions')!;
    const controls = [...left.children].filter(element => element.tagName !== 'INPUT').map(element => ({
      name: element.className, ...box(element),
      button: box(element.matches('button') ? element : element.querySelector('button')!),
    }));
    const buttons = [...bar.querySelectorAll('button')].map(element => ({
      label: element.getAttribute('aria-label') ?? element.textContent,
      ...box(element), icons: [...element.querySelectorAll('svg')].map(box),
      hit: element.disabled || element.contains(document.elementFromPoint(box(element).left + box(element).width / 2, box(element).cy)),
    }));
    const name = card.querySelector('.model-selector-name')!;
    return { card: box(card), bar: box(bar), left: box(left), right: box(right), controls, buttons,
      mcp: right.querySelector('.mcp-session-trigger') ? box(right.querySelector('.mcp-session-trigger')!) : null,
      send: box(right.querySelector('.composer-send-button')!),
      modelName: { width: name.clientWidth, fullWidth: name.scrollWidth, overflow: getComputedStyle(name).textOverflow },
    };
  });
}

async function assertLayout(composer: Locator, width: number, hasAgent: boolean, hasMcp: boolean) {
  const value = await measure(composer);
  expect(Math.round(value.card.width)).toBe(width);
  expect(value.left.left).toBeGreaterThanOrEqual(value.bar.left - 1);
  expect(value.right.right).toBeLessThanOrEqual(value.bar.right + 1);
  expect(value.right.right).toBeCloseTo(value.bar.right, 0);
  expect(value.controls).toHaveLength(hasAgent ? 4 : 3);
  for (const [index, control] of value.controls.entries()) {
    expect(control.left).toBeGreaterThanOrEqual(value.left.left - 1);
    expect(control.right).toBeLessThanOrEqual(value.left.right + 1);
    expect(control.button.left).toBeGreaterThanOrEqual(control.left - 1);
    expect(control.button.right).toBeLessThanOrEqual(control.right + 1);
    expect(control.cy).toBeCloseTo(value.left.cy, 0);
    if (index) expect(control.left).toBeGreaterThanOrEqual(value.controls[index - 1]!.right);
  }
  for (const button of value.buttons) {
    expect(button.width).toBeGreaterThanOrEqual(28);
    expect(button.height).toBeGreaterThanOrEqual(28);
    expect(button.left).toBeGreaterThanOrEqual(value.bar.left - 1);
    expect(button.right).toBeLessThanOrEqual(value.bar.right + 1);
    expect(button.hit).toBe(true);
    for (const icon of button.icons) {
      expect(icon.width).toBeGreaterThanOrEqual(13);
      expect(icon.left).toBeGreaterThanOrEqual(button.left);
      expect(icon.right).toBeLessThanOrEqual(button.right);
    }
  }
  expect(Boolean(value.mcp)).toBe(hasMcp);
  if (value.mcp) {
    expect(value.mcp.cy).toBeCloseTo(value.send.cy, 0);
    expect(value.mcp.right).toBeLessThan(value.send.left);
  }
  const sameRow = Math.abs(value.left.cy - value.right.cy) < 1;
  if (sameRow) expect(value.left.right).toBeLessThan(value.right.left);
  else {
    expect(value.left.right).toBeCloseTo(value.bar.right, 0);
    expect(value.right.top).toBeGreaterThanOrEqual(value.left.bottom + 7);
  }
  if (width === 540) expect(sameRow).toBe(true);
  if (hasAgent && hasMcp && width <= 430) expect(sameRow).toBe(false);
  expect(value.modelName.width).toBeGreaterThan(0);
  expect(value.modelName.overflow).toBe('ellipsis');
  if (hasAgent && width === 320) expect(value.modelName.fullWidth).toBeGreaterThan(value.modelName.width);
  return value;
}

async function checkMcp(composer: Locator, state: McpState) {
  const trigger = composer.locator('.mcp-session-trigger');
  if (state === 'hidden') { await expect(trigger).toHaveCount(0); return; }
  await expect(trigger).toContainText('MCP · 12');
  await expect(trigger.getByRole('img', { name: '有服务待处理' })).toHaveCount(state === 'attention' ? 1 : 0);
  await trigger.click();
  await expect(composer.getByRole('dialog', { name: '本会话的 MCP 工具' })).toBeVisible();
  await composer.getByRole('dialog', { name: '本会话的 MCP 工具' }).getByRole('button').first().press('Escape');
  await expect(composer.getByRole('dialog', { name: '本会话的 MCP 工具' })).toHaveCount(0);
}

async function attachEvidence(testInfo: TestInfo, name: string, measurements: unknown[]) {
  await testInfo.attach(`${name}-sizes.json`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
}

test.describe('输入工具栏按容器宽度分组', () => {
  test.use({ viewport: { width: 1800, height: 1000 } });
  test.beforeEach(async ({ request }) => { await resetE2eState(request); });

  for (const state of ['hidden', 'ready', 'attention'] as const) {
    test(`并排工作会话：六种容器宽度、长模型名、智能体选择与移除，MCP=${state}`, async ({ page }, testInfo) => {
      await mockMcp(page, state);
      await useLongModelName(page);
      await page.goto('/');
      await openPanel(page, 'workspace');
      for (const title of ['工具栏甲', '工具栏乙']) {
        await openCreationDialog(page);
        const dialog = page.getByRole('dialog', { name: '创建新会话' });
        await dialog.getByLabel('会话名称').fill(title);
        await dialog.getByRole('button', { name: '创建', exact: true }).click();
        await expect(dialog).toHaveCount(0);
      }
      await setWorkspaceMode(page, 'parallel');
      await expect(page.locator('.conversation-panel')).toHaveCount(2);
      const panel = page.locator('.conversation-panel').filter({ has: page.getByRole('heading', { name: '工具栏乙', exact: true }) });
      const composer = panel.locator('.assistant-composer');
      const draft = composer.getByLabel('Multivac 草稿');
      await expect(draft).toBeEditable();
      await expect(composer.locator('.model-selector-name')).toHaveText(longName);
      const measurements = [];
      for (const width of widths) {
        await setCardWidth(composer, width);
        await draft.fill(`容器 ${width}px 的草稿`);
        // 等待 MCP 的异步读取稳定，避免将首次加载当作隐藏状态。
        await checkMcp(composer, state);
        measurements.push({ width, selected: false, ...await assertLayout(composer, width, true, state !== 'hidden') });
        await composer.getByRole('button', { name: '选择本轮智能体' }).click();
        const search = composer.getByRole('textbox', { name: '搜索执行智能体' });
        await search.fill('通用执行');
        await expect(composer.getByRole('option')).toHaveCount(1);
        await search.press('Enter');
        await expect(composer.getByRole('group', { name: '本轮智能体', exact: true })).toContainText('通用执行');
        measurements.push({ width, selected: true, ...await assertLayout(composer, width, true, state !== 'hidden') });
        if ([540, 430, 320].includes(width)) await testInfo.attach(`work-${state}-${width}.png`, { body: await composer.screenshot(), contentType: 'image/png' });
        await composer.getByRole('button', { name: '移除本轮智能体' }).click();
        await expect(composer.getByRole('group', { name: '本轮智能体', exact: true })).toHaveCount(0);
        await expect(draft).toHaveValue(`容器 ${width}px 的草稿`);
        await assertLayout(composer, width, true, state !== 'hidden');
      }
      await composer.getByRole('button', { name: '添加图片或引用资源' }).click();
      await expect(composer.getByRole('menu', { name: '添加材料' })).toBeVisible();
      await composer.getByRole('menu', { name: '添加材料' }).getByRole('menuitem').first().press('Escape');
      await composer.getByRole('button', { name: '选择 Skill' }).click();
      await expect(composer.getByRole('textbox', { name: '搜索 Skill' })).toBeFocused();
      await composer.getByRole('textbox', { name: '搜索 Skill' }).press('Escape');
      await composer.getByRole('button', { name: '当前会话模型', exact: true }).click();
      const modelMenu = composer.locator('.model-selector-menu');
      await expect(modelMenu).toBeVisible();
      await expect(modelMenu.getByLabel('推理等级')).toBeVisible();
      await modelMenu.locator('.model-option button').nth(1).click();
      await expect(modelMenu.locator('.model-option button').nth(1)).toHaveClass(/selected/);
      await expect(modelMenu).toBeVisible();
      await modelMenu.locator('.model-option button').nth(1).press('Escape');
      await draft.fill('窄容器发送回归');
      await composer.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(panel.locator('article.chat-row.user').filter({ hasText: '窄容器发送回归' })).toHaveCount(1);
      await expect(draft).toHaveValue('');
      await expect(panel.getByRole('status').getByText('处理完成', { exact: true })).toBeVisible();
      await checkMcp(composer, state);
      await attachEvidence(testInfo, 'work', measurements);
    });

    test(`共享输入组件：首页、侧栏与不开放智能体的工作会话，MCP=${state}`, async ({ page, request }, testInfo) => {
      await mockMcp(page, state);
      const created = await request.post(`${fakeApiRoot}/api/sessions`, { data: { sessionId: 'toolbar-restricted', title: '共享组件' } });
      expect(created.ok()).toBe(true);
      await page.goto('/multi-session-harness.html');
      await page.waitForFunction(() => '__setViews' in window);
      await page.evaluate(() => {
        (window as unknown as { __setViews(views: unknown[]): void }).__setViews([
          { key: 'home', sessionId: 'global-coordinator', variant: 'page' },
          { key: 'sidebar', sessionId: 'global-coordinator', variant: 'sidebar' },
          { key: 'restricted', sessionId: 'toolbar-restricted', variant: 'page' },
        ]);
      });
      const measurements = [];
      for (const view of ['home', 'sidebar', 'restricted']) {
        const composer = page.locator(`[data-view="${view}"] .assistant-composer`);
        await expect(composer.getByLabel('Multivac 草稿')).toBeEditable();
        await expect(composer.locator('.model-selector-name')).toHaveText('GPT Fixture');
        await expect(composer.getByRole('button', { name: '选择本轮智能体' })).toHaveCount(0);
        for (const width of widths) {
          await setCardWidth(composer, width);
          await checkMcp(composer, view === 'restricted' ? 'hidden' : state);
          measurements.push({ view, width, ...await assertLayout(composer, width, false, view !== 'restricted' && state !== 'hidden') });
        }
      }
      await attachEvidence(testInfo, 'shared', measurements);
    });
  }
});
