import { useEffect } from 'react';

import { CharacterScreen } from '../screens/CharacterScreen.tsx';
import { PlaceholderScreen } from '../screens/Placeholder.tsx';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { Header } from './Header.tsx';
import type { AppServices } from './services.ts';
import { useLiveState } from './services.ts';
import { TabBar } from './TabBar.tsx';
import type { TabId } from './tabs.ts';
import { useHashTab } from './tabs.ts';
import { useGameSession } from './useGameSession.ts';

export function App({ services }: { services: AppServices }) {
  const { live } = services;
  const liveState = useLiveState(live);
  const [tab, selectTab] = useHashTab();
  const { state, retry, runCharacterCommand } = useGameSession(services);

  useEffect(() => {
    const online = () => live.online();
    const offline = () => live.offline();
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [live]);

  const character = state.phase === 'ready' ? state.character : null;
  const canCommand = liveState.status === 'open';

  return (
    <div className="shell">
      <Header character={character} />
      {state.phase === 'ready' && <ConnectionBanner state={liveState} onRetry={() => live.start()} />}
      <main className="content" id="content">
        {state.phase === 'loading' && <p className="muted" role="status">Signing in…</p>}
        {state.phase === 'error' && (
          <div className="screen" role="alert">
            <p>Could not reach the server ({state.error}).</p>
            <button type="button" className="button" onClick={retry}>Try again</button>
          </div>
        )}
        {state.phase === 'ready' && <Screen tab={tab} character={character} canCommand={canCommand} run={runCharacterCommand} />}
      </main>
      <TabBar active={tab} onSelect={selectTab} />
    </div>
  );
}

function Screen({ tab, character, canCommand, run }: {
  tab: TabId;
  character: Parameters<typeof CharacterScreen>[0]['character'];
  canCommand: boolean;
  run: Parameters<typeof CharacterScreen>[0]['runCharacterCommand'];
}) {
  switch (tab) {
    case 'character':
      return <CharacterScreen character={character} canCommand={canCommand} runCharacterCommand={run} />;
    case 'inventory':
      return <PlaceholderScreen title="Inventory">Storage and equipment arrive with the inventory and ledger modules.</PlaceholderScreen>;
    case 'world':
      return <PlaceholderScreen title="World map">The world map needs a client content endpoint and the client-kit map.</PlaceholderScreen>;
    case 'expeditions':
      return <PlaceholderScreen title="Expeditions">Expedition setup and progress arrive with expedition hosting.</PlaceholderScreen>;
  }
}
