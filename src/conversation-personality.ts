import { queryPeriodBounds } from './query-periods';
import type { IntelligenceParameters, Interpretation } from './intelligence';
import { isTaskOverdue, priorityLabels, type Task } from './tasks';

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
// Free prose is restricted to social conversation. Any task/operation/capability
// language falls back to local text, including claims hidden in another intent.
export function conversationalReply(reply: string, fallback = 'Estou à disposição, senhor. Podemos organizar suas tarefas por aqui.') {
  if (!reply.trim() || reply.length > 1000) return fallback;
  const sentences = reply.match(/[^.!?\n]+(?:[.!?]|$)/g) ?? [];
  const social = sentences.filter(sentence => {
    const text = sentence.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return !/\d|\b(taref\w*|prazo\w*|prioridad\w*|projet\w*|relatori\w*|pendenc\w*|agend\w*|notific\w*|lembret\w*|voz|windows|banco|api|gemini|operac\w*|execut\w*|cri\w*|registr\w*|anot\w*|inclu\w*|salv\w*|grav\w*|alter\w*|atualiz\w*|ajust\w*|defin\w*|conclu\w*|finaliz\w*|termin\w*|exclu\w*|remov\w*|delet\w*|abr\w*|abert\w*|consultei|encontrei|pesquisei|feito|fiz|farei|amanha|semana)\b/.test(text);
  });
  return social.map(sentence => sentence.trim()).join(' ') || fallback;
}
export function clarificationReply(text: string | null) {
  const normalized = text?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return text && text.trim().endsWith('?') && !/\b(criei|criada|registrei|anotei|salvei|alterei|atualizei|atualizada|ajustei|defini|conclui|concluida|exclui|excluida|removi|executei|feito|fiz|encontrei)\b/.test(normalized!) ? text : 'Pode esclarecer o que deseja fazer, senhor?';
}
export function spokenDeadline(task: Task, now: Date): string {
  if (!task.dueDate) return 'sem prazo definido';
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const date = task.dueDate === localDate(now) ? 'hoje' : task.dueDate === localDate(tomorrow) ? 'amanhã' : `dia ${task.dueDate.split('-').reverse().join('/')}`;
  return `${date}${task.dueTime ? ` às ${task.dueTime.replace(':', 'h')}` : ''}`;
}

// Operation prose is assembled only after SQLite returns. Model prose is never a receipt.
export interface ConversationPersonalityContext { turn: number }
export class ConversationPersonality {
  private turn = 0;
  exportContext(): ConversationPersonalityContext { return { turn: this.turn }; }
  importContext(context: ConversationPersonalityContext) {
    if (!Number.isSafeInteger(context.turn) || context.turn < 0) throw new Error('Contexto de conversa inválido.');
    this.turn = context.turn;
  }
  reset() { this.turn = 0; }
  next() { this.turn++; }
  private choose(options: string[]) { return options[(Math.max(1, this.turn) - 1) % options.length]; }
  private finish(text: string) { return `${text}${this.turn % 3 !== 2 ? ', senhor' : ''}.`; }
  saved(intent: Interpretation['intent'], task: Task, before: Task | undefined, now: Date) {
    if (intent === 'create_task') {
      const details = [task.dueDate ? `para ${spokenDeadline(task, now)}` : '', task.priority !== 'normal' ? `com prioridade ${priorityLabels[task.priority].toLowerCase()}` : '', task.project ? `no projeto “${task.project}”` : ''].filter(Boolean).join(', ');
      return this.finish(`${this.choose(['Registrei', 'Anotei', 'Incluí na sua lista'])} “${task.title}”${details ? ` ${details}` : ''}`);
    }
    if (intent === 'complete_task') return this.finish(this.choose([`Marquei “${task.title}” como concluída`, `“${task.title}” está concluída. Uma pendência a menos`, `Dei baixa em “${task.title}”` ]));
    const changes: string[] = [];
    if (before && task.title !== before.title) changes.push(`o título agora é “${task.title}”`);
    if (before && task.priority !== before.priority) changes.push(`a prioridade agora é ${priorityLabels[task.priority].toLowerCase()}`);
    if (before && (task.dueDate !== before.dueDate || task.dueTime !== before.dueTime)) changes.push(task.dueDate ? `o prazo ficou para ${spokenDeadline(task, now)}` : 'o prazo foi removido');
    if (before && task.project !== before.project) changes.push(task.project ? `o projeto agora é “${task.project}”` : 'o projeto foi removido');
    return this.finish(`${this.choose(['Ajustei', 'Pronto', 'Feito'])}${changes.length ? `: ${changes.join('; ')}` : ` os dados de “${task.title}”`}`);
  }
  deleted(task: Task) { return this.finish(`Removi “${task.title}” da sua lista`); }
  query(p: IntelligenceParameters, tasks: Task[], now: Date) {
    const week = p.queryPeriod === 'week_of_date' ? queryPeriodBounds(p.queryPeriod, now, p.dueDate) : null;
    const period = week ? ` com prazo de ${week[0].split('-').reverse().join('/')} a ${week[1].split('-').reverse().join('/')}` : p.queryPeriod ? { today: ' com prazo hoje', tomorrow: ' com prazo amanhã', this_week: ' com prazo nesta semana', next_week: ' com prazo na próxima semana', week_of_date: '' }[p.queryPeriod] : p.dueDate ? ` com prazo em ${p.dueDate.split('-').reverse().join('/')}` : '';
    const status = p.status === 'all' ? '' : p.status === 'completed' ? ' concluída' : p.status === 'overdue' ? ' atrasada' : ' pendente';
    const filters = `${p.priority ? ` de prioridade ${priorityLabels[p.priority].toLowerCase()}` : ''}${p.project ? ` no projeto “${p.project}”` : ''}${p.target ? ` com referência a “${p.target}”` : ''}`;
    if (!tasks.length) return this.finish(`Não encontrei tarefas${status ? `${status}s` : ''}${period}${filters}`);
    const count = `${tasks.length} tarefa${tasks.length === 1 ? '' : 's'}${status}${status && tasks.length !== 1 ? 's' : ''}${period}${filters}`;
    return `${this.finish(`${this.choose(['Encontrei', 'Você tem', 'Constam na sua lista'])} ${count}`)} ${tasks.slice(0, 5).map(t => `“${t.title}” (${spokenDeadline(t, now)}; prioridade ${priorityLabels[t.priority].toLowerCase()}${isTaskOverdue(t, now) ? '; prazo vencido' : ''})`).join('; ')}.${tasks.length > 5 ? ' A lista completa está no painel de tarefas.' : ''}`;
  }
}
