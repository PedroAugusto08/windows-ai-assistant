import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskConversation, resolveTasks, queryPeriodBounds } from './task-conversation';
import { IntelligenceSession, type IntelligencePreview, type IntelligenceTransport, type Interpretation } from './intelligence';
import { TaskClient, type Task, type TaskSnapshot } from './tasks';
const task = (id: number, title = 'Relatório'): Task => ({ id, title, description: 'privado', project: '', priority: 'normal', dueDate: null, dueTime: null, completed: false });
function interpretation(intent: Interpretation['intent'], parameters: Partial<Interpretation['parameters']> = {}, extra: Partial<Interpretation> = {}): IntelligencePreview {
  return { dryRun: true, executed: false, model: 'gemini-3.5-flash-lite', latencyMs: 1, requestCount: 1, promptTokens: null, outputTokens: null,
    interpretation: { intent, parameters: { title: null, priority: null, dueDate: null, dueTime: null, project: null, target: null, panel: null, status: null, ...parameters }, clarification: null, reply: 'Interpretei.', requiresConfirmation: false, usesPreviousDraft: false, ...extra } };
}
async function setup(tasks: Task[] = [], initialNow = Date.now()) {
  let snapshot: TaskSnapshot = { revision: 0, tasks }; let nextId = Math.max(0, ...tasks.map(t => t.id)) + 1;
  const call = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<TaskSnapshot> => {
    if (command === 'list_tasks') return structuredClone(snapshot);
    if (args?.expectedRevision !== snapshot.revision) throw 'As tarefas mudaram.';
    const id = args.id as number | null;
    if (command === 'save_task') {
      if (id === null) snapshot.tasks.push({ ...task(nextId++), ...args.input as Task });
      else snapshot.tasks = snapshot.tasks.map(t => t.id === id ? { ...t, ...args.input as Task } : t);
    } else if (command === 'delete_task') snapshot.tasks = snapshot.tasks.filter(t => t.id !== id);
    else snapshot.tasks = snapshot.tasks.map(t => t.id === id ? { ...t, completed: true } : t);
    snapshot.revision++; return structuredClone(snapshot);
  });
  const client = new TaskClient({ call, subscribe: async () => () => {} }); await client.start();
  const transport = vi.fn<IntelligenceTransport>();
  let now = initialNow;
  const session = new TaskConversation(client, new IntelligenceSession(transport, () => now), () => now);
  return { session, transport, call, client, db: () => snapshot, advance: (milliseconds = 16 * 60_000) => { now += milliseconds; } };
}
describe('operações reais por conversa', () => {
  it('cria, altera a anterior, conclui e vincula exclusão a confirmação única', async () => {
    const s = await setup();
    s.transport.mockResolvedValueOnce(interpretation('create_task', { title: 'Estudar', dueDate: '2099-10-09', dueTime: '19:00' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', priority: 'high' }))
      .mockResolvedValueOnce(interpretation('complete_task', { target: 'Estudar' }))
      .mockResolvedValueOnce(interpretation('delete_task', { target: 'Estudar' }));
    expect((await s.session.send('Preciso estudar amanhã às 19h'))?.executed).toBe(true);
    const update = await s.session.send('Coloca prioridade alta');
    expect(update?.text).toContain('prioridade agora é alta');
    expect(s.db().tasks[0]).toMatchObject({ id: 1, priority: 'high', dueTime: '19:00' });
    expect(s.transport.mock.calls[1][0]).toMatchObject({ previousTask: true, previousDraft: null, context: [] });
    expect(JSON.stringify(s.transport.mock.calls)).not.toContain('privado');
    await s.session.send('Terminei estudar'); expect(s.db().tasks[0].completed).toBe(true);
    expect((await s.session.send('Exclui estudar'))?.text).toContain('confirmo excluir 1');
    expect(s.db().tasks).toHaveLength(1);
    await s.session.send('confirmo excluir 1'); expect(s.db().tasks).toHaveLength(0);
    await s.session.send('confirmo excluir 1');
    expect(s.call.mock.calls.filter(([name]) => name === 'delete_task')).toHaveLength(1);
    expect(s.transport).toHaveBeenCalledTimes(4);
  });
  it('resolve ambiguidade sem API extra e sem escolher por suposição', async () => {
    const s = await setup([task(1, 'Relatório mensal'), task(2, 'Relatório anual')]);
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'relatório', priority: 'high' }));
    expect((await s.session.send('Prioridade alta no relatório'))?.text).toContain('Qual delas');
    expect(s.db().revision).toBe(0);
    await s.session.send('2'); expect(s.db().tasks[1].priority).toBe('high'); expect(s.db().tasks[0].priority).toBe('normal');
    expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it('bloqueia confirmação genérica, cancela e recusa confirmação sem pendência', async () => {
    const s = await setup([task(1)]); s.transport.mockResolvedValue(interpretation('delete_task', { target: 'Relatório' }));
    await s.session.send('Excluir relatório'); await s.session.send('sim');
    await s.session.send('confirmo excluir 1'); expect(s.db().tasks).toHaveLength(1);
    await s.session.send('Excluir relatório'); await s.session.send('cancelar');
    await s.session.send('confirmo excluir 1'); expect(s.db().tasks).toHaveLength(1);
  });
  it('invalida pendência se edição manual mudar o banco', async () => {
    const s = await setup([task(1)]); s.transport.mockResolvedValue(interpretation('delete_task', { target: 'Relatório' }));
    await s.session.send('Excluir relatório'); s.db().revision++;
    expect((await s.session.send('confirmo excluir 1'))?.text).toContain('mudaram'); expect(s.db().tasks).toHaveLength(1);
  });
  it('consulta registros reais com filtros e usa painel dinâmico', async () => {
    const s = await setup([task(1), { ...task(2), dueDate: '2099-10-09' }, { ...task(3), dueDate: '2099-10-09', completed: true }]);
    s.transport.mockResolvedValue(interpretation('query_tasks', { dueDate: '2099-10-09' }));
    expect(await s.session.send('O que tenho em 09/10/2099?')).toMatchObject({ panel: 'tasks', taskIds: [2] }); expect(s.db().revision).toBe(0);
    s.transport.mockResolvedValue(interpretation('query_tasks', { status: 'completed' }));
    expect(await s.session.send('Minhas tarefas concluídas')).toMatchObject({ taskIds: [3] });
  });
  it('reproduz a semana de 05 a 11/10 sem incluir prazos de 12 e 28/10', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 8, 12));
    try {
      const s = await setup([
        { ...task(1, 'Estudar para prova de física'), priority: 'high', dueDate: '2026-10-28' },
        { ...task(2, 'Terminar o JARVIS'), dueDate: '2026-10-12' },
      ]);
      s.transport.mockResolvedValue(interpretation('query_tasks', { priority: 'high' }));
      expect(await s.session.send('Tenho algo de importante para essa semana?')).toMatchObject({ taskIds: [] });
      expect(await s.session.send('Para essa semana.')).toMatchObject({ taskIds: [] });
      s.transport.mockResolvedValue(interpretation('query_tasks'));
      expect(await s.session.send('Tenho alguma tarefa para essa semana?')).toMatchObject({ taskIds: [] });
      expect(s.db().revision).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('não duplica envios nem tarefas equivalentes', async () => {
    const s = await setup(); s.transport.mockResolvedValue(interpretation('create_task', { title: 'Estudar' }));
    await s.session.send('Estudar'); await s.session.send('Estudar');
    expect(s.transport).toHaveBeenCalledTimes(1); expect(s.db().tasks).toHaveLength(1);
    await s.session.send('Preciso estudar'); expect(s.db().tasks).toHaveLength(1);
  });
  it('descarta interpretação limpa durante rede e impede envio concorrente', async () => {
    const s = await setup(); let resolve!: (p: IntelligencePreview) => void;
    s.transport.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = s.session.send('Estudar'); await vi.waitFor(() => expect(s.transport).toHaveBeenCalled());
    expect((await s.session.send('Estudar'))?.text).toContain('pedido anterior');
    s.session.clear(); resolve(interpretation('create_task', { title: 'Estudar' }));
    expect(await pending).toBeNull(); expect(s.db().tasks).toHaveLength(0);
  });
  it('falhas de interpretação, indisponibilidade e escrita nunca alegam sucesso', async () => {
    const s = await setup(); s.transport.mockRejectedValue({ code: 'network', message: 'segredo' });
    expect((await s.session.send('Estudar'))?.text).toContain('Nenhuma ação executada'); expect(s.db().revision).toBe(0);
    s.transport.mockResolvedValue(interpretation('create_task', { title: 'Estudar' }));
    const execute = vi.spyOn(s.client, 'execute').mockRejectedValue('erro');
    expect((await s.session.send('Estudar'))?.text).toContain('Não confirmei a operação'); expect(s.db().revision).toBe(0); execute.mockRestore();
    s.transport.mockResolvedValue(interpretation('clarify', {}, { clarification: 'Qual horário?' }));
    await s.session.send('Estudar à noite'); expect(s.db().revision).toBe(0);
  });
  it('preserva campos não alterados, inclusive prazo atrasado e descrição', async () => {
    const s = await setup([{ ...task(1), dueDate: '2000-01-01', dueTime: '19:00' }]);
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'relatório', priority: 'high' }));
    await s.session.send('Relatório prioridade alta'); expect(s.db().tasks[0]).toMatchObject({ description: 'privado', dueDate: '2000-01-01', dueTime: '19:00', priority: 'high' });
  });
  it('não usa alvo inventado e não usa referência anterior expirada', async () => {
    const s = await setup([task(1)]); s.transport.mockResolvedValue(interpretation('update_task', { target: 'relatório', priority: 'high' }));
    await s.session.send('prioridade alta'); expect(s.db().revision).toBe(0);
    await s.session.send('relatório prioridade alta'); s.advance();
    s.transport.mockResolvedValue(interpretation('complete_task', { target: 'a anterior' }));
    await s.session.send('terminei'); expect(s.db().tasks[0].completed).toBe(false);
  });
  it('rejeita contrato inválido sem mutação e capacidades indisponíveis', async () => {
    const s = await setup(); s.transport.mockResolvedValue({ ...interpretation('create_task', { title: 'Estudar' }), executed: true } as unknown as IntelligencePreview);
    expect((await s.session.send('Estudar'))?.text).toContain('Nenhuma ação executada');
    s.transport.mockResolvedValue(interpretation('unsupported')); expect((await s.session.send('Desligar o PC'))?.text).toContain('não está disponível'); expect(s.db().revision).toBe(0);
  });
  it('não grava em indisponibilidade do SQLite', async () => {
    const s = await setup(); s.call.mockRejectedValue('Banco indisponível');
    expect((await s.session.send('Estudar'))?.text).toContain('Nenhuma ação executada'); expect(s.transport).not.toHaveBeenCalled();
  });
  it('esclarece uma criação sem gravar e completa apenas após a resposta', async () => {
    const s = await setup();
    s.transport.mockResolvedValueOnce(interpretation('clarify', { title: 'Estudar' }, { clarification: 'Qual horário?' }))
      .mockResolvedValueOnce(interpretation('create_task', { title: 'Estudar', dueDate: '2099-01-01', dueTime: '19:00' }));
    await s.session.send('Estudar amanhã à noite'); expect(s.db().revision).toBe(0);
    await s.session.send('Às 19h'); expect(s.db().tasks).toHaveLength(1);
    expect(s.transport.mock.calls[1][0].context).toEqual(['Estudar amanhã à noite']);
  });
  it('rejeita escrita se outra janela gravar após a resolução', async () => {
    const s = await setup([task(1)]); s.transport.mockResolvedValue(interpretation('update_task', { target: 'relatório', priority: 'high' }));
    const original = s.client.execute.bind(s.client);
    vi.spyOn(s.client, 'execute').mockImplementation((command, args) => { s.db().revision++; return original(command, args); });
    expect((await s.session.send('Relatório prioridade alta'))?.text).toContain('Não confirmei a operação');
    expect(s.db().tasks[0].priority).toBe('normal');
  });
  it('altera prazo preservando título e não grava uma atualização incompleta', async () => {
    const s = await setup([{ ...task(1), dueDate: '2099-01-01', dueTime: '19:00' }]);
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'relatório', dueDate: '2099-01-02' }));
    const update = await s.session.send('Muda o prazo do relatório para amanhã');
    expect(update?.text).toContain('prazo');
    expect(s.db().tasks[0]).toMatchObject({ id: 1, title: 'Relatório', dueDate: '2099-01-02', dueTime: '19:00', description: 'privado' });
    const revision = s.db().revision;
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'relatório' }));
    await s.session.send('Atualiza o relatório'); expect(s.db().revision).toBe(revision);
  });
  it('uma tarefa com título exato não mascara outra correspondência plausível', async () => {
    const s = await setup([task(1), task(2, 'Relatório anual')]);
    s.transport.mockResolvedValue(interpretation('complete_task', { target: 'relatório' }));
    expect((await s.session.send('Terminei o relatório'))?.text).toContain('Qual delas'); expect(s.db().revision).toBe(0);
  });
  it('não usa texto de sucesso do modelo em conversa', async () => {
    const s = await setup(); s.transport.mockResolvedValue(interpretation('conversation', {}, { reply: 'Criei e excluí tudo.' }));
    expect((await s.session.send('Olá'))?.text).not.toContain('Criei'); expect(s.db().revision).toBe(0);
  });
  it('exige todas as palavras e preserva múltiplos títulos idênticos', () => {
    expect(resolveTasks([task(1, 'Relatório anual'), task(2, 'Relatório mensal')], 'relatório')).toHaveLength(2);
    expect(resolveTasks([task(1, 'Estudar'), task(2, 'Estudar')], 'estudar')).toHaveLength(2);
    expect(resolveTasks([task(1, 'Relatório anual')], 'relatório financeiro')).toHaveLength(0);
  });
});

describe('calendário local das consultas', () => {
  it.each([
    [new Date(2026, 9, 8), 'this_week', '2026-10-05', '2026-10-11'],
    [new Date(2026, 9, 11, 23, 59), 'this_week', '2026-10-05', '2026-10-11'],
    [new Date(2026, 9, 12), 'this_week', '2026-10-12', '2026-10-18'],
    [new Date(2026, 9, 31), 'next_week', '2026-11-02', '2026-11-08'],
    [new Date(2026, 11, 31), 'this_week', '2026-12-28', '2027-01-03'],
    [new Date(2026, 11, 31), 'next_week', '2027-01-04', '2027-01-10'],
    [new Date(2026, 11, 31, 23, 59), 'tomorrow', '2027-01-01', '2027-01-01'],
    [new Date(2026, 9, 8, 23, 59), 'today', '2026-10-08', '2026-10-08'],
  ] as const)('calcula %s / %s', (now, period, start, end) => {
    expect(queryPeriodBounds(period, now)).toEqual([start, end]);
  });
  it('aplica hoje e amanhã ao calendário local e expira correções', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 11, 31, 23, 59));
    try {
      const s = await setup([
        { ...task(1), dueDate: '2026-12-31' },
        { ...task(2), dueDate: '2027-01-01' },
        { ...task(3), dueDate: '2027-01-02' },
      ]);
      s.transport.mockResolvedValue(interpretation('query_tasks'));
      expect(await s.session.send('Tenho tarefas hoje?')).toMatchObject({ taskIds: [1] });
      expect(s.transport.mock.calls[0][0].localNow).toContain('2026-12-31T23:59');
      expect(await s.session.send('E amanhã?')).toMatchObject({ taskIds: [2] });
      expect(s.transport).toHaveBeenCalledTimes(1);
      s.advance();
      expect((await s.session.send('Para hoje'))?.text).toContain('Quais tarefas');
      expect(s.db().revision).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('combina prioridade, período e status e corrige só o período sem API extra', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 8, 12));
    try {
      const s = await setup([
        { ...task(1), priority: 'high', dueDate: '2026-10-05' },
        { ...task(2), priority: 'high', dueDate: '2026-10-11' },
        { ...task(3), priority: 'high', dueDate: '2026-10-12' },
        { ...task(4), dueDate: '2026-10-11' },
        { ...task(5), priority: 'high', dueDate: '2026-10-11', completed: true },
        { ...task(6), priority: 'high' },
        { ...task(7), priority: 'high', dueDate: '2026-10-04' },
      ]);
      s.transport.mockResolvedValue(interpretation('query_tasks', { priority: 'high', queryPeriod: 'this_week' }));
      expect(await s.session.send('Tarefas importantes nesta semana')).toMatchObject({ taskIds: [1, 2] });
      expect(await s.session.send('Para próxima semana')).toMatchObject({ taskIds: [3] });
      expect(s.transport).toHaveBeenCalledTimes(1);
      s.transport.mockResolvedValue(interpretation('query_tasks', { status: 'completed', queryPeriod: 'this_week' }));
      expect(await s.session.send('Concluídas nesta semana')).toMatchObject({ taskIds: [5] });
      s.transport.mockResolvedValue(interpretation('query_tasks', { status: 'overdue', queryPeriod: 'this_week' }));
      expect(await s.session.send('Atrasadas nesta semana')).toMatchObject({ taskIds: [1] });
      s.transport.mockResolvedValue(interpretation('query_tasks', { status: 'all', queryPeriod: 'this_week' }));
      expect((await s.session.send('Todas nesta semana'))?.taskIds?.sort()).toEqual([1, 2, 4, 5]);
      s.session.clear();
      expect((await s.session.send('Para essa semana'))?.text).toContain('Quais tarefas');
      expect(s.db().revision).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});


describe('personalidade e sugestões locais', () => {
  afterEach(() => vi.restoreAllMocks());
  async function nearTask() {
    const now = new Date(2026, 9, 8, 12).getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const s = await setup([{ ...task(1, 'Prova de física'), dueDate: '2026-10-09' }]);
    s.transport.mockResolvedValue(interpretation('query_tasks', { queryPeriod: 'tomorrow' }));
    return s;
  }
  it('varia redação e tratamento sem usar a confirmação do modelo', async () => {
    const s = await setup();
    s.transport.mockResolvedValueOnce(interpretation('create_task', { title: 'Relatório', priority: 'low', project: 'Trabalho' }, { reply: 'Apaguei tudo.' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', priority: 'high' }))
      .mockResolvedValueOnce(interpretation('complete_task', { target: 'a anterior' }));
    const replies = [await s.session.send('Preciso do relatório'), await s.session.send('Coloca prioridade alta'), await s.session.send('Terminei')];
    expect(replies[0]?.text).toMatch(/Registrei.*Relatório.*baixa.*Trabalho.*senhor/);
    expect(replies[1]?.text).toContain('prioridade agora é alta');
    expect(replies[1]?.text).not.toContain('senhor');
    expect(replies[2]?.text).toContain('senhor');
    expect(replies.every(r => r?.executed)).toBe(true);
    expect(s.transport).toHaveBeenCalledTimes(3);
  });
  it('usa prosa social do Gemini na mesma chamada', async () => {
    const s = await setup();
    s.transport.mockResolvedValue(interpretation('conversation', {}, { reply: 'Boa noite, senhor. Sempre um prazer ajudar.' }));
    expect((await s.session.send('Boa noite, Jarvis'))?.text).toBe('Boa noite, senhor. Sempre um prazer ajudar.');
    expect(s.db().revision).toBe(0); expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it.each(['Pode colocar.', 'Sim.', 'Pode ajustar', 'Sim, por favor'])('aceita %s para a tarefa oferecida, sem API extra', async message => {
    const s = await nearTask();
    const query = await s.session.send('Tenho algo para amanhã?');
    expect(query?.text).toContain('Prova de física'); expect(query?.text).toContain('prioridade alta?');
    expect(s.db().revision).toBe(0);
    const result = await s.session.send(message);
    expect(result?.executed).toBe(true); expect(result?.text).toContain('prioridade agora é alta');
    expect(s.db().tasks[0].priority).toBe('high'); expect(s.transport).toHaveBeenCalledTimes(1);
    await s.session.send(message); expect(s.db().revision).toBe(1);
    vi.restoreAllMocks();
  });
  it.each(['Não.', 'Deixa como está.', 'Agora não.'])('recusa %s e descarta a autorização', async message => {
    const s = await nearTask(); await s.session.send('Tenho algo para amanhã?');
    expect((await s.session.send(message))?.text).toContain('Deixei como está');
    expect((await s.session.send('Pode colocar'))?.text).toContain('Não há uma sugestão');
    expect(s.db().revision).toBe(0); expect(s.transport).toHaveBeenCalledTimes(1); vi.restoreAllMocks();
  });
  it.each(['clear', 'expire', 'revision', 'new-request'])('invalida sugestão por %s', async reason => {
    const s = await nearTask(); await s.session.send('Tenho algo para amanhã?');
    if (reason === 'clear') s.session.clear();
    if (reason === 'expire') s.advance();
    if (reason === 'revision') s.db().revision++;
    if (reason === 'new-request') {
      s.transport.mockResolvedValue(interpretation('query_tasks', { status: 'completed' }));
      await s.session.send('Consulte minhas tarefas concluídas');
    }
    const revision = s.db().revision;
    expect((await s.session.send('Pode colocar'))?.executed).not.toBe(true);
    expect(s.db().revision).toBe(revision); expect(s.db().tasks[0].priority).toBe('normal'); vi.restoreAllMocks();
  });
  it('não faz perguntas em toda operação nem repete sugestão recusada', async () => {
    const s = await nearTask(); await s.session.send('Tenho algo para amanhã?'); await s.session.send('Agora não');
    for (const message of ['Tarefas para amanhã', 'O que vence amanhã?', 'Consultar amanhã']) expect((await s.session.send(message))?.text).not.toContain('Gostaria');
    expect(s.db().revision).toBe(0); vi.restoreAllMocks();
  });
  it('aceite sem pendência não chama nem obedece ao modelo', async () => {
    const s = await setup([task(1)]);
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'a anterior', priority: 'high' }));
    for (const message of ['sim', 'pode colocar', 'ok']) expect((await s.session.send(message))?.text).toContain('Não há uma sugestão');
    expect(s.transport).not.toHaveBeenCalled(); expect(s.db().revision).toBe(0);
  });
  it('aceite genérico não resolve ambiguidade nem confirma exclusão', async () => {
    const s = await setup([task(1, 'Relatório mensal'), task(2, 'Relatório anual')]);
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'relatório', priority: 'high' }));
    await s.session.send('Relatório prioridade alta'); await s.session.send('Pode colocar');
    expect(s.db().revision).toBe(0);
    s.transport.mockResolvedValue(interpretation('delete_task', { target: 'Relatório mensal' }));
    await s.session.send('Excluir relatório mensal'); await s.session.send('Pode colocar'); await s.session.send('confirmo excluir 1');
    expect(s.db().tasks).toHaveLength(2); expect(s.db().revision).toBe(0);
  });
  it('falha ao aceitar sugestão não alega sucesso nem reusa aceite', async () => {
    const s = await nearTask(); await s.session.send('Tenho algo para amanhã?');
    vi.spyOn(s.client, 'execute').mockRejectedValue('falhou');
    const result = await s.session.send('Pode colocar');
    expect(result?.text).toContain('Não confirmei'); expect(result?.executed).not.toBe(true);
    expect((await s.session.send('Sim'))?.text).toContain('Não há uma sugestão');
    expect(s.db().revision).toBe(0); vi.restoreAllMocks();
  });
  it('confere revisão no IPC mesmo após aceite válido', async () => {
    const s = await nearTask(); await s.session.send('Tenho algo para amanhã?');
    const execute = s.client.execute.bind(s.client);
    vi.spyOn(s.client, 'execute').mockImplementation((command, args) => { s.db().revision++; return execute(command, args); });
    expect((await s.session.send('Pode colocar'))?.text).toContain('Não confirmei');
    expect(s.db().tasks[0].priority).toBe('normal'); vi.restoreAllMocks();
  });
  it('oferece revisão de atraso no painel sem modificar a tarefa', async () => {
    const s = await setup([{ ...task(1), dueDate: '2000-01-01' }]);
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'Relatório', priority: 'high' }));
    expect((await s.session.send('Relatório prioridade alta'))?.text).toContain('já passou');
    const revision = s.db().revision;
    expect(await s.session.send('Pode abrir')).toMatchObject({ panel: 'tasks', taskIds: [1] });
    expect(s.db().revision).toBe(revision); expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it('não confirma conclusão quando o retorno não comprova a mudança', async () => {
    const s = await setup([task(1)]);
    s.transport.mockResolvedValue(interpretation('complete_task', { target: 'Relatório' }));
    vi.spyOn(s.client, 'execute').mockResolvedValue({ revision: 1, tasks: [task(1)] });
    const result = await s.session.send('Terminei o relatório');
    expect(result?.text).toContain('Não confirmei'); expect(result?.executed).not.toBe(true);
  });
});


describe('limites da redação do modelo', () => {
  afterEach(() => vi.restoreAllMocks());
  it('preserva a saudação gerada quando a mesma resposta menciona tarefas', async () => {
    const s = await setup();
    s.transport.mockResolvedValue(interpretation('conversation', {}, { reply: 'Boa noite, senhor. Você tem tarefas amanhã. Como posso ajudar hoje?' }));
    expect((await s.session.send('Boa noite'))?.text).toBe('Boa noite, senhor. Como posso ajudar hoje?');
    expect(s.db().revision).toBe(0);
  });
  it.each(['Criei sua tarefa, senhor.', 'Você tem 3 tarefas amanhã.', 'Vou desligar o Windows.', 'A prioridade é alta.', 'Sua tarefa foi concluída.'])('não apresenta como conversa a alegação %s', async reply => {
    const s = await setup([task(1)]); s.transport.mockResolvedValue(interpretation('conversation', {}, { reply }));
    const result = await s.session.send('Olá'); expect(result?.text).not.toBe(reply); expect(s.db().revision).toBe(0);
  });
  it('esclarecimento não pode anunciar uma gravação', async () => {
    const s = await setup(); s.transport.mockResolvedValue(interpretation('clarify', {}, { clarification: 'Criei sua tarefa. Qual horário?' }));
    expect((await s.session.send('Estudar à noite'))?.text).not.toContain('Criei'); expect(s.db().revision).toBe(0);
  });
  it('recibo usa dados normalizados do banco e rejeita retorno incompatível', async () => {
    const s = await setup([task(1)]); s.transport.mockResolvedValue(interpretation('update_task', { target: 'Relatório', priority: 'high' }, { reply: 'Prioridade alta definida.' }));
    vi.spyOn(s.client, 'execute').mockResolvedValue({ revision: 1, tasks: [task(1)] });
    const result = await s.session.send('Relatório prioridade alta'); expect(result?.executed).not.toBe(true); expect(result?.text).not.toContain('Prioridade alta definida');
  });
  it('retém apenas a última troca social e descarta antes de transmitir dados locais', async () => {
    const s = await setup();
    s.transport.mockResolvedValueOnce(interpretation('conversation', {}, { reply: 'Boa noite, senhor. Sempre um prazer ajudar.' }))
      .mockResolvedValueOnce(interpretation('create_task', { title: 'Relatório privado' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', priority: 'high' }));
    await s.session.send('Boa noite, Jarvis'); await s.session.send('Preciso do relatório privado'); await s.session.send('Coloca prioridade alta');
    expect(s.transport.mock.calls[1][0].context).toEqual(['Boa noite, Jarvis', 'Boa noite, senhor. Sempre um prazer ajudar.']);
    expect(s.transport.mock.calls[2][0]).toMatchObject({ context: [], previousTask: true });
    expect(JSON.stringify(s.transport.mock.calls[2][0])).not.toContain('Relatório privado');
  });
  it('agradecimento preserva a tarefa anterior, sem enviar seu conteúdo ao modelo', async () => {
    const s = await setup();
    s.transport.mockResolvedValueOnce(interpretation('create_task', { title: 'Relatório' }))
      .mockResolvedValueOnce(interpretation('conversation', {}, { reply: 'À disposição, senhor.' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', priority: 'high' }));
    await s.session.send('Preciso do relatório'); await s.session.send('Obrigado'); await s.session.send('Coloca prioridade alta');
    expect(s.db().tasks[0].priority).toBe('high'); expect(s.transport.mock.calls[2][0].previousTask).toBe(true);
  });
  it('limpar durante IPC não recria uma sugestão ou referência', async () => {
    const s = await setup(); s.transport.mockResolvedValue(interpretation('create_task', { title: 'Estudar' }));
    let resolve!: (snapshot: TaskSnapshot) => void;
    vi.spyOn(s.client, 'execute').mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = s.session.send('Preciso estudar'); await vi.waitFor(() => expect(resolve).toBeDefined()); s.session.clear();
    resolve({ revision: 1, tasks: [task(1, 'Estudar')] }); await pending;
    expect((await s.session.send('Sim'))?.text).toContain('Não há uma sugestão');
  });
});


describe('regressões de continuidade da Personality', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  async function offered() {
    const s = await setup([], now);
    s.transport.mockResolvedValueOnce(interpretation('create_task', { title: 'prova', dueDate: '2026-10-10' }));
    const result = await s.session.send('Tenho prova amanhã');
    expect(result?.text).toContain('prioridade alta?');
    return s;
  }
  it('reproduz pode ser e a referência à oferta', async () => {
    const s = await offered();
    s.transport.mockResolvedValue(interpretation('conversation', {}, { reply: 'Senhor, pode ser carece de contexto.' }));
    expect((await s.session.send('pode ser'))?.executed).toBe(true);
    expect(s.db().tasks[0].priority).toBe('high');
  });
  it('uma mensagem não reconhecida preserva a sugestão para um aceite posterior', async () => {
    const s = await offered();
    s.transport.mockResolvedValue(interpretation('clarify', {}, { clarification: 'O senhor se refere à sugestão?' }));
    const doubtful = await s.session.send('hmm, não entendi bem');
    expect(doubtful?.executed).not.toBe(true);
    expect((await s.session.send('Faça o que vc sugeriu.'))?.executed).toBe(true);
    expect(s.db().tasks[0].priority).toBe('high');
  });
  it('remove repetição do título e prazo ao oferecer prioridade após criação', async () => {
    const s = await offered();
    s.session.clear();
    s.transport.mockResolvedValue(interpretation('create_task', { title: 'relatório', dueDate: '2026-10-10' }));
    const reply = (await s.session.send('Relatório para amanhã'))!.text;
    expect(reply.match(/relatório/g)).toHaveLength(1);
    expect(reply.match(/amanhã/g)).toHaveLength(1);
  });
  it('reproduz esta semana, semana que vem, semana do dia 23 e seguinte', async () => {
    const s = await setup([
      { ...task(1), dueDate: '2026-10-09' },
      { ...task(2), dueDate: '2026-10-12' },
      { ...task(3), dueDate: '2026-10-19' },
      { ...task(4), dueDate: '2026-10-25' },
      { ...task(5), dueDate: '2026-10-26' },
    ], now);
    s.transport.mockResolvedValueOnce(interpretation('query_tasks', { queryPeriod: 'this_week' }));
    s.transport.mockRejectedValue({ code: 'invalid_response', message: '' });
    expect(await s.session.send('O que tenho para esta semana?')).toMatchObject({ taskIds: [1] });
    expect(await s.session.send('E semana que vem?')).toMatchObject({ taskIds: [2] });
    const week = await s.session.send('E na semana do dia 23?');
    expect(week).toMatchObject({ taskIds: [3, 4] });
    expect(week?.text).toContain('19/10/2026'); expect(week?.text).toContain('25/10/2026');
    expect(await s.session.send('E na semana seguinte?')).toMatchObject({ taskIds: [5] });
    expect(s.transport).toHaveBeenCalledTimes(1); expect(s.db().revision).toBe(0);
  });
});


describe('aceites com contexto e salvaguardas', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  async function offered() {
    const s = await setup([{ ...task(7, 'prova'), dueDate: '2026-10-10' }, task(8, 'Outra tarefa')], now);
    s.transport.mockResolvedValueOnce(interpretation('query_tasks', { target: 'prova' }));
    await s.session.send('Consulte a prova');
    return s;
  }
  it.each(['pode ser', 'claro', 'pode fazer', 'faça isso', 'o que você sugeriu', 'Faça o que vc sugeriu.', 'Jarvis, pode ser, por favor.'])('aceita %s usando somente a oferta local', async message => {
    const s = await offered(); const result = await s.session.send(message);
    expect(result?.executed).toBe(true); expect(s.db().tasks[0].priority).toBe('high');
    expect(s.db().tasks[1].priority).toBe('normal'); expect(s.transport).toHaveBeenCalledTimes(1);
    await s.session.send(message); expect(s.db().revision).toBe(1);
  });
  it.each(['Não.', 'Agora não.', 'Deixe como está', 'melhor não', 'não precisa'])('recusa %s', async message => {
    const s = await offered(); await s.session.send(message); await s.session.send('pode ser');
    expect(s.db().revision).toBe(0); expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it.each(['pode ser', 'faça o que vc sugeriu', 'o que você sugeriu'])('não autoriza %s sem oferta', async message => {
    const s = await setup([task(7)], now); await s.session.send(message);
    expect(s.db().revision).toBe(0); expect(s.transport).not.toHaveBeenCalled();
  });
  it('interpreta formulação não catalogada com o tipo da oferta, sem enviar tarefa/ID', async () => {
    const s = await offered(); s.transport.mockResolvedValueOnce(interpretation('accept_suggestion'));
    expect((await s.session.send('Acho uma ótima ideia, pode seguir com ela.'))?.executed).toBe(true);
    const request = s.transport.mock.calls[1][0];
    expect(request.pendingSuggestion).toBe('priority'); expect(request.previousDraft).toBeNull();
    expect(JSON.stringify(request)).not.toContain('prova'); expect(JSON.stringify(request)).not.toContain('privado');
    expect(s.db().tasks[0].priority).toBe('high'); expect(s.db().tasks[1].priority).toBe('normal');
  });
  it('recusa semântica não grava', async () => {
    const s = await offered(); s.transport.mockResolvedValueOnce(interpretation('decline_suggestion'));
    await s.session.send('Prefiro manter as coisas do jeito que estão.'); await s.session.send('Pode fazer');
    expect(s.db().revision).toBe(0);
  });
  it('aceite semântico não pode incluir outros parâmetros ou confirmação', async () => {
    const s = await offered(); s.transport.mockResolvedValueOnce(interpretation('accept_suggestion', { target: 'Outra tarefa', priority: 'low' }));
    expect((await s.session.send('Pode seguir com sua ideia'))?.executed).not.toBe(true);
    expect(s.db().revision).toBe(0);
    s.transport.mockResolvedValueOnce(interpretation('accept_suggestion', {}, { requiresConfirmation: true }));
    expect((await s.session.send('Vamos fazer isso então'))?.executed).not.toBe(true);
    expect((await s.session.send('Pode ser'))?.executed).toBe(true);
  });
  it('pergunta sobre a sugestão e aceite condicional pedem esclarecimento sem consumir', async () => {
    const s = await offered();
    expect((await s.session.send('O que você sugeriu?'))?.text).toContain('Sugeri definir prioridade alta');
    expect(s.transport).toHaveBeenCalledTimes(1); expect(s.db().revision).toBe(0);
    s.transport.mockResolvedValueOnce(interpretation('clarify', {}, { clarification: 'O senhor quer aceitar?' }));
    await s.session.send('Pode ser, se não mudar mais nada'); expect(s.db().revision).toBe(0);
    expect((await s.session.send('Faça isso'))?.executed).toBe(true);
  });
  it('rede inválida não consome a oferta válida', async () => {
    const s = await offered(); s.transport.mockRejectedValue({ code: 'invalid_response', message: 'interno' });
    expect((await s.session.send('Talvez...'))?.text).toContain('Sugeri'); expect(s.db().revision).toBe(0);
    expect((await s.session.send('Pode ser'))?.executed).toBe(true);
  });
  it('atividade ambígua não renova os quinze minutos da oferta', async () => {
    const s = await offered(); s.advance(10 * 60_000);
    s.transport.mockResolvedValueOnce(interpretation('clarify', {}, { clarification: 'Deseja aceitar?' }));
    await s.session.send('Hmm, ainda pensando'); s.advance(5 * 60_000);
    expect((await s.session.send('Pode ser'))?.executed).not.toBe(true); expect(s.db().revision).toBe(0);
  });
  it('mudança de revisão após interpretação semântica invalida o aceite', async () => {
    const s = await offered(); s.transport.mockImplementationOnce(async () => {
      s.db().revision++; return interpretation('accept_suggestion');
    });
    expect((await s.session.send('Acho ótima sua ideia'))?.executed).not.toBe(true); expect(s.db().tasks[0].priority).toBe('normal');
  });
  it('limpeza durante classificação descarta o aceite semântico', async () => {
    const s = await offered(); let resolve!: (preview: IntelligencePreview) => void;
    s.transport.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const request = s.session.send('A ideia me agrada, pode seguir'); await vi.waitFor(() => expect(resolve).toBeDefined());
    s.session.clear(); resolve(interpretation('accept_suggestion')); expect(await request).toBeNull(); expect(s.db().revision).toBe(0);
  });
  it('aceite natural não confirma uma exclusão nem escolhe tarefa ambígua', async () => {
    const s = await setup([task(7, 'prova'), task(8, 'prova anual')], now);
    s.transport.mockResolvedValueOnce(interpretation('delete_task', { target: 'prova anual' }));
    await s.session.send('Excluir prova anual'); await s.session.send('Faça o que vc sugeriu'); await s.session.send('confirmo excluir 8');
    expect(s.db().tasks).toHaveLength(2);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'prova', priority: 'high' }));
    await s.session.send('Prova prioridade alta'); await s.session.send('Pode ser'); expect(s.db().revision).toBe(0);
  });
});

describe('semanas com data de referência', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  it('preserva prioridade, projeto, referência e status no complemento de período', async () => {
    const s = await setup([
      { ...task(1, 'Prova de física'), project: 'Estudos', priority: 'high', completed: true, dueDate: '2026-10-23' },
      { ...task(2, 'Prova de química'), project: 'Estudos', completed: true, dueDate: '2026-10-23' },
      { ...task(3, 'Prova de física'), priority: 'high', completed: true, dueDate: '2026-10-23' },
      { ...task(4, 'Relatório'), project: 'Estudos', priority: 'high', completed: true, dueDate: '2026-10-23' },
      { ...task(5, 'Prova de física'), project: 'Estudos', priority: 'high', dueDate: '2026-10-23' },
    ], now);
    s.transport.mockResolvedValueOnce(interpretation('query_tasks', { status: 'completed', project: 'Estudos', priority: 'high', target: 'prova', queryPeriod: 'this_week' }));
    await s.session.send('Provas concluídas de prioridade alta no projeto Estudos nesta semana');
    expect(await s.session.send('E na semana do dia 23?')).toMatchObject({ taskIds: [1] });
    expect(s.transport).toHaveBeenCalledTimes(1); expect(s.db().revision).toBe(0);
  });
  it.each([
    ['E na semana do dia 23/10/2026?', '2026-10-19', '2026-10-25'],
    ['E na semana de 2026-10-23?', '2026-10-19', '2026-10-25'],
    ['E na semana do dia 23 de outubro de 2026?', '2026-10-19', '2026-10-25'],
    ['E na semana do dia 01/11/2026?', '2026-10-26', '2026-11-01'],
    ['E na semana do dia 01/01/2027?', '2026-12-28', '2027-01-03'],
    ['E na semana do dia 29/02/2028?', '2028-02-28', '2028-03-05'],
  ])('resolve %s com calendário local', async (message, start, end) => {
    const s = await setup([{ ...task(1), dueDate: start }, { ...task(2), dueDate: end }, { ...task(3), dueDate: null }], now);
    const result = await s.session.send(message); expect(result?.taskIds).toEqual([1, 2]);
    expect(result?.text).toContain(start.split('-').reverse().join('/')); expect(result?.text).toContain(end.split('-').reverse().join('/'));
    expect(s.transport).not.toHaveBeenCalled();
  });
  it('semana seguinte atravessa o ano conservando filtros', async () => {
    const s = await setup([{ ...task(1), priority: 'high', dueDate: '2027-01-04' }, { ...task(2), dueDate: '2027-01-04' }], now);
    s.transport.mockResolvedValueOnce(interpretation('query_tasks', { priority: 'high', queryPeriod: 'week_of_date', dueDate: '2026-12-31' }));
    await s.session.send('Tarefas importantes na semana de 31/12/2026');
    expect(await s.session.send('E na semana seguinte?')).toMatchObject({ taskIds: [1] });
    expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it('usa o mês da consulta explícita anterior e não o mês atual', async () => {
    const s = await setup([{ ...task(1), dueDate: '2026-11-23' }, { ...task(2), dueDate: '2026-10-23' }], now);
    await s.session.send('Semana do dia 10/11/2026');
    expect(await s.session.send('E na semana do dia 23?')).toMatchObject({ taskIds: [1] });
  });
  it('uma semana relativa em dois meses exige esclarecimento para dia sem mês', async () => {
    const s = await setup([], new Date(2026, 9, 30, 12).getTime());
    s.transport.mockResolvedValueOnce(interpretation('query_tasks', { queryPeriod: 'this_week' }));
    await s.session.send('O que tenho nesta semana?');
    expect((await s.session.send('E na semana do dia 23?'))?.text).toContain('mês e ano');
    expect(s.transport).toHaveBeenCalledTimes(1);
    expect((await s.session.send('E na semana do dia 23/11/2026?'))?.text).toContain('23/11/2026');
  });
  it.each(['E na semana do dia 31/02/2026?', 'Semana do dia 29/02/2027', 'Semana do dia 0', 'Semana do dia 32', 'Semana do dia 23 de janeiro'])('esclarece data inválida ou ano inseguro em %s', async message => {
    const s = await setup([], now); const result = await s.session.send(message);
    expect(result?.text).toMatch(/Qual data|qual ano/); expect(result?.executed).not.toBe(true); expect(s.transport).not.toHaveBeenCalled();
  });
  it('semana seguinte sem consulta ou após expiração não presume referência', async () => {
    const s = await setup([], now);
    expect((await s.session.send('E na semana seguinte?'))?.text).toContain('qual data');
    await s.session.send('Semana do dia 23'); s.advance();
    expect((await s.session.send('E na semana seguinte?'))?.text).toContain('qual data');
  });
  it('erro interno de interpretação vira esclarecimento e conserva a última consulta', async () => {
    const s = await setup([], now); s.transport.mockResolvedValueOnce(interpretation('query_tasks', { priority: 'high' }));
    await s.session.send('Minhas prioridades'); s.transport.mockRejectedValueOnce({ code: 'invalid_response', message: 'segredo' });
    const result = await s.session.send('Um período que o modelo não representou');
    expect(result?.text).not.toContain('Gemini'); expect(result?.text).not.toContain('segredo'); expect(result?.text).toContain('Pode esclarecer');
    expect((await s.session.send('E na semana do dia 23?'))?.text).toContain('prioridade alta');
  });
});


describe('esclarecimento antes de executar uma oferta', () => {
  it.each(['Pode ser, mas só se for outra tarefa', 'Pode fazer?', 'Talvez essa sua ideia seja boa'])('não executa aceite semântico duvidoso: %s', async message => {
    const s = await setup([{ ...task(1), dueDate: '2026-10-10' }], new Date(2026, 9, 9, 12).getTime());
    s.transport.mockResolvedValueOnce(interpretation('query_tasks')).mockResolvedValueOnce(interpretation('accept_suggestion'));
    await s.session.send('Minhas tarefas'); await s.session.send(message);
    expect(s.db().revision).toBe(0); expect((await s.session.send('Pode ser'))?.executed).toBe(true);
  });
});

describe('restauração da última edição confirmada', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  it('restaura a prioridade original após aceite da sugestão, sem outra interpretação', async () => {
    const s = await setup([], now);
    s.transport.mockResolvedValueOnce(interpretation('create_task', { title: 'Prova', dueDate: '2026-10-10' }));
    await s.session.send('Tenho uma prova amanhã');
    await s.session.send('Pode ser');
    expect(s.db().tasks[0].priority).toBe('high');
    const result = await s.session.send('Na verdade, deixe como estava');
    expect(result?.executed).toBe(true);
    expect(s.db().tasks[0]).toMatchObject({ id: 1, priority: 'normal', dueDate: '2026-10-10' });
    expect(s.transport).toHaveBeenCalledTimes(1);
  });
});

describe('limites e concorrência na restauração de campos', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  async function edited(before: Task = task(1), patch: Partial<Interpretation['parameters']> = { priority: 'high' }) {
    const s = await setup([before], now);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: before.title, ...patch }));
    expect((await s.session.send(`Ajusta ${before.title}`))?.executed).toBe(true);
    return s;
  }
  it.each(['deixa como estava', 'volta para o anterior', 'desfaz essa alteração', 'Na verdade, deixe como estava, senhor', 'Restaure os valores anteriores'])('restaura por %s e consome uma única edição', async phrase => {
    const s = await edited({ ...task(1), priority: 'low' });
    expect((await s.session.send(phrase))?.executed).toBe(true);
    expect(s.db().tasks[0].priority).toBe('low');
    expect((await s.session.send('desfaça a última alteração'))?.executed).not.toBe(true);
    expect(s.db().revision).toBe(2);
    expect(s.transport).toHaveBeenCalledTimes(1);
    expect(s.call.mock.calls.filter(([name]) => name === 'save_task').map(([, args]) => args?.expectedRevision)).toEqual([0, 1]);
  });
  it.each([
    [null, null, '2026-10-12', '19:00'],
    ['2026-10-10', '08:00', '2026-10-12', '19:00'],
    ['2026-10-10', null, '2026-10-10', '19:00'],
  ])('restaura prazo/data/horário inclusive ausências: %s %s', async (dueDate, dueTime, nextDate, nextTime) => {
    const before = { ...task(1), dueDate, dueTime, project: 'Trabalho' };
    const s = await edited(before, { dueDate: nextDate, dueTime: nextTime });
    const result = await s.session.send('volta para o anterior');
    expect(result?.executed).toBe(true);
    expect(s.db().tasks[0]).toEqual(before);
    expect(result?.text).toContain(dueDate ? 'prazo ficou' : 'prazo foi removido');
    expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it('restaura todos os campos da única edição, sem desfazer a criação', async () => {
    const before = { ...task(1), project: 'Trabalho', dueDate: '2026-10-10' };
    const s = await edited(before, { title: 'Relatório revisado', project: 'Estudos', priority: 'low', dueDate: '2026-10-12' });
    expect((await s.session.send('desfaz essa alteração'))?.executed).toBe(true);
    expect(s.db().tasks).toEqual([before]);
  });
  it('guarda somente a última edição e não restaura outra tarefa', async () => {
    const s = await setup([task(1, 'Relatório'), task(2, 'Prova')], now);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Relatório', priority: 'high' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'Prova', priority: 'low' }));
    await s.session.send('Prioridade alta no relatório');
    await s.session.send('Prioridade baixa na prova');
    await s.session.send('deixa como estava');
    expect(s.db().tasks.map(t => t.priority)).toEqual(['high', 'normal']);
    await s.session.send('volta para o anterior');
    expect(s.db().revision).toBe(3);
  });
  it.each(['Desfaz as duas alterações', 'Desfaz essa alteração?', 'Deixa a outra tarefa como estava', 'Volta para o anterior se for possível', 'Desfaz essa alteração e exclui a prova'])('pede esclarecimento sem execução para %s', async phrase => {
    const s = await edited();
    expect((await s.session.send(phrase))?.text).toContain('Qual edição');
    expect(s.db().revision).toBe(1);
    expect(s.transport).toHaveBeenCalledTimes(1);
    await s.session.send('desfaz essa alteração');
    expect(s.db().tasks[0].priority).toBe('normal');
  });
  it('não presume edição sem contexto e não chama Gemini para inventar valores', async () => {
    const s = await setup([task(1)], now);
    expect((await s.session.send('deixa como estava'))?.text).toContain('Qual tarefa e valor');
    expect(s.db().revision).toBe(0);
    expect(s.transport).not.toHaveBeenCalled();
  });
  it.each(['create_task', 'complete_task', 'delete_task'] as const)('não desfaz %s nem reutiliza uma edição anterior', async intent => {
    const s = await edited();
    s.transport.mockResolvedValueOnce(interpretation(intent, intent === 'create_task' ? { title: 'Outra tarefa' } : { target: 'Relatório' }));
    await s.session.send(intent === 'create_task' ? 'Cria outra tarefa' : intent === 'complete_task' ? 'Terminei relatório' : 'Exclui relatório');
    if (intent === 'delete_task') await s.session.send('confirmo excluir 1');
    const before = structuredClone(s.db());
    expect((await s.session.send('desfaz essa alteração'))?.executed).not.toBe(true);
    expect(s.db()).toEqual(before);
  });
  it('não usa reversão para contornar seleção ambígua ou confirmação de exclusão', async () => {
    const s = await setup([task(1, 'Relatório mensal'), task(2, 'Relatório anual')], now);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'relatório', priority: 'high' }));
    await s.session.send('Prioridade alta no relatório');
    expect((await s.session.send('desfaz essa alteração'))?.text).toContain('Qual edição');
    expect(s.db().revision).toBe(0);
    await s.session.send('2');
    await s.session.send('deixa como estava');
    expect(s.db().tasks.map(t => t.priority)).toEqual(['normal', 'normal']);
  });
  it.each(['clear', 'expire', 'query'] as const)('encerra a referência em %s', async reason => {
    const s = await edited();
    if (reason === 'clear') s.session.clear();
    else if (reason === 'expire') s.advance();
    else {
      s.transport.mockResolvedValueOnce(interpretation('query_tasks'));
      await s.session.send('Lista as tarefas');
    }
    expect((await s.session.send('deixa como estava'))?.executed).not.toBe(true);
    expect(s.db().tasks[0].priority).toBe('high');
  });
  it('conversa social não renova o vencimento da edição', async () => {
    const s = await edited(); s.advance(10 * 60_000);
    s.transport.mockResolvedValueOnce(interpretation('conversation', {}, { reply: 'Estou à disposição, senhor.' }));
    await s.session.send('Obrigado'); s.advance(5 * 60_000);
    expect((await s.session.send('deixa como estava'))?.executed).not.toBe(true);
    expect(s.db().revision).toBe(1);
  });
  it('bloqueia a restauração se outra janela modificar o banco', async () => {
    const s = await edited(); s.db().tasks[0].priority = 'low'; s.db().revision++;
    expect((await s.session.send('deixa como estava'))?.text).toContain('mudaram');
    expect(s.db().tasks[0].priority).toBe('low');
    expect(s.call.mock.calls.filter(([name]) => name === 'save_task')).toHaveLength(1);
  });
  it('verifica também identidade e valores confirmados, mesmo com revisão incoerente', async () => {
    const s = await edited(); s.db().tasks[0].id = 2;
    expect((await s.session.send('deixa como estava'))?.text).toContain('mudaram');
    expect(s.db().revision).toBe(1);
  });
  it('mantém expectedRevision contra uma gravação concorrente entre leitura e IPC', async () => {
    const s = await edited();
    const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (command, args) => {
      if (command === 'save_task') { s.db().revision++; s.db().tasks[0].priority = 'low'; }
      return original(command, args);
    });
    const result = await s.session.send('deixa como estava');
    expect(result?.executed).not.toBe(true); expect(result?.text).toContain('nenhuma restauração foi confirmada');
    expect(s.db().tasks[0].priority).toBe('low');
    await s.session.send('volta para o anterior');
    expect(s.call.mock.calls.filter(([name]) => name === 'save_task')).toHaveLength(2);
  });
  it('falha de validação local não afirma restauração nem reutiliza autorização', async () => {
    const s = await edited({ ...task(1), dueDate: '2026-10-10' }, { dueDate: '2026-10-12' });
    const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (command, args) => {
      if (command === 'save_task') throw 'O prazo anterior já passou.';
      return original(command, args);
    });
    expect((await s.session.send('desfaz essa alteração'))?.executed).not.toBe(true);
    expect(s.db().tasks[0].dueDate).toBe('2026-10-12');
    await s.session.send('volta para o anterior');
    expect(s.call.mock.calls.filter(([name]) => name === 'save_task')).toHaveLength(2);
  });
  it('não confirma restauração quando o retorno não corresponde aos valores antigos', async () => {
    const s = await edited(); const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (command, args) => command === 'save_task' ? { revision: 2, tasks: [{ ...task(1), priority: 'high' }] } : original(command, args));
    expect((await s.session.send('deixa como estava'))?.text).toContain('Não consegui confirmar');
    expect(s.db().tasks[0].priority).toBe('high');
  });
  it('limpar durante a restauração não recria o contexto', async () => {
    const s = await edited(); const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (command, args) => {
      if (command === 'save_task') s.session.clear();
      return original(command, args);
    });
    expect((await s.session.send('deixa como estava'))?.text).toContain('conversa foi limpa');
    expect(s.db().tasks[0].priority).toBe('normal');
    expect((await s.session.send('volta para o anterior'))?.executed).not.toBe(true);
  });
});

describe('correções contextuais de campos — regressão', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  async function presentation() {
    const s = await setup([], now);
    s.transport.mockResolvedValueOnce(interpretation('create_task', { title: 'Apresentação', project: 'C&T', dueDate: '2026-10-22', dueTime: '14:15' }));
    await s.session.send('Tenho uma apresentação na C&T dia 22, às 14:15.');
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', project: 'Lis Analisys' }));
    await s.session.send('Na verdade o projeto é o Lis Analisys, C&T é o nome do evento.');
    return s;
  }
  it('não permite que uma nova menção ao evento sobrescreva o projeto corrigido', async () => {
    const s = await presentation();
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', project: 'C&T' }));
    expect((await s.session.send('Coloque que a apresentação é na C&T.'))?.executed).not.toBe(true);
    expect(s.db().tasks[0].project).toBe('Lis Analisys');
    expect(s.transport.mock.calls.at(-1)?.[0].context.join(' ')).toContain('nome do evento');
  });
  it('acrescenta informação ao título existente preservando campos não mencionados', async () => {
    const s = await presentation();
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T' }));
    expect((await s.session.send('Coloque C&T no título.'))?.executed).toBe(true);
    expect(s.db().tasks[0]).toMatchObject({ title: 'Apresentação na C&T', project: 'Lis Analisys', dueDate: '2026-10-22', dueTime: '14:15' });
  });
  it('combina restauração de um campo conhecido e acréscimo ao título em uma gravação', async () => {
    const s = await presentation();
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', project: 'C&T' }));
    await s.session.send('Mude o projeto para C&T.');
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['project'] }));
    expect((await s.session.send('Quis dizer para colocar no título. Volte como estava.'))?.executed).toBe(true);
    expect(s.db().tasks[0]).toMatchObject({ title: 'Apresentação na C&T', project: 'Lis Analisys', dueDate: '2026-10-22', dueTime: '14:15' });
  });
});

describe('validação local de correções de campos', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  const original = () => ({ ...task(1, 'Apresentação'), project: 'Lis Analisys', dueDate: '2026-10-22', dueTime: '14:15', priority: 'low' as const });
  async function prepared() { return setup([original()], now); }
  it('altera título e projeto numa única gravação preservando os outros campos', async () => {
    const s = await prepared(); s.transport.mockResolvedValue(interpretation('update_task', { target: 'Apresentação', title: 'Apresentação na C&T', project: 'Outro projeto' }));
    expect((await s.session.send('Na Apresentação, deixe o projeto como Outro projeto e mude o título para Apresentação na C&T'))?.executed).toBe(true);
    expect(s.db().tasks[0]).toEqual({ ...original(), title: 'Apresentação na C&T', project: 'Outro projeto' });
    expect(s.db().revision).toBe(1);
  });
  it.each([
    ['Coloque C&T no título da Apresentação', { titleSuffix: 'na C&T', project: 'C&T' }],
    ['O projeto da Apresentação é Lis Analisys', { project: 'Lis Analisys', title: 'Título indevido' }],
    ['Coloque C&T no título da Apresentação', { titleSuffix: 'na C&T', priority: 'high' }],
    ['Coloque C&T no título da Apresentação', { titleSuffix: 'na C&T', dueDate: '2026-10-23' }],
    ['Na verdade o projeto é outro', { project: 'Outro' }],
  ] as const)('bloqueia interpretação que modifica campos não autorizados: %s', async (message, patch) => {
    const s = await prepared(); s.transport.mockResolvedValue(interpretation('update_task', { target: 'Apresentação', ...patch }));
    expect((await s.session.send(message))?.executed).not.toBe(true);
    expect(s.db().tasks[0]).toEqual(original()); expect(s.db().revision).toBe(0);
  });
  it('registra esclarecimento sem gravação e transmite somente a mensagem necessária', async () => {
    const s = await prepared();
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', priority: 'high' }))
      .mockResolvedValueOnce(interpretation('clarify', {}, { clarification: 'Deseja colocar o evento no título?' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T' }));
    await s.session.send('Prioridade alta na Apresentação');
    await s.session.send('C&T é o nome do evento, não do projeto');
    expect(s.db().revision).toBe(1);
    expect((await s.session.send('Coloque essa informação no título'))?.executed).toBe(true);
    expect(s.db().tasks[0]).toEqual({ ...original(), priority: 'high', title: 'Apresentação na C&T' });
    const request = s.transport.mock.calls.at(-1)![0];
    expect(request.context.join(' ')).toContain('C&T é o nome do evento');
    expect(JSON.stringify(request)).not.toContain('privado');
    expect(JSON.stringify(request)).not.toContain('14:15');
  });
  it('instrução explícita posterior pode atribuir o evento ao projeto', async () => {
    const s = await prepared();
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'Lis Analisys' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', project: 'C&T' }));
    await s.session.send('Na Apresentação, o projeto é Lis Analisys, C&T é o nome do evento');
    expect((await s.session.send('Agora mude o projeto para C&T'))?.executed).toBe(true);
    expect(s.db().tasks[0].project).toBe('C&T');
  });
  it('mantém a restauração normal após uma correção de dois campos', async () => {
    const s = await prepared(); s.transport.mockResolvedValue(interpretation('update_task', { target: 'Apresentação', title: 'Apresentação na C&T', project: 'Novo' }));
    await s.session.send('Mude o título da Apresentação para Apresentação na C&T e o projeto para Novo');
    expect((await s.session.send('desfaz essa alteração'))?.executed).toBe(true);
    expect(s.db().tasks[0]).toEqual(original()); expect(s.transport).toHaveBeenCalledTimes(1);
  });
  it.each(['Quis dizer no título, não no projeto', 'Volte o projeto ao valor anterior e acrescente C&T no título'])('restaura apenas projeto e acrescenta ao título: %s', async message => {
    const s = await prepared(); s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'C&T' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['project'] }));
    await s.session.send('Mude o projeto da Apresentação para C&T');
    const result = await s.session.send(message);
    expect(result?.executed).toBe(true); expect(result?.text).toContain('título'); expect(result?.text).toContain('projeto');
    expect(s.db().tasks[0]).toEqual({ ...original(), title: 'Apresentação na C&T' });
    expect(s.db().revision).toBe(2);
    expect(s.transport.mock.calls[1][0].restorableFields).toEqual(['project']);
    expect(JSON.stringify(s.transport.mock.calls[1][0])).not.toContain('Lis Analisys');
  });
  it('não restaura campos arbitrários mesmo que estejam conhecidos no snapshot anterior', async () => {
    const s = await prepared(); s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'C&T' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['priority'] }));
    await s.session.send('Mude o projeto da Apresentação para C&T');
    expect((await s.session.send('Volte o projeto anterior e acrescente C&T no título'))?.executed).not.toBe(true);
    expect(s.db().revision).toBe(1); expect(s.db().tasks[0].project).toBe('C&T');
  });
  it('não infere restauração genérica entre múltiplos campos alterados', async () => {
    const s = await prepared(); s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'C&T', priority: 'high' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['project'] }));
    await s.session.send('Na Apresentação, projeto C&T e prioridade alta');
    expect((await s.session.send('Quis dizer para colocar no título. Volte como estava'))?.executed).not.toBe(true);
    expect(s.db().revision).toBe(1);
  });
  it.each(['expire', 'clear', 'concurrent'] as const)('não usa valores anteriores após %s', async reason => {
    const s = await prepared(); s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'C&T' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['project'] }));
    await s.session.send('Mude o projeto da Apresentação para C&T');
    if (reason === 'expire') s.advance(); else if (reason === 'clear') s.session.clear(); else s.db().revision++;
    const before = structuredClone(s.db());
    expect((await s.session.send('Volte o projeto anterior e acrescente C&T no título'))?.executed).not.toBe(true);
    expect(s.db()).toEqual(before);
  });
  it('bloqueia mudança concorrente durante interpretação contextual', async () => {
    const s = await prepared(); s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'C&T' }));
    await s.session.send('Mude o projeto da Apresentação para C&T');
    s.transport.mockImplementationOnce(async () => { s.db().revision++; s.db().tasks[0].project = 'Manual'; return interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['project'] }); });
    expect((await s.session.send('Volte o projeto anterior e acrescente C&T no título'))?.text).toContain('mudaram');
    expect(s.db().tasks[0]).toEqual({ ...original(), project: 'Manual' });
  });
  it('não cria acréscimo inventado ou acréscimo e substituição simultâneos', async () => {
    const s = await prepared(); s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', titleSuffix: 'na Conferência inventada' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', title: 'Apresentação na C&T', titleSuffix: 'na C&T' }));
    await s.session.send('Coloque C&T no título da Apresentação');
    await s.session.send('No título da Apresentação, acrescente C&T');
    expect(s.db().tasks[0]).toEqual(original()); expect(s.db().revision).toBe(0);
  });
  it('mensagem ambígua sem informação não escreve e não perde a referência da tarefa', async () => {
    const s = await prepared(); s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', priority: 'high' }))
      .mockResolvedValueOnce(interpretation('clarify', {}, { clarification: 'Qual informação deseja incluir no título?' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T' }));
    await s.session.send('Prioridade alta na Apresentação');
    expect((await s.session.send('Coloque essa informação no título'))?.executed).not.toBe(true);
    expect((await s.session.send('C&T no título'))?.executed).toBe(true);
    expect(s.db().tasks[0].title).toBe('Apresentação na C&T');
  });
  it('não duplica sufixo nem revive reversão antiga após edição sem mudança', async () => {
    const s = await prepared(); s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', titleSuffix: 'na C&T' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T' }));
    await s.session.send('Acrescente C&T no título da Apresentação');
    expect((await s.session.send('Inclua C&T no título'))?.executed).not.toBe(true);
    await s.session.send('desfaz essa alteração');
    expect(s.db().tasks[0].title).toBe('Apresentação na C&T'); expect(s.db().revision).toBe(1);
  });
});

describe('recibos sem alteração de campos adicionais', () => {
  it('aceita ecos dos dados já salvos, mas só altera o projeto explicitamente pedido', async () => {
    const s = await setup([{ ...task(1, 'Apresentação na C&T'), dueDate: '2026-10-22', dueTime: '14:15' }], new Date(2026, 9, 9, 12).getTime());
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'Apresentação', titleSuffix: 'na C&T', dueDate: '2026-10-22', dueTime: '14:15', project: 'Lis Analisys' }));
    expect((await s.session.send('Na apresentação, o projeto é Lis Analisys, C&T é o nome do evento'))?.executed).toBe(true);
    expect(s.db().tasks[0]).toMatchObject({ title: 'Apresentação na C&T', project: 'Lis Analisys', dueDate: '2026-10-22', dueTime: '14:15' });
  });
});

describe('valor explícito do projeto na correção de significado', () => {
  it('bloqueia C&T como projeto quando o usuário atribuiu Lis Analisys a esse campo', async () => {
    const s = await setup([{ ...task(1, 'Apresentação'), project: 'C&T' }], new Date(2026, 9, 9, 12).getTime());
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'Apresentação', project: 'C&T' }));
    const result = await s.session.send('Na apresentação, o projeto é o Lis Analisys, C&T é o nome do evento');
    expect(result?.text).toContain('nenhuma alteração');
    expect(s.call.mock.calls.filter(([name]) => name === 'save_task')).toHaveLength(0);
  });
});

describe('isolamento do contexto semântico', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  it('preserva o esclarecimento durante conversa social sem enviar estado anterior', async () => {
    const s = await setup([{ ...task(1, 'Apresentação'), project: 'Lis Analisys' }], now);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'Lis Analisys' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', project: 'C&T' }))
      .mockResolvedValueOnce(interpretation('conversation', {}, { reply: 'Sempre à disposição, senhor.' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['project'] }));
    await s.session.send('Na apresentação, o projeto é Lis Analisys, C&T é o nome do evento');
    await s.session.send('Mude o projeto para C&T');
    await s.session.send('Obrigado');
    expect((await s.session.send('Quis dizer no título, não no projeto'))?.executed).toBe(true);
    const request = s.transport.mock.calls.at(-1)![0];
    expect(request.context.join(' ')).toContain('nome do evento');
    expect(request.context.join(' ')).not.toContain('Sempre à disposição');
    expect(request.context.length).toBeLessThanOrEqual(3);
  });
  it('não transfere o significado de evento para outra tarefa', async () => {
    const s = await setup([task(1, 'Apresentação'), task(2, 'Relatório')], now);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'Lis Analisys' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'Relatório', priority: 'high' }))
      .mockResolvedValueOnce(interpretation('clarify', {}, { clarification: 'Qual informação deseja incluir?' }));
    await s.session.send('Na apresentação, o projeto é Lis Analisys, C&T é o nome do evento');
    await s.session.send('No relatório, prioridade alta');
    await s.session.send('Coloque essa informação no título');
    expect(s.transport.mock.calls.at(-1)![0].context.join(' ')).not.toContain('nome do evento');
    expect(s.db().tasks[1].title).toBe('Relatório');
  });
  it('não aplica parte de uma combinação com exclusão independente', async () => {
    const s = await setup([task(1, 'Apresentação')], now);
    s.transport.mockResolvedValue(interpretation('update_task', { target: 'Apresentação', title: 'Novo título', project: 'Estudos' }));
    expect((await s.session.send('Mude o título da Apresentação para Novo título e projeto Estudos e exclua outra tarefa'))?.executed).not.toBe(true);
    expect(s.db().revision).toBe(0);
  });
});

describe('campos identificados e atomicidade da correção combinada', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  it('identifica projeto negado explicitamente sem restaurar a prioridade da mesma edição', async () => {
    const s = await setup([{ ...task(1, 'Apresentação'), project: 'Lis Analisys' }], now);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'C&T', priority: 'high' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['project'] }));
    await s.session.send('Na Apresentação, projeto C&T e prioridade alta');
    expect((await s.session.send('Quis dizer no título, não no projeto'))?.executed).toBe(true);
    expect(s.db().tasks[0]).toMatchObject({ title: 'Apresentação na C&T', project: 'Lis Analisys', priority: 'high' });
  });
  it('não grava parcialmente os dois campos quando outra janela muda a revisão no IPC', async () => {
    const s = await setup([{ ...task(1, 'Apresentação'), project: 'Lis Analisys', dueDate: '2026-10-22', dueTime: '14:15' }], now);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'C&T' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['project'] }));
    await s.session.send('Projeto da Apresentação para C&T');
    const original = s.call.getMockImplementation()!;
    s.call.mockImplementation(async (command, args) => {
      if (command === 'save_task') { s.db().revision++; s.db().tasks[0].project = 'Manual'; }
      return original(command, args);
    });
    expect((await s.session.send('Volte o projeto ao anterior e acrescente C&T no título'))?.executed).not.toBe(true);
    expect(s.db().tasks[0]).toMatchObject({ title: 'Apresentação', project: 'Manual', dueDate: '2026-10-22', dueTime: '14:15' });
    await s.session.send('desfaz essa alteração');
    expect(s.call.mock.calls.filter(([name]) => name === 'save_task')).toHaveLength(2);
  });
  it('contexto de significado expira sem renovação por conversa social', async () => {
    const s = await setup([task(1, 'Apresentação')], now);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'Lis Analisys' }))
      .mockResolvedValueOnce(interpretation('conversation', {}, { reply: 'Sempre à disposição, senhor.' }));
    await s.session.send('Na apresentação, o projeto é Lis Analisys, C&T é nome do evento');
    s.advance(10 * 60_000); await s.session.send('Obrigado'); s.advance(6 * 60_000);
    expect((await s.session.send('Coloque essa informação no título'))?.text).toContain('referência já não está segura');
    expect(s.transport).toHaveBeenCalledTimes(2); expect(s.db().tasks[0].title).toBe('Apresentação');
  });
});

describe('referência após uma interpretação recusada', () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  it('não restaura uma edição mais antiga ao corrigir um pedido que não foi executado', async () => {
    const s = await setup([{ ...task(1, 'Apresentação'), project: 'C&T' }], now);
    s.transport.mockResolvedValueOnce(interpretation('update_task', { target: 'Apresentação', project: 'Lis Analisys' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', project: 'C&T' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T', restoreFields: ['project'] }));
    await s.session.send('Na Apresentação, o projeto é Lis Analisys, C&T é o nome do evento');
    await s.session.send('Coloque que a apresentação é na C&T');
    expect((await s.session.send('Quis dizer para colocar no título. Volte como estava'))?.executed).not.toBe(true);
    expect(s.db().tasks[0]).toMatchObject({ title: 'Apresentação', project: 'Lis Analisys' });
    expect(s.transport.mock.calls.at(-1)![0].restorableFields).toEqual([]);
  });
  it('termina a sequência original com título, projeto, data e horário corretos', async () => {
    const s = await setup([], now);
    s.transport.mockResolvedValueOnce(interpretation('create_task', { title: 'Apresentação', project: 'C&T', dueDate: '2026-10-22', dueTime: '14:15' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', project: 'Lis Analisys' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', titleSuffix: 'na C&T' }))
      .mockResolvedValueOnce(interpretation('clarify', {}, { clarification: 'O título já contém C&T. Qual campo deseja restaurar?' }))
      .mockResolvedValueOnce(interpretation('update_task', { target: 'a anterior', project: 'Lis Analisys' }));
    await s.session.send('Tenho uma apresentação na C&T dia 22, às 14:15.');
    await s.session.send('Na verdade o projeto é o Lis Analisys, C&T é o nome do evento.');
    await s.session.send('Coloque que a apresentação é na C&T.');
    expect((await s.session.send('Quis dizer para colocar no título. Volte como estava.'))?.executed).not.toBe(true);
    await s.session.send('O projeto para Lis Analisys.');
    expect(s.db().tasks).toHaveLength(1);
    expect(s.db().tasks[0]).toMatchObject({ title: 'Apresentação na C&T', project: 'Lis Analisys', dueDate: '2026-10-22', dueTime: '14:15', priority: 'normal' });
    expect(s.db().revision).toBe(3);
  });
});
