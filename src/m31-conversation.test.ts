import { describe, it, expect, vi } from 'vitest';
import { AssistantConversation, generalAnswer, type AssistantPreview, type PlanTransport } from './assistant-conversation';
import { AuthorizedTaskConversation } from './authorized-task-conversation';
import { TaskClient } from './tasks';
import type { ExecutorGoal } from './executor';
const tasks = () => new AuthorizedTaskConversation(new TaskClient({ call: async () => { throw Error('No task reads for general answers'); }, subscribe: async () => () => {} }));
const preview = (capability: AssistantPreview['interpretation']['capability'], patch: Partial<AssistantPreview['interpretation']> = {}): AssistantPreview => ({ dryRun: true, executed: false, interpretation: { capability, executionIntent: 'non_executive', task: null, city: null, query: null, date: null, question: null, usesCityContext: false, answer: null, planTargets: null, ...patch } });
describe('M3.1 typed general conversation (fixtures, not semantic evaluation)', () => {
  it.each(['non_executive', 'execute_now'] as const)('reports unavailable research without offering execution for %s', async executionIntent => {
    // Replays the capability/intent combination observed in real call 19.
    const open = vi.fn(), weather = vi.fn(), prepare = vi.fn(), read = vi.fn();
    const a = new AssistantConversation(tasks(), async () => preview('research', { executionIntent, query: 'energia solar e analise fontes atuais' }), open, Date.now, weather, { read, prepare });
    const result = await a.send('Pesquise energia solar e analise fontes atuais aqui na conversa.');
    expect(result).toMatchObject({ responseKind: 'unavailable' });
    expect(result?.text).toContain('ainda não está disponível');
    expect(result?.text).not.toContain('Deseja realizar uma ação agora');
    expect(open).not.toHaveBeenCalled(); expect(weather).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it('keeps deferred research non-executable without retaining permission', async () => {
    const open = vi.fn(); const interpret = vi.fn().mockResolvedValue(preview('research', { executionIntent: 'deferred', query: 'energia solar' }));
    const a = new AssistantConversation(tasks(), interpret, open);
    expect((await a.send('Pesquise e analise energia solar se eu confirmar depois'))?.text).toContain('condição');
    expect(a.exportContext().clarification).toBeNull(); expect(a.exportContext().activeCapability).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
  it.each(['A água ferve a cerca de 100 °C ao nível do mar.', 'Um algoritmo é uma sequência finita de passos.', 'O rádio foi criado a partir de avanços na transmissão eletromagnética.', 'Podemos comparar os dois argumentos sem consultar fontes.'])('preserves intellectual prose and numbers: %s', async answer => {
    const open = vi.fn(); const a = new AssistantConversation(tasks(), async () => preview('conversation', { answer }), open);
    expect(await a.send('Explique o conceito.')).toMatchObject({ text: answer, responseKind: 'general_answer' });
    expect(open).not.toHaveBeenCalled();
  });
  it.each(['Criei a tarefa.', 'Sua tarefa #1 foi concluída com sucesso.', 'A tarefa #1 está completa.', 'A tarefa #1 foi finalizada.', 'O plano foi autorizado.', 'I created your task.', 'Your task has been completed.', 'Agora está feito.'])('rejects unverified operational claims: %s', async answer => {
    expect(generalAnswer(answer)).toBeNull();
    const a = new AssistantConversation(tasks(), async () => preview('conversation', { answer }));
    expect((await a.send('Explique'))?.responseKind).toBe('unavailable');
  });
  it('keeps a general clarification and consumes it after a correction without extra calls', async () => {
    const interpret = vi.fn().mockResolvedValueOnce(preview('clarify', { question: 'Você se refere ao banco de dados ou à instituição financeira?' })).mockResolvedValueOnce(preview('conversation', { answer: 'Um banco de dados organiza informações.' })).mockResolvedValueOnce(preview('conversation', { answer: 'Entendido.' }));
    const a = new AssistantConversation(tasks(), interpret);
    await a.send('Explique bancos');
    expect((await a.send('Quis dizer banco de dados'))?.text).toContain('organiza');
    expect(interpret.mock.calls[1][0].clarification).toContain('Explique bancos');
    await a.send('Obrigado'); expect(interpret.mock.calls[2][0].clarification).toBeNull();
    expect(interpret).toHaveBeenCalledTimes(3);
  });
  it.each(['network', 'rate_limit', 'timeout', 'invalid_response', 'unavailable'])('fails honestly without tool effects or retry: %s', async code => {
    const interpret = vi.fn().mockRejectedValue({ code, message: 'PRIVATE BODY' }); const open = vi.fn();
    const a = new AssistantConversation(tasks(), interpret, open);
    const result = await a.send('Explique gravidade');
    expect(result?.responseKind).toBe('unavailable'); expect(result?.text).not.toContain('PRIVATE');
    expect(interpret).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled();
  });
});
describe('M3.1 proposals use the existing M2 preparation only', () => {
  function fixture() {
    const snapshot = { revision: 7, tasks: [1, 2].map(id => ({ id, title: `Sintética ${id}`, completed: false, description: '', project: '', priority: 'normal' as const, dueDate: null, dueTime: null })) };
    const prepare = vi.fn().mockImplementation(async request => ({ status: 'draft', plan: { steps: request.steps } }) as ExecutorGoal);
    const plans: PlanTransport = { read: vi.fn().mockResolvedValue(snapshot), prepare };
    const interpret = vi.fn().mockResolvedValue(preview('plan', { executionIntent: 'execute_now', planTargets: ['#1', '#2'] }));
    return { a: new AssistantConversation(tasks(), interpret, vi.fn(), Date.now, vi.fn(), plans), plans, prepare, interpret, snapshot };
  }
  it('resolves concrete IDs locally, prepares exactly once, and never grants or starts', async () => {
    const f = fixture(); const result = await f.a.send('Prepare um plano para concluir #1 e #2');
    expect(result?.responseKind).toBe('proposal'); expect(result?.executed).not.toBe(true);
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith({ objective: 'Prepare um plano para concluir #1 e #2', maxOperations: 2, durationSeconds: 1800, steps: [{ id: 'step-1', operation: 'complete_task', targetId: 1, dependsOn: [] }, { id: 'step-2', operation: 'complete_task', targetId: 2, dependsOn: ['step-1'] }] }, 7);
    expect(f.snapshot.tasks.every(t => !t.completed)).toBe(true);
  });
  it.each(['Prepare um plano', 'Prepare #10 e #20', 'Explique planos'])('does not accept model-invented references: %s', async input => {
    const f = fixture(); expect((await f.a.send(input))?.responseKind).toBe('clarification'); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('rejects ambiguous titles and never executes a partial plan', async () => {
    const f = fixture(); f.snapshot.tasks[1].title = f.snapshot.tasks[0].title;
    f.interpret.mockResolvedValue(preview('plan', { executionIntent: 'execute_now', planTargets: ['Sintética 1'] }));
    expect((await f.a.send('Prepare Sintética 1'))?.responseKind).toBe('clarification'); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('does not prepare deferred plans or retry a lost preparation response', async () => {
    const f = fixture(); f.interpret.mockResolvedValueOnce(preview('plan', { executionIntent: 'deferred', planTargets: ['#1'] }));
    await f.a.send('Prepare #1 se eu confirmar depois'); expect(f.prepare).not.toHaveBeenCalled();
    f.prepare.mockRejectedValueOnce(Error('lost delivery'));
    expect((await f.a.send('Prepare #1 e #2'))?.responseKind).toBe('unavailable'); expect(f.prepare).toHaveBeenCalledTimes(1);
  });
});

it('sends a live reviewed draft as typed data for correction while preserving new approval', async () => {
  const { AuthorizationTaskStore } = await import('./test-fixtures/authorization-task-store');
  const { IntelligenceSession } = await import('./intelligence');
  const store = new AuthorizationTaskStore([]); await store.client.start();
  let sequence = 0;
  const auth = { prepare: vi.fn(async effect => ({ proposalId: String(++sequence), effect, before: null, expiresInSeconds: 900 })), approve: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined) };
  const inner = new AuthorizedTaskConversation(store.client, new IntelligenceSession(vi.fn()), Date.now, auth);
  const task = { intent: 'create_task' as const, parameters: { title: 'Órion sintético', dueDate: '2026-10-30', dueTime: '18:00', priority: null, project: null, target: null, panel: null }, reply: 'Proposta.', clarification: null, requiresConfirmation: false, usesPreviousDraft: false };
  const interpret = vi.fn().mockResolvedValueOnce(preview('task', { executionIntent: 'execute_now', task })).mockImplementationOnce(async request => {
    expect(request.taskContext.previousDraft).toMatchObject({ title: 'Órion sintético', dueDate: '2026-10-30', dueTime: '18:00' });
    return preview('task', { executionIntent: 'execute_now', task: { ...task, parameters: { ...task.parameters, title: 'Vega sintética' }, usesPreviousDraft: true } });
  });
  const a = new AssistantConversation(inner, interpret);
  const first = await a.send('Crie Órion sintético amanhã às 18h');
  const corrected = await a.send('Corrija o rascunho para Vega sintética');
  expect(corrected?.approval?.id).not.toBe(first?.approval?.id);
  expect(corrected?.text).toContain('Vega sintética'); expect(corrected?.text).toContain('18:00');
  expect(auth.approve).not.toHaveBeenCalled(); expect(store.inspect().tasks).toHaveLength(0);
});
