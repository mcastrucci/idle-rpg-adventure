import assert from 'node:assert/strict';
import test from 'node:test';

import { assertScenarioBDebugResponse, assertScenarioBEvaluatedWorld, assertRenderedWorldNodeEvidence } from './world-map-touch-guard.mjs';

const actorId = 'actor-123';
const debug = { status: 200, body: { actorId, completedAreas: ['area:region_1'] } };
const worldBody = { hub: { id: 'area:sanctuary', label: 'Sanctuary', position: { x: 0, y: 0 } }, areas: [
  { id: 'area:region_1', label: 'The Verdant Hollow', visibility: 'known', position: { x: 0, y: 100 }, lockedReasons: [],
    completion: { discovered: 8, required: 8, completed: true, mandatoryBosses: { required: 1, defeated: 1, complete: true, bosses: [{ label: 'Boss', defeated: true }] } },
    danger: { status: 'known', minLevel: 1, maxLevel: 5 }, idle: { unlocked: true, activities: ['idle:region_1.hunt'] },
    actions: { enterLive: true, startIdle: true } },
  { id: 'area:region_2', label: 'Region 2', visibility: 'known', position: { x: 50, y: 200 }, lockedReasons: [], completion: null,
    danger: { status: 'unknown' }, idle: { unlocked: false, activities: [] }, actions: { enterLive: false, startIdle: false } },
] };
const world = { status: 200, body: worldBody };

test('Scenario B rejects an unsuccessful debug response before fetching the evaluated world', () => {
  assert.throws(() => assertScenarioBDebugResponse({ ...debug, status: 503 }, actorId), /HTTP 503/);
  assert.throws(() => assertScenarioBDebugResponse({ ...debug, body: { ...debug.body, completedAreas: [] } }, actorId), /did not confirm/);
  assert.throws(() => assertScenarioBDebugResponse({ ...debug, body: { actorId: 'another-actor', completedAreas: ['area:region_1'] } }, actorId), /did not confirm/);
  assert.throws(() => assertScenarioBDebugResponse({ ...debug, body: null }, actorId), /did not confirm/);
});

test('Scenario B requires the authoritative evaluated world to show Region 1 complete and Region 2 known', () => {
  assert.throws(() => assertScenarioBEvaluatedWorld({ ...world, body: { areas: [{ id: 'area:region_1', completion: { completed: true } }] } }), /area:region_2 unlocked/);
  assert.throws(() => assertScenarioBEvaluatedWorld({ ...world, body: { areas: 'area:region_1 complete; area:region_2 unlocked' } }), /areas array/);
  assert.throws(() => assertScenarioBEvaluatedWorld({ ...world, status: 503 }), /HTTP 503/);
  assert.throws(() => assertScenarioBEvaluatedWorld({ ...world, body: null }), /areas array/);
  assert.doesNotThrow(() => assertScenarioBDebugResponse(debug, actorId));
  assert.doesNotThrow(() => assertScenarioBEvaluatedWorld(world));
});

test('rendered map evidence must match the authoritative hub and visible area IDs', () => {
  const nodes = [{ id: 'area:sanctuary' }, { id: 'area:region_1' }, { id: 'area:region_2' }];
  assert.doesNotThrow(() => assertRenderedWorldNodeEvidence(worldBody, nodes));
  assert.throws(() => assertRenderedWorldNodeEvidence(worldBody, []), /expected 3, found 0/);
  assert.throws(() => assertRenderedWorldNodeEvidence(worldBody, nodes.slice(0, 2)), /expected 3, found 2/);
  assert.throws(() => assertRenderedWorldNodeEvidence(worldBody, [...nodes.slice(0, 2), { id: 'area:stale' }]), /do not match/);
  assert.throws(() => assertRenderedWorldNodeEvidence(worldBody, [...nodes, { id: 'area:extra' }]), /do not match/);
});
