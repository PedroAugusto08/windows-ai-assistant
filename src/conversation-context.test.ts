import { describe, expect, it, vi } from 'vitest';
import { AssistantConversation, type AssistantInterpreter, type AssistantInterpretation } from './assistant-conversation';
import { AuthorizedTaskConversation } from './authorized-task-conversation';
import { IntelligenceSession, type IntelligencePreview, type IntelligenceTransport } from './intelligence';
import { ConversationPersonality } from './conversation-personality';
import { AuthorizationTaskStore } from './test-fixtures/authorization-task-store';
import type { AuthorizationTransport, ReviewProposal } from './conversation-authorization';
import { TaskClient, type Task } from './tasks';
import type { WeatherPlace, WeatherReport, WeatherTransport } from './weather';

const roundtrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const task = (id = 1, title = 'Ensaio fictício'): Task => ({ id, title, description: '', priority: 'normal', project: '', dueDate: null, dueTime: null, completed: false });
const preview = (intent: IntelligencePreview['interpretation']['intent'], parameters: Partial<IntelligencePreview['interpretation']['parameters']> = {}): IntelligencePreview => ({
  dryRun: true, executed: false, model: 'fixture', latencyMs: 0, requestCount: 1, promptTokens: 0, outputTokens: 0,
  interpretation: { intent, parameters: { title: null, priority: null, project: null, dueDate: null, dueTime: null, target: null, panel: null, ...parameters }, reply: 'Estou à disposição, senhor.', clarification: null, requiresConfirmation: false, usesPreviousDraft: false },
});
const assistantPreview = (capability: AssistantInterpretation['capability'], patch: Partial<AssistantInterpretation> = {}) => ({ dryRun: true as const, executed: false as const,
  interpretation: { executionIntent: 'execute_now' as const, capability, task: null, query: null, city: null, date: null, usesCityContext: false, question: null, ...patch } });

async function setup(tasks = [task()]) {
  let now = Date.parse('2026-10-20T12:00:00-03:00');
  const store = new AuthorizationTaskStore(tasks); await store.client.start();
  const transport = vi.fn<IntelligenceTransport>();
  let staged: ReviewProposal | null = null;
  let sequence = 0;
  const auth: AuthorizationTransport = {
    prepare: vi.fn(async effect => {
      staged = { proposalId: String(++sequence), effect: structuredClone(effect), before: store.inspect().tasks.find(value => value.id === effect.id) ?? null, expiresInSeconds: 900 };
      return structuredClone(staged);
    }),
    approve: vi.fn(async id => {
      const pending = staged; if (!pending || pending.proposalId !== id) throw Error('Consumed');
      staged = null; const e = pending.effect;
      return store.client.execute(e.kind === 'complete_task' ? 'complete_task' : e.kind === 'delete_task' ? 'delete_task' : 'save_task', { id: e.id, input: e.input, expectedRevision: e.expectedRevision });
    }),
    cancel: vi.fn(async id => { if (staged?.proposalId === id) staged = null; }),
  };
  const clock = () => now;
  const create = () => new AuthorizedTaskConversation(store.client, new IntelligenceSession(transport, clock), clock, auth);
  const migrate = (source: AuthorizedTaskConversation) => { const next = create(); next.importContext(roundtrip(source.exportContext())); return next; };
  return { store, transport, auth, create, migrate, clock, advance: (ms = 900_000) => { now += ms; } };
}

describe('canonical conversation context hydration', () => {
  it('preserves a staged operation without canceling, executing, renewing or aliasing it', async () => {
    const s = await setup([]); s.transport.mockResolvedValue(preview('create_task', { title: 'Valor apresentado' }));
    const first = s.create(); const result = await first.send('Crie Valor apresentado');
    const exported = first.exportContext(); const expected = roundtrip(exported);
    const next = s.create(); next.importContext(exported);
    exported.staged!.proposal.effect.input!.title = 'Alterado fora';
    next.exportContext().staged!.proposal.effect.input!.title = 'Outra alteração fora';
    expect(roundtrip(next.exportContext())).toEqual(expected);
    expect(s.auth.cancel).not.toHaveBeenCalled(); expect(s.auth.approve).not.toHaveBeenCalled();
    expect((await next.approve(result!.approval!.id)).executed).toBe(true);
    expect(s.store.inspect().tasks[0].title).toBe('Valor apresentado');
    expect((await next.approve(result!.approval!.id)).executed).not.toBe(true);
    expect(s.auth.approve).toHaveBeenCalledTimes(1);
  });

  it('keeps a full-size valid task database out of the canonical review context without weakening verification', async () => {
    const rows = Array.from({ length: 110 }, (_, index) => ({ ...task(index + 1, `Tarefa válida ${index + 1}`), description: 'd'.repeat(5000) }));
    const s = await setup(rows); s.transport.mockResolvedValue(preview('create_task', { title: 'Nova tarefa válida' }));
    const first = s.create(); const result = await first.send('Crie Nova tarefa válida');
    const exported = first.exportContext();
    expect(new TextEncoder().encode(JSON.stringify({ tasks: rows })).byteLength).toBeGreaterThan(512 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(exported)).byteLength).toBeLessThan(512 * 1024);
    expect(exported.staged!.snapshot).toMatchObject({ revision: 0, taskCount: 110, othersDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(exported)).not.toContain('d'.repeat(5000));
    const next = s.migrate(first); expect((await next.approve(result!.approval!.id)).executed).toBe(true);
    expect(s.store.inspect().tasks).toHaveLength(111);
    expect(s.store.inspect().tasks.slice(0, 110)).toEqual(rows);
  });

  it('confirms a newly created task even when an identical task already exists', async () => {
    const existing = task(1, 'Tarefa repetida');
    const s = await setup([existing]);
    s.transport.mockResolvedValue(preview('create_task', { title: existing.title }));
    // Exercise confirmation independently of the local duplicate-title guard.
    const { id: _id, completed: _completed, ...input } = existing;
    const proposal = await s.auth.prepare({ kind: 'create_task', id: null, input, expectedRevision: 0 });
    const rows = [[existing.id, existing.completed, existing.title, existing.description, existing.priority, existing.project, existing.dueDate, existing.dueTime]];
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
    const othersDigest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const next = s.create(); const state = next.exportContext();
    state.staged = { proposal, snapshot: { revision: 0, taskCount: 1, othersDigest }, message: 'Crie Tarefa repetida', restoring: false, expiresAt: s.clock() + 900_000 };
    next.importContext(state); const receipt = await next.approve(proposal.proposalId);
    expect(receipt.executed).toBe(true);
    expect(s.store.inspect().tasks).toEqual([existing, { ...existing, id: 2 }]);
    expect(next.exportContext().previousId).toBe(2);
    expect(s.auth.approve).toHaveBeenCalledTimes(1);
  });

  it('rejects an approval response that changes an unrelated row despite matching revision and row count', async () => {
    const s = await setup([task(1, 'Outra tarefa')]); s.transport.mockResolvedValue(preview('create_task', { title: 'Nova tarefa' }));
    const first = s.create(); const result = await first.send('Crie Nova tarefa');
    const approve = s.auth.approve;
    s.auth.approve = vi.fn(async id => { const saved = await approve(id); saved.tasks[0].description = 'Alteração indevida no retorno'; return saved; });
    const next = s.migrate(first); const receipt = await next.approve(result!.approval!.id);
    expect(receipt.executed).not.toBe(true); expect(receipt.text).toContain('Não consegui confirmar o efeito autorizado');
    expect(s.store.inspect().tasks[0].description).toBe('');
    expect((await next.approve(result!.approval!.id)).text).toContain('já não está ativa');
  });

  it('keeps absolute proposal expiry across transfers', async () => {
    const s = await setup([]); s.transport.mockResolvedValue(preview('create_task', { title: 'Expira' }));
    let session = s.create(); const result = await session.send('Crie Expira');
    const expiresAt = session.exportContext().staged!.expiresAt;
    s.advance(899_000); session = s.migrate(session);
    expect(session.exportContext().staged!.expiresAt).toBe(expiresAt);
    s.advance(1000); expect((await session.approve(result!.approval!.id)).text).toContain('expirou');
    expect(s.auth.approve).not.toHaveBeenCalled(); expect(s.store.inspect().tasks).toEqual([]);
  });

  it('continues an ambiguous selection without another interpretation or granting approval', async () => {
    const s = await setup([task(1, 'Ensaio mensal'), task(2, 'Ensaio anual')]);
    s.transport.mockResolvedValue(preview('complete_task', { target: 'Ensaio' }));
    const first = s.create(); await first.send('Conclua Ensaio');
    const next = s.migrate(first); const selected = await next.send('2');
    expect(selected?.text).toContain('Ensaio anual'); expect(selected?.approval).toBeDefined();
    expect(s.auth.approve).not.toHaveBeenCalled(); expect(s.transport).toHaveBeenCalledTimes(1);
    await next.approve(selected!.approval!.id); expect(s.store.inspect().tasks.map(value => value.completed)).toEqual([false, true]);
  });

  it('retains task identity, meaning and the confirmed edit needed for a single undo', async () => {
    const s = await setup(); s.transport.mockResolvedValue(preview('update_task', { target: 'Ensaio fictício', priority: 'high' }));
    const first = s.create(); const edit = await first.send('Prioridade alta em Ensaio fictício do evento no projeto'); await first.approve(edit!.approval!.id);
    const context = first.exportContext();
    expect(context.previousId).toBe(1); expect(context.meaning?.id).toBe(1); expect(context.lastEdit?.before.priority).toBe('normal');
    const next = s.migrate(first); const restore = await next.send('Deixe como estava');
    expect(restore?.text).toContain('alta → normal'); expect(restore?.approval).toBeDefined();
    await next.approve(restore!.approval!.id); expect(s.store.inspect().tasks[0].priority).toBe('normal');
    const afterRestore = s.migrate(next); expect((await afterRestore.send('Deixe como estava'))?.approval).toBeUndefined();
    expect(s.transport).toHaveBeenCalledTimes(1);
  });

  it('routes a confirmed reference from Rust context before the new WebView task cache is ready', async () => {
    const s = await setup();
    s.transport.mockResolvedValue(preview('update_task', { target: 'Ensaio fictício', priority: 'high' }));
    const first = s.create(); const edit = await first.send('Prioridade alta em Ensaio fictício do evento no projeto');
    await first.approve(edit!.approval!.id);
    const context = roundtrip(first.exportContext());
    const read = vi.fn(async () => s.store.inspect());
    const cold = new TaskClient({ call: read, subscribe: async () => () => {} });
    const next = new AuthorizedTaskConversation(cold, new IntelligenceSession(s.transport, s.clock), s.clock, s.auth);
    next.importContext(context);
    const routing = next.routingContext('Desfaça a prioridade e corrija essa informação');
    expect(cold.getState().ready).toBe(false); expect(read).not.toHaveBeenCalled();
    expect(routing).toMatchObject({ revision: 1, previousTask: true, restorableFields: ['priority'] });
    expect(routing.context).toContain(context.lastEdit!.message);
    const interpret = vi.fn<AssistantInterpreter>().mockImplementation(async () => {
      expect(read).not.toHaveBeenCalled(); // Routing remains independent of database availability.
      return assistantPreview('task', { task: preview('update_task', { target: 'previous', priority: 'low' }).interpretation });
    });
    const assistant = new AssistantConversation(next, interpret, vi.fn(), s.clock);
    const result = await assistant.send('Altere a anterior para prioridade baixa.');
    expect(interpret.mock.calls[0][0].taskContext.previousTask).toBe(true);
    expect(read).toHaveBeenCalled();
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(s.auth.prepare).mock.invocationCallOrder.at(-1)!); // Fresh data precedes the proposal.
    expect(result?.approval).toBeDefined(); expect(s.store.inspect().tasks[0].priority).toBe('high');
    expect(s.auth.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, expectedRevision: 1 }));
  });

  it('rejects a canonical routing hint when fresh SQLite data changed before a cold-cache turn', async () => {
    const s = await setup(); s.transport.mockResolvedValue(preview('update_task', { target: 'Ensaio fictício', priority: 'high' }));
    const first = s.create(); const edit = await first.send('Prioridade alta em Ensaio fictício'); await first.approve(edit!.approval!.id);
    const cold = new TaskClient({ call: async () => s.store.inspect(), subscribe: async () => () => {} });
    const next = new AuthorizedTaskConversation(cold, new IntelligenceSession(s.transport, s.clock), s.clock, s.auth);
    next.importContext(roundtrip(first.exportContext()));
    const interpret = vi.fn<AssistantInterpreter>().mockImplementation(async () => {
      s.store.concurrentEdit(1, { title: 'Alteração concorrente' });
      return assistantPreview('task', { task: preview('update_task', { target: 'previous', priority: 'low' }).interpretation });
    });
    const before = vi.mocked(s.auth.prepare).mock.calls.length;
    const assistant = new AssistantConversation(next, interpret, vi.fn(), s.clock);
    expect((await assistant.send('Altere a anterior para prioridade baixa.'))?.text).toContain('As tarefas mudaram');
    expect(s.auth.prepare).toHaveBeenCalledTimes(before);
    expect(s.store.inspect().tasks[0]).toMatchObject({ title: 'Alteração concorrente', priority: 'high' });
  });

  it('preserves suggestions, their expiry and deduplication set between engines', async () => {
    const s = await setup([{ ...task(), dueDate: '2026-10-21' }]); s.transport.mockResolvedValue(preview('query_tasks'));
    const first = s.create(); expect((await first.send('Quais tarefas?'))?.text).toContain('prioridade alta');
    const context = first.exportContext(); expect(context.suggested).toHaveLength(1);
    const next = s.migrate(first); expect(next.exportContext().suggestion?.expiresAt).toBe(context.suggestion?.expiresAt);
    expect((await next.send('sim'))?.executed).toBe(true); expect(s.store.inspect().tasks[0].priority).toBe('high');
    expect(s.transport).toHaveBeenCalledTimes(1);
  });

  it('does not renew an expired suggestion or undo reference during hydration', async () => {
    const suggestion = await setup([{ ...task(), dueDate: '2026-10-21' }]);
    suggestion.transport.mockResolvedValue(preview('query_tasks'));
    const offered = suggestion.create(); await offered.send('Quais tarefas?'); suggestion.advance();
    const transferred = suggestion.migrate(offered);
    expect((await transferred.send('sim'))?.executed).not.toBe(true);
    expect(suggestion.auth.prepare).not.toHaveBeenCalled(); expect(suggestion.store.inspect().tasks[0].priority).toBe('normal');

    const edit = await setup(); edit.transport.mockResolvedValue(preview('update_task', { target: 'Ensaio fictício', priority: 'high' }));
    const first = edit.create(); const result = await first.send('Prioridade alta em Ensaio fictício'); await first.approve(result!.approval!.id);
    edit.advance(); const afterExpiry = edit.migrate(first);
    expect((await afterExpiry.send('Deixe como estava'))?.approval).toBeUndefined();
    expect(edit.auth.prepare).toHaveBeenCalledTimes(1); expect(edit.store.inspect().tasks[0].priority).toBe('high');
  });

  it('preserves temporal query context and personality turn counts', async () => {
    const s = await setup(); s.transport.mockResolvedValue(preview('query_tasks', { queryPeriod: 'this_week' }));
    const first = s.create(); await first.send('Quais tarefas nesta semana?');
    const next = s.migrate(first); const result = await next.send('E na próxima semana?');
    expect(result?.text).toContain('próxima semana'); expect(s.transport).toHaveBeenCalledTimes(1);
    expect(next.exportContext().personality.turn).toBe(2); expect(next.exportContext().previousQuery?.queryPeriod).toBe('next_week');
  });

  it('carries social context and task clarification through JSON without treating them as authority', async () => {
    const s = await setup([]); const clarify = preview('clarify'); clarify.interpretation.clarification = 'Qual título?';
    s.transport.mockResolvedValueOnce(preview('conversation')).mockResolvedValueOnce(clarify).mockResolvedValueOnce(preview('create_task', { title: 'Ensaio novo' }));
    const first = s.create(); await first.send('Olá'); const second = s.migrate(first);
    await second.send('Quero uma tarefa'); expect(s.transport.mock.calls[1][0].context).toContain('Olá');
    const third = s.migrate(second); const result = await third.send('Ensaio novo');
    expect(s.transport.mock.calls[2][0].context).toContain('Quero uma tarefa');
    expect(s.transport.mock.calls[2][0].context).toContain('Qual título?');
    expect(result?.approval).toBeDefined(); expect(s.auth.approve).not.toHaveBeenCalled();
  });

  it('preserves intelligence user history, draft and original TTL independently of transports', async () => {
    let now = 1000; const transport = vi.fn<IntelligenceTransport>().mockResolvedValue(preview('create_task', { title: 'Rascunho' }));
    const first = new IntelligenceSession(transport, () => now); await first.interpret('Criar Rascunho');
    const exported = first.exportContext(); const next = new IntelligenceSession(transport, () => now); next.importContext(roundtrip(exported));
    exported.context.push('Não incorporar'); exported.draft!.title = 'Mutação';
    await next.interpret('Amanhã'); expect(transport.mock.calls[1][0].context).toEqual(['Criar Rascunho']); expect(transport.mock.calls[1][0].previousDraft?.title).toBe('Rascunho');
    const old = first.exportContext(); now += 900_001; next.importContext(old); await next.interpret('Outro pedido');
    expect(transport.mock.calls[2][0].context).toEqual([]); expect(transport.mock.calls[2][0].previousDraft).toBeNull();
  });

  it('rejects hydration during pending interpretation and unsupported/oversized contexts', async () => {
    let finish!: (value: IntelligencePreview) => void;
    const intelligence = new IntelligenceSession(() => new Promise(resolve => { finish = resolve; }));
    const original = intelligence.exportContext(); const pending = intelligence.interpret('Pedido');
    expect(() => intelligence.importContext(original)).toThrow('em andamento'); finish(preview('conversation')); await pending;
    expect(() => intelligence.importContext({ ...original, version: 2 } as unknown as typeof original)).toThrow('inválido');
    const s = await setup(); const session = s.create(); const context = session.exportContext();
    expect(() => session.importContext({ ...context, socialContext: ['x'.repeat(1001)] })).toThrow('inválido');
    const personality = new ConversationPersonality(); expect(() => personality.importContext({ turn: -1 })).toThrow('inválido');
  });
});

const place: WeatherPlace = { id: 1, name: 'Belo Horizonte', admin1: 'Minas Gerais', country: 'Brasil', latitude: -19.92, longitude: -43.94, timezone: 'America/Sao_Paulo' };
const report: WeatherReport = { place, referenceTime: '2026-10-20T12:00', timezone: 'America/Sao_Paulo', retrievedAt: '2026-10-20T15:00:00Z', forecastDate: null, weatherCode: 2, temperature: 25, apparentTemperature: 26, precipitation: 0, minimum: null, maximum: null, rainProbability: null };

describe('cross-capability context hydration', () => {
  it('reuses a factual city and its original expiry in another engine', async () => {
    const s = await setup(); const interpreter = vi.fn<AssistantInterpreter>()
      .mockResolvedValueOnce(assistantPreview('weather', { city: 'Belo Horizonte' }))
      .mockResolvedValue(assistantPreview('browser_search', { query: 'passeios em {city}', usesCityContext: true }));
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report }); const open = vi.fn().mockResolvedValue(undefined);
    const make = () => new AssistantConversation(s.create(), interpreter, open, s.clock, weather);
    const first = make(); await first.send('Tempo em Belo Horizonte?'); const context = first.exportContext();
    s.advance(899_000); const next = make(); next.importContext(roundtrip(context));
    context.city!.place.name = 'Mutação';
    await next.send('Pesquise passeios nessa cidade'); expect(open).toHaveBeenCalledExactlyOnceWith('passeios em Belo Horizonte, Minas Gerais, Brasil');
    expect(next.exportContext().city?.expiresAt).toBe(first.exportContext().city?.expiresAt);
    s.advance(1000); const third = make(); third.importContext(roundtrip(next.exportContext()));
    expect((await third.send('Pesquise passeios nessa cidade'))?.text).toContain('Qual cidade'); expect(open).toHaveBeenCalledTimes(1);
  });

  it('continues city selection locally without repeating the semantic call', async () => {
    const s = await setup(); const other = { ...place, id: 2, admin1: 'Outro estado' };
    const weather = vi.fn<WeatherTransport>().mockResolvedValueOnce({ status: 'choose', choices: [place, other] }).mockResolvedValueOnce({ status: 'ready', report: { ...report, place: other } });
    const interpreter = vi.fn<AssistantInterpreter>().mockResolvedValue(assistantPreview('weather', { city: 'Belo Horizonte' }));
    const make = () => new AssistantConversation(s.create(), interpreter, vi.fn(), s.clock, weather);
    const first = make(); await first.send('Tempo em Belo Horizonte?'); const next = make(); next.importContext(roundtrip(first.exportContext()));
    await next.send('2'); expect(weather.mock.calls[1][0].place).toEqual(other); expect(interpreter).toHaveBeenCalledTimes(1);
  });

  it('preserves original clarification without renewal or hydration side effects', async () => {
    const s = await setup(); const interpreter = vi.fn<AssistantInterpreter>()
      .mockResolvedValueOnce(assistantPreview('clarify', { question: 'Qual cidade?' }))
      .mockResolvedValueOnce(assistantPreview('weather', { city: 'Belo Horizonte' }));
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report });
    const make = () => new AssistantConversation(s.create(), interpreter, vi.fn(), s.clock, weather);
    const first = make(); await first.send('Qual a previsão para sábado?'); const before = first.exportContext();
    const next = make(); next.importContext(roundtrip(before)); expect(roundtrip(next.exportContext())).toEqual(roundtrip(before));
    expect(s.auth.cancel).not.toHaveBeenCalled(); await next.send('Belo Horizonte');
    expect(interpreter.mock.calls[1][0].clarification).toContain('sábado'); expect(weather).toHaveBeenCalledTimes(1);
  });
});
