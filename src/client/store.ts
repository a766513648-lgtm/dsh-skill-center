/**
 * Panel state for the Skill Center settings section.
 *
 * A tiny hand-rolled store keeps the browser half free of extra dependencies
 * and lets the React layer subscribe with `useSyncExternalStore`. Every write
 * goes through `fetch` against the host half; nothing here reads the disk
 * directly, because the browser is not the process that owns the files.
 *
 * @module client/store
 */

import type {
  RootsResponse,
  CreateResponse,
  DeleteResponse,
  DetailResponse,
  ErrorResponse,
  InstallResponse,
  StateResponse,
  ToggleResponse,
  TrashResponse,
} from '../contract.ts';

/** Route prefix owned by the host half. */
const ROUTE = '/api/skill-center';

/** Which pane the section is showing. */
export type Pane = 'list' | 'detail' | 'trash' | 'create';

/** One load failure, in a shape the panel can render and localize. */
export interface PanelError {
  /** Stable code from the host, or a client-side code. */
  readonly code: string;
  /** English fallback message. */
  readonly message: string;
}

/** A confirmation worth showing after an action succeeded. */
export interface PanelNotice {
  /** Which success happened. */
  readonly kind: 'deleted' | 'created' | 'installed' | 'restored' | 'emptied';
  /** Detail for the message: a path, or the names that were installed. */
  readonly detail?: string;
}

/** Everything the panel renders. */
export interface PanelState {
  /** Whether the first load has completed. */
  readonly loaded: boolean;
  /** Whether a request is in flight. */
  readonly busy: boolean;
  /** The last successful state response. */
  readonly data?: StateResponse;
  /** The open skill's detail, when the detail pane is showing. */
  readonly detail?: DetailResponse;
  /** Recoverable skills, when the trash pane is showing. */
  readonly trash?: TrashResponse;
  /** Which pane is active. */
  readonly pane: Pane;
  /** Search text. */
  readonly query: string;
  /** Whether switched-off skills are hidden. */
  readonly hideDisabled: boolean;
  /** The most recent failure. */
  readonly error?: PanelError;
  /** The most recent success worth confirming, replaced on the next action. */
  readonly notice?: PanelNotice;
  /** Directories a new skill may be written into, from the host. */
  readonly roots: readonly string[];
  /** Which of those new skills go into; empty means the host's default. */
  readonly targetRoot: string;
}

/** Read one JSON response, normalizing failures into an error envelope. */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${ROUTE}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-skill-center': '1',
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw { code: 'error.client.network', message: 'The browser could not reach the host.' } satisfies PanelError;
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text === '' ? {} : JSON.parse(text);
  } catch {
    throw { code: 'error.client.response', message: `The host returned an unreadable response (HTTP ${response.status}).` } satisfies PanelError;
  }

  if (!response.ok) {
    const failure = payload as Partial<ErrorResponse>;
    throw {
      code: typeof failure.code === 'string' ? failure.code : 'error.client.response',
      message: typeof failure.error === 'string' ? failure.error : `The request failed (HTTP ${response.status}).`,
    } satisfies PanelError;
  }
  return payload as T;
}

/** Create the store the section mounts once per settings panel. */
export function createPanelStore(): {
  getSnapshot: () => PanelState;
  subscribe: (listener: () => void) => () => void;
  load: () => Promise<void>;
  setQuery: (query: string) => void;
  setHideDisabled: (hide: boolean) => void;
  openDetail: (rootKey: string, name: string) => Promise<void>;
  closeDetail: () => void;
  toggle: (rootKey: string, name: string, disabled: boolean) => Promise<void>;
  remove: (rootKey: string, name: string) => Promise<boolean>;
  openTrash: () => Promise<void>;
  restore: (id: string) => Promise<boolean>;
  emptyTrash: () => Promise<boolean>;
  openCreate: () => void;
  closePane: () => void;
  create: (input: { name: string; description: string; body: string }) => Promise<boolean>;
  install: (url: string) => Promise<boolean>;
  setTargetRoot: (root: string) => void;
  loadRoots: () => Promise<void>;
  dismissNotice: () => void;
  dispose: () => void;
} {
  let state: PanelState = { loaded: false, busy: false, pane: 'list', query: '', hideDisabled: false, roots: [], targetRoot: '' };
  const listeners = new Set<() => void>();

  const publish = (next: Partial<PanelState>): void => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const fail = (error: unknown, loadedBefore = state.loaded): void => {
    const candidate = error as Partial<PanelError> | undefined;
    publish({
      busy: false,
      // `loaded` records that a successful load happened at some point; a later
      // failure keeps the last good list on screen instead of flashing the
      // "nothing here yet" empty state.
      loaded: loadedBefore,
      error: {
        code: typeof candidate?.code === 'string' ? candidate.code : 'error.client.unknown',
        message: typeof candidate?.message === 'string' ? candidate.message : 'Unexpected failure.',
      },
    });
  };

  /** Re-read the list after a change, keeping the pane the user is on. */
  const reload = async (): Promise<void> => {
    const data = await requestJson<StateResponse>('/state');
    publish({ data, loaded: true, busy: false });
  };

  /** Read the trash and show it. */
  const readTrash = async (): Promise<TrashResponse> => {
    const trash = await requestJson<TrashResponse>('/trash');
    publish({ trash, busy: false });
    return trash;
  };

  /**
   * Read the directories a new skill may go into.
   *
   * Derived from the profile's own configuration rather than stored here, so there
   * is one source of truth. A failure is swallowed: the list still renders and the
   * host applies its own default, which is better than an error about a detail.
   */
  const loadRoots = async (): Promise<void> => {
    try {
      const { roots } = await requestJson<RootsResponse>('/roots');
      // Keep the current choice when it is still offered, so a refresh does not
      // silently move where new skills go.
      const keep = roots.includes(state.targetRoot) ? state.targetRoot : (roots[0] ?? '');
      publish({ roots, targetRoot: keep });
    } catch {
      publish({ roots: [], targetRoot: '' });
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: async () => {
      const startedAtLoad = state.loaded;
      publish({ busy: true, error: undefined });
      try {
        const data = await requestJson<StateResponse>('/state');
        publish({ data, loaded: true, busy: false });
        // The destinations are derived from the profile's own configuration, so they
        // are read rather than remembered; a failure here must not fail the list, so
        // it is ignored and the host's default applies.
        void loadRoots();
      } catch (error) {
        fail(error, startedAtLoad);
      }
    },
    setQuery: (query) => publish({ query }),
    setHideDisabled: (hideDisabled) => publish({ hideDisabled }),
    setTargetRoot: (targetRoot) => publish({ targetRoot }),
    loadRoots,

    openDetail: async (rootKey, name) => {
      publish({ busy: true, error: undefined, pane: 'detail', detail: undefined });
      try {
        const detail = await requestJson<DetailResponse>('/detail', { method: 'POST', body: JSON.stringify({ rootKey, name }) });
        publish({ detail, busy: false });
      } catch (error) {
        fail(error);
        publish({ pane: 'list' });
      }
    },
    closeDetail: () => publish({ pane: 'list', detail: undefined }),
    toggle: async (rootKey, name, disabled) => {
      publish({ busy: true, error: undefined, notice: undefined });
      try {
        await requestJson<ToggleResponse>('/toggle', { method: 'POST', body: JSON.stringify({ rootKey, name, disabled }) });
        const data = await requestJson<StateResponse>('/state');
        const detail = state.detail === undefined
          ? undefined
          : { ...state.detail, disabled };
        publish({ data, busy: false, ...(detail === undefined ? {} : { detail }) });
      } catch (error) {
        fail(error);
      }
    },
    remove: async (rootKey, name) => {
      publish({ busy: true, error: undefined, notice: undefined });
      try {
        await requestJson<DeleteResponse>('/delete', { method: 'POST', body: JSON.stringify({ rootKey, name }) });
        publish({ pane: 'list', detail: undefined, notice: { kind: 'deleted', detail: name } });
        await reload();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    openTrash: async () => {
      publish({ busy: true, error: undefined, pane: 'trash' });
      try {
        await readTrash();
      } catch (error) {
        fail(error);
      }
    },
    restore: async (id) => {
      publish({ busy: true, error: undefined, notice: undefined });
      try {
        await requestJson('/restore', { method: 'POST', body: JSON.stringify({ id }) });
        publish({ notice: { kind: 'restored' } });
        await reload();
        await readTrash();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    emptyTrash: async () => {
      publish({ busy: true, error: undefined, notice: undefined });
      try {
        await requestJson('/empty-trash', { method: 'POST', body: '{}' });
        publish({ notice: { kind: 'emptied' } });
        await readTrash();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    openCreate: () => publish({ pane: 'create', error: undefined, notice: undefined }),
    closePane: () => publish({ pane: 'list', detail: undefined, error: undefined }),
    create: async (input) => {
      publish({ busy: true, error: undefined, notice: undefined });
      try {
        const created = await requestJson<CreateResponse>('/create', {
          method: 'POST',
          body: JSON.stringify({ ...input, targetRoot: state.targetRoot }),
        });
        publish({ pane: 'list', notice: { kind: 'created', detail: created.directory } });
        await reload();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    install: async (url) => {
      publish({ busy: true, error: undefined, notice: undefined });
      try {
        const installed = await requestJson<InstallResponse>('/install', {
          method: 'POST',
          body: JSON.stringify({ url, targetRoot: state.targetRoot }),
        });
        const names = installed.skills.map((skill) => skill.name).join(', ');
        publish({ pane: 'list', notice: { kind: 'installed', detail: names } });
        await reload();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    dismissNotice: () => publish({ notice: undefined }),
    dispose: () => listeners.clear(),
  };
}

/** The store handle the section injects into its component. */
export type PanelStore = ReturnType<typeof createPanelStore>;
