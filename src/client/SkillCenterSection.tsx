/**
 * The Skill Center settings page.
 *
 * Layout follows the shape Host settings pages use: a header that names the
 * page, one action row, then the content. Colors come from Host semantic
 * variables with fallbacks, so the page follows the light or dark theme without
 * shipping a theme of its own.
 *
 * @module client/SkillCenterSection
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button, Input, Modal, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SkillView } from '../contract.ts';
import type { PanelNotice, PanelStore } from './store.ts';
import { ensureScrollStyles, SCROLL_CLASS, SCROLL_INLINE } from './scrollStyles.ts';

/** Props the section receives: the shell's, the injected store, and the translator. */
export interface SkillCenterProps {
  /** Closes the settings panel; provided by the settings shell. */
  readonly close: () => void;
  /** Store created for this mount. */
  readonly store: PanelStore;
  /** Translate a key from this plugin's dictionary. */
  readonly t: (key: string, params?: Record<string, string | number>) => string;
  /** Optional sink for a diagnostic line the host log should carry. */
  readonly onReport?: ((step: string, detail: string) => void) | undefined;
}

/** Guards the one-time stylesheet report across remounts and entry points. */
let reportedStyles = false;

/**
 * Inline styles that read the Host's semantic theme tokens.
 *
 * The names are the ones the shipped components actually use (`--dsw-alias-*`),
 * taken from `Input.module.css` for the raised card surface and the text ramp,
 * `Modal.module.css` for the dialog surface, and `Tag.module.css` for a chip.
 * The soft fallbacks matter: a token that is missing would otherwise resolve to
 * nothing and leave the page with no surface at all.
 */
const styles = {
  // `height: 100%` is only honoured when the parent has a definite height, which is
  // not guaranteed inside another plugin's modal. `minHeight: 0` plus the list's own
  // cap below means the page never has to rely on it.
  page: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0, height: '100%' } as const,
  header: { display: 'flex', flexDirection: 'column', gap: '2px' } as const,
  title: { fontSize: 'var(--dsw-font-xs-13, 13px)', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1f2328)' } as const,
  muted: { fontSize: 'var(--dsw-font-xs-13, 13px)', color: 'var(--dsw-alias-label-tertiary, #6b7280)' } as const,
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } as const,
  search: { flex: '1 1 200px', minWidth: '160px' } as const,
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    overflowY: 'auto',
    minHeight: 0,
    flex: 1,
    paddingRight: '2px',
    // An independent cap, so the list is a real scroll container even when the
    // flex chain above it does not resolve a height. Relying on `flex: 1` alone
    // proved fragile: with an indefinite ancestor the item does not shrink, the
    // list grows to its content, and an outer `overflow: hidden` clips it — which
    // is indistinguishable from a list that simply cannot scroll.
    maxHeight: '65vh',
    ...SCROLL_INLINE,
  } as const,
  card: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '10px 12px',
    borderRadius: 'var(--dsw-radius-sm, 8px)',
    border: '1px solid var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.18))',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
  } as const,
  cardText: { display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: 0 } as const,
  name: { fontSize: 'var(--dsw-font-xs-13, 13px)', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1f2328)', overflowWrap: 'anywhere' } as const,
  desc: { fontSize: 'var(--dsw-font-xs-13, 13px)', color: 'var(--dsw-alias-label-secondary, #4b5563)', overflowWrap: 'anywhere' } as const,
  tagline: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } as const,
  mono: {
    fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: 'var(--dsw-font-xs-13, 13px)',
    color: 'var(--dsw-alias-label-tertiary, #6b7280)',
    overflowWrap: 'anywhere',
  } as const,
  body: {
    whiteSpace: 'pre-wrap',
    fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: 'var(--dsw-font-xs-13, 13px)',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-primary, #1f2328)',
    background: 'var(--dsw-alias-bg-base, rgba(127, 127, 127, 0.08))',
    border: '1px solid var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.18))',
    borderRadius: 'var(--dsw-radius-sm, 8px)',
    padding: '12px',
    margin: 0,
    maxHeight: '340px',
    overflow: 'auto',
    ...SCROLL_INLINE,
  } as const,
  error: { fontSize: 'var(--dsw-font-xs-13, 13px)', color: 'var(--dsw-alias-state-error-primary, #b42318)' } as const,
  link: {
    border: 'none',
    background: 'none',
    padding: 0,
    cursor: 'pointer',
    fontSize: 'var(--dsw-font-xs-13, 13px)',
    color: 'var(--dsw-alias-link, #0969da)',
    textDecoration: 'underline',
  } as const,
  empty: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '24px 12px', textAlign: 'center', alignItems: 'center' } as const,
  diagnostics: { display: 'flex', flexDirection: 'column', gap: '2px' } as const,
  notice: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--dsw-font-xs-13, 13px)', color: 'var(--dsw-alias-state-success-primary, #1f7a3f)' } as const,
  dangerLink: {
    border: 'none',
    background: 'none',
    padding: 0,
    cursor: 'pointer',
    fontSize: 'var(--dsw-font-xs-13, 13px)',
    color: 'var(--dsw-alias-state-error-primary, #b42318)',
    textDecoration: 'underline',
  } as const,
  field: { display: 'flex', flexDirection: 'column', gap: '4px' } as const,
  textarea: {
    minHeight: '140px',
    resize: 'vertical',
    padding: '8px',
    fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: 'var(--dsw-font-xs-13, 13px)',
    color: 'var(--dsw-alias-label-primary, #1f2328)',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    border: '1px solid var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.18))',
    borderRadius: 'var(--dsw-radius-sm, 8px)',
    ...SCROLL_INLINE,
  } as const,
} as const;

/**
 * Render one diagnostic code as localized copy, falling back to the host text.
 * @param t - the page translator.
 * @param code - diagnostic code from the host.
 * @param fallback - English message from the host.
 * @returns the text to show.
 */
function diagnosticText(t: SkillCenterProps['t'], code: string, fallback: string): string {
  const localized = t(code);
  return localized === code ? fallback : localized;
}

/**
 * Turn a success notice into a sentence.
 * @param t - the page translator.
 * @param notice - which success happened, and its detail.
 * @returns the text to show.
 */
function noticeText(t: SkillCenterProps['t'], notice: PanelNotice): string {
  switch (notice.kind) {
    case 'created':
      return t('created', { path: notice.detail ?? '' });
    case 'installed':
      return t('installed', { names: notice.detail ?? '' });
    case 'restored':
      return t('restored');
    case 'emptied':
      return t('emptied');
    default:
      return t('deleted');
  }
}

/**
 * Install a skill from a link.
 *
 * Kept next to the list rather than inside the create form: installing a published
 * skill and writing a new one by hand are different jobs, and the one people do most
 * often should not be behind a dialog.
 */
function UrlInstall(props: { t: SkillCenterProps['t']; store: PanelStore }): JSX.Element {
  const { t, store } = props;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [url, setUrl] = useState('');

  return (
    <div style={styles.row}>
      <div style={styles.search}>
        <Input
          value={url}
          placeholder={t('installPlaceholder')}
          aria-label={t('installPlaceholder')}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && url.trim() !== '' && !state.busy) void store.install(url.trim());
          }}
        />
      </div>
      <Button
        variant="outline"
        disabled={state.busy || url.trim() === ''}
        onClick={() => void store.install(url.trim())}
      >
        {state.busy ? t('installing') : t('install')}
      </Button>
    </div>
  );
}

/** Render the settings page. */
export function SkillCenterSection(props: SkillCenterProps): JSX.Element {
  const { store, t } = props;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    if (!state.loaded && !state.busy) void store.load();
  }, [state.loaded, state.busy, store]);

  useEffect(() => {
    // One stylesheet for every mount of this page, whichever entry point opened
    // it. The style element is left in place on unmount: removing it would fight
    // the other mount, and a few hundred bytes of inert CSS costs nothing. The
    // outcome is reported once, because a stylesheet that never reaches the
    // document leaves no other trace anywhere.
    if (reportedStyles) return;
    reportedStyles = true;
    props.onReport?.('scroll styles', ensureScrollStyles());
  }, [props]);

  useEffect(() => () => store.dispose(), [store]);

  const skills = useMemo(() => {
    const roots = state.data?.roots ?? [];
    return roots.flatMap((root) => root.skills);
  }, [state.data]);

  const query = state.query.trim().toLowerCase();
  const visible = skills.filter((skill) => {
    if (state.hideDisabled && skill.disabled) return false;
    if (query === '') return true;
    return skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query);
  });

  const summary = state.data?.summary;
  const busy = state.busy;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.title}>{t('title')}</div>
        <div style={styles.muted}>{t('description')}</div>
        {summary === undefined ? null : (
          <div style={styles.muted}>
            {t('summary', { total: summary.total, disabled: summary.disabled, issues: summary.issues })}
          </div>
        )}
      </div>

      {state.error === undefined ? null : (
        <div style={styles.error}>
          {diagnosticText(t, state.error.code, state.error.message)}{' '}
          <Button variant="ghost" onClick={() => void store.load()}>
            {t('retry')}
          </Button>
        </div>
      )}

      {state.notice === undefined ? null : (
        <div style={styles.notice}>
          {noticeText(t, state.notice)}
          <Button variant="ghost" onClick={() => store.dismissNotice()}>
            ×
          </Button>
        </div>
      )}

      {state.pane === 'create' ? (
        <CreatePane t={t} store={store} />
      ) : state.pane === 'trash' ? (
        <TrashPane t={t} store={store} />
      ) : state.pane === 'detail' && state.detail !== undefined ? (
        <DetailPane t={t} store={store} />
      ) : (
        <>
          <div style={styles.row}>
            <div style={styles.search}>
              <Input
                value={state.query}
                placeholder={t('search')}
                aria-label={t('search')}
                onChange={(event) => store.setQuery(event.target.value)}
              />
            </div>
            <Button variant="outline" onClick={() => void store.load()} disabled={busy}>
              {busy ? t('refreshing') : t('refresh')}
            </Button>
            <Button variant="primary" onClick={() => store.openCreate()} disabled={busy}>
              {t('create')}
            </Button>
            <Button variant="outline" onClick={() => void store.openTrash()} disabled={busy}>
              {t('trash')}
            </Button>
          </div>

          <UrlInstall t={t} store={store} />

          <div style={styles.row}>
            <Switch
              checked={state.hideDisabled}
              label={t('hideDisabled')}
              onChange={(checked) => store.setHideDisabled(checked)}
            />
            <span style={styles.muted}>{t('hideDisabled')}</span>
          </div>

          {(state.data?.warnings ?? []).map((warning) => (
            <div key={warning.code} style={styles.muted}>
              {diagnosticText(t, warning.code, warning.message)}
            </div>
          ))}

          <div className={SCROLL_CLASS} style={styles.list}>
            {!state.loaded && busy ? <div style={styles.muted}>{t('loading')}</div> : null}

            {state.loaded && skills.length === 0 ? (
              <div style={styles.empty}>
                <div style={styles.title}>{t('empty')}</div>
                <div style={styles.muted}>{t('emptyHint')}</div>
              </div>
            ) : null}

            {skills.length > 0 && visible.length === 0 ? (
              <div style={styles.empty}>
                <div style={styles.muted}>{t('emptyFiltered')}</div>
              </div>
            ) : null}

            {visible.map((skill) => (
              <SkillRow key={`${skill.rootKey}:${skill.name}`} skill={skill} t={t} store={store} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Remove one skill, after asking.
 *
 * The confirmation is a dialog rather than an inline "are you sure" so the
 * destructive action is never one stray click away, and it says plainly that the
 * skill goes to the trash, because "delete" that is quietly reversible is a
 * different promise from "delete".
 */
function DeleteDialog(props: {
  t: SkillCenterProps['t'];
  store: PanelStore;
  rootKey: string;
  name: string;
  onClose: () => void;
}): JSX.Element {
  const { t, store, rootKey, name, onClose } = props;
  const [working, setWorking] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title={t('deleteTitle', { name })}
      description={t('deleteBody')}
      closeLabel={t('cancel')}
    >
      <div style={{ ...styles.row, justifyContent: 'flex-end' }}>
        <Button variant="outline" onClick={onClose} disabled={working}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={working}
          onClick={() => {
            setWorking(true);
            void store.remove(rootKey, name).then(() => {
              setWorking(false);
              onClose();
            });
          }}
        >
          {t('deleteConfirm')}
        </Button>
      </div>
    </Modal>
  );
}

/** One skill row: name, description, provenance, problems, switch, details. */
function SkillRow(props: { skill: SkillView; t: SkillCenterProps['t']; store: PanelStore }): JSX.Element {
  const { skill, t, store } = props;
  const [confirming, setConfirming] = useState(false);
  const errors = skill.diagnostics.filter((item) => item.level === 'error');
  const warnings = skill.diagnostics.filter((item) => item.level === 'warning');
  const busy = store.getSnapshot().busy;
  // Removal is offered only where the host will allow it: a project skill and a
  // skill that cannot be loaded are both refused, so the button is not shown
  // rather than shown and then rejected.
  const removable = skill.scope === 'user' && skill.loadable;

  return (
    <div style={styles.card}>
      <div style={styles.cardText}>
        <div style={styles.name}>{skill.name}</div>
        {skill.description === '' ? null : <div style={styles.desc}>{skill.description}</div>}
        <div style={styles.tagline}>
          <Tag tone={skill.scope === 'project' ? 'info' : 'neutral'}>
            {skill.scope === 'project' ? t('project') : t('global')}
          </Tag>
          {skill.disabled ? <Tag tone="quiet">{t('switchedOff')}</Tag> : null}
          {errors.length > 0 ? <Tag tone="danger">{`${t('issues')} ${errors.length}`}</Tag> : null}
          {errors.length === 0 && warnings.length > 0 ? <Tag tone="warning">{`${t('issues')} ${warnings.length}`}</Tag> : null}
          <button
            type="button"
            onClick={() => void store.openDetail(skill.rootKey, skill.name)}
            style={styles.link}
          >
            {t('viewDetails')}
          </button>
          {removable ? (
            <button type="button" onClick={() => setConfirming(true)} style={styles.dangerLink} disabled={busy}>
              {t('delete')}
            </button>
          ) : null}
        </div>
        {skill.diagnostics.length === 0 ? null : (
          <div style={styles.diagnostics}>
            {skill.diagnostics.map((diagnostic) => (
              <div key={diagnostic.code} style={diagnostic.level === 'error' ? styles.error : styles.muted}>
                {diagnosticText(t, diagnostic.code, diagnostic.message)}
              </div>
            ))}
          </div>
        )}
        {skill.loadable ? null : <div style={styles.muted}>{t('notLoadable')}</div>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
        <Switch
          checked={!skill.disabled}
          disabled={!skill.loadable || busy}
          label={skill.disabled ? t('toggleOn') : t('toggleOff')}
          onChange={(checked) => void store.toggle(skill.rootKey, skill.name, !checked)}
        />
        <span style={styles.muted}>{skill.disabled ? t('switchedOff') : ''}</span>
      </div>

      {confirming ? (
        <DeleteDialog t={t} store={store} rootKey={skill.rootKey} name={skill.name} onClose={() => setConfirming(false)} />
      ) : null}
    </div>
  );
}

/** The trash: what was removed, and the two ways back. */
function TrashPane(props: { t: SkillCenterProps['t']; store: PanelStore }): JSX.Element {
  const { t, store } = props;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [confirming, setConfirming] = useState(false);
  const entries = state.trash?.entries ?? [];

  return (
    <div style={styles.page}>
      <div style={styles.row}>
        <Button variant="outline" onClick={() => store.closePane()} disabled={state.busy}>
          {t('back')}
        </Button>
        <span style={styles.muted}>{t('trashCount', { count: entries.length })}</span>
        <div style={{ flex: 1 }} />
        <Button
          variant="outline"
          onClick={() => setConfirming(true)}
          disabled={state.busy || entries.length === 0}
        >
          {t('emptyTrash')}
        </Button>
      </div>

      {state.trash?.warning === undefined ? null : (
        <div style={styles.muted}>{diagnosticText(t, state.trash.warning.code, state.trash.warning.message)}</div>
      )}

      <div className={SCROLL_CLASS} style={styles.list}>
        {entries.length === 0 ? (
          <div style={styles.empty}>
            <div style={styles.title}>{t('trashEmpty')}</div>
            <div style={styles.muted}>{t('trashEmptyHint')}</div>
          </div>
        ) : null}

        {entries.map((entry) => (
          <div key={entry.id} style={styles.card}>
            <div style={styles.cardText}>
              <div style={styles.name}>{entry.name}</div>
              <div style={styles.mono}>{entry.originalPath}</div>
              {entry.removedAt === '' ? null : <div style={styles.muted}>{entry.removedAt}</div>}
            </div>
            <Button variant="outline" disabled={state.busy} onClick={() => void store.restore(entry.id)}>
              {t('restore')}
            </Button>
          </div>
        ))}
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('emptyTrashTitle')}
        description={t('emptyTrashBody')}
        closeLabel={t('cancel')}
      >
        <div style={{ ...styles.row, justifyContent: 'flex-end' }}>
          <Button variant="outline" onClick={() => setConfirming(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void store.emptyTrash().then(() => setConfirming(false));
            }}
          >
            {t('emptyTrashConfirm')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** The create form: three fields, one of which the host refuses to do without. */
function CreatePane(props: { t: SkillCenterProps['t']; store: PanelStore }): JSX.Element {
  const { t, store } = props;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.title}>{t('createTitle')}</div>
      </div>

      <label style={styles.field}>
        <span style={styles.muted}>{t('createName')}</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} aria-label={t('createName')} />
        <span style={styles.muted}>{t('createNameHint')}</span>
      </label>

      <label style={styles.field}>
        <span style={styles.muted}>{t('createDescription')}</span>
        <Input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          aria-label={t('createDescription')}
        />
        <span style={styles.muted}>{t('createDescriptionHint')}</span>
      </label>

      <label style={styles.field}>
        <span style={styles.muted}>{t('createBody')}</span>
        <textarea
          className={SCROLL_CLASS}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-label={t('createBody')}
          style={styles.textarea}
        />
        <span style={styles.muted}>{t('createBodyHint')}</span>
      </label>

      <div style={styles.row}>
        <Button variant="primary" disabled={state.busy} onClick={() => void store.create({ name, description, body })}>
          {t('createSubmit')}
        </Button>
        <Button variant="outline" onClick={() => store.closePane()} disabled={state.busy}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

/** Detail view for one skill: metadata, diagnostics, frontmatter and body. */
function DetailPane(props: { t: SkillCenterProps['t']; store: PanelStore }): JSX.Element {
  const { t, store } = props;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const detail = state.detail;
  const [showFrontmatter, setShowFrontmatter] = useState(false);

  if (detail === undefined) return <div style={styles.muted}>{t('loading')}</div>;

  return (
    <div style={{ ...styles.page, overflowY: 'auto' }}>
      <div style={styles.row}>
        <Button variant="outline" onClick={() => store.closeDetail()}>
          {t('back')}
        </Button>
        <Switch
          checked={!detail.disabled}
          disabled={!detail.loadable}
          label={detail.disabled ? t('toggleOn') : t('toggleOff')}
          onChange={(checked) => void store.toggle(detail.rootKey, detail.name, !checked)}
        />
        <span style={styles.muted}>{detail.disabled ? t('switchedOff') : t('toggleHint')}</span>
      </div>

      <div style={styles.header}>
        <div style={styles.title}>{detail.name}</div>
        {detail.description === '' ? null : <div style={styles.desc}>{detail.description}</div>}
      </div>

      <div>
        <div style={styles.muted}>{t('path')}</div>
        <div style={styles.mono}>{detail.path}</div>
      </div>

      {detail.diagnostics.length === 0 ? null : (
        <div style={styles.diagnostics}>
          {detail.diagnostics.map((diagnostic) => (
            <div key={diagnostic.code} style={diagnostic.level === 'error' ? styles.error : styles.muted}>
              {diagnosticText(t, diagnostic.code, diagnostic.message)}
            </div>
          ))}
        </div>
      )}

      {detail.frontmatter === '' ? null : (
        <div>
          <div style={styles.row}>
            <span style={styles.muted}>{t('frontmatter')}</span>
            <Button variant="ghost" onClick={() => setShowFrontmatter(!showFrontmatter)}>
              {showFrontmatter ? '−' : '+'}
            </Button>
          </div>
          {showFrontmatter ? <pre className={SCROLL_CLASS} style={styles.body}>{detail.frontmatter}</pre> : null}
        </div>
      )}

      <div>
        <div style={styles.muted}>{t('body')}</div>
        <pre className={SCROLL_CLASS} style={styles.body}>{detail.body === '' ? t('noBody') : detail.body}</pre>
      </div>
    </div>
  );
}
