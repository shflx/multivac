import { createFakeHarness } from './fake-harness.js';
import type { HarnessContext, HarnessFactory, HarnessRuntime } from './harness.js';
import { createPiHarness } from './pi-harness.js';

/** 已登记的 harness。新增 harness 只需实现 HarnessFactory 并在这里登记。 */
const HARNESSES = {
  pi: createPiHarness,
  fake: createFakeHarness,
} satisfies Record<string, HarnessFactory>;

export type HarnessName = keyof typeof HARNESSES;

/**
 * 本次启动使用的 harness：MULTIVAC_HARNESS 指定，缺省为 pi；MULTIVAC_FAKE_ASSISTANT=1 等同于 fake。
 * 未登记的名称在启动时明确报错，不回退到其他执行器。
 */
export function selectedHarness(environment: NodeJS.ProcessEnv): HarnessName {
  if (environment.MULTIVAC_FAKE_ASSISTANT === '1') return 'fake';
  const name = environment.MULTIVAC_HARNESS?.trim() || 'pi';
  if (!Object.hasOwn(HARNESSES, name)) throw new Error(`未登记的执行器：${name}。可用：${Object.keys(HARNESSES).join('、')}。`);
  return name as HarnessName;
}

export function createHarness(name: HarnessName, context: HarnessContext): HarnessRuntime {
  return HARNESSES[name](context);
}
