import { describe, expect, it, vi } from 'vitest';
import { AssistantConversation, explicitSearchRequest, type AssistantInterpretation, type AssistantInterpreter, type AssistantPreview } from './assistant-conversation';
import { AuthorizedTaskConversation } from './authorized-task-conversation';
import { TaskClient } from './tasks';
import { IntelligenceSession, type Interpretation } from './intelligence';
import { AuthorizationTaskStore } from './test-fixtures/authorization-task-store';
import type { AuthorizationTransport } from './conversation-authorization';
import type { WeatherPlace, WeatherReport, WeatherTransport } from './weather';

const result = (capability: AssistantInterpretation['capability'], query: string | null = null, patch: Partial<AssistantInterpretation> = {}): AssistantPreview => ({
  dryRun: true, executed: false, interpretation: {
    executionIntent: 'execute_now', capability, task: null, query, city: null, date: null, usesCityContext: false,
    question: capability === 'clarify' ? 'Qual assunto deseja pesquisar?' : null,
    ...patch,
  },
});
const tasks = () => new AuthorizedTaskConversation(new TaskClient({
  call: async () => ({ revision: 0, tasks: [] }), subscribe: async () => () => {},
}));

describe('pending intent regressions', () => {
  it('cancellation consumes the search clarification before later bare arguments', async () => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('clarify')).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn().mockResolvedValue(undefined);
    const conversation = new AssistantConversation(tasks(), interpret, open);
    await conversation.send('Pesquise');
    await conversation.send('cancelar');
    await conversation.send('notebooks');
    expect(interpret.mock.calls.at(-1)![0].clarification).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
  it('a browser capability with deferred intent cannot open immediately', async () => {
    const deferred = result('browser_search', 'notebooks');
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValue({ ...deferred,
      interpretation: { ...deferred.interpretation, executionIntent: 'deferred' } } as AssistantPreview);
    const open = vi.fn().mockResolvedValue(undefined);
    const conversation = new AssistantConversation(tasks(), interpret, open);
    await conversation.send('Pesquise notebooks se eu confirmar depois');
    expect(open).not.toHaveBeenCalled();
    expect(explicitSearchRequest('Pesquise notebooks se eu confirmar depois')).toBe(true); // Existing prefix guard alone is insufficient.
  });

  it('an uncancelled, live clarification can complete the same direct request', async () => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('clarify')).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn().mockResolvedValue(undefined);
    const conversation = new AssistantConversation(tasks(), interpret, open);
    await conversation.send('Pesquise'); await conversation.send('notebooks');
    expect(open).toHaveBeenCalledExactlyOnceWith('notebooks');
  });

  it.each(['cancelar', 'cancela', 'não', 'agora não'])('a new explicit request works after cancellation: %s', async cancel => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('clarify')).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn().mockResolvedValue(undefined);
    const conversation = new AssistantConversation(tasks(), interpret, open);
    await conversation.send('Pesquise'); await conversation.send(cancel); await conversation.send('Pesquise notebooks');
    expect(open).toHaveBeenCalledExactlyOnceWith('notebooks');
    expect(interpret).toHaveBeenCalledTimes(2);
    expect(interpret.mock.calls[1][0].clarification).toBeNull();
  });

  it.each([
    ['Pesquise notebooks', 'execute_now', true],
    ['Não pesquise notebooks', 'non_executive', false],
    ['Pesquise notebooks?', 'non_executive', false],
    ['Se eu pedisse para pesquisar notebooks?', 'non_executive', false],
    ['Pesquise notebooks se eu confirmar depois', 'deferred', false],
    ['Abra o Google quando eu autorizar', 'deferred', false],
  ] as const)('requires present execution intent independently of capability: %s', async (message, executionIntent, executes) => {
    const open = vi.fn().mockResolvedValue(undefined);
    const conversation = new AssistantConversation(tasks(), async () => result('browser_search', 'notebooks', { executionIntent }), open);
    await conversation.send(message);
    expect(open).toHaveBeenCalledTimes(executes ? 1 : 0);
  });

  it('does not retain deferred authorization for a later generic confirmation', async () => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('browser_search', 'notebooks', { executionIntent: 'deferred' })).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn().mockResolvedValue(undefined);
    const conversation = new AssistantConversation(tasks(), interpret, open);
    await conversation.send('Pesquise notebooks se eu confirmar depois'); await conversation.send('confirmo');
    expect(open).not.toHaveBeenCalled(); expect(interpret.mock.calls[1][0].clarification).toBeNull();
    await conversation.send('Pesquise notebooks agora'); expect(open).toHaveBeenCalledTimes(1);
  });

  it('capability selection alone cannot execute and cannot preserve old clarification on a malformed response', async () => {
    const malformed = result('browser_search', 'notebooks');
    delete (malformed.interpretation as Partial<AssistantInterpretation>).executionIntent;
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('clarify')).mockResolvedValueOnce(malformed).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn(); const conversation = new AssistantConversation(tasks(), interpret, open);
    await conversation.send('Pesquise'); await conversation.send('notebooks'); await conversation.send('notebooks');
    expect(open).not.toHaveBeenCalled(); expect(interpret.mock.calls.at(-1)![0].clarification).toBeNull();
  });

  it('non-executive clarification cannot be promoted to permission by later arguments', async () => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('clarify', null, { executionIntent: 'non_executive' })).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn(); const conversation = new AssistantConversation(tasks(), interpret, open);
    await conversation.send('Pesquise só se eu decidir depois'); await conversation.send('notebooks');
    expect(open).not.toHaveBeenCalled();
  });

  it('a failed clarification attempt is consumed before the next bare argument', async () => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('clarify')).mockRejectedValueOnce({ code: 'network', message: '' }).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn(); const conversation = new AssistantConversation(tasks(), interpret, open);
    await conversation.send('Pesquise'); await conversation.send('notebooks'); await conversation.send('notebooks');
    expect(open).not.toHaveBeenCalled(); expect(interpret.mock.calls.at(-1)![0].clarification).toBeNull();
  });

  it('expired clarification is not sent and does not authorize bare arguments', async () => {
    let now = 1000;
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('clarify')).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn(); const conversation = new AssistantConversation(tasks(), interpret, open, () => now);
    await conversation.send('Pesquise'); now += 15 * 60_000; await conversation.send('notebooks');
    expect(open).not.toHaveBeenCalled(); expect(interpret.mock.calls[1][0].clarification).toBeNull();
  });

  it('checks clarification expiry again after interpretation and does not renew it on follow-up questions', async () => {
    let now = 1000; let finish!: (preview: AssistantPreview) => void;
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('clarify')).mockResolvedValueOnce(result('clarify')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn(); const conversation = new AssistantConversation(tasks(), interpret, open, () => now);
    await conversation.send('Pesquise'); now += 14 * 60_000; await conversation.send('notebooks');
    const pending = conversation.send('notebooks'); now += 60_000; finish(result('clarify')); await pending;
    await conversation.send('notebooks'); expect(open).not.toHaveBeenCalled();
    expect(interpret.mock.calls.at(-1)![0].clarification).not.toContain('Pesquise');
  });

  it('semantic cancellation ends the request without inventing authority for the next turn', async () => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('clarify')).mockResolvedValueOnce(result('clarify', null, { executionIntent: 'cancel', question: null })).mockResolvedValue(result('browser_search', 'notebooks'));
    const open = vi.fn(); const conversation = new AssistantConversation(tasks(), interpret, open);
    await conversation.send('Pesquise'); await conversation.send('Pode esquecer esse pedido, por favor'); await conversation.send('notebooks');
    expect(open).not.toHaveBeenCalled(); expect(interpret.mock.calls.at(-1)![0].clarification).toBeNull();
  });
});

const city: WeatherPlace = { id: 1, name: 'Cidade sintética', admin1: 'Estado sintético', country: 'Brasil', latitude: -20, longitude: -40, timezone: 'America/Sao_Paulo' };
const report: WeatherReport = { place: city, referenceTime: '2026-10-25T10:00', retrievedAt: '2026-10-25T13:00:00Z', timezone: city.timezone, forecastDate: null, weatherCode: 2, temperature: 25, apparentTemperature: 26, precipitation: 0, minimum: null, maximum: null, rainProbability: null };

describe('cancellation shares lifecycle across capabilities and preserves facts', () => {
  it('preserves factual city data without inheriting a cancelled search request', async () => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('weather', null, { city: city.name })).mockResolvedValueOnce(result('clarify'))
      .mockResolvedValueOnce(result('browser_search', 'notebooks')).mockResolvedValueOnce(result('browser_search', 'passeios em {city}', { usesCityContext: true }));
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report });
    const open = vi.fn().mockResolvedValue(undefined); const conversation = new AssistantConversation(tasks(), interpret, open, Date.now, weather);
    await conversation.send('Como está o clima na Cidade sintética?'); await conversation.send('Pesquise'); await conversation.send('cancelar'); await conversation.send('notebooks');
    expect(open).not.toHaveBeenCalled();
    const next = interpret.mock.calls.at(-1)![0]; expect(next.clarification).toBeNull(); expect(next.activeCapability).toBeNull(); expect(next.cityContext).toContain(city.name);
    await conversation.send('Pesquise passeios nessa cidade'); expect(open).toHaveBeenCalledExactlyOnceWith('passeios em Cidade sintética, Estado sintético, Brasil');
    expect(weather).toHaveBeenCalledTimes(1);
  });

  it('cancels weather city selection without depending on storage or fetching again', async () => {
    const read = vi.fn().mockRejectedValue(new Error('isolated unavailable tasks'));
    const unavailable = new AuthorizedTaskConversation(new TaskClient({ call: read, subscribe: async () => () => {} }));
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('weather', null, { city: 'Cidade' })).mockResolvedValue(result('clarify', null, { executionIntent: 'non_executive', question: 'Qual cidade deseja consultar?' }));
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'choose', choices: [city, { ...city, id: 2 }] });
    const conversation = new AssistantConversation(unavailable, interpret, vi.fn(), Date.now, weather);
    await conversation.send('Clima na Cidade?'); const cancelled = await conversation.send('cancelar'); await conversation.send('1');
    expect(cancelled?.text).toContain('cancelada'); expect(weather).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
    expect(interpret.mock.calls[1][0].activeCapability).toBeNull(); expect(interpret.mock.calls[1][0].clarification).toBeNull();
  });

  it('does not consult weather on deferred or non-executive proposals', async () => {
    const weather = vi.fn(); const conversation = new AssistantConversation(tasks(), async () => result('weather', null, { city: city.name, executionIntent: 'deferred' }), vi.fn(), Date.now, weather);
    await conversation.send('Consulte o clima depois que eu confirmar'); expect(weather).not.toHaveBeenCalled();
  });

  it('idle cancellation does not require SQLite and does not renew factual city validity', async () => {
    let now = 1000; const read = vi.fn().mockRejectedValue(new Error('isolated unavailable tasks'));
    const unavailable = new AuthorizedTaskConversation(new TaskClient({ call: read, subscribe: async () => () => {} }));
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(result('weather', null, { city: city.name })).mockResolvedValue(result('browser_search', 'passeios em {city}', { usesCityContext: true }));
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report });
    const open = vi.fn(); const conversation = new AssistantConversation(unavailable, interpret, open, () => now, weather);
    await conversation.send('Qual é o clima na Cidade sintética?'); now += 14 * 60_000; await conversation.send('cancelar');
    expect(read).not.toHaveBeenCalled(); now += 60_000; await conversation.send('Pesquise passeios nessa cidade');
    expect(interpret.mock.calls.at(-1)![0].cityContext).toBeNull(); expect(open).not.toHaveBeenCalled();
  });

  it.each([false, true])('delegates exact task cancellation acknowledgement to v1 (IPC failure=%s)', async fails => {
    const store = new AuthorizationTaskStore([]); await store.client.start();
    const cancel = fails ? vi.fn().mockRejectedValue(new Error('synthetic IPC failure')) : vi.fn().mockResolvedValue(undefined);
    const auth: AuthorizationTransport = { prepare: vi.fn().mockImplementation(async effect => ({ proposalId: 'task-p1', effect, before: null, expiresInSeconds: 900 })), approve: vi.fn(), cancel };
    const legacy = vi.fn().mockRejectedValue(new Error('additional interpretation forbidden'));
    const taskConversation = new AuthorizedTaskConversation(store.client, new IntelligenceSession(legacy), Date.now, auth);
    const task: Interpretation = { intent: 'create_task', parameters: { title: 'Tarefa sintética', priority: null, project: null, dueDate: null, dueTime: null, target: null, panel: null }, reply: 'Proposta.', clarification: null, requiresConfirmation: false, usesPreviousDraft: false };
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValue(result('task', null, { task }));
    const conversation = new AssistantConversation(taskConversation, interpret, vi.fn());
    expect((await conversation.send('Crie Tarefa sintética'))?.approval).toBeDefined();
    const response = await conversation.send('cancelar');
    expect(cancel).toHaveBeenCalledExactlyOnceWith('task-p1'); expect(auth.approve).not.toHaveBeenCalled();
    expect(interpret).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
    expect(response?.text).toContain(fails ? 'não consegui confirmar' : 'foi cancelada');
    expect((await conversation.approve('task-p1')).executed).not.toBe(true);
    expect(store.inspect().tasks).toHaveLength(0);
  });
});
