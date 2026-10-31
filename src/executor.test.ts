import { describe, expect, it, vi } from 'vitest';
import { ExecutorClient, type ExecutorSnapshot, type ExecutorProposal } from './executor';
const snapshot = (revision: number): ExecutorSnapshot => ({ revision, goals: [] });
const proposal: ExecutorProposal = { objective: 'Sintético', steps: [{ id: 'one', operation: 'complete_task', targetId: 1, dependsOn: [] }], maxOperations: 20, durationSeconds: 1800 };
describe('executor durable coordinator client', () => {
  it('hydration and refresh only read history', async () => {
    const call = vi.fn().mockResolvedValue(snapshot(0)); const client = new ExecutorClient({ call });
    expect(call).not.toHaveBeenCalled(); await client.refresh(); await client.refresh();
    expect(call.mock.calls).toEqual([['executor_history'], ['executor_history']]);
  });
  it('consent and start bind only the immutable plan ID, as separate user actions', async () => {
    const call = vi.fn().mockResolvedValue(snapshot(1)); const client = new ExecutorClient({ call });
    await client.prepare(proposal); await client.consent('plan-one');
    expect(call.mock.calls.filter(([cmd]) => cmd !== 'executor_history')).toEqual([['executor_prepare', { request: proposal }], ['executor_consent', { planId: 'plan-one' }]]);
    await client.start('plan-one'); expect(call).toHaveBeenCalledWith('executor_start', { planId: 'plan-one' });
  });
  it('does not retry uncertain start or consent on refresh or reload', async () => {
    const call = vi.fn().mockImplementation(async (cmd: string) => { if (cmd !== 'executor_history') throw Error('response lost after admission'); return snapshot(3); });
    const client = new ExecutorClient({ call }); await client.start('plan-one'); await client.refresh();
    expect(client.getState().error).toContain('Não haverá reenvio automático');
    expect(call.mock.calls.filter(([cmd]) => cmd === 'executor_start')).toHaveLength(1);
    const reloaded = new ExecutorClient({ call }); await reloaded.refresh(); expect(call.mock.calls.filter(([cmd]) => cmd === 'executor_start')).toHaveLength(1);
  });
  it('ignores out-of-order and older canonical snapshots', async () => {
    let first!: (s: ExecutorSnapshot) => void; const call = vi.fn().mockImplementationOnce(() => new Promise(r => { first = r; })).mockResolvedValueOnce(snapshot(4)).mockResolvedValueOnce(snapshot(2));
    const client = new ExecutorClient({ call }); const pending = client.refresh(); await client.refresh(); first(snapshot(1)); await pending; await client.refresh(); expect(client.getState().snapshot.revision).toBe(4);
  });
  it('serializes local controls and always queries real state after lost response', async () => {
    let release!: () => void; const call = vi.fn().mockImplementationOnce(() => new Promise<void>(r => { release = r; })).mockResolvedValue(snapshot(1));
    const client = new ExecutorClient({ call }); const pending = client.end('goal-one', 'revoked'); await client.start('plan-one'); expect(call).toHaveBeenCalledTimes(1); release(); await pending;
    expect(call.mock.calls).toEqual([['executor_end', { goalId: 'goal-one', reason: 'revoked' }], ['executor_history']]);
  });
  it('explicit omission only proposes a new draft and stop only revokes execution', async () => {
    const call = vi.fn().mockResolvedValue(snapshot(1)); const client = new ExecutorClient({ call });
    await client.review('goal-one', ['external-step']); await client.end('goal-one', 'blocked');
    expect(call.mock.calls.filter(([cmd]) => cmd !== 'executor_history')).toEqual([
      ['executor_review', { goalId: 'goal-one', omitStepIds: ['external-step'] }], ['executor_end', { goalId: 'goal-one', reason: 'blocked' }],
    ]);
  });
  it('review creates a draft without consent, start, or resetting cumulative consumption locally', async () => {
    const call = vi.fn().mockResolvedValue(snapshot(1)); const client = new ExecutorClient({ call }); await client.review('goal-one');
    expect(call.mock.calls).toEqual([['executor_review', { goalId: 'goal-one', omitStepIds: [] }], ['executor_history']]);
  });
});
