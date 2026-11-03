import { useEffect } from 'react';

import { CharacterScreen } from '../screens/CharacterScreen.tsx';
import { ExpeditionScreen } from '../screens/ExpeditionScreen.tsx';
import { InventoryScreen } from '../screens/InventoryScreen.tsx';
import { LiveScreen } from '../screens/LiveScreen.tsx';
import { PlaceholderScreen } from '../screens/Placeholder.tsx';
import { RulesScreen } from '../screens/RulesScreen.tsx';
import { WorldMapScreen } from '../screens/WorldMapScreen.tsx';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { Header } from './Header.tsx';
import type { AppServices } from './services.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { ApiClient } from '../api/http.ts';
import { useLiveState } from './services.ts';
import { TabBar } from './TabBar.tsx';
import type { TabId } from './tabs.ts';
import { useHashSubroute, useHashTab } from './tabs.ts';
import { useGameSession } from './useGameSession.ts';

export function App({ services }: { services: AppServices }) {
  const { live } = services;
  const liveState = useLiveState(live);
  const [tab, selectTab] = useHashTab();
  const { state, retry, runCharacterCommand, runExpeditionCommand, refreshCharacter, dismissExpeditionNotice } = useGameSession(services);
  const subroute = useHashSubroute();

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
      {state.phase === 'ready' && state.expeditionNotice && <div className="expedition-toast" role="status" aria-live="polite">
        <span>{state.expeditionNotice}</span><button type="button" aria-label="Dismiss expedition update" onClick={dismissExpeditionNotice}>Dismiss</button>
      </div>}
      <main className="content" id="content">
        {state.phase === 'loading' && <p className="muted" role="status">Signing in…</p>}
        {state.phase === 'error' && (
          <div className="screen" role="alert">
            <p>Could not reach the server ({state.error}).</p>
            <button type="button" className="button" onClick={retry}>Try again</button>
          </div>
        )}
        {state.phase === 'ready' && <>
          <Screen tab={tab} character={character} canCommand={canCommand} run={runCharacterCommand} live={live}
            subroute={subroute} api={services.api} runExpedition={runExpeditionCommand} refreshCharacter={refreshCharacter} />
          <WorldTab visible={tab === 'world'} subroute={subroute} character={character} canCommand={canCommand} api={services.api}
            live={live} refreshCharacter={refreshCharacter} />
        </>}
      </main>
      <TabBar active={tab} onSelect={selectTab} />
    </div>
  );
}

function Screen({ tab, subroute, character, canCommand, run, api, live, runExpedition, refreshCharacter }: {
  tab: TabId;
  subroute: string | null;
  character: Parameters<typeof CharacterScreen>[0]['character'];
  canCommand: boolean;
  run: Parameters<typeof CharacterScreen>[0]['runCharacterCommand'];
  api: ApiClient;
  live: AppServices['live'];
  runExpedition: <T,>(request: CommandRequest<T>) => Promise<T>;
  refreshCharacter: () => Promise<void>;
}) {
  switch (tab) {
    case 'character':
      if (subroute === 'rules' && character) return <RulesScreen character={character} canCommand={canCommand} runCharacterCommand={run} />;
      return <CharacterScreen character={character} canCommand={canCommand} runCharacterCommand={run} api={api} live={live} />;
    case 'inventory':
      return <InventoryScreen character={character} canCommand={canCommand} api={api} runCommand={runExpedition} refreshCharacter={refreshCharacter} />;
    case 'world':
      return null;
    case 'expeditions':
      return <ExpeditionScreen character={character} canCommand={canCommand} api={api} runCommand={runExpedition} refreshCharacter={refreshCharacter}
        initialAreaId={decodeRoutePart(subroute)} />;
  }
}

/** Keep the live session mounted while navigating between the map and adventure subroutes or other tabs. */
function WorldTab({ visible, subroute, character, canCommand, api, live, refreshCharacter }: {
  visible: boolean;
  subroute: string | null;
  character: Parameters<typeof CharacterScreen>[0]['character'];
  canCommand: boolean;
  api: ApiClient;
  live: AppServices['live'];
  refreshCharacter: () => Promise<void>;
}) {
  const route = subroute?.split('/') ?? [];
  const inLive = route[0] === 'live';
  const liveAreaId = inLive ? decodeRoutePart(route[1] ?? null) : undefined;
  if (!character) return <div hidden={!visible} inert={!visible}><PlaceholderScreen title="World map">Create your character before exploring Sanctuary’s portals.</PlaceholderScreen></div>;
  return <div className="world-tab" hidden={!visible} inert={!visible}>
    <div hidden={inLive} inert={inLive}>
      <WorldMapScreen actorId={character.actorId} characterLevel={character.level} api={api} active={visible && !inLive}
        liveActive={character.activityState === 'live'} idleActive={character.activityState === 'expedition'}
        refreshKey={`${inLive ? 'live' : 'map'}:${character.activityState}:${character.level}`}
        onEnterLive={(areaId) => { window.location.hash = `#/world/live/${encodeURIComponent(areaId)}`; }}
        onStartIdle={(areaId) => { window.location.hash = `#/expeditions/${encodeURIComponent(areaId)}`; }} />
    </div>
    <div hidden={!inLive} inert={!inLive}>
      <LiveScreen actorId={character.actorId} initialAreaId={liveAreaId} api={api} live={live} canCommand={canCommand} onCharacterRefresh={refreshCharacter} />
    </div>
  </div>;
}

function decodeRoutePart(value: string | null): string | undefined {
  if (!value) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}
