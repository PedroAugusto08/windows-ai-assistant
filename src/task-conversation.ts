import { IntelligenceSession, intelligenceFailure, type IntelligenceParameters, type Interpretation, type RestorableField } from './intelligence';
import { ConversationPersonality, clarificationReply, conversationalReply, spokenDeadline } from './conversation-personality';
import { readQueryPeriod, queryBounds, queryPeriodBounds } from './query-periods';
import { taskClient, taskDeadline, isTaskOverdue, selectTasks, type Task, type TaskClient, type TaskInput, type TaskSnapshot } from './tasks';

export interface ConversationResult { text: string; panel?: 'tasks' | 'chat'; taskIds?: number[]; executed?: boolean }
type Pending = { interpretation: Interpretation; ids: number[]; revision: number; kind: 'choose' | 'delete' };
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const previousReferences = new Set(['a anterior', 'anterior', 'ela', 'essa tarefa', 'a tarefa anterior', 'ultima tarefa', 'a ultima tarefa', 'essa', 'isso', 'a mesma', 'previous']);

// IDs and resolution remain local; only bounded user clarification accompanies the previous-task flag.
export function resolveTasks(tasks: Task[], target: string): Task[] {
  const text = normalize(target);
  if (!text) return [];
  const exact = tasks.filter(task => normalize(task.title) === text);
  const words = text.split(' ').filter(word => !['a', 'o', 'de', 'da', 'do', 'tarefa'].includes(word));
  return words.length ? tasks.filter(task => words.every(word => normalize(task.title).split(' ').includes(word))) : exact;
}

export { queryPeriodBounds } from './query-periods';
type Suggestion = { id: number; revision: number; kind: 'priority' | 'panel'; expiresAt: number };
// Common constructions are local; other formulations use the existing semantic interpreter.
function suggestionReply(message: string): 'accept' | 'decline' | 'reference' | null {
  let text = normalize(message).replace(/^(jarvis|senhor) /, '').replace(/ (?:senhor|jarvis|por favor|obrigado|obrigada)$/, '');
  if (/^(nao(?: obrigado| obrigada| senhor| quero| precisa)?|(?:deixa|deixe) (?:como esta|pra la|para la)|agora nao|cancelar|cancela|manter tarefa|melhor nao)$/.test(text)) return 'decline';
  const reference = /^(?:o que (?:voce|vc) sugeriu|(?:qual|qual foi) (?:a |sua |a sua )?sugestao|(?:me )?(?:explique|explica) (?:a |sua |a sua )?sugestao)$/;
  if (reference.test(text) && (message.includes('?') || !/^o que /.test(text))) return 'reference';
  if (/^(sim(?: sim| senhor| por favor)?|claro|aceito|ok|beleza|vamos nessa|isso|por favor|pode(?: ser| fazer| colocar| sim| ajustar| definir| aumentar| abrir)?|abra|(?:faca|faz|fazer) (?:isso|o que (?:voce|vc) sugeriu|(?:a |sua |a sua )?sugestao)|o que (?:voce|vc) sugeriu)$/.test(text)) return message.includes('?') ? 'reference' : 'accept';
  return null;
}

const taskFields: (keyof TaskInput)[] = ['title', 'description', 'priority', 'project', 'dueDate', 'dueTime'];
type LastEdit = { before: Task; after: Task; revision: number; expiresAt: number; message: string };
// Accept a correction only when it refers to one whole edit. Questions, targets,
// multiple operations and conditional wording need clarification instead.
function editCorrection(message: string): 'restore' | 'clarify' | null {
  const text = normalize(message).replace(/^(?:na verdade|na realidade|jarvis|senhor)[ ]+/, '').replace(/ (?:por favor|senhor|jarvis)$/, '');
  const clear = /^(?:(?:deixa|deixe|deixar)(?: (?:isso|ela|essa tarefa))? como (?:estava|antes)|(?:volta|volte|voltar) (?:para o anterior|ao anterior|ao estado anterior|para como estava)|(?:desfaz|desfaca|desfazer) (?:essa alteracao|a alteracao|a ultima alteracao)|(?:restaura|restaure) (?:o valor anterior|os valores anteriores))$/;
  if (clear.test(text)) return message.includes('?') ? 'clarify' : 'restore';
  return /\b(?:desfaz|desfaca|desfazer)\b|\b(?:deixa|deixe|deixar)\b.*\bcomo (?:estava|antes)\b|\b(?:volta|volte|voltar|restaura|restaure)\b.*\b(?:anterior|anteriores|estava)\b/.test(text) ? 'clarify' : null;
}

const editableFields: RestorableField[] = ['title', 'project', 'priority', 'dueDate', 'dueTime'];
const asksRestore = (message: string) => /\b(?:volta|volte|voltar|restaura|restaure|desfaz|desfaca|desfazer)\b|\bquis dizer\b.*\btitulo\b.*\bnao (?:no|do|o) projeto\b/.test(normalize(message));
const refersToInformation = (message: string) => /\b(?:essa informacao|isso|quis dizer|nome do evento)\b/.test(normalize(message));
function explicitFields(message: string): Set<RestorableField> {
  const text = normalize(message).replace(/\bnao (?:e )?(?:do |no |o )?(?:projeto|titulo)\b/g, '');
  const fields = new Set<RestorableField>();
  if (/\btitulo\b/.test(text)) fields.add('title');
  if (/\bprojeto\b/.test(text)) fields.add('project');
  if (/\bprioridade\b/.test(text)) fields.add('priority');
  if (/\b(?:prazo|data|dia)\b|\b\d{4} \d{2} \d{2}\b/.test(text)) fields.add('dueDate');
  if (/\b(?:horario|hora|horas)\b|\b\d{1,2}h|\bas \d{1,2}\b/.test(text)) fields.add('dueTime');
  if (/\bprazo\b/.test(text)) fields.add('dueTime');
  return fields;
}
type MeaningContext = { id: number; revision: number; message: string; expiresAt: number };

export class TaskConversation {
  private personality = new ConversationPersonality();
  private socialContext: string[] = [];
  private suggestion: Suggestion | null = null;
  private lastEdit: LastEdit | null = null;
  private meaning: MeaningContext | null = null;
  private requestMessage = '';
  private suggested = new Set<string>();
  private turns = 0;
  private lastSuggestionTurn = -3;
  private previousQuery: IntelligenceParameters | null = null;
  private previousId: number | null = null;
  private pending: Pending | null = null;
  private clarification: string | undefined;
  private busy = false;
  private generation = 0;
  private updatedAt = 0;
  private last: { message: string; result: ConversationResult } | null = null;
  constructor(private client: TaskClient = taskClient, private intelligence = new IntelligenceSession(), private clock = () => Date.now()) {}
  clear() {
    this.requestMessage = ''; this.meaning = null; this.lastEdit = null; this.suggestion = null; this.suggested.clear(); this.turns = 0; this.lastSuggestionTurn = -3; this.personality.reset(); this.socialContext = [];
    this.previousQuery = null; this.previousId = null; this.pending = null; this.clarification = undefined; this.last = null;
    this.updatedAt = 0; this.generation++; this.intelligence.clear();
  }
  async send(message: string): Promise<ConversationResult | null> {
    if (this.busy) return { text: 'Já estou cuidando do pedido anterior.' };
    if (!message.trim() || message.length > 1000) return { text: 'Informe um pedido com até 1.000 caracteres.' };
    if (this.updatedAt && this.clock() - this.updatedAt > 15 * 60_000) this.clear();
    const text = normalize(message);
    this.requestMessage = message;
    if (this.last?.message === text) return { ...this.last.result, executed: false, text: 'Esse pedido já foi atendido, senhor. Confira o resultado no painel de tarefas.' };
    this.last = null;
    const generation = this.generation;
    this.busy = true;
    try {
      await this.client.refresh();
      if (generation !== this.generation) return null;
      const state = this.client.getState();
      if (!state.ready) return { text: 'Não foi possível consultar as tarefas locais. Nenhuma ação executada.' };
      let snapshot = state.snapshot;
      this.updatedAt = this.clock();
      this.personality.next(); this.turns++;
      if (this.meaning && (this.meaning.id !== this.previousId || this.meaning.revision !== snapshot.revision || this.clock() >= this.meaning.expiresAt)) {
        this.meaning = null;
        if (refersToInformation(message)) return { text: 'Essa referência já não está segura, senhor. Indique a tarefa e a informação que deseja corrigir.' };
      }
      const compoundCorrection = asksRestore(message) && explicitFields(message).size > 0 && /\b(?:titulo|projeto|prioridade|prazo|data|horario)\b/.test(text);
      if (compoundCorrection && this.pending) return { text: 'Há um pedido aguardando identificação ou confirmação, senhor. Esclareça esse pedido antes de combinar uma restauração.' };
      const correction = compoundCorrection ? null : editCorrection(message);
      if (correction) {
        if (correction === 'clarify' || this.pending) return { text: 'Qual edição deseja restaurar, senhor? Preciso de uma referência inequívoca antes de alterar a tarefa.' };
        const result = await this.restoreLastEdit(snapshot);
        if (result.executed && generation === this.generation) this.last = { message: text, result };
        return result;
      }
      const decision = suggestionReply(message);
      if (decision === 'decline') {
        const hadPending = this.pending !== null || this.suggestion !== null || this.clarification !== undefined;
        this.suggestion = null;
        this.pending = null; this.clarification = undefined;
        return { text: hadPending ? 'Está bem, senhor. Deixei como está; o pedido pendente foi cancelado.' : 'Está bem, senhor.' };
      }
      if (this.pending) {
        const pending = this.pending;
        if (snapshot.revision !== pending.revision) {
          this.pending = null;
          return { text: 'As tarefas mudaram desde a seleção. Repita o pedido para identificar e confirmar novamente.' };
        }
        if (pending.kind === 'delete') {
          const task = snapshot.tasks.find(task => task.id === pending.ids[0]);
          if (text === `confirmo excluir ${pending.ids[0]}` && task) {
            // Consume before awaiting IPC: a double submit cannot reuse this authorization.
            this.pending = null;
            const result = await this.apply(pending.interpretation, task, snapshot, true);
            if (result.executed && generation === this.generation) this.last = { message: text, result };
            return result;
          }
          this.pending = null;
          if (/^(sim|confirm|exclu)/.test(text)) return { text: 'A exclusão não foi confirmada. Repita o pedido e use a confirmação indicada para aquela tarefa.' };
        } else {
          const choices = pending.ids.map(id => snapshot.tasks.find(task => task.id === id)!).filter(Boolean);
          const numeric = /^\d+$/.test(text) ? Number(text) - 1 : -1;
          const selected = numeric >= 0 ? choices[numeric] : choices.filter(task => normalize(task.title) === text).length === 1 ? choices.find(task => normalize(task.title) === text) : undefined;
          if (selected) {
            this.pending = null;
            const result = await this.apply(pending.interpretation, selected, snapshot);
            if (result.executed && generation === this.generation) this.last = { message: text, result };
            return result;
          }
          this.pending = null;
          if (numeric >= 0) return { text: 'Opção inválida. Repita o pedido para selecionar uma tarefa.' };
        }
      }
      if (this.suggestion && this.clock() >= this.suggestion.expiresAt) this.suggestion = null;
      if (this.suggestion) {
        if (snapshot.revision !== this.suggestion.revision) {
          this.suggestion = null;
          return { text: 'As tarefas mudaram desde a sugestão, senhor. Consulte novamente antes de aceitar.' };
        }
        if (decision === 'accept') {
          const result = await this.acceptSuggestion(snapshot);
          if (result.executed && generation === this.generation) this.last = { message: text, result };
          return result;
        }
        if (decision === 'reference') return this.describeSuggestion(snapshot);
      } else if (decision === 'accept' || decision === 'reference') return { text: 'Não há uma sugestão aguardando aceite, senhor. Qual ação deseja realizar?' };
      if (/^confirmo excluir\b/.test(text)) return { text: 'Não há exclusão aguardando essa confirmação.' };
      const period = readQueryPeriod(message, new Date(this.clock()), this.previousQuery);
      if (period?.clarification) return { text: period.clarification };
      if (period?.onlyPeriod && period.parameters) {
        if (this.previousQuery || period.parameters.queryPeriod === 'week_of_date') {
          this.lastEdit = null; this.suggestion = null;
          return this.query({ title: null, priority: null, project: null, dueTime: null, target: null, panel: null, ...this.previousQuery, ...period.parameters }, snapshot);
        }
        if (this.previousId === null && !this.clarification) return { text: 'Quais tarefas você quer consultar nesse período?' };
      }
      const clarificationContext = this.clarification;
      const edit = this.lastEdit;
      const validEdit = edit && edit.after.id === this.previousId && edit.revision === snapshot.revision && this.clock() < edit.expiresAt;
      const restorableFields = compoundCorrection && validEdit ? editableFields.filter(field => edit.before[field] !== edit.after[field]) : [];
      const taskContext = [this.meaning?.message, (compoundCorrection || refersToInformation(message)) && validEdit ? edit.message : undefined].filter((value): value is string => !!value);
      const contextRevision = snapshot.revision;
      const preview = await this.intelligence.interpret(message, { taskContext, restorableFields, previousTask: this.previousId !== null && snapshot.tasks.some(t => t.id === this.previousId), clarification: this.clarification, conversation: this.socialContext, pendingSuggestion: this.suggestion?.kind, queryAnchor: this.previousQuery ? queryBounds(this.previousQuery, new Date(this.clock()))?.[0] : null });
      if (!preview || generation !== this.generation) return null;
      await this.client.refresh();
      if (generation !== this.generation) return null;
      if (!this.client.getState().ready) return { text: 'Não foi possível reler as tarefas locais. Nenhuma ação executada.' };
      snapshot = this.client.getState().snapshot;
      const i = preview.interpretation;
      if ((i.parameters.titleSuffix || i.parameters.restoreFields?.length) && i.intent !== 'update_task') return { text: 'Essa correção precisa identificar uma única edição de tarefa, senhor. Nenhuma alteração foi feita.' };
      if ((taskContext.length || compoundCorrection) && snapshot.revision !== contextRevision) return { text: 'As tarefas mudaram durante a interpretação, senhor. Confira a tarefa e repita a correção.' };
      if (compoundCorrection && (this.pending || i.intent !== 'update_task' || !i.parameters.restoreFields?.length)) return { text: 'Quais campos deseja restaurar e como deve ficar o título, senhor? Nenhuma alteração foi feita.' };
      if (i.intent === 'accept_suggestion' || i.intent === 'decline_suggestion') {
        if (!this.suggestion) return { text: 'Não há uma sugestão aguardando aceite, senhor. Qual ação deseja realizar?' };
        if (i.clarification || i.requiresConfirmation || (i.intent === 'accept_suggestion' && (message.includes('?') || /\b(se|talvez|mas|porem|depende|ou|outra|outro)\b/.test(text)))) return this.describeSuggestion(snapshot);
        if (i.intent === 'decline_suggestion') { this.suggestion = null; return { text: 'Está bem, senhor. Deixei como está.' }; }
        // A semantic acceptance chooses only the stored action, never model parameters.
        if (Object.values(i.parameters).some(value => value !== null && value !== undefined)) return this.describeSuggestion(snapshot);
        const result = await this.acceptSuggestion(snapshot);
        if (result.executed && generation === this.generation) this.last = { message: text, result };
        return result;
      }
      if (this.suggestion && (i.clarification || ['clarify', 'conversation', 'unsupported'].includes(i.intent))) return this.describeSuggestion(snapshot);
      this.suggestion = null;
      if (!['update_task', 'conversation', 'clarify', 'unsupported'].includes(i.intent) && !i.clarification) { this.lastEdit = null; this.meaning = null; }
      this.socialContext = [];
      this.clarification = undefined;
      if (i.intent !== 'query_tasks') this.previousQuery = null;
      if (i.clarification || i.intent === 'clarify') {
        if (explicitFields(message).size === 0 && !refersToInformation(message)) this.previousId = null;
        if (this.previousId !== null) this.rememberMeaning(message, this.previousId, snapshot.revision);
        this.clarification = message;
        return { text: clarificationReply(i.clarification) };
      }
      let result: ConversationResult;
      if (i.intent === 'query_tasks') {
        result = this.query({ ...i.parameters, ...period?.parameters }, snapshot);
      } else if (i.intent === 'create_task') {
        result = await this.apply(i, undefined, snapshot);
      } else if (['update_task', 'complete_task', 'delete_task'].includes(i.intent)) {
        const target = i.parameters.target;
        if (!target) return { text: 'A qual tarefa você se refere?' };
        if (!previousReferences.has(normalize(target)) && !normalize(`${message} ${clarificationContext ?? ''}`).includes(normalize(target))) {
          return { text: 'Não consegui vincular a referência ao seu pedido. Informe o título da tarefa.' };
        }
        const matches = previousReferences.has(normalize(target))
          ? snapshot.tasks.filter(t => t.id === this.previousId)
          : resolveTasks(snapshot.tasks, target);
        if (!matches.length) return { text: 'Não encontrei essa tarefa. Informe o título para eu identificá-la.' };
        if (matches.length > 1) {
          const choices = matches.slice(0, 10);
          this.pending = { interpretation: i, ids: choices.map(t => t.id), revision: snapshot.revision, kind: 'choose' };
          return { text: `Encontrei mais de uma tarefa. Qual delas? Responda com o número:\n${choices.map((t, index) => `${index + 1}. ${t.title} · ${taskDeadline(t)} · ${t.completed ? 'concluída' : 'pendente'} · #${t.id}`).join('\n')}${matches.length > 10 ? '\nOu informe um título mais específico.' : ''}` };
        }
        result = await this.apply(i, matches[0], snapshot);
      } else {
        if (i.intent !== 'conversation') this.previousId = null;
        result = i.intent === 'open_panel'
          ? i.parameters.panel === 'tasks' ? { text: 'Aqui estão suas tarefas, senhor.', panel: 'tasks' } : i.parameters.panel === 'chat' ? { text: 'Estou à disposição, senhor.', panel: 'chat' } : { text: 'Esse painel ainda não oferece dados reais pela conversa. Você pode acessá-lo pelos controles existentes.' }
          : i.intent === 'unsupported' ? { text: 'Essa ação ainda não está disponível no JARVIS, senhor.' } : { text: conversationalReply(i.reply) };
        if (i.intent === 'conversation' && this.previousId !== null) this.rememberMeaning(message, this.previousId, snapshot.revision);
        if (i.intent === 'conversation' && result.text === i.reply.trim()) this.socialContext = [message, result.text];
      }
      if (result.executed && generation === this.generation) this.last = { message: text, result };
      return result;
    } catch (error) {
      if (generation !== this.generation) return null;
      const failure = intelligenceFailure(error);
      if (failure.code === 'invalid_response' || failure.code === 'blocked_response') return this.suggestion ? this.describeSuggestion(this.client.getState().snapshot) : { text: 'Não consegui determinar esse pedido com segurança, senhor. Nenhuma ação executada. Pode esclarecer a ação ou o período desejado?' };
      return { text: `${failure.message}${failure.retryAfterSeconds ? ` Aguarde ${failure.retryAfterSeconds}s.` : ''} Nenhuma ação executada.` };
    } finally { this.busy = false; }
  }
  private query(p: IntelligenceParameters, snapshot: TaskSnapshot): ConversationResult {
    const now = new Date(this.clock());
    if (p.queryPeriod === 'week_of_date' && !p.dueDate) return { text: 'Qual data identifica essa semana, senhor?' };
    const bounds = queryBounds(p, now);
    const matches = selectTasks(snapshot.tasks, p.status === 'completed' ? 'completed' : p.status === 'all' ? 'all' : 'pending').filter(t =>
      (p.status !== 'overdue' || isTaskOverdue(t, now)) &&
      (!bounds || !!t.dueDate && t.dueDate >= bounds[0] && t.dueDate <= bounds[1]) &&
      (!p.priority || t.priority === p.priority) && (!p.project || normalize(t.project) === normalize(p.project)) &&
      (!p.target || resolveTasks([t], p.target).length > 0));
    this.meaning = null;
    this.previousId = null;
    this.previousQuery = { ...p };
    const result: ConversationResult = { text: this.personality.query(p, matches, now), panel: 'tasks', taskIds: matches.map(t => t.id) };
    return this.offer(result, matches, snapshot.revision, true);
  }
  private describeSuggestion(snapshot: TaskSnapshot): ConversationResult {
    const suggestion = this.suggestion;
    const task = snapshot.tasks.find(t => t.id === suggestion?.id);
    if (!suggestion || this.clock() >= suggestion.expiresAt || snapshot.revision !== suggestion.revision || !task || task.completed) {
      this.suggestion = null;
      return { text: 'Essa sugestão já não está válida, senhor. Consulte as tarefas novamente.' };
    }
    return { text: suggestion.kind === 'priority' ? `Sugeri definir prioridade alta para “${task.title}”, senhor. Deseja aceitar ou deixar como está?` : `Sugeri abrir “${task.title}” no painel para revisão, senhor. Deseja aceitar ou deixar como está?` };
  }
  private rememberMeaning(message: string, id: number, revision: number) {
    if (/\bevento\b/.test(normalize(message)) && /\bprojeto\b/.test(normalize(message))) this.meaning = { id, revision, message, expiresAt: this.clock() + 15 * 60_000 };
    else if (this.meaning?.id === id) this.meaning.revision = revision;
    else this.meaning = null;
  }
  private correctedInput(i: Interpretation, task: Task, snapshot: TaskSnapshot, input: TaskInput): TaskInput | null {
    const p = i.parameters;
    const fields = explicitFields(this.requestMessage);
    const restores = p.restoreFields ?? [];
    const values = editableFields.filter(field => p[field] !== null && p[field] !== undefined);
    if (p.titleSuffix) values.push('title');
    if ((p.title && p.titleSuffix) || new Set(restores).size !== restores.length || restores.some(field => !editableFields.includes(field) || values.includes(field))) return null;
    if (restores.length) {
      const edit = this.lastEdit;
      if (!asksRestore(this.requestMessage) || !edit || edit.after.id !== task.id || edit.revision !== snapshot.revision || this.clock() >= edit.expiresAt || task.completed !== edit.after.completed || taskFields.some(field => task[field] !== edit.after[field])) return null;
      const changed = editableFields.filter(field => edit.before[field] !== edit.after[field]);
      const identifiedProject = /\bquis dizer\b.*\btitulo\b.*\bnao (?:no|do|o) projeto\b/.test(normalize(this.requestMessage));
      if (restores.some(field => !changed.includes(field) || (!fields.has(field) && !(field === 'project' && identifiedProject) && !(changed.length === 1 && fields.has('title') && refersToInformation(this.requestMessage))))) return null;
      for (const field of restores) Object.assign(input, { [field]: edit.before[field] });
    }
    const literal = this.requestMessage.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/\bprojeto(?: (?:da|do|de) [^,.;]+?)? (?:e|para|como|agora e) (?:o )?([^,.;]+?)(?=\s+e\s+(?:mude|altere|o titulo|titulo)|[,.;]|$)/)?.[1];
    if (p.project !== null && p.project !== undefined && literal && normalize(p.project) !== normalize(literal)) return null;
    const changes = values.filter(field => field === 'title' && p.titleSuffix ? !normalize(task.title).includes(normalize(p.titleSuffix)) : input[field] !== task[field]);
    if (fields.size && changes.some(field => !fields.has(field))) return null;
    if (/\b(?:e|tambem) (?:exclua|excluir|crie|criar|conclua|concluir)\b/.test(normalize(this.requestMessage))) return null;
    if (/\bprojeto (?:e )?(?:outro|o outro|diferente)$/.test(normalize(this.requestMessage))) return null;
    // An unqualified mention cannot turn an explicitly distinguished event into a project.
    if (this.meaning?.id === task.id && !fields.has('project') && p.project !== null && p.project !== task.project) return null;
    if (/\b(?:evento)\b/.test(normalize(this.requestMessage)) && !fields.has('project') && p.project !== null && p.project !== task.project) return null;
    if (p.titleSuffix) {
      const suffix = p.titleSuffix.trim();
      const content = normalize(suffix).replace(/^(?:na|no|em|para|sobre) /, '');
      const source = normalize(`${this.requestMessage} ${this.meaning?.id === task.id ? this.meaning.message : ''} ${this.lastEdit?.after.id === task.id ? this.lastEdit.message : ''}`);
      if (!content || suffix.length > 200 || !source.includes(content)) return null;
      input.title = normalize(task.title).includes(normalize(suffix)) ? task.title : `${task.title} ${suffix}`;
      if (input.title.length > 200) return null;
    }
    return input;
  }
  private async restoreLastEdit(snapshot: TaskSnapshot): Promise<ConversationResult> {
    const edit = this.lastEdit;
    if (!edit || this.clock() >= edit.expiresAt) {
      this.lastEdit = null;
      return { text: 'Não tenho uma edição anterior identificável para restaurar, senhor. Qual tarefa e valor deseja ajustar?' };
    }
    const task = snapshot.tasks.find(t => t.id === edit.after.id);
    if (snapshot.revision !== edit.revision || !task || task.completed !== edit.after.completed || taskFields.some(key => task[key] !== edit.after[key])) {
      this.lastEdit = null;
      return { text: 'As tarefas mudaram desde essa edição, senhor. Confira a tarefa e indique o ajuste desejado antes de prosseguirmos.' };
    }
    const { id: _id, completed: _completed, ...input } = edit.before;
    const generation = this.generation;
    // Consume before IPC: failures and repeated corrections cannot reuse permission.
    this.lastEdit = null; this.suggestion = null; this.clarification = undefined;
    this.previousQuery = null; this.socialContext = [];
    try {
      const saved = await this.client.execute('save_task', { id: task.id, input, expectedRevision: edit.revision });
      const affected = saved.tasks.find(t => t.id === task.id);
      if (saved.revision <= snapshot.revision || !affected || affected.completed !== task.completed || taskFields.some(key => affected[key] !== input[key])) {
        return { text: 'Não consegui confirmar a restauração, senhor. Confira os valores no painel antes de repetir.' };
      }
      if (generation !== this.generation) return { text: 'A conversa foi limpa durante a gravação. Confira o resultado no painel de tarefas.' };
      this.previousId = affected.id;
      this.rememberMeaning(this.requestMessage, affected.id, saved.revision);
      return { text: this.personality.saved('update_task', affected, task, new Date(this.clock())), executed: true };
    } catch {
      return { text: 'Não consegui restaurar os valores anteriores, senhor. Confira a tarefa; nenhuma restauração foi confirmada.' };
    }
  }
  private async acceptSuggestion(snapshot: TaskSnapshot): Promise<ConversationResult> {
    const suggestion = this.suggestion;
    const task = snapshot.tasks.find(t => t.id === suggestion?.id);
    if (!suggestion || this.clock() >= suggestion.expiresAt || snapshot.revision !== suggestion.revision || !task || task.completed) return this.describeSuggestion(snapshot);
    // Consume before IPC. Neither an unknown turn nor model prose can redirect this action.
    this.suggestion = null; this.clarification = undefined;
    if (suggestion.kind === 'panel') return { text: `Aqui está “${task.title}”, senhor.`, panel: 'tasks', taskIds: [task.id] };
    this.previousQuery = null;
    return this.apply({ intent: 'update_task', parameters: { title: null, priority: 'high', project: null, dueDate: null, dueTime: null, target: null, panel: null }, reply: '', clarification: null, requiresConfirmation: false, usesPreviousDraft: false }, task, snapshot);
  }
  private offer(result: ConversationResult, tasks: Task[], revision: number, panelOpen = false): ConversationResult {
    if (this.turns - this.lastSuggestionTurn < 3) return result;
    const now = new Date(this.clock());
    const tomorrow = queryPeriodBounds('tomorrow', now)[0];
    for (const task of tasks) {
      if (task.completed || !task.dueDate) continue;
      const overdue = isTaskOverdue(task, now);
      const near = !overdue && task.dueDate <= tomorrow;
      const kind = overdue ? 'panel' : near && task.priority !== 'high' ? 'priority' : null;
      if (!kind || kind === 'panel' && panelOpen) continue;
      const key = `${task.id}:${kind}:${task.dueDate}:${task.dueTime}`;
      if (this.suggested.has(key)) continue;
      this.suggested.add(key);
      if (this.suggested.size > 20) this.suggested.delete(this.suggested.values().next().value!);
      this.lastSuggestionTurn = this.turns;
      this.suggestion = { id: task.id, revision, kind, expiresAt: this.clock() + 15 * 60_000 };
      const reason = overdue ? `O prazo de “${task.title}” já passou. Posso abrir essa tarefa no painel para revisarmos?` : panelOpen && tasks.length > 1 ? `“${task.title}” tem prazo ${spokenDeadline(task, now)}. Gostaria que eu definisse prioridade alta?` : 'Como o prazo está próximo, gostaria que eu definisse prioridade alta?';
      return { ...result, text: `${result.text} ${reason}` };
    }
    return result;
  }

  private async apply(i: Interpretation, task: Task | undefined, snapshot: TaskSnapshot, confirmed = false): Promise<ConversationResult> {
    const generation = this.generation;
    const p = i.parameters;
    if (i.intent === 'delete_task' && task && !confirmed) {
      this.pending = { interpretation: i, ids: [task.id], revision: snapshot.revision, kind: 'delete' };
      return { text: `Excluir “${task.title}” (#${task.id}, ${taskDeadline(task)})? Para confirmar, digite “confirmo excluir ${task.id}”. Ou “cancelar”.` };
    }
    if (i.requiresConfirmation && i.intent !== 'delete_task') return { text: 'Esse pedido requer esclarecimento. Reformule a operação desejada.' };
    if (i.intent === 'complete_task' && task?.completed) { this.previousId = task.id; return { text: `“${task.title}” já está concluída.` }; }
    let input: TaskInput = {
      title: p.title ?? task?.title ?? '', description: task?.description ?? '', priority: p.priority ?? task?.priority ?? 'normal',
      project: p.project ?? task?.project ?? '', dueDate: p.dueDate ?? task?.dueDate ?? null, dueTime: p.dueTime ?? task?.dueTime ?? null,
    };
    if (i.intent === 'update_task' && task) {
      const corrected = this.correctedInput(i, task, snapshot, input);
      if (!corrected) { if (!p.restoreFields?.length) this.lastEdit = null; this.rememberMeaning(this.requestMessage, task.id, snapshot.revision); return { text: 'Preciso confirmar quais campos deseja alterar, senhor. Indique o título, o projeto ou os valores a restaurar; nenhuma alteração foi feita.' }; }
      input = corrected;
    }
    if (i.intent === 'create_task') {
      const duplicates = snapshot.tasks.filter(t => !t.completed && normalize(t.title) === normalize(input.title) && t.dueDate === input.dueDate && t.dueTime === input.dueTime && normalize(t.project) === normalize(input.project));
      if (duplicates.length) {
        this.previousId = duplicates.length === 1 ? duplicates[0].id : null;
        return { text: `Já existe uma tarefa com esse título e prazo. Não criei outra.`, panel: 'tasks' };
      }
    }
    if (i.intent === 'update_task' && task && Object.entries(input).every(([key, value]) => task[key as keyof TaskInput] === value)) {
      this.lastEdit = null; this.previousId = task.id; this.rememberMeaning(this.requestMessage, task.id, snapshot.revision); return { text: `“${task.title}” já está com esses dados.` };
    }
    const command = i.intent === 'delete_task' ? 'delete_task' : i.intent === 'complete_task' ? 'complete_task' : 'save_task';
    const args = command === 'save_task' ? { id: task?.id ?? null, input, expectedRevision: snapshot.revision } : { id: task!.id, completed: true, expectedRevision: snapshot.revision };
    this.lastEdit = null;
    try {
      const saved = await this.client.execute(command, args);
      if (saved.revision <= snapshot.revision) return { text: 'Não consegui confirmar a operação, senhor. Confira as tarefas antes de repetir.' };
      const affected = task ? saved.tasks.find(t => t.id === task.id) : saved.tasks.find(t => !snapshot.tasks.some(old => old.id === t.id));
      if (i.intent === 'delete_task') {
        if (saved.tasks.some(t => t.id === task?.id)) return { text: 'Não confirmei a exclusão. Confira as tarefas antes de repetir.' };
        if (generation === this.generation) this.previousId = null;
        return { text: this.personality.deleted(task!), executed: true };
      }
      if (!affected) return { text: 'A operação foi enviada, mas não consegui confirmar o registro salvo. Confira as tarefas antes de repetir.' };
      if (i.intent === 'complete_task' && !affected.completed) return { text: 'Não confirmei a conclusão, senhor. Confira a tarefa antes de repetir.' };
      if (command === 'save_task' && Object.entries(input).some(([key, value]) => affected[key as keyof TaskInput] !== (typeof value === 'string' ? value.trim() : value))) return { text: 'Os dados retornados não confirmam o pedido, senhor. Confira a tarefa antes de repetir.' };
      if (generation !== this.generation) return { text: 'A conversa foi limpa durante a gravação. Confira o resultado no painel de tarefas.' };
      this.previousId = affected.id;
      if (i.intent === 'update_task' && task) this.lastEdit = { before: { ...task }, after: { ...affected }, revision: saved.revision, expiresAt: this.clock() + 15 * 60_000, message: this.requestMessage };
      this.rememberMeaning(this.requestMessage, affected.id, saved.revision);
      const result = { text: this.personality.saved(i.intent, affected, task, new Date(this.clock())), executed: true };
      return this.offer(result, [affected], saved.revision);
    } catch {
      // SQLite errors are local and already sanitized by Rust; never display provider bodies.
      return { text: `${this.client.getState().error || 'Não foi possível gravar a tarefa.'} Não confirmei a operação. Confira as tarefas antes de repetir.` };
    }
  }
}
