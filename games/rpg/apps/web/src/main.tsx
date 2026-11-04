import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ensureSession } from './api/auth.ts';
import { ApiClient } from './api/http.ts';
import { App } from './app/App.tsx';
import { getLocale } from './i18n/index.ts';
import { LiveClient } from './live/client.ts';
import './styles.css';

// Resolve the device language first so <html lang> is right before the first paint.
getLocale();
const api = new ApiClient();
const storage = window.localStorage;
const liveUrl = new URL('/auth/live', window.location.href);
liveUrl.protocol = liveUrl.protocol === 'https:' ? 'wss:' : 'ws:';
// Each (re)connect first re-validates the cookie session, renewing it through the device guest login if expired.
const live = new LiveClient({ url: liveUrl.href, beforeConnect: async () => { await ensureSession(api, storage); } });

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing');
createRoot(root).render(
  <StrictMode>
    <App services={{ api, live, storage }} />
  </StrictMode>,
);
