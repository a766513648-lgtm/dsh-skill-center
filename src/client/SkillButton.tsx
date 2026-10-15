/**
 * The composer's Skill Center button.
 *
 * It sits in the input row next to the permission chip 鈥?the one place in the
 * composer a third-party plugin may add a control (`conversation.input.left` is
 * a `list`; the permission and model seats are `single` and already taken) 鈥?and
 * opens the same page the settings section renders, over a modal.
 *
 * A modal rather than a small anchored popup: the input row clips its own
 * overflow, and a body-portaled dialog is not affected by that. It also gives
 * Escape, focus return and backdrop dismissal for free, which a hand-rolled
 * popover would have to reimplement.
 *
 * @module @dsh-workship/skill-center/client/SkillButton
 */

import { useState } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { SkillCenterSection } from './SkillCenterSection.tsx';
import type { PanelStore } from './store.ts';

/** Props the composer slot hands the button, plus its injected face. */
export interface SkillButtonProps {
  /** Translate a key from this plugin's dictionary. */
  readonly t: (key: string, params?: Record<string, string | number>) => string;
  /** Store shared with the settings section, so both views agree. */
  readonly store: PanelStore;
  /** Optional sink for a diagnostic line the host log should carry. */
  readonly onReport?: ((step: string, detail: string) => void) | undefined;
}

/** Render the button and, when open, the page over a modal. */
export function SkillButton(props: SkillButtonProps): JSX.Element {
  const { t, store, onReport } = props;
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('openButton')}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('title')}
        description={t('description')}
        closeLabel={t('closeModal')}
        contentClassName="skill-center-modal-content"
      >
        {/*
          A definite height, in viewport units, on purpose.

          `Modal` gives its card `max-height: 100%` and no height of its own, so the
          card is only bounded if every ancestor up to the fixed layer resolves a
          height. That chain is not reliable: measured in Chromium, the card computed
          `max-height: none`, grew past the viewport and clipped its own body, which
          is exactly what a list that cannot scroll looks like. A percentage here
          would inherit that same uncertainty, so the cap is expressed against the
          viewport instead, with room for the card's header, description and padding.
        */}
        <div
          className="skill-center-modal-content"
          style={{ height: '80vh', maxHeight: '80vh', minHeight: 0, display: 'flex' }}
        >
          <SkillCenterSection close={() => setOpen(false)} store={store} t={t} onReport={onReport} />
        </div>
      </Modal>
    </>
  );
}



