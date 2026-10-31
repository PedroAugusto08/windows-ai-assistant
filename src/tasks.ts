import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type Priority = 'low' | 'normal' | 'high';
export interface TaskInput { title: string; description: string; priority: Priority; dueDate: string | null; dueTime: string | null; project: string }
export interface Task extends TaskInput { id: number; completed: boolean }
export interface TaskSnapshot { revision: number; tasks: Task[] }
export type TaskFilter = 'pending' | 'completed' | 'all';
export const priorityLabels: Record<Priority, string> = { low: 'Baixa', normal: 'Normal', high: 'Alta' };
export const emptyTask = (): TaskInput => ({ title: '', description: '', priority: 'normal', dueDate: null, dueTime: null, project: '' });
export function selectTasks(tasks: Task[], filter: TaskFilter = 'pending') {
  const rank = { high: 0, normal: 1, low: 2 };
  return tasks.filter(task => filter === 'all' || task.completed === (filter === 'completed')).sort((a, b) =>
    Number(a.completed) - Number(b.completed) || rank[a.priority] - rank[b.priority] ||
    deadlineKey(a).localeCompare(deadlineKey(b)) || a.id - b.id);
}
function deadlineKey(task: Task) {
  return task.dueDate ? `${task.dueDate}T${task.dueTime ?? '23:59:59'}` : '9999-12-31T23:59:59';
}
function localDeadline(task: Task) {
  if (!task.dueDate) return null;
  const [year, month, day] = task.dueDate.split('-').map(Number);
  // setFullYear avoids JavaScript's special 1900 offset for years 0001–0099.
  const start = new Date(0);
  start.setFullYear(year, month - 1, day);
  start.setHours(0, 0, 0, 0);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return null;
  if (task.dueTime) {
    const [hour, minute] = task.dueTime.split(':').map(Number);
    const instant = new Date(start);
    instant.setHours(hour, minute, 0, 0);
    if (instant.getFullYear() !== year || instant.getMonth() !== month - 1 || instant.getDate() !== day || instant.getHours() !== hour || instant.getMinutes() !== minute) return null;
    return instant.getTime();
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return end.getTime() - 1;
}
export function isTaskOverdue(task: Task, now = new Date()) {
  const deadline = task.completed ? null : localDeadline(task);
  return deadline !== null && deadline <= now.getTime();
}
export function taskDeadline(task: Task, now = new Date()) {
  if (!task.dueDate) return 'Sem prazo';
  const [year, month, day] = task.dueDate.split('-');
  const date = `${day}/${month}/${year}${task.dueTime ? ` · ${task.dueTime}` : ''}`;
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return task.dueDate === localDate ? `Hoje · ${date}` : date;
}

interface TaskState { snapshot: TaskSnapshot; ready: boolean; busy: boolean; error: string }
export interface TaskTransport {
  call(command: string, args?: Record<string, unknown>): Promise<TaskSnapshot>;
  subscribe(callback: (snapshot: TaskSnapshot) => void): Promise<() => void>;
}
export class TaskClient {
  private state: TaskState = { snapshot: { revision: -1, tasks: [] }, ready: false, busy: false, error: '' };
  private listeners = new Set<() => void>();
  private eventOff: (() => void) | undefined;
  private connecting: Promise<void> | undefined;
  constructor(private transport: TaskTransport, snapshot?: TaskSnapshot) {
    if (snapshot) this.state = { snapshot: structuredClone(snapshot), ready: true, busy: false, error: '' };
  }
  getState = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private update(patch: Partial<TaskState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(callback => callback()); }
  private accept(snapshot: TaskSnapshot) {
    if (snapshot.revision >= this.state.snapshot.revision) this.update({ snapshot, ready: true, error: '' });
  }
  private async connect() {
    if (this.eventOff) return;
    this.connecting ??= this.transport.subscribe(snapshot => this.accept(snapshot)).then(off => { this.eventOff = off; });
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  async refresh() {
    try {
      await this.connect();
      this.accept(await this.transport.call('list_tasks'));
    } catch (error) { this.update({ ready: false, error: String(error) }); }
  }
  async start() {
    await this.refresh();
    return () => { this.eventOff?.(); this.eventOff = undefined; };
  }
  async execute(command: 'save_task' | 'complete_task' | 'delete_task', args: Record<string, unknown>): Promise<TaskSnapshot> {
    if (this.state.busy || !this.state.ready) throw new Error('Tarefas indisponíveis ou operação em andamento.');
    this.update({ busy: true, error: '' });
    try {
      const snapshot = await this.transport.call(command, args);
      this.accept(snapshot);
      return snapshot;
    } catch (error) { this.update({ error: String(error) }); throw error; }
    finally { this.update({ busy: false }); }
  }
  async mutate(command: 'save_task' | 'complete_task' | 'delete_task', args: Record<string, unknown>) {
    try { await this.execute(command, args); return true; } catch { return false; }
  }
  save = (id: number | null, input: TaskInput) => this.mutate('save_task', { id, input });
  complete = (id: number, completed: boolean) => this.mutate('complete_task', { id, completed });
  delete = (id: number) => this.mutate('delete_task', { id });
}
export const nativeTasks = isTauri();
export const taskClient = new TaskClient({
  call: (command, args) => nativeTasks ? invoke(command, args) : Promise.reject('Tarefas locais estão disponíveis no aplicativo desktop. A prévia web não grava dados.'),
  subscribe: async callback => nativeTasks ? listen<TaskSnapshot>('tasks-changed', event => callback(event.payload)) : () => {},
});
