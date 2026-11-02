import type { CharacterDto } from '../api/types.ts';
import { levelProgress } from '../character/progression.ts';

/**
 * Sanctuary header. Values are server-provided; placeholders mark data the server does not expose yet:
 * gold needs the ledger, the chip needs expedition hosting. The XP bar uses the client's mirror of the content XP
 * curve (no content endpoint yet) and stays empty if the server's level does not fit it.
 */
export function Header({ character }: { character: CharacterDto | null }) {
  const onExpedition = character?.activityState === 'expedition';
  const progress = character ? levelProgress(character.level, character.xp) : null;
  return (
    <header className="header">
      <div className="header__identity">
        <span className="header__level" aria-label={character ? `Level ${character.level}` : 'Level unknown'}>
          Lv {character?.level ?? '–'}
        </span>
        <span className="header__name">{character?.name ?? 'No character'}</span>
      </div>
      <div className="header__xp">
        <span className="header__label">
          XP {character?.xp ?? '–'}{progress?.xpToNext != null ? ` / ${progress.xpToNext}` : ''}
        </span>
        <div className="header__bar" role="presentation">
          <div className="header__bar-fill" style={progress ? { width: `${progress.progressBp / 100}%` } : undefined} />
        </div>
      </div>
      <span className="header__gold" title="Gold arrives with the ledger">
        <span className="visually-hidden">Gold: </span>
        <span aria-hidden="true" className="header__coin" />
        —
      </span>
      <span className={`chip${onExpedition ? ' chip--active' : ''}`}>
        {onExpedition ? 'On expedition' : 'No expedition'}
      </span>
    </header>
  );
}
