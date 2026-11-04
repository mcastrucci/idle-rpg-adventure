import { useSyncExternalStore } from 'react';

import { getLocale, subscribeLocale } from './locale.ts';
import type { Locale } from './locale.ts';

/** Re-renders the calling component when the active locale changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
