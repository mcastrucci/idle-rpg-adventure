import { useCallback, useSyncExternalStore } from 'react';

/** Sanctuary hub tabs (docs/spec/ui-mobile.md §2). Social arrives in phase 2. */
export const TABS = [
  { id: 'character', label: 'Character' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'world', label: 'World map' },
  { id: 'expeditions', label: 'Expeditions' },
] as const;

export type TabId = typeof TABS[number]['id'];
export const DEFAULT_TAB: TabId = 'character';

export function tabFromHash(hash: string): TabId {
  const id = hash.replace(/^#\/?/, '');
  return TABS.find((tab) => tab.id === id)?.id ?? DEFAULT_TAB;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

/** Hash routing keeps deep links and the back button working without a router dependency or server rewrites. */
export function useHashTab(): [TabId, (tab: TabId) => void] {
  const tab = useSyncExternalStore(subscribe, () => tabFromHash(window.location.hash));
  const select = useCallback((next: TabId) => { window.location.hash = `/${next}`; }, []);
  return [tab, select];
}
