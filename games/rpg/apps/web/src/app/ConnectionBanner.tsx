import { codeText, t } from '../i18n/index.ts';
import type { LiveState } from '../live/state.ts';

export function connectionMessage(state: LiveState): string | null {
  switch (state.status) {
    case 'open':
    case 'idle':
      return null;
    case 'connecting':
      return state.attempt === 0 ? t('ui.connection.connecting') : t('ui.connection.reconnecting', { attempt: state.attempt + 1 });
    case 'reconnecting': {
      const seconds = Math.ceil((state.retryInMs ?? 0) / 1000);
      if (state.lastCloseCode === 4409) return t('ui.connection.elsewhere', { seconds });
      return t('ui.connection.lost', { seconds });
    }
    case 'failed':
      return t('ui.connection.failed', { error: state.error === null ? t('ui.connection.generic_error') : codeText(state.error) });
    case 'stopped':
      return t('ui.connection.stopped');
  }
}

/** Shown whenever commands are unavailable; actions stay disabled (not lost) until the socket is back. */
export function ConnectionBanner({ state, onRetry }: { state: LiveState; onRetry: () => void }) {
  const message = connectionMessage(state);
  if (message === null) return null;
  return (
    <div className={`banner banner--${state.status}`} role="status" aria-live="polite">
      <span>{message}</span>
      {(state.status === 'failed' || state.status === 'stopped') && (
        <button type="button" className="banner__action" onClick={onRetry}>{t('ui.common.retry')}</button>
      )}
    </div>
  );
}
