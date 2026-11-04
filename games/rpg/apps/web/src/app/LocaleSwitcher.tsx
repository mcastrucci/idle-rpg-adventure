import { LOCALES, setLocale, t, useLocale } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';

/** Native names, never translated: a player must be able to find their own language. */
const NATIVE_NAMES: Readonly<Record<Locale, { readonly short: string; readonly name: string }>> = {
  es: { short: 'ES', name: 'Español' },
  en: { short: 'EN', name: 'English' },
};

/** Two-button language switch; the choice is remembered on this device and updates `<html lang>`. */
export function LocaleSwitcher() {
  const active = useLocale();
  return (
    <div className="locale-switch" role="group" aria-label={t('ui.locale.label')}>
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          className="locale-switch__option"
          lang={locale}
          aria-label={NATIVE_NAMES[locale].name}
          aria-pressed={locale === active}
          onClick={() => setLocale(locale)}
        >
          {NATIVE_NAMES[locale].short}
        </button>
      ))}
    </div>
  );
}
