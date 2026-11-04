import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Header } from '../app/Header.tsx';
import { connectionMessage } from '../app/ConnectionBanner.tsx';
import { TabBar } from '../app/TabBar.tsx';
import type { CharacterDto } from '../api/types.ts';
import { INITIAL_LIVE_STATE } from '../live/state.ts';
import { displayLabel } from '../content/labels.ts';
import { describeRule, formatBp } from '../rules/describe.ts';
import { CharacterScreen } from '../screens/CharacterScreen.tsx';
import { RulesScreen } from '../screens/RulesScreen.tsx';
import { codeText, detectLocale, getLocale, LOCALE_STORAGE_KEY, readStoredLocale, setLocale, t } from './index.ts';

const CHARACTER: CharacterDto = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accountId: 'acc', gameId: 'rpg', name: 'Ada', level: 3, xp: 120,
  attributes: { STR: 9, AGI: 4, INT: 2, VIT: 10, SPI: 5 }, unspentPoints: 2,
  skillLoadout: ['skill:shield_bash', 'skill:guard'],
  automationRules: [{ when: { selfHpBelowBp: 3500 }, do: { useSkill: 'skill:mend', target: 'self' } }],
  activityState: 'none', activityId: null, version: 1,
};

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe('locale selection', () => {
  it('uses the first supported browser language and defaults to Spanish', () => {
    expect(detectLocale(['en-US', 'es'])).toBe('en');
    expect(detectLocale(['fr-FR', 'en-GB'])).toBe('en');
    expect(detectLocale(['es-MX'])).toBe('es');
    expect(detectLocale(['de', 'ja'])).toBe('es');
    expect(detectLocale([])).toBe('es');
    expect(detectLocale(undefined)).toBe('es');
  });

  it('persists the choice per device, updates <html lang>, and survives blocked storage', () => {
    setLocale('es');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('es');
    expect(readStoredLocale()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    setLocale('en');
    expect(document.documentElement.lang).toBe('en');
    expect(readStoredLocale({ getItem: () => { throw new Error('blocked'); } })).toBeNull();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'klingon');
    expect(readStoredLocale()).toBeNull();
  });
});

describe('translation lookup', () => {
  beforeEach(() => { setLocale('es', { persist: false }); });

  it('interpolates and picks Spanish plural forms', () => {
    expect(t('ui.attributes.spend', { count: 1 })).toBe('Gastar 1 punto');
    expect(t('ui.attributes.spend', { count: 3 })).toBe('Gastar 3 puntos');
    setLocale('en', { persist: false });
    expect(t('ui.attributes.spend', { count: 1 })).toBe('Spend 1 point');
    expect(t('ui.attributes.spend', { count: 0 })).toBe('Spend 0 points');
  });

  it('never shows a raw key: unknown keys are humanized', () => {
    expect(t('ui.some.missing_thing')).toBe('Missing thing');
    expect(t('ui.some.missing_thing')).not.toContain('ui.');
  });

  it('localizes server codes and falls back to the code itself', () => {
    expect(codeText('insufficient_funds')).toBe('No hay suficiente oro.');
    expect(codeText('origin_forbidden')).toContain('origen');
    expect(codeText('idle.death.no_consumables')).toBe('No llevaste consumibles de curación.');
    expect(codeText('brand_new_code')).toBe('brand_new_code');
  });

  it('formats percentages with the locale decimal separator', () => {
    expect(formatBp(3505)).toBe('35,05%');
    setLocale('en', { persist: false });
    expect(formatBp(3505)).toBe('35.05%');
  });

  it('humanizes content IDs when no content catalog entry exists', () => {
    expect(displayLabel('item:unknown_thing')).toBe('Unknown Thing');
    expect(displayLabel('item:minor_healing_potion')).toBe('Poción de Curación Menor');
    expect(displayLabel('area.region_1.name')).toBe('La Hondonada Verde');
    setLocale('en', { persist: false });
    expect(displayLabel('area.region_1.name')).toBe('The Verdant Hollow');
  });
});

describe('Spanish rendering', () => {
  beforeEach(() => { setLocale('es', { persist: false }); });

  it('renders the header and tab bar in Spanish', () => {
    render(<><Header character={CHARACTER} /><TabBar active="inventory" onSelect={() => {}} /></>);
    expect(screen.getByText('Nv 3')).toBeDefined();
    expect(screen.getByText('Sin expedición')).toBeDefined();
    const nav = screen.getByRole('navigation', { name: 'Santuario' });
    for (const label of ['Personaje', 'Inventario', 'Mapa del mundo', 'Expediciones']) expect(within(nav).getByText(label)).toBeDefined();
  });

  it('switches language from the header and re-renders', () => {
    render(<Header character={CHARACTER} />);
    expect(getLocale()).toBe('es');
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'English' })); });
    expect(screen.getByText('No expedition')).toBeDefined();
    expect(document.documentElement.lang).toBe('en');
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Español' })); });
    expect(screen.getByText('Sin expedición')).toBeDefined();
  });

  it('renders the character screen with glossary terms', () => {
    render(<CharacterScreen character={CHARACTER} canCommand runCharacterCommand={async () => {}} />);
    expect(screen.getByRole('heading', { name: 'Atributos · 2 de 2 puntos por gastar' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Habilidades equipadas' })).toBeDefined();
    expect(screen.getByRole('heading', { name: /Reglas de automatización \(1\/\d+\)/ })).toBeDefined();
    expect(screen.getByText('En el Santuario: puedes cambiar los atributos, las habilidades equipadas y las reglas.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Añadir un punto a FUE' })).toBeDefined();
    expect(screen.getByText(/Si mi HP está por debajo de 35%, usar Sanar sobre mí mismo\./)).toBeDefined();
  });

  it('renders the rules editor in Spanish', () => {
    render(<RulesScreen character={CHARACTER} canCommand runCharacterCommand={async () => {}} />);
    expect(screen.getByRole('heading', { name: 'Reglas de automatización' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Editar la regla 1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Usar Baluarte' })).toBeDefined();
    expect(screen.getByRole('heading', { name: /^Reglas \(1\/\d+\)$/ })).toBeDefined();
  });

  it('describes rules and connection states in Spanish', () => {
    expect(describeRule({ when: {}, do: { useSkill: 'skill:cleave' } })).toBe('Siempre usar Tajo Amplio.');
    expect(connectionMessage({ ...INITIAL_LIVE_STATE, status: 'reconnecting', retryInMs: 2500, lastCloseCode: null }))
      .toBe('Se perdió la conexión. Reconectando en 3 s…');
  });
});
