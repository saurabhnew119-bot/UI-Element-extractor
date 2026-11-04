import type { ElementRepository } from '../core/repository.ts';
import { assertPlatform } from '../platforms/index.ts';

/** One entry of the healing report written by the ElementIQ Java framework (target/elementiq/healing-report.json). */
export interface HealingEntry {
  element: string;
  platform: string;
  outcome: 'HEALED' | 'BROKEN';
  failedLocator: { strategy: string; value: string };
  usedLocator: { strategy: string; value: string } | null;
  test: string | null;
}

/**
 * HEALED entries: the fallback that worked at run time becomes the primary locator. BROKEN entries cannot be fixed
 * from the report alone; they need the current screen, so they are listed for an inspector repair.
 */
export function applyHealing(r: ElementRepository, entries: HealingEntry[]) {
  return entries.map((e) => {
    const platform = assertPlatform(e.platform);
    const el = r.findByName(e.element);
    if (e.outcome === 'BROKEN' || !e.usedLocator) {
      return { ...e, result: 'repair', detail: `no recorded locator worked (${e.failedLocator.strategy}="${e.failedLocator.value}"); capture the screen and run a repair${e.test ? ` (seen in ${e.test})` : ''}` };
    }
    if (!el) return { ...e, result: 'missing', detail: 'element is not in this repository' };
    const ok = r.promoteLocator(el.id, platform, e.usedLocator.strategy, e.usedLocator.value);
    return ok
      ? { ...e, result: 'promoted', detail: `${e.usedLocator.strategy}="${e.usedLocator.value}" is now primary (was ${e.failedLocator.strategy}="${e.failedLocator.value}")` }
      : { ...e, result: 'missing', detail: `${e.usedLocator.strategy}="${e.usedLocator.value}" is not a recorded unique ${platform} locator` };
  });
}
