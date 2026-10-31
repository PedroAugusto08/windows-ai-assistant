import { describe, expect, it, vi } from 'vitest';
import { AssistantConversation, explicitSearchRequest, type AssistantInterpretation, type AssistantInterpreter } from './assistant-conversation';
import { AuthorizedTaskConversation } from './authorized-task-conversation';
import { IntelligenceSession, type IntelligencePreview } from './intelligence';
import { AuthorizationTaskStore } from './test-fixtures/authorization-task-store';
import type { AuthorizationTransport } from './conversation-authorization';
import { TaskClient } from './tasks';
import type { WeatherPlace, WeatherReport, WeatherTransport } from './weather';

const preview = (capability: AssistantInterpretation['capability'] = 'browser_search', patch: Partial<AssistantInterpretation> = {}) => ({ dryRun: true as const, executed: false as const,
  interpretation: { executionIntent: 'execute_now' as const, capability, task: null, query: 'notebooks ASUS', city: null, date: null, usesCityContext: false, question: null, ...patch } });
const unavailableTasks = () => new AuthorizedTaskConversation(new TaskClient({ call: async () => { throw new Error('isolated unreadable store'); }, subscribe: async () => () => {} }));

describe('habitual browser search and dispatch', () => {
  it.each(['Pesquise sobre a atualização do Windows.', 'Abra o Google e procure notebooks ASUS.', 'Pesquise passeios em Belo Horizonte.', 'Pode buscar notebooks ASUS?', 'Busque informações sobre notebooks no Google', 'Faça uma pesquisa sobre notebooks ASUS', 'Pesquise como desfazer atualização do Windows', 'Pesquise por que não atualizar o Windows'])('accepts an explicit varied request: %s', async message => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValue(preview());
    const open = vi.fn().mockResolvedValue(undefined);
    const tasks = unavailableTasks(); const read = vi.spyOn(tasks, 'send');
    const assistant = new AssistantConversation(tasks, interpret, open);
    const result = await assistant.send(message);
    expect(interpret).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledExactlyOnceWith('notebooks ASUS'); expect(read).not.toHaveBeenCalled();
    expect(result?.text).toContain('Solicitei ao Windows'); expect(result?.text).toContain('Não consultei nem analisei');
  });
  it.each(['Não pesquise notebooks', 'Explique “pesquise notebooks”.', 'Ele disse para pesquisar notebooks.', 'Como pesquisar notebooks?', 'Pesquise notebooks e analise as fontes', 'Se eu pesquisar notebooks?', 'Pesquise e me responda com um resumo'])('does not grant browser permission from %s', async message => {
    expect(explicitSearchRequest(message)).toBe(false);
    const open = vi.fn(); const a = new AssistantConversation(unavailableTasks(), async () => preview(), open);
    expect((await a.send(message))?.executed).not.toBe(true); expect(open).not.toHaveBeenCalled();
  });
  it('does not substitute opening for in-conversation research', async () => {
    const open = vi.fn(); const a = new AssistantConversation(unavailableTasks(), async () => preview('research'), open);
    expect((await a.send('Pesquise notebooks e me explique'))?.text).toContain('ainda não está disponível'); expect(open).not.toHaveBeenCalled();
  });
  it('does not claim success or retry an unconfirmed OS request', async () => {
    const open = vi.fn().mockRejectedValue(new Error('private OS error'));
    const a = new AssistantConversation(unavailableTasks(), async () => preview(), open);
    const result = await a.send('Pesquise notebooks'); expect(open).toHaveBeenCalledTimes(1);
    expect(result?.text).toContain('Não consegui confirmar'); expect(result?.text).not.toContain('private'); expect(result?.executed).not.toBe(true);
  });
  it('clearing while interpretation is in flight prevents execution', async () => {
    let finish!: (p: ReturnType<typeof preview>) => void;
    const open = vi.fn(); const a = new AssistantConversation(unavailableTasks(), () => new Promise(resolve => { finish = resolve; }), open);
    const pending = a.send('Pesquise notebooks'); a.clear(); finish(preview());
    expect(await pending).toBeNull(); expect(open).not.toHaveBeenCalled();
  });
  it('blocks simultaneous sends, without suppressing a later deliberate repeat', async () => {
    let finish!: () => void; const open = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const a = new AssistantConversation(unavailableTasks(), async () => preview(), open);
    const pending = a.send('Pesquise notebooks'); await Promise.resolve();
    await a.send('Pesquise notebooks'); finish(); await pending;
    expect(open).toHaveBeenCalledTimes(1); await a.send('Pesquise notebooks'); expect(open).toHaveBeenCalledTimes(2);
  });
  it('uses the same interpretation for a task write and keeps v1 approval', async () => {
    const store = new AuthorizationTaskStore([]); await store.client.start();
    const legacyInterpret = vi.fn().mockRejectedValue(new Error('second model call forbidden'));
    const prepare = vi.fn().mockImplementation(async effect => ({ proposalId: 'p1', effect, before: null, expiresInSeconds: 900 }));
    const auth: AuthorizationTransport = { prepare, approve: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined) };
    const tasks = new AuthorizedTaskConversation(store.client, new IntelligenceSession(legacyInterpret), Date.now, auth);
    const task: IntelligencePreview['interpretation'] = { intent: 'create_task', parameters: { title: 'Ensaio fictício', priority: null, project: null, dueDate: null, dueTime: null, target: null, panel: null }, reply: 'Proposta.', clarification: null, requiresConfirmation: false, usesPreviousDraft: false };
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValue(preview('task', { query: null, task }));
    const a = new AssistantConversation(tasks, interpret, vi.fn());
    const result = await a.send('Crie a tarefa Ensaio fictício');
    expect(result?.approval).toBeDefined(); expect(prepare).toHaveBeenCalledTimes(1); expect(auth.approve).not.toHaveBeenCalled();
    expect(interpret).toHaveBeenCalledTimes(1); expect(legacyInterpret).not.toHaveBeenCalled(); expect(store.inspect().tasks).toHaveLength(0);
    interpret.mockRejectedValueOnce({ code: 'network', message: '' }); await a.send('Pesquise notebooks');
    expect(auth.cancel).toHaveBeenCalledWith('p1'); expect((await a.approve('p1')).executed).not.toBe(true);
  });
});

const city: WeatherPlace = { id: 3470127, name: 'Belo Horizonte', admin1: 'Minas Gerais', country: 'Brasil', latitude: -19.92, longitude: -43.94, timezone: 'America/Sao_Paulo' };
const report: WeatherReport = { place: city, referenceTime: '2026-10-24T12:00', timezone: 'America/Sao_Paulo', retrievedAt: '2026-10-24T15:00:00Z', forecastDate: null, weatherCode: 2, temperature: 25.5, apparentTemperature: 26, precipitation: 0, minimum: null, maximum: null, rainProbability: null };
const weatherPreview = (patch: Partial<AssistantInterpretation> = {}) => preview('weather', { query: null, city: 'Belo Horizonte', ...patch });

describe('weather and temporary cross-capability context', () => {
  it('reports provider data with location, reference and attribution, independently of tasks', async () => {
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report });
    const a = new AssistantConversation(unavailableTasks(), async () => weatherPreview(), vi.fn(), Date.now, weather);
    const result = await a.send('Como está o tempo em Belo Horizonte?');
    expect(weather).toHaveBeenCalledExactlyOnceWith({ city: 'Belo Horizonte', place: null, date: null });
    expect(result?.text).toContain('25,5 °C'); expect(result?.text).toContain('2026-10-24 12:00'); expect(result?.text).toContain('Open-Meteo, CC BY 4.0'); expect(result?.text).toContain('GeoNames');
    expect(result?.weatherAttribution).toBe(true);
  });
  it('passes a concrete forecast date and reports probability rather than inventing certainty', async () => {
    const forecast = { ...report, forecastDate: '2026-10-25', temperature: null, apparentTemperature: null, minimum: 19, maximum: 28, rainProbability: 80, precipitation: 3.5, weatherCode: 61 };
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report: forecast });
    const a = new AssistantConversation(unavailableTasks(), async () => weatherPreview({ date: '2026-10-25' }), vi.fn(), Date.now, weather);
    const result = await a.send('Vai chover amanhã em Belo Horizonte?');
    expect(weather.mock.calls[0][0].date).toBe('2026-10-25'); expect(result?.text).toContain('25/10/2026'); expect(result?.text).toContain('80%'); expect(result?.text).toContain('3,5 mm');
  });
  it('substitutes the locally resolved city in a browser query without another weather request', async () => {
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report });
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(weatherPreview()).mockResolvedValueOnce(preview('browser_search', { query: 'passeios em {city}', usesCityContext: true }));
    const open = vi.fn().mockResolvedValue(undefined);
    const a = new AssistantConversation(unavailableTasks(), interpret, open, Date.now, weather);
    await a.send('Como está o tempo em Belo Horizonte?'); await a.send('Pesquise passeios nessa cidade.');
    expect(open).toHaveBeenCalledExactlyOnceWith('passeios em Belo Horizonte, Minas Gerais, Brasil'); expect(weather).toHaveBeenCalledTimes(1); expect(interpret).toHaveBeenCalledTimes(2);
    const request = interpret.mock.calls[1][0]; expect(request.cityContext).toBe('Belo Horizonte, Minas Gerais, Brasil'); expect(JSON.stringify(request)).not.toContain('latitude');
  });
  it('reuses the resolved place for a weather continuation', async () => {
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report });
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(weatherPreview()).mockResolvedValueOnce(weatherPreview({ city: null, usesCityContext: true, date: '2026-10-25' }));
    const a = new AssistantConversation(unavailableTasks(), interpret, vi.fn(), Date.now, weather);
    await a.send('Como está o tempo em Belo Horizonte?'); await a.send('E amanhã?');
    expect(interpret.mock.calls[1][0].activeCapability).toBe('weather'); expect(weather.mock.calls[1][0]).toEqual({ city: null, place: city, date: '2026-10-25' });
  });
  it('does not guess a missing or expired city and never renews its TTL through searches', async () => {
    let now = 1000; const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report });
    const reference = preview('browser_search', { query: 'passeios em {city}', usesCityContext: true });
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(reference).mockResolvedValueOnce(weatherPreview()).mockResolvedValue(reference);
    const open = vi.fn().mockResolvedValue(undefined); const a = new AssistantConversation(unavailableTasks(), interpret, open, () => now, weather);
    expect((await a.send('Pesquise passeios nessa cidade'))?.text).toContain('Qual cidade'); expect(open).not.toHaveBeenCalled();
    await a.send('Como está o tempo em Belo Horizonte?'); now += 10 * 60_000; await a.send('Pesquise passeios nessa cidade');
    now += 5 * 60_000; expect((await a.send('Pesquise passeios nessa cidade'))?.text).toContain('Qual cidade'); expect(open).toHaveBeenCalledTimes(1);
    expect(interpret.mock.calls.at(-1)![0].cityContext).toBeNull();
  });
  it('checks city expiry again after a slow interpretation', async () => {
    let now = 1000; const open = vi.fn();
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report });
    let finish!: (p: ReturnType<typeof preview>) => void;
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(weatherPreview()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const a = new AssistantConversation(unavailableTasks(), interpret, open, () => now, weather);
    await a.send('Tempo em Belo Horizonte?'); const pending = a.send('Pesquise passeios nessa cidade'); now += 15 * 60_000;
    finish(preview('browser_search', { query: 'passeios em {city}', usesCityContext: true }));
    expect((await pending)?.text).toContain('Qual cidade'); expect(open).not.toHaveBeenCalled();
  });
  it('preserves ambiguity, asks for selection, then uses only the selected provider place', async () => {
    const other = { ...city, id: 2, admin1: 'Outro estado' };
    const weather = vi.fn<WeatherTransport>().mockResolvedValueOnce({ status: 'choose', choices: [city, other] }).mockResolvedValueOnce({ status: 'ready', report: { ...report, place: other } });
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValue(weatherPreview());
    const a = new AssistantConversation(unavailableTasks(), interpret, vi.fn(), Date.now, weather);
    expect((await a.send('Tempo em Belo Horizonte?'))?.text).toContain('mais de uma'); expect(weather).toHaveBeenCalledTimes(1);
    await a.send('2'); expect(interpret).toHaveBeenCalledTimes(1); expect(weather.mock.calls[1][0].place).toEqual(other);
  });
  it('expires a pending city selection and does not reuse it after clearing', async () => {
    let now = 1000; const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'choose', choices: [city, { ...city, id: 2 }] });
    const a = new AssistantConversation(unavailableTasks(), async () => weatherPreview(), vi.fn(), () => now, weather);
    await a.send('Tempo em Belo Horizonte?'); now += 15 * 60_000;
    expect((await a.send('1'))?.text).toContain('expirou'); expect(weather).toHaveBeenCalledTimes(1);
    a.clear();
  });
  it('does not confirm weather on failure, incomplete data or a response discarded by clear', async () => {
    const weather = vi.fn<WeatherTransport>().mockRejectedValueOnce(new Error('private network detail')).mockResolvedValueOnce({ status: 'ready', report: { ...report, temperature: null } });
    const a = new AssistantConversation(unavailableTasks(), async () => weatherPreview(), vi.fn(), Date.now, weather);
    for (let i = 0; i < 2; i++) { const result = await a.send('Tempo em Belo Horizonte?'); expect(result?.text).toContain('Não tenho uma previsão confirmada'); expect(result?.text).not.toContain('private'); }
    let finish!: (r: Awaited<ReturnType<WeatherTransport>>) => void;
    weather.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = a.send('Tempo em Belo Horizonte?'); await Promise.resolve(); a.clear(); finish({ status: 'ready', report }); expect(await pending).toBeNull();
  });
  it('carries missing-city clarification without a second interpretation in the turn', async () => {
    const interpret = vi.fn<AssistantInterpreter>().mockResolvedValueOnce(preview('clarify', { query: null, question: 'Para qual cidade deseja a previsão?' })).mockResolvedValueOnce(weatherPreview());
    const weather = vi.fn<WeatherTransport>().mockResolvedValue({ status: 'ready', report });
    const a = new AssistantConversation(unavailableTasks(), interpret, vi.fn(), Date.now, weather);
    await a.send('Qual a previsão para sábado?'); await a.send('Belo Horizonte');
    expect(interpret.mock.calls[1][0].clarification).toContain('sábado'); expect(interpret).toHaveBeenCalledTimes(2); expect(weather).toHaveBeenCalledTimes(1);
  });
  it('does not display model weather claims hidden inside clarification prose', async () => {
    const a = new AssistantConversation(unavailableTasks(), async () => preview('clarify', { query: null, question: 'A previsão será 35 graus e chuva forte. Qual cidade?' }), vi.fn());
    const result = await a.send('Qual a previsão?'); expect(result?.text).toContain('Qual cidade'); expect(result?.text).not.toContain('35'); expect(result?.text).not.toContain('chuva');
  });
});
