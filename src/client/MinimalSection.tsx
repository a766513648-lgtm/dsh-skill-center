/**
 * One static paragraph, used only by the minimal diagnostic build of the
 * browser half. It lives in a `.tsx` file so the JSX transform applies.
 *
 * @module @dsh-workship/skill-center/client/MinimalSection
 */

/** Render the placeholder page. */
export function MinimalSection(): JSX.Element {
  return <p style={{ fontSize: '13px' }}>Skill Center is registered. (minimal build)</p>;
}
