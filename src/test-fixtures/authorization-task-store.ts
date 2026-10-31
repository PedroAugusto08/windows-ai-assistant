import { TaskClient, type Task, type TaskInput, type TaskSnapshot } from '../tasks';

// Volatile transport for authorization tests, not a second validator for Rust.
// No native IPC, database, filesystem, subscriptions or external effects.
export class AuthorizationTaskStore {
  readonly client: TaskClient;
  readonly calls: { command: string; args?: Record<string, unknown> }[] = [];
  private snapshot: TaskSnapshot;
  private nextId: number;
  private failAfterWrite = false;

  constructor(tasks: Task[]) {
    this.snapshot = { revision: 0, tasks: structuredClone(tasks) };
    this.nextId = Math.max(0, ...tasks.map(task => task.id)) + 1;
    this.client = new TaskClient({ call: async (command, args) => this.call(command, args), subscribe: async () => () => {} });
  }

  inspect(): TaskSnapshot { return structuredClone(this.snapshot); }
  failNext(_mode: 'after') { this.failAfterWrite = true; }
  concurrentEdit(id: number, patch: Partial<TaskInput>) {
    const task = this.snapshot.tasks.find(task => task.id === id);
    if (!task) throw new Error('Registro fictício ausente.');
    Object.assign(task, structuredClone(patch));
    this.snapshot.revision++;
  }

  private call(command: string, args?: Record<string, unknown>): TaskSnapshot {
    this.calls.push({ command, args: structuredClone(args) });
    if (command === 'list_tasks') return this.inspect();
    if (!args || args.expectedRevision !== this.snapshot.revision) throw new Error('As tarefas mudaram.');
    const next = this.inspect();
    const index = next.tasks.findIndex(task => task.id === args.id);
    if (command === 'save_task') {
      const input = structuredClone(args.input) as TaskInput;
      if (!input) throw new Error('Dados fictícios ausentes.');
      if (args.id === null) next.tasks.push({ ...input, id: this.nextId++, completed: false });
      else {
        if (index < 0) throw new Error('Registro fictício ausente.');
        next.tasks[index] = { ...next.tasks[index], ...input };
      }
    } else if (command === 'complete_task' || command === 'delete_task') {
      if (index < 0) throw new Error('Registro fictício ausente.');
      if (command === 'delete_task') next.tasks.splice(index, 1);
      else next.tasks[index].completed = true;
    } else throw new Error('Operação fictícia não permitida.');
    next.revision++;
    this.snapshot = next;
    if (this.failAfterWrite) {
      this.failAfterWrite = false;
      throw new Error('Falha fictícia após a gravação.');
    }
    return this.inspect();
  }
}
