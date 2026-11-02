import type { CharacterDto } from '../api/types.ts';

/**
 * Sanctuary header. Values are server-provided; placeholders mark data the server does not expose yet:
 * gold needs the ledger, the XP bar needs the XP curve (content endpoint), the chip needs expedition hosting.
 */
export function Header({ character }: { character: CharacterDto | null }) {
  const onExpedition = character?.activityState === 'expedition';
  return (
    <header className="header">
      <div className="header__identity">
        <span className="header__level" aria-label={character ? `Level ${character.level}` : 'Level unknown'}>
          Lv {character?.level ?? '–'}
        </span>
        <span className="header__name">{character?.name ?? 'No character'}</span>
      </div>
      <div className="header__xp" title="XP to next level is not exposed by the server yet">
        <span className="header__label">XP {character?.xp ?? '–'}</span>
        <div className="header__bar" role="presentation"><div className="header__bar-fill" /></div>
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
