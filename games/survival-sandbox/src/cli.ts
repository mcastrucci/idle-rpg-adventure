/**
 * Sandbox CLI: simulate one scavenging run and print the placed timeline, progressive reveal, settlement and an
 * estimate. Runs directly on Node ≥ 22.18 (built-in type stripping), no build step:
 *
 *   pnpm --filter @survival/sandbox exec node src/cli.ts --district old_market --hours 3 --seed 42
 *
 * Options: --district old_market|rail_yard, --hours 1|2|3, --seed <uint32>, --members <n>, --condition <1..100>,
 * --carry <n>, --food <n>, --water <n>, --medkits <n>, --pace <bp>, --runs <n>, --fresh 1 (district not completed).
 * The wall clock is simulated: the run starts at t = 0 (no `Date`, ADR-0004).
 */
import { netDeltas } from '@engine/economy';
import type { LedgerDelta } from '@engine/economy';
import { cancelCutoff, checkStart, estimate, placeSegments, settleWithEscrow, visibleView } from '@engine/expedition-kernel';
import { BP_SCALE, mulDivFloor } from '@engine/sim-core';
import { computeWorldView } from '@engine/world';

import { SCAVENGE_ACTIVITY_ID, createScavengeSimulator, survivalActivities } from './scavenge.ts';
import type { ScavengeEvent, SurvivorGroup } from './scavenge.ts';
import { loadWorld, survivalContext, survivalRegistry } from './world.ts';

const MS_PER_MIN = 60_000;

function parseArgs(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    out.set(arg.slice(2), value);
    i++;
  }
  return out;
}

function intArg(args: Map<string, string>, name: string, fallback: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new Error(`--${name} must be an integer`);
  return Number(raw);
}

function clock(ms: number): string {
  const totalMin = mulDivFloor(ms, 1, MS_PER_MIN);
  const h = mulDivFloor(totalMin, 1, 60);
  const m = totalMin - h * 60;
  return `+${h}h${String(m).padStart(2, '0')}m`;
}

function describe(e: ScavengeEvent): string {
  switch (e.type) {
    case 'consumed':
      return `ate ${e.food} / drank ${e.water}`;
    case 'found':
      return e.kept === e.qty ? `found ${e.qty} ${e.item}` : `found ${e.qty} ${e.item} (kept ${e.kept})`;
    case 'infection':
      return `infection -${e.damage} (cond ${e.conditionAfter})`;
    case 'threat':
      return `${e.threat} -${e.damage} (cond ${e.conditionAfter})`;
    case 'medkit':
      return `medkit +${e.healed} (cond ${e.conditionAfter})`;
    case 'down':
      return `DOWN (${e.cause})`;
    case 'retreat':
      return `retreat (${e.reason})`;
  }
}

function formatDeltas(deltas: readonly LedgerDelta[]): string[] {
  return netDeltas(deltas).map((d) => {
    const asset = d.asset.kind === 'stack' ? d.asset.item : d.asset.kind === 'currency' ? d.asset.currency : d.asset.itemId;
    return `    ${d.actorId}  ${asset.padEnd(18)} ${String(d.qty).padStart(4)}  @ ${d.container ?? '(default)'}`;
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const district = `area:${args.get('district') ?? 'old_market'}`;
  const hours = intArg(args, 'hours', 3);
  const seed = intArg(args, 'seed', 42);
  const members = intArg(args, 'members', 3);
  const paceBp = intArg(args, 'pace', BP_SCALE);
  const runs = intArg(args, 'runs', 500);

  // World: validate content and show what this group can reach.
  const registry = survivalRegistry();
  const world = loadWorld(registry);
  const view = computeWorldView(world, survivalContext({}, []), registry);
  console.log(`World: ${world.areas.length} areas, ${world.routes.length} routes, ${world.locations.length} locations (valid)`);
  for (const a of view.areas) console.log(`  ${a.id.padEnd(18)} ${a.visibility}${a.reasons.length > 0 ? ` (${a.reasons.join(', ')})` : ''}`);

  const simulator = createScavengeSimulator();
  const durationMin = hours * 60;
  const config = simulator.parseConfig({
    district,
    supplies: {
      food: intArg(args, 'food', members * hours),
      water: intArg(args, 'water', members * hours),
      medkits: intArg(args, 'medkits', 1),
    },
  });
  const actors: SurvivorGroup[] = [
    { actorId: 'group:alpha', members, condition: intArg(args, 'condition', 100), carryCapacity: intArg(args, 'carry', 12) },
  ];
  // Engine start gates (area, activity, completion — the group is assumed to have completed the district unless
  // --fresh 1 is passed) and then the simulator's own canStart.
  const fresh = intArg(args, 'fresh', 0) === 1;
  const ctx = survivalContext(fresh ? {} : { completedAreas: [config.district] }, []);
  const gate = checkStart({
    world,
    request: { areaId: config.district, activityId: SCAVENGE_ACTIVITY_ID, durationMin, paceBp },
    activities: survivalActivities(simulator),
    simulator,
    config,
    actors,
    evalContexts: actors.map(() => ctx),
    predicates: registry,
  });
  if (!gate.ok) {
    const why = [gate.message, ...(gate.reasons ?? [])].filter((x) => x !== undefined).join('; ');
    throw new Error(`cannot start: ${gate.code}${why === '' ? '' : ` (${why})`}`);
  }
  const { budget } = gate;
  console.log('\nEscrow at start:');
  for (const line of formatDeltas(gate.escrow)) console.log(line);
  console.log(`\nRun: ${simulator.id}@${simulator.version} ${JSON.stringify(config)} seed=${seed} budget=${budget}h pace=${paceBp}bp`);

  // Simulate and place on a simulated wall clock starting at t = 0.
  const timeline = simulator.simulate({ config, actors, seed, budget });
  const durationMs = durationMin * MS_PER_MIN;
  const placed = placeSegments(timeline, 0, durationMs, budget);
  console.log(`\nTimeline (server view): outcome=${placed.outcome}, ends ${clock(placed.endsAtMs)} (planned ${clock(placed.plannedEndsAtMs)})`);
  for (const s of placed.segments) {
    console.log(`  hour ${s.index} @${clock(s.revealAtMs)}: ${s.events.map(describe).join('; ')}`);
  }

  // Progressive reveal (client view).
  console.log('\nReveal (client view):');
  const times = [0, 1, 2, 3, 4].map((q) => mulDivFloor(durationMs, q, 4));
  if (placed.endsAtMs < durationMs) times.push(placed.endsAtMs - 1, placed.endsAtMs);
  for (const now of [...new Set(times)].sort((a, b) => a - b)) {
    const v = visibleView(placed, now);
    const tail = v.ended ? `ended at ${clock(v.endedAtMs ?? 0)}, outcome=${v.outcome ?? '?'}` : `in progress, planned end ${clock(v.plannedEndsAtMs)}`;
    console.log(`  at ${clock(now)}: ${v.segments.length} hour(s) revealed, ${tail}`);
  }

  // Settlement.
  const last = timeline.segments.length - 1;
  console.log(`\nSettlement (natural end, outcome ${timeline.outcome}; incl. escrow returns):`);
  for (const line of formatDeltas(settleWithEscrow(simulator, timeline, last, 'completed', config, actors).deltas)) console.log(line);
  const cancelAt = mulDivFloor(durationMs, 1, 2);
  const cutoff = cancelCutoff(placed, cancelAt);
  console.log(`Settlement if cancelled at ${clock(cancelAt)} (cutoff ${cutoff}):`);
  for (const line of formatDeltas(settleWithEscrow(simulator, timeline, cutoff, 'cancelled', config, actors).deltas)) console.log(line);
  console.log(`\nReport: ${JSON.stringify(simulator.summarize(timeline, last))}`);

  // Estimate.
  const est = estimate(simulator, { config, actors, budget }, runs, seed);
  console.log(`\nEstimate (${est.runs} runs): outcomes ${JSON.stringify(est.outcomes)} rates(bp) ${JSON.stringify(est.outcomeRatesBp)}`);
  for (const a of est.assets) {
    const asset = a.asset.kind === 'stack' ? a.asset.item : JSON.stringify(a.asset);
    console.log(`    ${a.actorId}  ${asset.padEnd(18)} min ${a.min}  p10 ${a.p10}  p50 ${a.p50}  p90 ${a.p90}  max ${a.max}`);
  }
}

main();
