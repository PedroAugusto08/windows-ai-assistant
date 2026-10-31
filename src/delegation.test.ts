import { describe, it, expect } from 'vitest';
import { DelegationClient, type DelegationGrant, type DelegationReceipt, type DelegationExecution, type DelegationTransport } from './delegation';
const draft = (): DelegationGrant => ({ id: 'draft-id', version: 1, owner: 'dashboard', status: 'draft', scope: { objective: 'Revisão sintética', requester: 'local_user', tool: 'tasks', operation: 'complete_task', targets: [{ id: 7, title: 'Sintética' }], data: 'local_task_state', destination: 'local_sqlite', risk: 'moderate', expectedRevision: 3, durationSeconds: 1800 }, maxOperations: 20, used: 0, createdAt: 1, grantedAt: null, expiresAt: null, endedAt: null });
function fixture() {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  let receipt: DelegationReceipt | undefined;
  let failDelivery = false;
  let writes = 0;
  const transport: DelegationTransport = { async call<T>(command: string, args?: Record<string, unknown>) {
    calls.push({ command, args: structuredClone(args) });
    let result: unknown;
    if (command === 'delegation_history') result = { grants: [], receipts: receipt ? [receipt] : [] };
    else if (command === 'delegation_prepare') result = draft();
    else if (command === 'delegation_consent') result = { ...draft(), status: 'active' };
    else if (command === 'delegation_end') result = { ...draft(), status: args?.reason };
    else if (command === 'list_tasks') result = { revision: 3, tasks: [] };
    else if (command === 'delegation_execute') {
      const request = args?.request as DelegationExecution;
      if (!receipt) { writes++; receipt = { ...request, owner: 'dashboard', beforeRevision: request.expectedRevision, revision: request.expectedRevision + 1, used: 1, committedAt: 3 }; }
      if (failDelivery) throw new Error('synthetic post-commit delivery failure');
      result = receipt;
    } else throw new Error('unexpected command');
    return structuredClone(result) as T;
  } };
  return { calls, transport, client: new DelegationClient(transport, () => 'stable-key'), fail: () => { failDelivery = true; }, recover: () => { failDelivery = false; }, writes: () => writes };
}
describe('M2.1 consent client (transport fixture, not Rust authority)', () => {
  it('hydration and refresh cannot grant or execute', async () => {
    const f = fixture(); await f.client.refresh(); await f.client.refresh();
    expect(f.calls.map(c => c.command)).toEqual(['delegation_history', 'delegation_history']);
    expect(f.writes()).toBe(0);
  });
  it('consent sends only the immutable backend draft ID', async () => {
    const f = fixture();
    const request = { objective: 'A', targetIds: [7], maxOperations: 20, durationSeconds: 1800 };
    await f.client.prepare(request); request.targetIds[0] = 99; request.maxOperations = 100;
    await f.client.consent();
    expect(f.calls.find(c => c.command === 'delegation_consent')?.args).toEqual({ grantId: 'draft-id' });
    expect(f.calls.find(c => c.command === 'delegation_prepare')?.args).toEqual({ request: { objective: 'A', targetIds: [7], maxOperations: 20, durationSeconds: 1800 } });
    expect(f.writes()).toBe(0);
    await f.client.consent();
    expect(f.calls.filter(c => c.command === 'delegation_consent')).toHaveLength(1);
  });
  it('double activation admits one client call; only backend receipt confirms success', async () => {
    const f = fixture(); await Promise.all([f.client.execute('g', 7), f.client.execute('g', 7)]);
    expect(f.calls.filter(c => c.command === 'delegation_execute')).toHaveLength(1);
    expect(f.client.getState().feedback).toContain('Conclusão confirmada');
    expect(f.writes()).toBe(1);
  });
  it('lost delivery never retries automatically and explicit resend preserves all parameters', async () => {
    const f = fixture(); f.fail(); await f.client.execute('g', 7);
    expect(f.client.getState().feedback).not.toContain('confirmada');
    expect(f.client.getState().pending?.requestId).toBe('stable-key');
    await f.client.refresh(); await f.client.execute('g', 8);
    expect(f.calls.filter(c => c.command === 'delegation_execute')).toHaveLength(1);
    f.recover(); await f.client.resend();
    const sent = f.calls.filter(c => c.command === 'delegation_execute');
    expect(sent[0].args).toEqual(sent[1].args); expect(f.writes()).toBe(1);
    expect(f.client.getState().pending).toBeNull();
  });
  it('rejects mismatched receipts and exposes uncertainty', async () => {
    const f = fixture();
    const client = new DelegationClient({ call: async <T>(command: string, args?: Record<string, unknown>) => {
      const result = await f.transport.call<unknown>(command, args);
      return (command === 'delegation_execute' ? { ...(result as object), targetId: 99 } : result) as T;
    } });
    await client.execute('g', 7);
    expect(client.getState().pending).not.toBeNull();expect(client.getState().error).toContain('não confirmado');
    expect(client.getState().feedback).not.toContain('Conclusão confirmada');
  });
  it('cancel/revoke are explicit and hydration of a new client cannot resume', async () => {
    const f = fixture(); await f.client.end('g', 'revoked');
    expect(f.calls[0]).toEqual({ command: 'delegation_end', args: { grantId: 'g', reason: 'revoked' } });
    const reloaded = new DelegationClient(f.transport); await reloaded.refresh();
    expect(reloaded.getState().pending).toBeNull();expect(f.writes()).toBe(0);
  });
});
it('restores only recovery metadata after reload and waits for explicit resend', async () => {
  const f = fixture(); let saved: string | null = null;
  const storage = { load: () => saved, save: (value: string | null) => { saved = value; } };
  const first = new DelegationClient(f.transport, () => 'persistent-key', storage);
  f.fail(); await first.execute('g', 7);
  expect(saved).toContain('persistent-key');
  const reloaded = new DelegationClient(f.transport, () => 'new-key', storage);
  await reloaded.refresh();
  expect(f.calls.filter(c => c.command === 'delegation_execute')).toHaveLength(1);
  expect(reloaded.getState().pending).toEqual(first.getState().pending);
  f.recover(); await reloaded.resend();
  expect(f.writes()).toBe(1); expect(saved).toBeNull();
});
it('cannot send a new effect if durable recovery metadata cannot be written', async () => {
  const f = fixture();
  const client = new DelegationClient(f.transport, () => 'key', { load: () => null, save: () => { throw new Error('storage full'); } });
  await client.execute('g', 7);
  expect(f.writes()).toBe(0); expect(client.getState().error).toContain('não confirmado');
});
it.each(['{"version":2,"request":{}}', '{"version":1,"request":null}', '{"version":1,"request":{"grantId":"g","requestId":"r","targetId":-1,"expectedRevision":3}}', '{bad json'])('blocks new effects for unrecognized recovery until explicit discard: %s', async raw => {
  const f = fixture(); let saved: string | null = raw;
  const storage = { load: () => saved, save: (value: string | null) => { saved = value; } };
  const client = new DelegationClient(f.transport, () => 'reconciled-key', storage);
  expect(client.getState().recoveryBlocked).toBe(true);
  await client.refresh(); await client.execute('g', 7);
  expect(f.writes()).toBe(0);
  client.dismissUncertainty(); expect(saved).toBeNull();
  await client.execute('g', 7); expect(f.writes()).toBe(1);
});
it('inaccessible recovery remains blocked until explicit removal succeeds', async () => {
  const f = fixture(); let unavailable = true;
  const client = new DelegationClient(f.transport, () => 'reconciled-key', {
    load: () => { throw new Error('storage unavailable'); },
    save: () => { if (unavailable) throw new Error('still unavailable'); },
  });
  await client.execute('g', 7); expect(f.writes()).toBe(0);
  client.dismissUncertainty(); expect(client.getState().recoveryBlocked).toBe(true);
  unavailable = false; client.dismissUncertainty();
  await client.execute('g', 7); expect(f.writes()).toBe(1);
});
