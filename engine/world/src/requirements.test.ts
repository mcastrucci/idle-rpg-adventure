import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PredicateRegistry } from './registry.ts';
import { describeRequirement, evaluateRequirement } from './requirements.ts';
import { RequirementSchema, type Requirement } from './schemas.ts';
import { BOSS, R1, r1, rpgCtx, rpgRegistry, survivalCtx, survivalRegistry } from './testing/fixtures.ts';

const registry = rpgRegistry();
const evaluate = (req: Requirement, ctx = rpgCtx()) => evaluateRequirement(req, ctx, registry);

describe('engine predicates', () => {
  it('discovered', () => {
    const req = { discovered: r1(3) } as const;
    expect(evaluate(req)).toEqual({ ok: false, reasons: [`requires.discovered:${r1(3)}`] });
    expect(evaluate(req, rpgCtx({ discovered: { [R1]: [r1(3)] } })).ok).toBe(true);
  });

  it('areaCompleted', () => {
    const req = { areaCompleted: R1 } as const;
    expect(evaluate(req)).toEqual({ ok: false, reasons: [`requires.areaCompleted:${R1}`] });
    expect(evaluate(req, rpgCtx({ completedAreas: [R1] })).ok).toBe(true);
  });

  it('flag', () => {
    expect(evaluate({ flag: 'met_guide' })).toEqual({ ok: false, reasons: ['requires.flag:met_guide'] });
    expect(evaluate({ flag: 'met_guide' }, rpgCtx({ flags: ['met_guide'] })).ok).toBe(true);
  });

  it('hasItem', () => {
    const req = { hasItem: { item: 'item:key', qty: 2 } };
    expect(evaluate(req, rpgCtx({ items: { 'item:key': 1 } }))).toEqual({ ok: false, reasons: ['requires.hasItem:item:key:2'] });
    expect(evaluate(req, rpgCtx({ items: { 'item:key': 2 } })).ok).toBe(true);
  });
});

describe('composition', () => {
  const a = { flag: 'a' };
  const b = { flag: 'b' };

  it('all fails with every failing reason', () => {
    expect(evaluate({ all: [a, b] })).toEqual({ ok: false, reasons: ['requires.flag:a', 'requires.flag:b'] });
    expect(evaluate({ all: [a, b] }, rpgCtx({ flags: ['a'] }))).toEqual({ ok: false, reasons: ['requires.flag:b'] });
    expect(evaluate({ all: [a, b] }, rpgCtx({ flags: ['a', 'b'] })).ok).toBe(true);
  });

  it('any succeeds with one branch', () => {
    expect(evaluate({ any: [a, b] })).toEqual({ ok: false, reasons: ['requires.flag:a', 'requires.flag:b'] });
    expect(evaluate({ any: [a, b] }, rpgCtx({ flags: ['b'] }))).toEqual({ ok: true, reasons: [] });
  });

  it('not inverts', () => {
    expect(evaluate({ not: a }).ok).toBe(true);
    expect(evaluate({ not: a }, rpgCtx({ flags: ['a'] }))).toEqual({ ok: false, reasons: ['requires.not:flag:a'] });
  });

  it('nests and dedupes reasons', () => {
    const req: Requirement = { all: [a, { any: [a, { not: { flag: 'c' } }] }, { all: [a] }] };
    expect(evaluate(req, rpgCtx({ flags: ['c'] }))).toEqual({
      ok: false,
      reasons: ['requires.flag:a', 'requires.not:flag:c'],
    });
  });

  it('describes requirements canonically', () => {
    expect(describeRequirement({ all: [{ any: [a, { game: 'defeated', enemy: BOSS }] }, { not: { areaCompleted: R1 } }] })).toBe(
      `all(any(flag:a, game.defeated), not(areaCompleted:${R1}))`,
    );
    expect(describeRequirement({ discovered: r1(0) })).toBe(`discovered:${r1(0)}`);
    expect(describeRequirement({ hasItem: { item: 'item:x', qty: 3 } })).toBe('hasItem:item:x:3');
  });
});

describe('game predicates', () => {
  it('evaluates a registered predicate with custom reason', () => {
    const req = { game: 'defeated', enemy: BOSS };
    expect(evaluate(req)).toEqual({ ok: false, reasons: [`requires.game.defeated:${BOSS}`] });
    expect(evaluate(req, rpgCtx({ objectives: [`defeated:${BOSS}`] })).ok).toBe(true);
  });

  it('passes game state and defaults the reason key', () => {
    const req = { game: 'levelAtLeast', level: 5 };
    expect(evaluate(req, rpgCtx({}, 4))).toEqual({ ok: false, reasons: ['requires.game.levelAtLeast'] });
    expect(evaluate(req, rpgCtx({}, 5)).ok).toBe(true);
  });

  it('fails closed on unknown predicates and invalid args', () => {
    expect(evaluate({ game: 'hasTool', tool: 'tool:x' })).toEqual({ ok: false, reasons: ['requires.unknownPredicate:hasTool'] });
    expect(evaluate({ game: 'defeated', enemy: 42 })).toEqual({ ok: false, reasons: ['requires.invalidArgs:defeated'] });
    expect(evaluate({ not: { game: 'defeated' } }).ok).toBe(true);
  });

  it('works with another game registry and context', () => {
    const req = { game: 'hasTool', tool: 'tool:crowbar' };
    expect(evaluateRequirement(req, survivalCtx(), survivalRegistry()).reasons).toEqual(['requires.game.hasTool:tool:crowbar']);
    expect(evaluateRequirement(req, survivalCtx({}, ['tool:crowbar']), survivalRegistry()).ok).toBe(true);
  });

  it('rejects duplicate and malformed registrations', () => {
    const reg = new PredicateRegistry().register('x', { args: z.strictObject({}), evaluate: () => true });
    expect(() => reg.register('x', { args: z.strictObject({}), evaluate: () => true })).toThrow(/already registered/);
    expect(() => reg.register('1bad', { args: z.strictObject({}), evaluate: () => true })).toThrow(/Invalid/);
    expect(reg.names()).toEqual(['x']);
    expect(() => reg.validateArgs('nope', {})).toThrow(/Unknown/);
  });
});

describe('RequirementSchema', () => {
  it('accepts every shape', () => {
    const req = {
      all: [
        { any: [{ flag: 'f' }, { not: { discovered: 'loc:a.b' } }] },
        { areaCompleted: 'area:a' },
        { hasItem: { item: 'item:x', qty: 1 } },
        { game: 'defeated', enemy: BOSS },
      ],
    };
    expect(RequirementSchema.parse(req)).toEqual(req);
  });

  it.each([
    [{ discovered: 'area:a' }],
    [{ areaCompleted: 'loc:a' }],
    [{ flag: 'x', extra: 1 }],
    [{ all: [] }],
    [{ hasItem: { item: 'item:x', qty: 0 } }],
    [{ game: 'bad name' }],
    [{ unknown: 1 }],
  ])('rejects %j', (req) => {
    expect(RequirementSchema.safeParse(req).success).toBe(false);
  });
});
