/**
 * Scrollbar styling for the panel's scrolling surfaces.
 *
 * Two facts drove this, both read out of the Host's own stylesheets:
 *
 * 1. The theme defines a palette that flips with the mode —
 *    `--dsh-scrollbar-thumb` → `--dsw-alias-scrollbar-bg-l1`, which resolves to
 *    `--dsw-static-neutral-200` in light mode and `--dsw-static-neutral-700` in
 *    dark. So a themed variable is the right first choice for following the theme.
 * 2. That same dark value is a *dark* grey, and the Host uses it on a 5px overlay
 *    with a transparent track. On a dark panel it is nearly invisible — which is
 *    exactly why the bar appeared to be missing. The panel therefore favours the
 *    label ramp (`--dsw-alias-label-tertiary`, the token the Host's own markdown
 *    scrollbars use) because it inverts: light on dark, dark on light.
 *
 * The explicit colours are the last resort, and they invert too. The bar is also
 * wider than the Host overlay and sits on a faint track, so its presence is
 * obvious rather than something to hunt for.
 *
 * These rules cannot be inline: `style` cannot address a `::-webkit-scrollbar`
 * pseudo-element. Every scrolling element also carries {@link SCROLL_INLINE}, which
 * styles the standard scrollbar and therefore still works if this sheet is never
 * attached.
 *
 * @module @dsh-workship/skill-center/client/scrollStyles
 */

import type { CSSProperties } from 'react';

/** Class the panel puts on each scrolling surface. */
export const SCROLL_CLASS = 'skill-center-scroll';

/** Id of the injected stylesheet, so several mounts share one element. */
export const SCROLL_STYLE_ID = 'skill-center-scroll-style';

/**
 * Thumb colour for every layer: themed label token first (it inverts), then the
 * Host scrollbar palette, then a fixed colour that is light on dark and dark on
 * light.
 */
const THUMB = 'var(--dsw-alias-label-tertiary, var(--dsh-scrollbar-thumb, var(--dsw-alias-scrollbar-bg-l1, rgba(200, 204, 210, 0.8))))';

/** Hover colour for the thumb, same order with a stronger token. */
const THUMB_HOVER = 'var(--dsw-alias-label-secondary, var(--dsh-scrollbar-thumb-hover, var(--dsw-alias-scrollbar-hover-l1, rgba(226, 230, 236, 0.95))))';

/** Inline fallback, applied straight to the scrolling elements. */
export const SCROLL_INLINE: CSSProperties = {
  scrollbarWidth: 'thin',
  scrollbarColor: `${THUMB} transparent`,
};

/** The stylesheet for {@link SCROLL_CLASS}. */
export const SCROLLBAR_CSS = `
.${SCROLL_CLASS} {
  scrollbar-width: thin;
  scrollbar-color: ${THUMB} transparent;
}
.${SCROLL_CLASS}::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}
.${SCROLL_CLASS}::-webkit-scrollbar-track {
  background-color: rgba(127, 127, 127, 0.08);
  border-radius: 999px;
}
.${SCROLL_CLASS}::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
  background-color: ${THUMB};
}
.${SCROLL_CLASS}::-webkit-scrollbar-thumb:hover {
  background-color: ${THUMB_HOVER};
}
@media (prefers-color-scheme: dark) {
  .${SCROLL_CLASS}::-webkit-scrollbar-thumb {
    background-color: var(--dsw-alias-label-tertiary, rgba(214, 218, 224, 0.85));
  }
}
@media (prefers-color-scheme: light) {
  .${SCROLL_CLASS}::-webkit-scrollbar-thumb {
    background-color: var(--dsw-alias-label-tertiary, rgba(60, 64, 70, 0.6));
  }
}
`;

/**
 * Attach the stylesheet once per document.
 * @returns what happened, so the caller can report it — "the sheet never reached
 * the document" and "the sheet's rules are wrong" look identical otherwise.
 */
export function ensureScrollStyles(): string {
  if (typeof document === 'undefined') return 'no document';
  const existing = document.getElementById(SCROLL_STYLE_ID);
  if (existing !== null) return 'already attached';
  const style = document.createElement('style');
  style.id = SCROLL_STYLE_ID;
  style.textContent = SCROLLBAR_CSS;
  const host = document.head ?? document.body ?? document.documentElement;
  if (host === null || host === undefined) return 'no element to attach to';
  host.appendChild(style);
  const attached = document.getElementById(SCROLL_STYLE_ID);
  if (attached === null) return 'appendChild did not stick';
  const sheets = typeof document.styleSheets?.length === 'number' ? document.styleSheets.length : -1;
  return `attached ${String(SCROLLBAR_CSS.length)} chars; sheets=${String(sheets)}`;
}
