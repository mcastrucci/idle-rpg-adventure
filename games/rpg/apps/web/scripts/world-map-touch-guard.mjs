/** Validate the real debug response and server-evaluated world before collecting Scenario B geometry. */
export function assertScenarioBDebugResponse({ status, body }, actorId) {
  if (!isSuccess(status)) throw new Error(`debug record area:region_1 completion failed with HTTP ${status}`);
  if (!isRecord(body) || body.actorId !== actorId || !Array.isArray(body.completedAreas) ||
      !body.completedAreas.includes('area:region_1')) {
    throw new Error('debug response did not confirm area:region_1 completion for the test character');
  }
}

export function assertScenarioBEvaluatedWorld({ status, body }) {
  if (!isSuccess(status)) throw new Error(`evaluated world request failed with HTTP ${status}`);
  if (!isRecord(body) || !Array.isArray(body.areas)) {
    throw new Error('evaluated world response did not contain an areas array');
  }
  const region1 = body.areas.find(area => isRecord(area) && area.id === 'area:region_1');
  if (!isRecord(region1?.completion) || region1.completion.completed !== true) {
    throw new Error('evaluated world does not report area:region_1 complete');
  }
  const region2 = body.areas.find(area => isRecord(area) && area.id === 'area:region_2');
  if (!isRecord(region2) || region2.visibility !== 'known') {
    throw new Error('evaluated world does not report area:region_2 unlocked');
  }
}

/** Ensure the browser measured the hub and every visible server-projected area, with no stale extras. */
export function assertRenderedWorldNodeEvidence(world, nodes) {
  if (!isRecord(world) || !isRecord(world.hub) || typeof world.hub.id !== 'string' || !Array.isArray(world.areas)) {
    throw new Error('evaluated world cannot identify the expected map nodes');
  }
  if (!Array.isArray(nodes)) throw new Error('rendered world node evidence is not an array');
  const expectedIds = [world.hub.id, ...world.areas.map(area => isRecord(area) ? area.id : undefined)];
  if (expectedIds.some(id => typeof id !== 'string')) {
    throw new Error('evaluated world contains an area without a node ID');
  }
  const actualIds = nodes.map(node => isRecord(node) ? node.id : undefined);
  if (actualIds.some(id => typeof id !== 'string')) {
    throw new Error('rendered world node evidence contains a node without an ID');
  }
  const expectedSet = new Set(expectedIds);
  const actualSet = new Set(actualIds);
  if (expectedSet.size !== expectedIds.length || actualSet.size !== actualIds.length ||
      expectedSet.size !== actualSet.size || [...expectedSet].some(id => !actualSet.has(id))) {
    throw new Error(`rendered map nodes do not match evaluated world (expected ${expectedIds.length}, found ${actualIds.length})`);
  }
}

function isSuccess(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
