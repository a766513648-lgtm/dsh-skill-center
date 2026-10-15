/**
 * Skill Center — browser half.
 *
 * Registers one settings page into the Host settings shell's `settings.section`
 * ledger. All skill data comes from the host half over `/api/skill-center`, so
 * this module never touches the filesystem.
 *
 * Activation is defensive by design. A client plugin whose `apply` throws is
 * reported to the desktop as one entry that "did not activate" — which blocks
 * the app behind its recovery screen — and its only trace is a line in the
 * browser console that nobody can open. Since a missing Host service or a
 * shifted slot contract is not something this page can fix at runtime, every
 * step is guarded, and a failure is reported to the host (so it lands in the
 * desktop log) and then downgraded to "no page" instead of taking the client
 * down.
 *
 * @module @dsh-workship/skill-center/client
 */

import type { Context } from '@deepseek-ai/cordis';
// Type-only imports: these packages carry the module augmentations that declare
// `ctx.slots` and `ctx.locale` on the browser side. `ctx.slots` comes from the
// renderer's `./client` entry, not from its host entry. Written with `import
// type` so TypeScript erases them and the bundle never requires them at runtime
// — the shell only shares the packages listed in `dsh.client.external`.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
// Declares the composer row's slots, including `conversation.input.left`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { createPanelStore } from './store.ts';
import { SkillCenterSection } from './SkillCenterSection.tsx';
import { SkillButton } from './SkillButton.tsx';
import { en, NS, zh } from './locales.ts';

/** Services this browser half needs. */
export const inject = ['slots', 'locale'];

/** Which browser half this bundle carries; the suite uses it to pick expectations. */
export const VARIANT = 'real';

/** Nav position: after the built-in sections, before anything later. */
const SECTION_ORDER = 60;

/** Position of the composer button inside the input row's left lane. */
const COMPOSER_BUTTON_ORDER = 10;

/** The page translator type the slot contract expects. */
type PageTranslator = (key: string, params?: Record<string, string | number>) => string;

/**
 * Report one failure to the host log and to the console.
 *
 * The Host cannot see browser failures, so a client-side problem would otherwise
 * be invisible; `/api/skill-center/client-report` writes this to the host's
 * stderr, which the desktop log captures.
 * @param step - which step failed.
 * @param error - the thrown value.
 */
function reportFailure(step: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  try {
    console.error(`skill-center: ${step} failed; the settings page will not appear.`, error);
  } catch {
    // Console may be unavailable in an exotic embedding.
  }
  try {
    void fetch('/api/skill-center/client-report', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-skill-center': '1' },
      body: JSON.stringify({ step, detail, stack }),
    }).catch(() => undefined);
  } catch {
    // fetch may be unavailable.
  }
}

/**
 * Register the settings page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  try {
    // Each step is guarded separately so one missing capability cannot veto the
    // whole client entry: a throw during activation is what puts the desktop
    // into its recovery screen.
    let translate: PageTranslator;
    try {
      const bound = ctx.locale.bind(NS);
      translate = (key, params) => bound(key as Parameters<typeof bound>[0], params);
    } catch (error) {
      reportFailure('translator binding', error);
      return;
    }

    try {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'skill-center: dictionaries',
      );
    } catch (error) {
      // Without dictionaries the page would render raw keys; still usable, so
      // this is reported and the section registration continues.
      reportFailure('dictionary registration', error);
    }

    let store: ReturnType<typeof createPanelStore>;
    try {
      store = createPanelStore();
    } catch (error) {
      reportFailure('panel store', error);
      return;
    }

    try {
      // `slots.inject` is the contract for contributing to a slot another plugin
      // declares: it runs the callback once the declaration exists, re-runs it
      // when the declaration changes, and removes the contribution when it goes
      // away. Registering directly races the shell — `slots.register` throws
      // "slot \"settings.section\" is not declared" whenever this plugin happens
      // to activate first, which is exactly what it did before.
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'skill-center',
            order: SECTION_ORDER,
            label: () => translate('title'),
            locale: NS,
            inject: () => ({ store, t: translate }),
          },
          SkillCenterSection,
        ),
      );
    } catch (error) {
      reportFailure('settings section registration', error);
    }

    try {
      // The composer button, sharing the section's store so both views show the
      // same data. `conversation.input.left` is the one composer seat a plugin
      // may extend: it is a `list`, while the permission and model chips beside
      // it are `single` seats their own plugins already hold.
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'skill-center-button',
            order: COMPOSER_BUTTON_ORDER,
            locale: NS,
            inject: () => ({ store, t: translate }),
          },
          SkillButton,
        ),
      );
    } catch (error) {
      reportFailure('composer button registration', error);
    }
  } catch (error) {
    // Last resort: never let activation throw.
    reportFailure('apply', error);
  }
}
