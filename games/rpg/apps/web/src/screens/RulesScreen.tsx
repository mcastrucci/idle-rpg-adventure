import { MAX_AUTOMATION_RULES } from '@rpg/rpg-schema';
import type { AutomationRule, ItemId, SkillId, TargetSelector } from '@rpg/rpg-schema';
import type { CommandJson } from '@rpg/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CommandUnconfirmedError, configureCharacterCommand } from '../api/commands.ts';
import type { CommandRequest } from '../api/commands.ts';
import type { CharacterDto } from '../api/types.ts';
import { describeError } from '../app/useGameSession.ts';
import { ID_LABELS } from '../content/labels.ts';
import type { ContentLabels } from '../content/labels.ts';
import { BASIC_ATTACK, CONDITION_KEYS, ruleContext, targetOptions } from '../rules/catalog.ts';
import type { ConditionKey, RuleContext } from '../rules/catalog.ts';
import { conditionChips, describeAction, describeRule, formatBp, TARGET_PHRASES } from '../rules/describe.ts';
import {
  addRule, canAdd, clearCondition, defaultConditionValue, moveRule, removeRule, replaceRule, setActionConsumable, setActionKind,
  setActionSkill, setActionTarget, setCondition, toDraft, toRules,
} from '../rules/draft.ts';
import type { DraftRule } from '../rules/draft.ts';
import { PRESETS, presetRules, presetUnavailableReason } from '../rules/presets.ts';
import { validateRules } from '../rules/validate.ts';
import type { RuleIssue } from '../rules/validate.ts';

interface Props {
  readonly character: CharacterDto;
  readonly canCommand: boolean;
  readonly runCharacterCommand: (request: CommandRequest<CharacterDto>) => Promise<void>;
  readonly labels?: ContentLabels;
  /** Injected in tests for a predictable command_id. */
  readonly newCommandId?: () => string;
}

const CONDITION_NAMES: Readonly<Record<ConditionKey, string>> = {
  selfHpBelowBp: 'My HP below',
  allyHpBelowBp: "An ally's HP below",
  selfHasHarmfulEffect: 'I have a harmful effect',
  enemyTelegraphing: 'An enemy is winding up',
  skillReady: 'Skill is ready',
  enemiesAtLeast: 'Enemies at least',
  hasConsumable: 'Carrying',
};

const PERCENT_STEPS_BP = Array.from({ length: 19 }, (_, i) => (i + 1) * 500);
const ENEMY_COUNTS = [1, 2, 3, 4, 5, 6];

/** Key-order-insensitive JSON (PostgreSQL `jsonb` reorders object keys). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function serverMessage(code: string): string {
  switch (code) {
    case 'invalid_configuration': return 'The server rejected these rules (invalid_configuration): a skill or item is not available to this character.';
    case 'invalid_command': return 'The server could not read these rules (invalid_command).';
    case 'busy': return 'Rules can only be changed while the character is in the Sanctuary (busy).';
    case 'not_found': return 'This character no longer exists (not_found).';
    default: return `Could not save the rules (${code}).`;
  }
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Ensures `value` is offered by a picker even if it is not in the usual options (e.g. a server-saved 35.5%). */
function withCurrent<T>(options: readonly T[], current: T | undefined): readonly T[] {
  return current === undefined || options.includes(current) ? options : [...options, current];
}

export function RulesScreen({ character, canCommand, runCharacterCommand, labels = ID_LABELS, newCommandId }: Props) {
  const context = useMemo(() => ruleContext(character.skillLoadout, character.automationRules), [character.skillLoadout, character.automationRules]);
  const nextKey = useRef(character.automationRules.length);
  const [drafts, setDrafts] = useState<DraftRule[]>(() => toDraft(character.automationRules));
  const [syncedVersion, setSyncedVersion] = useState(character.version);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<CommandRequest<CharacterDto> | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const controls = useRef(new Map<string, HTMLElement>());

  // Reflect server state: a new character version (our save, or any other change) replaces the draft.
  if (character.version !== syncedVersion) {
    setSyncedVersion(character.version);
    setDrafts(toDraft(character.automationRules, nextKey.current));
    nextKey.current += character.automationRules.length;
    setExpanded(null);
  }

  useEffect(() => {
    if (focusTarget === null) return;
    controls.current.get(focusTarget)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const register = (id: string) => (element: HTMLElement | null) => {
    if (element) controls.current.set(id, element);
    else controls.current.delete(id);
  };

  const rules = toRules(drafts);
  const validation = validateRules(rules, context, labels);
  const issues: readonly RuleIssue[] = validation.ok ? [] : validation.issues;
  const dirty = canonical(rules) !== canonical(character.automationRules);
  const locked = pending || unconfirmed !== null;
  const canSave = canCommand && !pending && (unconfirmed !== null || (dirty && validation.ok));

  function edit(next: DraftRule[], message?: string) {
    setDrafts(next);
    setError(null);
    if (message) setAnnouncement(message);
  }

  function onMove(index: number, delta: -1 | 1) {
    const draft = drafts[index];
    if (!draft) return;
    const target = index + delta;
    edit(moveRule(drafts, index, delta), `Rule moved to position ${target + 1}.`);
    const atEdge = target === 0 || target === drafts.length - 1;
    const direction = delta === -1 ? 'up' : 'down';
    setFocusTarget(`${draft.key}:${atEdge ? (direction === 'up' ? 'down' : 'up') : direction}`);
  }

  function onAdd() {
    const key = nextKey.current++;
    edit(addRule(drafts, key), `Rule ${drafts.length + 1} added.`);
    setExpanded(key);
    setFocusTarget(`${key}:action-kind`);
  }

  function onRemove(index: number) {
    edit(removeRule(drafts, index), `Rule ${index + 1} removed.`);
    setFocusTarget('add-rule');
  }

  function onPreset(id: string) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const base = nextKey.current;
    nextKey.current += preset.rules.length;
    edit(toDraft(presetRules(preset), base), `${preset.name} preset loaded. Review it, then save.`);
    setExpanded(null);
  }

  function onDiscard() {
    edit(toDraft(character.automationRules, nextKey.current), 'Changes discarded.');
    nextKey.current += character.automationRules.length;
    setExpanded(null);
  }

  async function onSave() {
    let request = unconfirmed;
    if (request === null) {
      if (!validation.ok) return;
      request = configureCharacterCommand(character.actorId, { automationRules: validation.rules as unknown as CommandJson }, newCommandId);
    }
    setPending(true);
    setError(null);
    try {
      await runCharacterCommand(request);
      setUnconfirmed(null);
      setAnnouncement('Rules saved.');
    } catch (failure) {
      if (failure instanceof CommandUnconfirmedError) {
        setUnconfirmed(request);
        setError('The save could not be confirmed. Retry sends the same command, so it is never applied twice.');
      } else {
        setUnconfirmed(null);
        setError(serverMessage(describeError(failure)));
      }
    } finally {
      setPending(false);
    }
  }

  const listIssues = issues.filter((issue) => issue.index === null);
  let status: string;
  if (!canCommand) status = 'Waiting for the connection…';
  else if (pending) status = 'Saving…';
  else if (unconfirmed) status = 'Save not confirmed.';
  else if (issues.length > 0) status = `${issues.length} ${issues.length === 1 ? 'problem' : 'problems'} to fix before saving.`;
  else if (dirty) status = 'Unsaved changes.';
  else status = 'All changes saved.';

  return (
    <section className="screen rules" aria-labelledby="rules-title">
      <a className="back-link" href="#/character">‹ Character</a>
      <h1 id="rules-title" className="screen__title">Automation rules</h1>
      <p className="muted">
        Checked top to bottom whenever you are ready to act; the first rule whose conditions all hold fires. Up to{' '}
        {MAX_AUTOMATION_RULES} rules.
      </p>

      <section aria-labelledby="presets-title" className="presets">
        <h2 id="presets-title" className="screen__subtitle">Presets</h2>
        <div className="presets__list">
          {PRESETS.map((preset) => {
            const reason = presetUnavailableReason(preset, context, labels);
            const reasonId = `preset-${preset.id}-reason`;
            return (
              <div key={preset.id} className="preset">
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={locked || reason !== null}
                  aria-describedby={reasonId}
                  onClick={() => onPreset(preset.id)}
                >
                  Use {preset.name}
                </button>
                <p id={reasonId} className="preset__note muted">{reason ?? preset.blurb}</p>
              </div>
            );
          })}
        </div>
      </section>

      <h2 className="screen__subtitle" id="rule-list-title">Rules ({drafts.length}/{MAX_AUTOMATION_RULES})</h2>
      {drafts.length === 0 && <p className="muted">No rules: the character will only use basic attacks.</p>}
      <ol className="rule-list" aria-labelledby="rule-list-title">
        {drafts.map((draft, index) => (
          <RuleCard
            key={draft.key}
            draft={draft}
            index={index}
            count={drafts.length}
            expanded={expanded === draft.key}
            locked={locked}
            context={context}
            labels={labels}
            issues={issues.filter((issue) => issue.index === index)}
            register={register}
            onToggle={() => setExpanded(expanded === draft.key ? null : draft.key)}
            onMove={(delta) => onMove(index, delta)}
            onRemove={() => onRemove(index)}
            onChange={(rule) => edit(replaceRule(drafts, index, rule))}
          />
        ))}
      </ol>
      {listIssues.map((issue) => <p key={issue.message} className="form__error">{issue.message}</p>)}
      <button
        type="button"
        className="button button--secondary"
        ref={register('add-rule')}
        disabled={locked || !canAdd(drafts)}
        onClick={onAdd}
      >
        {canAdd(drafts) ? '+ Add rule' : `Rule limit reached (${MAX_AUTOMATION_RULES})`}
      </button>

      <div className="savebar">
        <p className="savebar__status" role="status">{status}</p>
        {error && <p className="form__error" role="alert">{error}</p>}
        <div className="savebar__actions">
          <button type="button" className="button button--secondary" disabled={locked || !dirty} onClick={onDiscard}>Discard</button>
          <button type="button" className="button" disabled={!canSave} onClick={() => void onSave()}>
            {pending ? 'Saving…' : unconfirmed ? 'Retry save' : 'Save rules'}
          </button>
        </div>
      </div>
      <p className="visually-hidden" aria-live="polite">{announcement}</p>
    </section>
  );
}

interface CardProps {
  readonly draft: DraftRule;
  readonly index: number;
  readonly count: number;
  readonly expanded: boolean;
  readonly locked: boolean;
  readonly context: RuleContext;
  readonly labels: ContentLabels;
  readonly issues: readonly RuleIssue[];
  readonly register: (id: string) => (element: HTMLElement | null) => void;
  readonly onToggle: () => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
  readonly onChange: (rule: AutomationRule) => void;
}

function RuleCard({ draft, index, count, expanded, locked, context, labels, issues, register, onToggle, onMove, onRemove, onChange }: CardProps) {
  const { rule, key } = draft;
  const n = index + 1;
  const chips = conditionChips(rule.when, labels);
  const editorId = `rule-${key}-editor`;
  return (
    <li className={`rule-card${issues.length > 0 ? ' rule-card--invalid' : ''}`} aria-label={`Rule ${n}`}>
      <div className="rule-card__head">
        <span className="rule-card__index" aria-hidden="true">{n}</span>
        <p className="rule-card__summary">{describeRule(rule, labels)}</p>
      </div>
      <div className="rule-card__chips" aria-hidden="true">
        {chips.length === 0 ? <span className="rule-chip">Always</span> : chips.map((chip) => <span key={chip.key} className="rule-chip">{chip.label}</span>)}
        <span className="rule-card__arrow">→</span>
        <span className="rule-chip rule-chip--action">{capitalize(describeAction(rule.do, labels))}</span>
      </div>
      {issues.map((issue) => <p key={issue.message} className="form__error">⚠ {issue.message}</p>)}
      <div className="rule-card__toolbar">
        <button type="button" className="icon-button" ref={register(`${key}:up`)} disabled={locked || index === 0}
          aria-label={`Move rule ${n} up`} onClick={() => onMove(-1)}>▲</button>
        <button type="button" className="icon-button" ref={register(`${key}:down`)} disabled={locked || index === count - 1}
          aria-label={`Move rule ${n} down`} onClick={() => onMove(1)}>▼</button>
        <button type="button" className="text-button" aria-expanded={expanded} aria-controls={editorId}
          aria-label={`Edit rule ${n}`} onClick={onToggle}>{expanded ? 'Done' : 'Edit'}</button>
        <button type="button" className="text-button text-button--danger" disabled={locked}
          aria-label={`Remove rule ${n}`} onClick={onRemove}>Remove</button>
      </div>
      {expanded && (
        <div id={editorId} className="rule-editor">
          <ConditionsEditor rule={rule} n={n} locked={locked} context={context} labels={labels} onChange={onChange} />
          <ActionEditor rule={rule} n={n} ruleKey={key} locked={locked} context={context} labels={labels} register={register} onChange={onChange} />
        </div>
      )}
    </li>
  );
}

interface EditorProps {
  readonly rule: AutomationRule;
  readonly n: number;
  readonly locked: boolean;
  readonly context: RuleContext;
  readonly labels: ContentLabels;
  readonly onChange: (rule: AutomationRule) => void;
}

function ConditionsEditor({ rule, n, locked, context, labels, onChange }: EditorProps) {
  const present = CONDITION_KEYS.filter((key) => rule.when[key] !== undefined);
  const missing = CONDITION_KEYS.filter((key) => rule.when[key] === undefined);

  function add(key: ConditionKey) {
    const value = defaultConditionValue(key, rule, context);
    if (value !== null) onChange(setCondition(rule, key, value as never));
  }

  return (
    <fieldset className="rule-editor__group" disabled={locked}>
      <legend>When (all must hold)</legend>
      {present.length === 0 && <p className="muted">No conditions: this rule always matches.</p>}
      {present.map((key) => {
        const id = `rule-${n}-${key}`;
        return (
          <div key={key} className="cond-row">
            <label htmlFor={id} className="cond-row__label">{CONDITION_NAMES[key]}</label>
            <ConditionValue id={id} conditionKey={key} rule={rule} context={context} labels={labels} onChange={onChange} />
            <button type="button" className="icon-button" aria-label={`Remove condition “${CONDITION_NAMES[key]}” from rule ${n}`}
              onClick={() => onChange(clearCondition(rule, key))}>✕</button>
          </div>
        );
      })}
      {missing.length > 0 && (
        <select className="form__input" aria-label={`Add condition to rule ${n}`} value=""
          onChange={(event) => add(event.target.value as ConditionKey)}>
          <option value="">+ Add condition…</option>
          {missing.map((key) => (
            <option key={key} value={key} disabled={defaultConditionValue(key, rule, context) === null}>{CONDITION_NAMES[key]}</option>
          ))}
        </select>
      )}
    </fieldset>
  );
}

function ConditionValue({ id, conditionKey, rule, context, labels, onChange }: {
  id: string; conditionKey: ConditionKey; rule: AutomationRule; context: RuleContext; labels: ContentLabels; onChange: (rule: AutomationRule) => void;
}) {
  const when = rule.when;
  switch (conditionKey) {
    case 'selfHpBelowBp':
    case 'allyHpBelowBp': {
      const value = when[conditionKey];
      return (
        <select id={id} className="form__input" value={value}
          onChange={(event) => onChange(setCondition(rule, conditionKey, Number(event.target.value)))}>
          {withCurrent(PERCENT_STEPS_BP, value).map((bp) => <option key={bp} value={bp}>{formatBp(bp)}</option>)}
        </select>
      );
    }
    case 'enemiesAtLeast': {
      const value = when.enemiesAtLeast;
      return (
        <select id={id} className="form__input" value={value}
          onChange={(event) => onChange(setCondition(rule, 'enemiesAtLeast', Number(event.target.value)))}>
          {withCurrent(ENEMY_COUNTS, value).map((count) => <option key={count} value={count}>{count}</option>)}
        </select>
      );
    }
    case 'skillReady': {
      const value = when.skillReady;
      return (
        <select id={id} className="form__input" value={value}
          onChange={(event) => onChange(setCondition(rule, 'skillReady', event.target.value as SkillId))}>
          {withCurrent(context.loadout, value).map((skill) => (
            <option key={skill} value={skill}>{labels.skill(skill)}{context.equippedSkills.includes(skill) ? '' : ' (not equipped)'}</option>
          ))}
        </select>
      );
    }
    case 'hasConsumable': {
      const value = when.hasConsumable;
      return (
        <select id={id} className="form__input" value={value}
          onChange={(event) => onChange(setCondition(rule, 'hasConsumable', event.target.value as ItemId))}>
          {withCurrent(context.consumables, value).map((item) => <option key={item} value={item}>{labels.item(item)}</option>)}
        </select>
      );
    }
    case 'selfHasHarmfulEffect':
    case 'enemyTelegraphing':
      return <output id={id} className="cond-row__flag">Yes</output>;
  }
}

function ActionEditor({ rule, n, ruleKey, locked, context, labels, register, onChange }: EditorProps & {
  ruleKey: number; register: CardProps['register'];
}) {
  const action = rule.do;
  const kind = 'useSkill' in action ? 'skill' : 'consumable';
  const targeting = 'useSkill' in action ? context.targetingOf(action.useSkill) : undefined;
  const targets = 'useSkill' in action ? withCurrent(targetOptions(targeting), action.target) : [];
  const defaultTarget = targeting === 'enemy' ? ' (lowest HP enemy)' : targeting === 'ally' ? ' (lowest HP ally)' : '';
  return (
    <fieldset className="rule-editor__group" disabled={locked}>
      <legend>Then</legend>
      <label className="cond-row__label" htmlFor={`rule-${n}-kind`}>Action</label>
      <select id={`rule-${n}-kind`} className="form__input" value={kind} ref={register(`${ruleKey}:action-kind`)}
        onChange={(event) => onChange(setActionKind(rule, event.target.value as 'skill' | 'consumable', context))}>
        <option value="skill">Use a skill</option>
        <option value="consumable" disabled={context.consumables.length === 0}>Use a consumable</option>
      </select>
      {'useSkill' in action ? (
        <>
          <label className="cond-row__label" htmlFor={`rule-${n}-skill`}>Skill</label>
          <select id={`rule-${n}-skill`} className="form__input" value={action.useSkill}
            onChange={(event) => onChange(setActionSkill(rule, event.target.value as SkillId, context))}>
            {withCurrent(context.equippedSkills, action.useSkill).map((skill) => (
              <option key={skill} value={skill}>
                {labels.skill(skill)}{skill === BASIC_ATTACK ? ' (always equipped)' : context.equippedSkills.includes(skill) ? '' : ' (not equipped)'}
              </option>
            ))}
          </select>
          {targets.length > 0 && (
            <>
              <label className="cond-row__label" htmlFor={`rule-${n}-target`}>Target</label>
              <select id={`rule-${n}-target`} className="form__input" value={action.target ?? ''}
                onChange={(event) => onChange(setActionTarget(rule, event.target.value === '' ? undefined : event.target.value as TargetSelector))}>
                <option value="">Default{defaultTarget}</option>
                {targets.map((target) => <option key={target} value={target}>{TARGET_PHRASES[target]}</option>)}
              </select>
            </>
          )}
        </>
      ) : (
        <>
          <label className="cond-row__label" htmlFor={`rule-${n}-item`}>Consumable</label>
          <select id={`rule-${n}-item`} className="form__input" value={action.useConsumable}
            onChange={(event) => onChange(setActionConsumable(rule, event.target.value as ItemId))}>
            {withCurrent(context.consumables, action.useConsumable).map((item) => <option key={item} value={item}>{labels.item(item)}</option>)}
          </select>
        </>
      )}
    </fieldset>
  );
}
