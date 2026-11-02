import { describe, expect, it, vi } from 'vitest';

import {
  buildEnvelope, cancelExpeditionCommand, CommandRejectedError, CommandUnconfirmedError, configureCharacterCommand, createCharacterCommand, sendCommand, startExpeditionCommand,
} from './commands.ts';
import { ApiClient } from './http.ts';
import type { FetchLike } from './http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noWait = { sleep: () => Promise.resolve(), backoff: () => 0 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every request body and answers from a scripted list of responses (or thrown network errors). */
function scriptedFetch(script: ReadonlyArray<Response | Error>) {
  const bodies: unknown[] = [];
  let index = 0;
  const fetch: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = script[index++];
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, bodies };
}

/**
 * Minimal model of the server command log (#29): the first request with a command_id mutates and stores the
 * response; a replay returns the stored response without mutating again; reusing the id for another payload is 409.
 */
function idempotentServer() {
  const log = new Map<string, { fingerprint: string; status: number; body: unknown }>();
  let mutations = 0;
  let loseNextResponse = false;
  const fetch: FetchLike = async (_input, init) => {
    const envelope = JSON.parse(String(init?.body)) as { command_id: string; operation: string; payload: unknown };
    const fingerprint = JSON.stringify([envelope.operation, envelope.payload]);
    let stored = log.get(envelope.command_id);
    if (!stored) {
      mutations++;
      stored = { fingerprint, status: 201, body: { actorId: 'actor', name: (envelope.payload as { name: string }).name, mutation: mutations } };
      log.set(envelope.command_id, stored);
    } else if (stored.fingerprint !== fingerprint) {
      return json(409, { error: 'command_id_conflict' });
    }
    if (loseNextResponse) { loseNextResponse = false; throw new TypeError('Failed to fetch'); }
    return json(stored.status, stored.body);
  };
  return { fetch, mutations: () => mutations, loseNextResponse: () => { loseNextResponse = true; } };
}

describe('command envelopes', () => {
  it('attaches a fresh client-generated UUID command_id per command', () => {
    const first = buildEnvelope('character.create', { name: 'Ada' });
    const second = buildEnvelope('character.create', { name: 'Ada' });
    expect(first.command_id).toMatch(UUID);
    expect(second.command_id).toMatch(UUID);
    expect(first.command_id).not.toBe(second.command_id);
    expect(first).toEqual({ command_id: first.command_id, operation: 'character.create', payload: { name: 'Ada' } });
  });

  it('maps character commands onto the server routes', () => {
    const create = createCharacterCommand('Ada', () => '11111111-1111-4111-8111-111111111111');
    expect(create).toEqual({ method: 'POST', path: '/characters',
      envelope: { command_id: '11111111-1111-4111-8111-111111111111', operation: 'character.create', payload: { name: 'Ada' } } });
    const configure = configureCharacterCommand('a/b', { name: 'Bo' });
    expect(configure.method).toBe('PATCH');
    expect(configure.path).toBe('/characters/a%2Fb/configuration');
    expect(configure.envelope.payload).toEqual({ name: 'Bo' });
  });

  it('uses the authenticated expedition routes and retains stable command IDs for both actions', () => {
    const payload = { actorId: '11111111-1111-4111-8111-111111111111', request: { areaId: 'area:ruins', activityId: 'activity:ruins', durationMin: 30, paceBp: 10_000 },
      config: { consumables: [], retreat: { belowHpBp: 0, onlyWhenNoHealing: false } } } as const;
    const start = startExpeditionCommand(payload, () => '22222222-2222-4222-8222-222222222222');
    expect(start.method).toBe('POST');
    expect(start.path).toBe('/expeditions');
    expect(start.envelope.operation).toBe('expedition.start');
    expect(start.envelope.payload).toMatchObject(payload);
    const cancel = cancelExpeditionCommand(payload.actorId, () => '33333333-3333-4333-8333-333333333333');
    expect(cancel.path).toBe(`/expeditions/${payload.actorId}/cancel`);
    expect(cancel.envelope.operation).toBe('expedition.cancel');
  });

  it('rejects envelopes the shared protocol parser would reject, before sending', () => {
    expect(() => buildEnvelope('character.create', { name: 'x' }, () => 'not-a-uuid')).toThrow(TypeError);
  });
});

describe('sendCommand retries', () => {
  it('retries network failures and retryable statuses with the identical envelope', async () => {
    const { fetch, bodies } = scriptedFetch([new TypeError('Failed to fetch'), json(503, { error: 'unavailable' }), json(201, { ok: true })]);
    const request = createCharacterCommand('Ada');
    await expect(sendCommand(new ApiClient(fetch), request, noWait)).resolves.toEqual({ ok: true });
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).toEqual(request.envelope);
  });

  it('never retries a response the server committed (domain errors, 409 conflict, 410 expired)', async () => {
    for (const [status, code] of [[400, 'invalid_command'], [409, 'command_id_conflict'], [410, 'command_expired']] as const) {
      const { fetch, bodies } = scriptedFetch([json(status, { error: code }), json(201, {})]);
      const failure = sendCommand(new ApiClient(fetch), createCharacterCommand('Ada'), noWait);
      await expect(failure).rejects.toBeInstanceOf(CommandRejectedError);
      await expect(failure).rejects.toMatchObject({ status, code });
      expect(bodies).toHaveLength(1);
    }
  });

  it('reports an unconfirmed command with the same request so a later retry keeps its command_id', async () => {
    const { fetch } = scriptedFetch([new TypeError('offline'), new TypeError('offline')]);
    const request = createCharacterCommand('Ada');
    const failure = await sendCommand(new ApiClient(fetch), request, { ...noWait, maxAttempts: 2 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandUnconfirmedError);
    expect((failure as CommandUnconfirmedError).request).toBe(request);
  });

  it('holds attempts until connected and backs off between them', async () => {
    const { fetch } = scriptedFetch([new TypeError('offline'), json(201, {})]);
    const order: string[] = [];
    await sendCommand(new ApiClient(fetch), createCharacterCommand('Ada'), {
      backoff: (attempt) => attempt * 100,
      sleep: async (ms) => { order.push(`sleep ${ms}`); },
      waitUntilConnected: async () => { order.push('connected'); },
    });
    expect(order).toEqual(['connected', 'sleep 100', 'connected']);
  });

  it('a lost response followed by a retry applies the command exactly once', async () => {
    const server = idempotentServer();
    const api = new ApiClient(server.fetch);
    server.loseNextResponse();
    const result = await sendCommand(api, createCharacterCommand('Ada'), noWait);
    expect(result).toMatchObject({ name: 'Ada', mutation: 1 });
    expect(server.mutations()).toBe(1);
    // A separate user intent gets a new id and does mutate.
    await sendCommand(api, createCharacterCommand('Bo'), noWait);
    expect(server.mutations()).toBe(2);
  });

  it('does not swallow programming errors', async () => {
    const api = new ApiClient(vi.fn<FetchLike>(async () => json(201, {})));
    const send = vi.spyOn(api, 'send').mockRejectedValueOnce(new RangeError('bug'));
    await expect(sendCommand(api, createCharacterCommand('Ada'), noWait)).rejects.toBeInstanceOf(RangeError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
