import type { ReactElement } from 'react';

import type { TabId } from './tabs.ts';
import { TABS } from './tabs.ts';

const ICONS: Record<TabId, ReactElement> = {
  character: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" />,
  inventory: <path d="M4 8h16v12H4zM8 8V5h8v3M4 13h16" />,
  world: <path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" />,
  expeditions: <path d="M12 3v4M5 21l7-14 7 14M8.5 14h7" />,
};

export function TabBar({ active, onSelect }: { active: TabId; onSelect: (tab: TabId) => void }) {
  return (
    <nav className="tabbar" aria-label="Sanctuary">
      {TABS.map((tab) => (
        <a
          key={tab.id}
          href={`#/${tab.id}`}
          className="tabbar__item"
          aria-current={tab.id === active ? 'page' : undefined}
          onClick={(event) => { event.preventDefault(); onSelect(tab.id); }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="tabbar__icon">{ICONS[tab.id]}</svg>
          <span>{tab.label}</span>
        </a>
      ))}
    </nav>
  );
}
