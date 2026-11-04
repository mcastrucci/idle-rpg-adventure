import type { CharacterDto } from '../api/types.ts';
import { levelProgress } from '../character/progression.ts';
import { t, useLocale } from '../i18n/index.ts';
import { LocaleSwitcher } from './LocaleSwitcher.tsx';

/**
 * Sanctuary header. Values are server-provided; gold is still a placeholder because the character DTO has no balance.
 * The expedition chip reflects the character's activity state. The XP bar uses the client's mirror of the content XP
 * curve (no content endpoint yet) and stays empty if the server's level does not fit it.
 */
export function Header({ character }: { character: CharacterDto | null }) {
  useLocale();
  const onLive = character?.activityState === 'live';
  const onExpedition = character?.activityState === 'expedition';
  const progress = character ? levelProgress(character.level, character.xp) : null;
  return (
    <header className="header">
      <div className="header__identity">
        <span className="header__level" aria-label={character ? t('ui.header.level_label', { level: character.level }) : t('ui.header.level_unknown')}>
          {t('ui.header.level_short', { level: character?.level ?? '–' })}
        </span>
        <span className="header__name">{character?.name ?? t('ui.header.no_character')}</span>
      </div>
      <div className="header__xp">
        <span className="header__label">
          {progress?.xpToNext != null
            ? t('ui.header.xp_next', { xp: character?.xp ?? '–', next: progress.xpToNext })
            : t('ui.header.xp', { xp: character?.xp ?? '–' })}
        </span>
        <div className="header__bar" role="presentation">
          <div className="header__bar-fill" style={progress ? { width: `${progress.progressBp / 100}%` } : undefined} />
        </div>
      </div>
      <div className="header__tools">
        <span className="header__gold" title={t('ui.header.gold_hint')}>
          <span className="visually-hidden">{t('ui.header.gold')}</span>
          <span aria-hidden="true" className="header__coin" />
          —
        </span>
        <LocaleSwitcher />
      </div>
      <span className={`chip${onExpedition || onLive ? ' chip--active' : ''}`}>
        {onLive ? t('ui.header.chip_live') : onExpedition ? t('ui.header.chip_expedition') : t('ui.header.chip_idle')}
      </span>
    </header>
  );
}
