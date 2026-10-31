import { describe, expect, it, vi } from 'vitest';
import { emptyTask, isTaskOverdue, selectTasks, TaskClient, taskDeadline, type Task, type TaskSnapshot, type TaskTransport } from './tasks';
const task = (id: number, patch: Partial<Task> = {}): Task => ({ ...emptyTask(), id, title: `Tarefa ${id}`, completed: false, ...patch });
const snapshot = (revision: number, tasks = [task(revision)]): TaskSnapshot => ({ revision, tasks });
function fixture() {
  let receive: (value: TaskSnapshot) => void = () => {};
  const call = vi.fn<TaskTransport['call']>().mockResolvedValue(snapshot(0, []));
  const off = vi.fn();
  const transport: TaskTransport = { call, subscribe: async callback => { receive = callback; return off; } };
  const client = new TaskClient(transport);
  return { client, call, off, emit: (value: TaskSnapshot) => receive(value) };
}
describe('tarefas locais', () => {
  it('ordena pendentes por prioridade, prazo e identificador sem alterar a origem', () => {
    const tasks = [task(1), task(2, { priority: 'low', dueDate: '2020-01-01' }), task(3, { priority: 'high' }), task(4, { priority: 'high', dueDate: '2026-10-09' }), task(5, { priority: 'high', dueDate: '2026-10-08' }), task(6, { completed: true, priority: 'high' })];
    expect(selectTasks(tasks).map(t => t.id)).toEqual([5, 4, 3, 1, 2]);
    expect(selectTasks(tasks, 'completed').map(t => t.id)).toEqual([6]);
    expect(selectTasks(tasks, 'all')).toHaveLength(6);
    expect(tasks.map(t => t.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('diferencia prazo no fim do dia, horário vencido e tarefa concluída', () => {
    const now = new Date(2026, 9, 8, 23, 30, 0, 0);
    const noTime = task(1, { dueDate: '2026-10-08' });
    expect(isTaskOverdue(noTime, now)).toBe(false);
    expect(taskDeadline(noTime, now)).toBe('Hoje · 08/10/2026');
    const earlyTime = task(2, { dueDate: '2026-10-08', dueTime: '23:29' });
    expect(isTaskOverdue(earlyTime, now)).toBe(true);
    expect(taskDeadline(earlyTime, now)).toBe('Hoje · 08/10/2026 · 23:29');
    expect(isTaskOverdue(task(3, { dueDate: '2026-10-08', dueTime: '23:31' }), now)).toBe(false);
    expect(isTaskOverdue(task(4, { dueDate: '2026-10-07' }), now)).toBe(true);
    expect(isTaskOverdue(task(5, { dueDate: '2026-10-07', completed: true }), now)).toBe(false);
    expect(isTaskOverdue(task(6), now)).toBe(false);
    expect(taskDeadline(task(2, { dueDate: '2026-10-08', dueTime: '23:29', completed: true }), now)).toBe('Hoje · 08/10/2026 · 23:29');
    expect(isTaskOverdue(noTime, new Date(2026, 9, 8, 23, 59, 59, 998))).toBe(false);
    expect(isTaskOverdue(noTime, new Date(2026, 9, 8, 23, 59, 59, 999))).toBe(true);
  });
  it('ordena horários antes de prazos no fim da mesma data', () => {
    const tasks = [task(1, { dueDate: '2026-10-08' }), task(2, { dueDate: '2026-10-08', dueTime: '18:30' }), task(3, { dueDate: '2026-10-08', dueTime: '09:00' }), task(4, { dueDate: '2026-10-08', dueTime: '23:59' })];
    expect(selectTasks(tasks).map(t => t.id)).toEqual([3, 2, 4, 1]);
  });
  it('escuta antes da leitura e rejeita respostas antigas', async () => {
    const f = fixture();
    let resolve!: (value: TaskSnapshot) => void;
    f.call.mockImplementationOnce(() => new Promise(r => { resolve = r as typeof resolve; }));
    const started = f.client.start(); await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
    f.emit(snapshot(2)); resolve(snapshot(1)); const off = await started;
    expect(f.client.getState().snapshot.revision).toBe(2);
    f.emit(snapshot(1)); expect(f.client.getState().snapshot.revision).toBe(2);
    off(); expect(f.off).toHaveBeenCalledOnce();
  });
  it('encaminha operações e aceita somente o resultado persistido', async () => {
    const f = fixture(); await f.client.start();
    f.call.mockResolvedValueOnce(snapshot(1));
    expect(await f.client.save(null, { ...emptyTask(), title: 'Nova' })).toBe(true);
    expect(f.call).toHaveBeenLastCalledWith('save_task', { id: null, input: { ...emptyTask(), title: 'Nova' } });
    f.call.mockResolvedValueOnce(snapshot(2)); await f.client.save(1, { ...emptyTask(), title: 'Editada' });
    f.call.mockResolvedValueOnce(snapshot(3)); await f.client.complete(1, true);
    expect(f.call).toHaveBeenLastCalledWith('complete_task', { id: 1, completed: true });
    f.call.mockResolvedValueOnce(snapshot(4)); await f.client.complete(1, false);
    f.call.mockResolvedValueOnce(snapshot(5, [])); await f.client.delete(1);
    expect(f.client.getState().snapshot).toEqual(snapshot(5, []));
  });
  it('preserva o snapshot após erro de gravação e permite retentar', async () => {
    const f = fixture(); await f.client.start(); f.emit(snapshot(2));
    f.call.mockRejectedValueOnce('Disco indisponível');
    expect(await f.client.save(null, { ...emptyTask(), title: 'Nova' })).toBe(false);
    expect(f.client.getState()).toEqual(expect.objectContaining({ busy: false, error: 'Disco indisponível', snapshot: snapshot(2) }));
    f.call.mockResolvedValueOnce(snapshot(3)); expect(await f.client.save(null, { ...emptyTask(), title: 'Nova' })).toBe(true);
  });
  it('bloqueia duplicação durante escrita e não muda a lista antecipadamente', async () => {
    const f = fixture(); await f.client.start();
    let resolve!: (value: TaskSnapshot) => void;
    f.call.mockImplementationOnce(() => new Promise(r => { resolve = r as typeof resolve; }));
    const saving = f.client.save(null, { ...emptyTask(), title: 'Nova' });
    expect(f.client.getState().busy).toBe(true); expect(f.client.getState().snapshot.tasks).toEqual([]);
    expect(await f.client.save(null, { ...emptyTask(), title: 'Nova' })).toBe(false);
    resolve(snapshot(1)); await saving; expect(f.client.getState().busy).toBe(false);
  });
  it('falha de leitura não é apresentada como uma lista vazia pronta', async () => {
    const f = fixture(); f.call.mockRejectedValueOnce('Banco indisponível'); await f.client.start();
    expect(f.client.getState().ready).toBe(false); expect(f.client.getState().error).toBe('Banco indisponível');
    expect(await f.client.delete(1)).toBe(false);
    f.call.mockResolvedValueOnce(snapshot(1)); await f.client.refresh(); expect(f.client.getState().ready).toBe(true);
  });
  it('retenta a assinatura após falha e continua sincronizando', async () => {
    let receive: (value: TaskSnapshot) => void = () => {};
    const subscribe = vi.fn<TaskTransport['subscribe']>().mockRejectedValueOnce('Listener indisponível').mockImplementationOnce(async callback => { receive = callback; return () => {}; });
    const client = new TaskClient({ call: async () => snapshot(0, []), subscribe });
    await client.start(); expect(client.getState().ready).toBe(false);
    await client.refresh(); expect(client.getState().ready).toBe(true);
    receive(snapshot(2)); expect(client.getState().snapshot.revision).toBe(2);
  });
  it('duas janelas recebem a mesma alteração confirmada', async () => {
    const dashboard = fixture(), assistant = fixture(); await Promise.all([dashboard.client.start(), assistant.client.start()]);
    dashboard.emit(snapshot(4)); assistant.emit(snapshot(4));
    expect(dashboard.client.getState().snapshot).toEqual(assistant.client.getState().snapshot);
  });
});
