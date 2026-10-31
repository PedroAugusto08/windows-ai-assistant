import { describe, it, expect, vi } from 'vitest';
import { AuthorizedTaskConversation } from './authorized-task-conversation';
import { IntelligenceSession, type Interpretation, type IntelligenceTransport } from './intelligence';
import { AuthorizationTaskStore } from './test-fixtures/authorization-task-store';
import { reviewSummary, type AuthorizationTransport, type ReviewProposal } from './conversation-authorization';
import type { Task } from './tasks';
const task = (id: number, title = 'Ensaio fictício'): Task => ({ id, title, description: '', project: '', priority: 'normal', dueDate: null, dueTime: null, completed: false });
function proposal(intent: Interpretation['intent'], parameters: Partial<Interpretation['parameters']> = {}, clarification: string | null = null) {
  return { dryRun: true as const, executed: false as const, model: 'offline', latencyMs: 1, requestCount: 1, promptTokens: 0, outputTokens: 0, interpretation: { intent, parameters: { title: null, priority: null, dueDate: null, dueTime: null, project: null, target: null, panel: null, ...parameters }, clarification, reply: 'Proposta simulada.', requiresConfirmation: false, usesPreviousDraft: false } };
}
async function setup(tasks = [task(830)]) {
  let now = Date.parse('2026-10-20T12:00:00-03:00');
  const sandbox = new AuthorizationTaskStore(tasks); await sandbox.client.start();
  const transport = vi.fn<IntelligenceTransport>();
  let staged: ReviewProposal | null = null; let sequence = 0;
  const auth: AuthorizationTransport = {
    prepare: vi.fn(async effect => { staged = { proposalId: String(++sequence), effect: structuredClone(effect), before: sandbox.inspect().tasks.find(t => t.id === effect.id) ?? null, expiresInSeconds: 900 }; return structuredClone(staged); }),
    approve: vi.fn(async id => {
      const pending = staged;
      if (!pending || pending.proposalId !== id) throw Error('Consumed');
      const e = pending.effect; staged = null;
      return sandbox.client.execute(e.kind === 'complete_task' ? 'complete_task' : e.kind === 'delete_task' ? 'delete_task' : 'save_task', { id: e.id, input: e.input, expectedRevision: e.expectedRevision });
    }),
    cancel: vi.fn(async id => { if (staged?.proposalId === id) staged = null; }),
  };
  const session = new AuthorizedTaskConversation(sandbox.client, new IntelligenceSession(transport, () => now), () => now, auth);
  return { sandbox, transport, session, auth, advance: (milliseconds = 900_000) => { now += milliseconds; }, writes: () => sandbox.calls.filter(c => c.command !== 'list_tasks') };
}
describe('habitual authorization v1', () => {
  it('N03 wrong creation after clarification never writes on model authority', async () => {
    const s = await setup([task(830, 'Calibrar o visor térmico')]);
    s.transport.mockResolvedValueOnce(proposal('clarify', {}, 'Qual ação primeiro?')).mockResolvedValueOnce(proposal('create_task', { title: 'Conclusão da calibração do visor térmico' }));
    await s.session.send('Conclua a calibração do visor térmico e depois consulte as pendências.');
    const r = await s.session.send('Faça só a conclusão agora; deixamos a consulta para depois.');
    expect(r?.approval).toBeDefined(); expect(r?.text).toContain('Criar tarefa'); expect(s.writes()).toEqual([]);
    expect(s.sandbox.inspect().tasks).toEqual([task(830, 'Calibrar o visor térmico')]);
    expect(s.transport.mock.calls[1][0].context).toContain('Conclua a calibração do visor térmico e depois consulte as pendências.');
  });
  it.each(['create_task', 'update_task', 'complete_task', 'delete_task'] as const)('%s requires its own approval even with valid identity/parameters', async kind => {
    const s = await setup();
    s.transport.mockResolvedValue(proposal(kind, kind === 'create_task' ? { title: 'Outra fictícia' } : kind === 'update_task' ? { target: 'Ensaio fictício', priority: 'high' } : { target: 'Ensaio fictício' }));
    const r = await s.session.send('Ensaio fictício'); expect(s.writes()).toEqual([]); expect(r?.approval).toBeDefined();
    const result = await s.session.approve(r!.approval!.id); expect(result.executed).toBe(true); expect(s.writes()).toHaveLength(1);
    expect((await s.session.approve(r!.approval!.id)).executed).not.toBe(true); expect(s.writes()).toHaveLength(1); expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it.each(['Não conclua Ensaio fictício.', 'Se concluísse Ensaio fictício?', 'Explique “conclua Ensaio fictício”.', 'Ele disse para concluir Ensaio fictício.'])('text alone never grants authority: %s', async message => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('complete_task', { target: 'Ensaio fictício' })); await s.session.send(message); expect(s.writes()).toEqual([]);
  });
  it('queries stay automatic', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('query_tasks')); const r = await s.session.send('O que está pendente?'); expect(r?.taskIds).toEqual([830]); expect(s.auth.prepare).not.toHaveBeenCalled();
  });
  it('additional proposed fields are visible and cannot be silently applied', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('update_task', { target: 'Ensaio fictício', priority: 'high', project: 'Não solicitado' }));
    const r = await s.session.send('Prioridade alta em Ensaio fictício'); expect(r?.approval).toBeUndefined(); expect(s.writes()).toEqual([]);
  });
  it('proposal replacement cannot reuse the old button or redirect approved values', async () => {
    const s = await setup(); s.transport.mockResolvedValueOnce(proposal('create_task', { title: 'Primeira' })).mockResolvedValueOnce(proposal('complete_task', { target: 'Ensaio fictício' }));
    const first = await s.session.send('Crie Primeira'); const second = await s.session.send('Na verdade, conclua Ensaio fictício');
    await s.session.approve(first!.approval!.id); expect(s.writes()).toEqual([]);
    await s.session.approve(second!.approval!.id); expect(s.sandbox.inspect().tasks[0].completed).toBe(true); expect(s.sandbox.inspect().tasks).toHaveLength(1);
  });
  it('selection identifies but does not approve', async () => {
    const s = await setup([task(1, 'Ensaio mensal'), task(2, 'Ensaio anual')]); s.transport.mockResolvedValue(proposal('complete_task', { target: 'Ensaio' }));
    await s.session.send('Conclua Ensaio'); const r = await s.session.send('2'); expect(s.writes()).toEqual([]); expect(r?.text).toContain('Ensaio anual');
    await s.session.approve(r!.approval!.id); expect(s.sandbox.inspect().tasks.map(t => t.completed)).toEqual([false, true]); expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it('delete has one explicit confirmation, supports a button or existing local protocol', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('delete_task', { target: 'Ensaio fictício' }));
    const r = await s.session.send('Exclua Ensaio fictício'); expect(r?.approval?.destructive).toBe(true);
    const result = await s.session.send('confirmo excluir 830'); expect(result?.executed).toBe(true); expect(s.auth.approve).toHaveBeenCalledTimes(1); expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it('cancel, clear and expiry prevent writes', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('create_task', { title: 'Teste' }));
    let r = await s.session.send('Crie Teste'); await s.session.cancelApproval(r!.approval!.id); await s.session.approve(r!.approval!.id);
    r = await s.session.send('Crie Teste'); s.session.clear(); await s.session.approve(r!.approval!.id);
    r = await s.session.send('Crie Teste'); s.advance(); await s.session.approve(r!.approval!.id); expect(s.writes()).toEqual([]);
  });
  it('stale revision consumes approval without execution', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('complete_task', { target: 'Ensaio fictício' })); const r = await s.session.send('Conclua Ensaio fictício');
    s.sandbox.concurrentEdit(830, { priority: 'high' }); const result = await s.session.approve(r!.approval!.id); expect(result.executed).not.toBe(true); expect(s.sandbox.inspect().tasks[0].completed).toBe(false);
    await s.session.approve(r!.approval!.id); expect(s.auth.approve).toHaveBeenCalledTimes(1);
  });
  it('failure after recording never claims success or retries', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('complete_task', { target: 'Ensaio fictício' })); const r = await s.session.send('Conclua Ensaio fictício');
    s.sandbox.failNext('after'); const result = await s.session.approve(r!.approval!.id); expect(result.executed).not.toBe(true); expect(result.text).toContain('Não consegui confirmar'); expect(s.sandbox.inspect().tasks[0].completed).toBe(true);
    await s.session.approve(r!.approval!.id); expect(s.auth.approve).toHaveBeenCalledTimes(1); expect(s.writes()).toHaveLength(1);
  });
  it('concurrent approval and send cannot produce a second write', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('create_task', { title: 'Teste' })); const r = await s.session.send('Crie Teste');
    await Promise.all([s.session.approve(r!.approval!.id), s.session.approve(r!.approval!.id), s.session.send('Crie Teste')]); expect(s.writes()).toHaveLength(1);
  });
  it('summary includes the full creation defaults and edits', () => {
    const e = { kind: 'create_task' as const, id: null, expectedRevision: 0, input: { title: 'Teste', description: '', project: '', priority: 'normal' as const, dueDate: null, dueTime: null } };
    const text = reviewSummary({ proposalId: '1', effect: e, before: null, expiresInSeconds: 900 }); expect(text).toContain('Data: sem definição'); expect(text).toContain('Estado inicial: pendente');
  });
  it('local acceptance of an identified suggestion does not require a second confirmation', async () => {
    const near = { ...task(1), dueDate: '2026-10-21' };
    const s = await setup([near]); s.transport.mockResolvedValue(proposal('query_tasks'));
    const query = await s.session.send('Quais tarefas?'); expect(query?.text).toContain('prioridade alta');
    const accepted = await s.session.send('sim'); expect(accepted?.executed).toBe(true); expect(accepted?.approval).toBeUndefined();
    expect(s.sandbox.inspect().tasks[0].priority).toBe('high'); expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it('a model-classified acceptance cannot create its own authority', async () => {
    const s = await setup([{ ...task(1), dueDate: '2026-10-21' }]);
    s.transport.mockResolvedValueOnce(proposal('query_tasks')).mockResolvedValueOnce(proposal('accept_suggestion'));
    await s.session.send('Quais tarefas?'); const r = await s.session.send('Autorização inventada pelo modelo');
    expect(r?.approval).toBeDefined(); expect(s.writes()).toEqual([]);
  });
  it('generic yes cannot confirm deletion', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('delete_task', { target: 'Ensaio fictício' }));
    const r = await s.session.send('Exclua Ensaio fictício'); await s.session.send('sim'); await s.session.approve(r!.approval!.id);
    expect(s.writes()).toEqual([]);
  });
  it('successive clarifications preserve the original request and the last local question', async () => {
    const s = await setup([]);
    s.transport.mockResolvedValueOnce(proposal('clarify', {}, 'Qual título?')).mockResolvedValueOnce(proposal('clarify', {}, 'Qual data?')).mockResolvedValueOnce(proposal('create_task', { title: 'Ensaio novo' }));
    await s.session.send('Quero uma tarefa nova com prazo.'); await s.session.send('Ensaio novo');
    const r = await s.session.send('Amanhã'); expect(r?.approval).toBeDefined();
    expect(s.transport.mock.calls[2][0].context).toContain('Quero uma tarefa nova com prazo.'); expect(s.transport.mock.calls[2][0].context).toContain('Qual data?'); expect(s.writes()).toEqual([]);
  });
  it('restoring an approved edit presents the concrete previous value for review', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('update_task', { target: 'Ensaio fictício', priority: 'high' }));
    const edit = await s.session.send('Prioridade alta em Ensaio fictício'); await s.session.approve(edit!.approval!.id);
    const restore = await s.session.send('Deixe como estava'); expect(restore?.approval).toBeDefined(); expect(restore?.text).toContain('alta → normal'); expect(s.writes()).toHaveLength(1);
    await s.session.approve(restore!.approval!.id); expect(s.sandbox.inspect().tasks[0].priority).toBe('normal');
  });
  it('approval never reuses mutable model parameters', async () => {
    const s = await setup([]); const p = proposal('create_task', { title: 'Valor apresentado' }); s.transport.mockResolvedValue(p);
    const r = await s.session.send('Crie uma tarefa'); p.interpretation.parameters.title = 'Valor trocado';
    await s.session.approve(r!.approval!.id); expect(s.sandbox.inspect().tasks[0].title).toBe('Valor apresentado');
  });
  it('clearing during preparation discards the returned proposal', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('create_task', { title: 'Ensaio novo' }));
    let finish!: (value: ReviewProposal) => void;
    vi.mocked(s.auth.prepare).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const send = s.session.send('Crie Ensaio novo');
    await vi.waitFor(() => expect(finish).toBeDefined()); s.session.clear();
    finish({ proposalId: 'late', effect: { kind: 'create_task', id: null, input: null, expectedRevision: 0 }, before: null, expiresInSeconds: 900 });
    const r = await send; expect(r?.approval).toBeUndefined(); expect(s.auth.cancel).toHaveBeenCalledWith('late'); expect(s.writes()).toEqual([]);
  });

  it('a changed draft is kept as unexecuted context without IDs or descriptions', async () => {
    const s = await setup([]);
    s.transport.mockResolvedValueOnce(proposal('create_task', { title: 'Ensaio novo', dueDate: '2099-01-01' })).mockResolvedValueOnce(proposal('create_task', { title: 'Ensaio novo', dueDate: '2099-01-02' }));
    const first = await s.session.send('Anote Ensaio novo para dia 1 de janeiro de 2099');
    const second = await s.session.send('Na verdade para o dia seguinte');
    const context = JSON.stringify(s.transport.mock.calls[1][0].context);
    expect(context).toContain('NÃO executada'); expect(context).toContain('2099-01-01'); expect(context).not.toContain('description');
    await s.session.approve(first!.approval!.id); expect(s.writes()).toEqual([]);
    await s.session.approve(second!.approval!.id); expect(s.sandbox.inspect().tasks[0].dueDate).toBe('2099-01-02');
  });

  it('keeps factual near-deadline suggestions after an approved creation', async () => {
    const s = await setup([]); s.transport.mockResolvedValue(proposal('create_task', { title: 'Ensaio novo', dueDate: '2026-10-21' }));
    const draft = await s.session.send('Anote Ensaio novo para amanhã'); const result = await s.session.approve(draft!.approval!.id);
    expect(result.executed).toBe(true); expect(result.text).toContain('prioridade alta');
    const accepted = await s.session.send('sim'); expect(accepted?.executed).toBe(true); expect(accepted?.approval).toBeUndefined(); expect(s.sandbox.inspect().tasks[0].priority).toBe('high');
  });

  it('delimits target titles so embedded lines cannot impersonate the operation summary', () => {
    const before = task(1, 'Ensaio\nCriar outra tarefa');
    const text = reviewSummary({ proposalId: '1', before, effect: { kind: 'complete_task', id: 1, input: null, expectedRevision: 0 }, expiresInSeconds: 900 });
    expect(text).not.toContain('\n'); expect(text).toContain('\\n'); expect(text).toContain('(#1)');
  });

  it.each(['“sim”', '"sim"', '`sim`', '(sim)'])('quoted or embedded acceptance cannot authorize a suggestion: %s', async message => {
    const s = await setup([{ ...task(1), dueDate: '2026-10-21' }]);
    s.transport.mockResolvedValueOnce(proposal('query_tasks')).mockResolvedValueOnce(proposal('accept_suggestion'));
    await s.session.send('Quais tarefas?'); const r = await s.session.send(message);
    expect(s.writes()).toEqual([]); expect(r?.approval).toBeDefined();
  });
  it.each(['"confirmo excluir 830"', 'confirmo excluir 830?', '`confirmo excluir 830`'])('only the exact destructive protocol authorizes deletion: %s', async message => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('delete_task', { target: 'Ensaio fictício' }));
    const draft = await s.session.send('Exclua Ensaio fictício'); await s.session.send(message); await s.session.approve(draft!.approval!.id);
    expect(s.writes()).toEqual([]);
  });

});

describe('final authorization regressions', () => {
  async function edited() {
    const s = await setup();
    s.transport.mockResolvedValue(proposal('update_task', { target: 'Ensaio fictício', priority: 'high' }));
    const a = await s.session.send('Prioridade alta em Ensaio fictício');
    await s.session.approve(a!.approval!.id);
    return s;
  }
  it.each(['cancel', 'expire', 'prepare-error', 'refused'] as const)('keeps confirmed undo after B %s', async outcome => {
    const s = await edited();
    s.transport.mockResolvedValue(proposal('update_task', { target: 'Ensaio fictício', priority: 'low' }));
    if (outcome === 'prepare-error') vi.mocked(s.auth.prepare).mockRejectedValueOnce(new Error('offline'));
    if (outcome === 'refused') s.transport.mockResolvedValue(proposal('update_task', { target: 'Ensaio fictício', priority: 'low', project: 'Extra' }));
    if (outcome === 'expire') {
      const prepare = s.auth.prepare;
      s.auth.prepare = async effect => ({ ...await prepare(effect), expiresInSeconds: 1 });
    }
    const b = await s.session.send('Prioridade baixa em Ensaio fictício');
    if (outcome === 'cancel') await s.session.cancelApproval(b!.approval!.id);
    if (outcome === 'expire') { s.advance(1000); expect((await s.session.approve(b!.approval!.id)).text).toContain('expirou'); }
    const undo = await s.session.send('Deixe como estava');
    expect(undo?.text).toContain('alta → normal');
    await s.session.approve(undo!.approval!.id);
    expect(s.sandbox.inspect().tasks[0].priority).toBe('normal');
    expect((await s.session.send('Deixe como estava'))?.approval).toBeUndefined();
  });
  it('cancelled creation and cancelled restoration both preserve the previous edit', async () => {
    const s = await edited(); s.transport.mockResolvedValue(proposal('create_task', { title: 'Outra' }));
    const b = await s.session.send('Crie Outra'); await s.session.cancelApproval(b!.approval!.id);
    const undo = await s.session.send('Deixe como estava'); await s.session.cancelApproval(undo!.approval!.id);
    expect((await s.session.send('Deixe como estava'))?.text).toContain('alta → normal');
    expect(s.writes()).toHaveLength(1);
  });
  it('undo without a reference does not write or interpret', async () => {
    const s = await setup(); expect((await s.session.send('Deixe como estava'))?.approval).toBeUndefined();
    expect(s.writes()).toEqual([]); expect(s.transport).not.toHaveBeenCalled();
  });
  it('uncertain execution invalidates the previous undo and cannot retry', async () => {
    const s = await edited(); s.transport.mockResolvedValue(proposal('update_task', { target: 'Ensaio fictício', priority: 'low' }));
    const b = await s.session.send('Prioridade baixa em Ensaio fictício'); s.sandbox.failNext('after');
    await s.session.approve(b!.approval!.id);
    expect((await s.session.send('Deixe como estava'))?.approval).toBeUndefined();
    await s.session.approve(b!.approval!.id); expect(s.writes()).toHaveLength(2);
  });
  it('revision changes still invalidate undo after cancellation', async () => {
    const s = await edited(); s.sandbox.concurrentEdit(830, { project: 'Concorrente' });
    expect((await s.session.send('Deixe como estava'))?.text).toContain('mudaram'); expect(s.writes()).toHaveLength(1);
  });
  it('replaces undo only when B executes', async () => {
    const s = await edited(); s.transport.mockResolvedValue(proposal('update_task', { target: 'Ensaio fictício', priority: 'low' }));
    const b = await s.session.send('Prioridade baixa em Ensaio fictício'); await s.session.approve(b!.approval!.id);
    expect((await s.session.send('Deixe como estava'))?.text).toContain('baixa → alta');
  });
  it('waits for cancellation acknowledgement and blocks concurrent approval', async () => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('create_task', { title: 'Teste' }));
    const b = await s.session.send('Crie Teste'); let finish!: () => void;
    vi.mocked(s.auth.cancel).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    let completed = false; const cancellation = s.session.cancelApproval(b!.approval!.id).then(r => { completed = true; return r; });
    await Promise.resolve(); expect(completed).toBe(false);
    await s.session.approve(b!.approval!.id); expect(s.writes()).toEqual([]);
    finish(); expect((await cancellation).text).toContain('foi cancelada');
  });
  it.each(['button', 'text'])('IPC failure never claims remote cancellation or restores approval: %s', async via => {
    const s = await setup(); s.transport.mockResolvedValue(proposal('create_task', { title: 'Teste' }));
    const b = await s.session.send('Crie Teste'); vi.mocked(s.auth.cancel).mockRejectedValueOnce(new Error('IPC'));
    const result = via === 'button' ? await s.session.cancelApproval(b!.approval!.id) : await s.session.send('cancelar');
    expect(result?.text).toContain('não consegui confirmar o cancelamento');
    await s.session.approve(b!.approval!.id); expect(s.writes()).toEqual([]);
  });
});

describe('M3.1 reviewed creation draft context', () => {
  it('exports typed draft values without authority or descriptions and consumes the old proposal', async () => {
    const s = await setup([]);
    s.transport.mockResolvedValue(proposal('create_task', { title: 'Órion sintético', dueDate: '2026-10-30', dueTime: '18:00' }));
    const first = await s.session.send('Crie Órion sintético amanhã às 18h');
    const context = s.session.exportContext(); context.staged!.proposal.effect.input!.description = 'PRIVATE LOCAL DESCRIPTION';
    s.session.importContext(context);
    const routing = s.session.routingContext('Corrija o rascunho para Vega');
    expect(routing.previousDraft).toMatchObject({ title: 'Órion sintético', priority: 'normal', dueDate: '2026-10-30', dueTime: '18:00', project: null });
    expect(JSON.stringify(routing.previousDraft)).not.toContain('PRIVATE');
    expect(JSON.stringify(routing.previousDraft)).not.toContain('proposalId');
    expect(s.session.exportContext().staged).toBeNull();
    expect(s.auth.cancel).toHaveBeenCalledWith(first!.approval!.id);
    expect((await s.session.approve(first!.approval!.id)).executed).not.toBe(true);
    expect(s.writes()).toHaveLength(0);
  });
  it.each(['expired', 'stale', 'cancelled'] as const)('does not export an invalidated creation: %s', async condition => {
    const s = await setup([]);
    s.transport.mockResolvedValue(proposal('create_task', { title: 'Órion sintético' }));
    const first = await s.session.send('Crie Órion sintético');
    if (condition === 'expired') s.advance();
    if (condition === 'cancelled') await s.session.cancelApproval(first!.approval!.id);
    if (condition === 'stale') await s.sandbox.client.execute('save_task', { id: null, input: { title: 'Externa sintética', description: '', project: '', priority: 'normal', dueDate: null, dueTime: null }, expectedRevision: 0 });
    const context = s.session.routingContext('Corrija o rascunho');
    expect(context.previousDraft).toBeNull();
    expect(context.context.join(' ')).not.toContain('Órion sintético');
  });
});

it('keeps a current creation draft distinct from an older persisted reference', async () => {
  const s = await setup();
  s.transport.mockResolvedValueOnce(proposal('query_tasks')).mockResolvedValueOnce(proposal('create_task', { title: 'Nova sintética' }));
  await s.session.send('Quais tarefas tenho?');
  await s.session.send('Crie Nova sintética');
  const routing = s.session.routingContext('Corrija o rascunho');
  expect(routing.previousTask).toBe(false);
  expect(routing.previousDraft?.title).toBe('Nova sintética');
  expect(s.writes()).toHaveLength(0);
});
