// Habitual authorization v1. Frozen A/B retains src/task-conversation.ts unchanged.
import { conversationAuthorization, reviewSummary, type AuthorizationTransport, type ReviewProposal, type WriteKind } from './conversation-authorization';
import { IntelligenceSession, intelligenceFailure, type IntelligenceParameters, type IntelligencePreview, type Interpretation, type RestorableField, type IntelligenceSessionContext } from './intelligence';
import { ConversationPersonality, clarificationReply, conversationalReply, spokenDeadline, type ConversationPersonalityContext } from './conversation-personality';
import { readQueryPeriod, queryBounds, queryPeriodBounds } from './query-periods';
import { taskClient, taskDeadline, isTaskOverdue, selectTasks, type Task, type TaskClient, type TaskInput, type TaskSnapshot } from './tasks';

export interface ConversationResult { text: string; panel?: 'tasks' | 'chat'; taskIds?: number[]; executed?: boolean; approval?: { id: string; destructive: boolean } }
type Pending = { interpretation: Interpretation; ids: number[]; revision: number; kind: 'choose'; expiresAt: number };
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

// Share the existing local refusal protocol; this does not grant permissions
// or change how v1 cancels a concrete task proposal.
export const isConversationCancellation = (message: string) => suggestionReply(message) === 'decline';

// A shared factual context does not transfer the authority of an offer.
export function requiresOriginAuthority(message: string, context: AuthorizedTaskConversationContext): boolean {
  const decision = suggestionReply(message);
  if (context.staged && (decision === 'decline' || /^confirmo excluir\b/.test(normalize(message)))) return true;
  return !!context.suggestion && (decision === 'decline' || decision === 'accept' && /^[\p{L}\p{M} ,]+[.!]?$/u.test(message.trim()));
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
export function explicitFields(message: string): Set<RestorableField> {
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
export interface TaskRoutingContext {
  revision: number | null;
  previousTask: boolean;
  pendingSuggestion: 'priority' | 'panel' | null;
  queryAnchor: string | null;
  restorableFields: RestorableField[];
  context: string[];
  previousDraft: IntelligenceParameters | null;
}

interface ReviewBaseline { revision: number; taskCount: number; othersDigest: string }
async function taskDigest(tasks: Task[], excludedId: number | null): Promise<string> {
  const rows = tasks.filter(task => task.id !== excludedId).sort((a, b) => a.id - b.id).map(task =>
    [task.id, task.completed, task.title, task.description, task.priority, task.project, task.dueDate, task.dueTime]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface AuthorizedTaskConversationContext {
  version: 1;
  staged: { proposal: ReviewProposal; snapshot: ReviewBaseline; message: string; expiresAt: number; restoring: boolean } | null;
  personality: ConversationPersonalityContext;
  socialContext: string[];
  suggestion: Suggestion | null;
  lastEdit: LastEdit | null;
  meaning: MeaningContext | null;
  requestMessage: string;
  suggested: string[];
  turns: number;
  lastSuggestionTurn: number;
  previousQuery: IntelligenceParameters | null;
  previousId: number | null;
  knownRevision?: number | null;
  pending: Pending | null;
  clarification?: string;
  clarificationQuestion?: string;
  updatedAt: number;
  last: { message: string; result: ConversationResult } | null;
  intelligence: IntelligenceSessionContext;
}

export class AuthorizedTaskConversation {
  private staged: { proposal: ReviewProposal; snapshot: ReviewBaseline; message: string; expiresAt: number; restoring: boolean } | null = null;
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
  private knownRevision: number | null = null;
  private pending: Pending | null = null;
  private clarification: string | undefined;
  private clarificationQuestion: string | undefined;
  private busy = false;
  private generation = 0;
  private updatedAt = 0;
  private last: { message: string; result: ConversationResult } | null = null;
  constructor(private client: TaskClient = taskClient, private intelligence = new IntelligenceSession(), private clock = () => Date.now(), private authorization: AuthorizationTransport = conversationAuthorization) {}
  exportContext(): AuthorizedTaskConversationContext {
    return structuredClone({ version: 1, staged: this.staged, personality: this.personality.exportContext(),
      socialContext: this.socialContext, suggestion: this.suggestion, lastEdit: this.lastEdit, meaning: this.meaning,
      requestMessage: this.requestMessage, suggested: [...this.suggested], turns: this.turns,
      lastSuggestionTurn: this.lastSuggestionTurn, previousQuery: this.previousQuery, previousId: this.previousId, knownRevision: this.knownRevision,
      pending: this.pending, clarification: this.clarification, clarificationQuestion: this.clarificationQuestion,
      updatedAt: this.updatedAt, last: this.last, intelligence: this.intelligence.exportContext() });
  }
  importContext(context: AuthorizedTaskConversationContext) {
    if (this.busy) throw new Error('Não é possível substituir uma conversa em andamento.');
    const copy = structuredClone(context);
    if (copy.version !== 1 || !Array.isArray(copy.socialContext) || copy.socialContext.length > 6
      || copy.socialContext.some(value => typeof value !== 'string' || value.length > 1000)
      || !Array.isArray(copy.suggested) || copy.suggested.length > 20
      || copy.suggested.some(value => typeof value !== 'string')
      || !Number.isSafeInteger(copy.turns) || copy.turns < 0 || !Number.isSafeInteger(copy.lastSuggestionTurn)
      || copy.knownRevision !== undefined && copy.knownRevision !== null && (!Number.isSafeInteger(copy.knownRevision) || copy.knownRevision < 0)
      || !Number.isFinite(copy.updatedAt) || copy.updatedAt < 0
      || new TextEncoder().encode(JSON.stringify(copy)).byteLength > 512 * 1024) throw new Error('Contexto de tarefas inválido.');
    // Hydration is data only: never clear/cancel a proposal or renew its expiry.
    this.intelligence.importContext(copy.intelligence); this.personality.importContext(copy.personality);
    this.staged = copy.staged; this.socialContext = copy.socialContext; this.suggestion = copy.suggestion;
    this.lastEdit = copy.lastEdit; this.meaning = copy.meaning; this.requestMessage = copy.requestMessage;
    this.suggested = new Set(copy.suggested); this.turns = copy.turns; this.lastSuggestionTurn = copy.lastSuggestionTurn;
    this.previousQuery = copy.previousQuery; this.previousId = copy.previousId; this.pending = copy.pending;
    this.knownRevision = copy.knownRevision ?? copy.lastEdit?.revision ?? copy.meaning?.revision ?? copy.pending?.revision ?? copy.suggestion?.revision ?? copy.staged?.snapshot.revision ?? null;
    this.clarification = copy.clarification; this.clarificationQuestion = copy.clarificationQuestion;
    this.updatedAt = copy.updatedAt; this.last = copy.last;
  }
  clear() {
    this.discardApproval();
    this.requestMessage = ''; this.meaning = null; this.lastEdit = null; this.suggestion = null; this.suggested.clear(); this.turns = 0; this.lastSuggestionTurn = -3; this.personality.reset(); this.socialContext = [];
    this.previousQuery = null; this.previousId = null; this.knownRevision = null; this.pending = null; this.clarification = undefined; this.last = null;
    this.clarificationQuestion = undefined;
    this.updatedAt = 0; this.generation++; this.intelligence.clear();
  }
  // Only read already-loaded state here. Independent capabilities must never
  // refresh, open or depend on the task database merely to choose a capability.
  routingContext(message: string): TaskRoutingContext {
    if (this.updatedAt && this.clock() - this.updatedAt > 15 * 60_000) this.clear();
    const state = this.client.getState();
    const snapshot = state.snapshot;
    // A freshly loaded WebView may not have its task cache yet. The canonical
    // revision is a routing hint, never authority: send() still rereads SQLite
    // and rejects a different revision before preparing any operation.
    const cacheCurrent = state.ready && (this.knownRevision === null || snapshot.revision >= this.knownRevision);
    const revision = cacheCurrent ? snapshot.revision : this.knownRevision;
    if (this.staged && (this.clock() >= this.staged.expiresAt || this.staged.snapshot.revision !== revision)) {
      this.discardApproval();
      this.clarification = undefined; this.clarificationQuestion = undefined;
    }
    const creation = this.staged?.proposal.effect.kind === 'create_task' ? this.staged.proposal.effect.input : null;
    const previousTask = !creation && this.previousId !== null && (cacheCurrent ? snapshot.tasks.some(t => t.id === this.previousId) : revision !== null);
    // Values from a still-current reviewed creation are factual draft data only.
    // Never export approval IDs, descriptions or an existing task as a draft.
    const previousDraft: IntelligenceParameters | null = creation ? {
      title: creation.title, priority: creation.priority, project: creation.project || null,
      dueDate: creation.dueDate, dueTime: creation.dueTime, target: null, panel: null,
      titleSuffix: null, restoreFields: null, status: null, queryPeriod: null,
    } : null;
    const edit = this.lastEdit;
    const validEdit = edit && edit.after.id === this.previousId && edit.revision === revision && this.clock() < edit.expiresAt;
    const compound = asksRestore(message) && explicitFields(message).size > 0;
    let original = this.clarification;
    let question = this.clarificationQuestion;
    if (this.staged) {
      const { kind, input } = this.staged.proposal.effect;
      const { description: _description, ...values } = input ?? { description: '' };
      original = this.staged.message;
      question = `Proposta ainda NÃO executada: ${JSON.stringify({ intent: kind, values, target: this.staged.proposal.before?.title ?? null })}`;
    }
    const meaning = this.meaning && this.meaning.revision === revision && this.clock() < this.meaning.expiresAt ? this.meaning.message : undefined;
    const context = [original, original ? question : undefined, meaning, (compound || refersToInformation(message)) && validEdit ? edit.message : undefined].filter((value): value is string => !!value);
    const routing: TaskRoutingContext = {
      revision,
      previousTask,
      previousDraft,
      pendingSuggestion: this.suggestion && this.clock() < this.suggestion.expiresAt ? this.suggestion.kind : null,
      queryAnchor: this.previousQuery ? queryBounds(this.previousQuery, new Date(this.clock()))?.[0] ?? null : null,
      restorableFields: compound && validEdit ? editableFields.filter(field => edit.before[field] !== edit.after[field]) : [],
      context: [...new Set(context.length ? context : this.socialContext)].slice(0, 3),
    };
    // A new free message invalidates the old proposal before any network wait,
    // while retaining its unexecuted meaning for the same clarification rules.
    if (this.staged) {
      this.clarification = original;
      this.clarificationQuestion = question;
      this.discardApproval();
    }
    return routing;
  }
  handlesLocalTurn(message: string): boolean {
    const text = normalize(message);
    if (this.updatedAt && this.clock() - this.updatedAt > 15 * 60_000) return false;
    const correction = /^(?:(?:na verdade|na realidade|jarvis|senhor) )?(?:deixa|deixe|deixar|volta|volte|voltar|desfaz|desfaca|desfazer|restaura|restaure)\b/.test(text) && editCorrection(message);
    if (this.last?.message === text || correction || suggestionReply(message) || /^confirmo excluir\b/.test(text)) return true;
    if (this.pending && (/^\d+$/.test(text) || this.client.getState().snapshot.tasks.some(t => this.pending!.ids.includes(t.id) && normalize(t.title) === text))) return true;
    return !!this.previousQuery && !!readQueryPeriod(message, new Date(this.clock()), this.previousQuery)?.onlyPeriod;
  }
  hasPendingTurn(): boolean {
    return !!(this.staged || this.pending || this.suggestion || this.clarification);
  }
  async send(message: string, routed?: { preview: IntelligencePreview; revision: number | null }): Promise<ConversationResult | null> {
    if (this.busy) { return { text: 'Já estou cuidando do pedido anterior.' }; }
    if (!message.trim() || message.length > 1000) { return { text: 'Informe um pedido com até 1.000 caracteres.' }; }
    if (this.updatedAt && this.clock() - this.updatedAt > 15 * 60_000) this.clear();
    const text = normalize(message);
    const approved = this.staged;
    if (approved?.proposal.effect.kind === 'delete_task' && message.trim().toLowerCase() === `confirmo excluir ${approved.proposal.effect.id}`) return this.approve(approved.proposal.proposalId);
    if (approved && suggestionReply(message) === 'decline') return this.cancelApproval(approved.proposal.proposalId);
    this.discardApproval();
    if (approved) {
      // Keep an unexecuted draft as context, never as permission. Do not send
      // persistent IDs, descriptions or previous restoration values to Gemini.
      const { kind, input } = approved.proposal.effect;
      const { description: _description, ...values } = input ?? { description: '' };
      this.clarification = approved.message;
      this.clarificationQuestion = `Proposta ainda NÃO executada: ${JSON.stringify({ intent: kind, values, target: approved.proposal.before?.title ?? null })}`;
    }
    this.requestMessage = message;
    if (this.last?.message === text) { return { ...this.last.result, executed: false, text: 'Esse pedido já foi atendido, senhor. Confira o resultado no painel de tarefas.' }; }
    this.last = null;
    const generation = this.generation;
    this.busy = true;
    try {
      await this.client.refresh();
      if (generation !== this.generation) return null;
      const state = this.client.getState();
      if (!state.ready) { return { text: 'Não foi possível consultar as tarefas locais. Nenhuma ação executada.' }; }
      let snapshot = state.snapshot;
      this.knownRevision = snapshot.revision;
      if (routed?.revision !== null && routed?.revision !== undefined && routed.revision !== snapshot.revision) return { text: 'As tarefas mudaram durante a interpretação, senhor. Repita o pedido para usar os dados atuais.' };
      this.updatedAt = this.clock();
      this.personality.next(); this.turns++;
      if (this.meaning && (this.meaning.id !== this.previousId || this.meaning.revision !== snapshot.revision || this.clock() >= this.meaning.expiresAt)) {
        this.meaning = null;
        if (refersToInformation(message)) { return { text: 'Essa referência já não está segura, senhor. Indique a tarefa e a informação que deseja corrigir.' }; }
      }
      const compoundCorrection = asksRestore(message) && explicitFields(message).size > 0 && /\b(?:titulo|projeto|prioridade|prazo|data|horario)\b/.test(text);
      if (compoundCorrection && this.pending) return { text: 'Há um pedido aguardando identificação ou confirmação, senhor. Esclareça esse pedido antes de combinar uma restauração.' };
      const correction = compoundCorrection ? null : editCorrection(message);
      if (correction) {
        if (correction === 'clarify' || this.pending) { return { text: 'Qual edição deseja restaurar, senhor? Preciso de uma referência inequívoca antes de alterar a tarefa.' }; }
        const result = await this.restoreLastEdit(snapshot);
        if (result.executed && generation === this.generation) this.last = { message: text, result };
        return result;
      }
      const decision = suggestionReply(message);
      // A bare local reply may accept a displayed offer. Quoted commands, code,
      // parentheses and other syntax must never become consent by normalization.
      const plainLocalAcceptance = /^[\p{L}\p{M} ,]+[.!]?$/u.test(message.trim());
      if (decision === 'decline') {
        const hadPending = approved !== null || this.pending !== null || this.suggestion !== null || this.clarification !== undefined;
        this.suggestion = null;
        this.pending = null; this.clarification = undefined;
        return { text: hadPending ? 'Está bem, senhor. Deixei como está; o pedido pendente foi cancelado.' : 'Está bem, senhor.' };
      }
      if (this.pending) {
        const pending = this.pending;
        if (snapshot.revision !== pending.revision || this.clock() >= pending.expiresAt) {
          this.pending = null;
          { return { text: 'A seleção expirou ou as tarefas mudaram. Repita o pedido para identificar e confirmar novamente.' }; }
        }
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
        if (numeric >= 0) { return { text: 'Opção inválida. Repita o pedido para selecionar uma tarefa.' }; }
      }
      if (this.suggestion && this.clock() >= this.suggestion.expiresAt) this.suggestion = null;
      if (this.suggestion) {
        if (snapshot.revision !== this.suggestion.revision) {
          this.suggestion = null;
          { return { text: 'As tarefas mudaram desde a sugestão, senhor. Consulte novamente antes de aceitar.' }; }
        }
        if (decision === 'accept' && plainLocalAcceptance) {
          const result = await this.acceptSuggestion(snapshot, true);
          if (result.executed && generation === this.generation) this.last = { message: text, result };
          return result;
        }
        if (decision === 'reference') { return this.describeSuggestion(snapshot); }
      } else if (decision === 'accept' || decision === 'reference') { return { text: 'Não há uma sugestão aguardando aceite, senhor. Qual ação deseja realizar?' }; }
      if (/^confirmo excluir\b/.test(text)) { return { text: 'Não há exclusão aguardando essa confirmação.' }; }
      const period = readQueryPeriod(message, new Date(this.clock()), this.previousQuery);
      if (period?.clarification) return { text: period.clarification };
      if (period?.onlyPeriod && period.parameters) {
        if (this.previousQuery || period.parameters.queryPeriod === 'week_of_date') {
          this.lastEdit = null; this.suggestion = null;
          return this.query({ title: null, priority: null, project: null, dueTime: null, target: null, panel: null, ...this.previousQuery, ...period.parameters }, snapshot);
        }
        if (this.previousId === null && !this.clarification) { return { text: 'Quais tarefas você quer consultar nesse período?' }; }
      }
      const clarificationContext = this.clarification;
      const edit = this.lastEdit;
      const validEdit = edit && edit.after.id === this.previousId && edit.revision === snapshot.revision && this.clock() < edit.expiresAt;
      const restorableFields = compoundCorrection && validEdit ? editableFields.filter(field => edit.before[field] !== edit.after[field]) : [];
      const taskContext = [this.clarification, this.clarification ? this.clarificationQuestion : undefined, this.meaning?.message, (compoundCorrection || refersToInformation(message)) && validEdit ? edit.message : undefined].filter((value): value is string => !!value);
      const contextRevision = snapshot.revision;
      const preview = routed ? routed.preview : await this.intelligence.interpret(message, { taskContext, restorableFields, previousTask: this.previousId !== null && snapshot.tasks.some(t => t.id === this.previousId), clarification: this.clarification, conversation: this.socialContext, pendingSuggestion: this.suggestion?.kind, queryAnchor: this.previousQuery ? queryBounds(this.previousQuery, new Date(this.clock()))?.[0] : null });
      if (!preview || generation !== this.generation) return null;
      await this.client.refresh();
      if (generation !== this.generation) return null;
      if (!this.client.getState().ready) { return { text: 'Não foi possível reler as tarefas locais. Nenhuma ação executada.' }; }
      snapshot = this.client.getState().snapshot;
      const i = preview.interpretation;
      if ((i.parameters.titleSuffix || i.parameters.restoreFields?.length) && i.intent !== 'update_task') { return { text: 'Essa correção precisa identificar uma única edição de tarefa, senhor. Nenhuma alteração foi feita.' }; }
      if ((taskContext.length || compoundCorrection) && snapshot.revision !== contextRevision) { return { text: 'As tarefas mudaram durante a interpretação, senhor. Confira a tarefa e repita a correção.' }; }
      if (compoundCorrection && (this.pending || i.intent !== 'update_task' || !i.parameters.restoreFields?.length)) { return { text: 'Quais campos deseja restaurar e como deve ficar o título, senhor? Nenhuma alteração foi feita.' }; }
      if (i.intent === 'accept_suggestion' || i.intent === 'decline_suggestion') {
        if (!this.suggestion) { return { text: 'Não há uma sugestão aguardando aceite, senhor. Qual ação deseja realizar?' }; }
        if (i.clarification || i.requiresConfirmation || (i.intent === 'accept_suggestion' && (message.includes('?') || /\b(se|talvez|mas|porem|depende|ou|outra|outro)\b/.test(text)))) { return this.describeSuggestion(snapshot); }
        if (i.intent === 'decline_suggestion') { this.suggestion = null; return { text: 'Está bem, senhor. Deixei como está.' }; }
        // A semantic acceptance chooses only the stored action, never model parameters.
        if (Object.values(i.parameters).some(value => value !== null && value !== undefined)) { return this.describeSuggestion(snapshot); }
        const result = await this.acceptSuggestion(snapshot);
        if (result.executed && generation === this.generation) this.last = { message: text, result };
        return result;
      }
      if (this.suggestion && (i.clarification || ['clarify', 'conversation', 'unsupported'].includes(i.intent))) { return this.describeSuggestion(snapshot); }
      this.suggestion = null;
      if (!['update_task', 'conversation', 'clarify', 'unsupported'].includes(i.intent) && !i.clarification) {
        if (!['create_task', 'complete_task', 'delete_task'].includes(i.intent)) this.lastEdit = null;
        this.meaning = null;
      }
      this.socialContext = [];
      this.clarification = undefined;
      if (i.intent !== 'query_tasks') this.previousQuery = null;
      if (i.clarification || i.intent === 'clarify') {
        if (explicitFields(message).size === 0 && !refersToInformation(message)) this.previousId = null;
        if (this.previousId !== null) this.rememberMeaning(message, this.previousId, snapshot.revision);
        this.clarification = clarificationContext ?? message;
        this.clarificationQuestion = clarificationReply(i.clarification);
        { return { text: clarificationReply(i.clarification) }; }
      }
      let result: ConversationResult;
      if (i.intent === 'query_tasks') {
        
        result = this.query({ ...i.parameters, ...period?.parameters }, snapshot);
      } else if (i.intent === 'create_task') {
        result = await this.apply(i, undefined, snapshot);
      } else if (['update_task', 'complete_task', 'delete_task'].includes(i.intent)) {
        const target = i.parameters.target;
        if (!target) { return { text: 'A qual tarefa você se refere?' }; }
        if (!previousReferences.has(normalize(target)) && !normalize(`${message} ${clarificationContext ?? ''}`).includes(normalize(target))) {
          { return { text: 'Não consegui vincular a referência ao seu pedido. Informe o título da tarefa.' }; }
        }
        const matches = previousReferences.has(normalize(target))
          ? snapshot.tasks.filter(t => t.id === this.previousId)
          : resolveTasks(snapshot.tasks, target);
        if (!matches.length) { return { text: 'Não encontrei essa tarefa. Informe o título para eu identificá-la.' }; }
        if (matches.length > 1) {
          const choices = matches.slice(0, 10);
          this.pending = { interpretation: i, ids: choices.map(t => t.id), revision: snapshot.revision, kind: 'choose', expiresAt: this.clock() + 15 * 60_000 };
          { return { text: `Encontrei mais de uma tarefa. Qual delas? Responda com o número:\n${choices.map((t, index) => `${index + 1}. ${t.title} · ${taskDeadline(t)} · ${t.completed ? 'concluída' : 'pendente'} · #${t.id}`).join('\n')}${matches.length > 10 ? '\nOu informe um título mais específico.' : ''}` }; }
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
      if (failure.code === 'invalid_response' || failure.code === 'blocked_response') { return this.suggestion ? this.describeSuggestion(this.client.getState().snapshot) : { text: 'Não consegui determinar esse pedido com segurança, senhor. Nenhuma ação executada. Pode esclarecer a ação ou o período desejado?' }; }
      { return { text: `${failure.message}${failure.retryAfterSeconds ? ` Aguarde ${failure.retryAfterSeconds}s.` : ''} Nenhuma ação executada.` }; }
    } finally { this.busy = false; }
  }
  private query(p: IntelligenceParameters, snapshot: TaskSnapshot): ConversationResult {
    const now = new Date(this.clock());
    if (p.queryPeriod === 'week_of_date' && !p.dueDate) { return { text: 'Qual data identifica essa semana, senhor?' }; }
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
      { return { text: 'Não tenho uma edição anterior identificável para restaurar, senhor. Qual tarefa e valor deseja ajustar?' }; }
    }
    const task = snapshot.tasks.find(t => t.id === edit.after.id);
    if (snapshot.revision !== edit.revision || !task || task.completed !== edit.after.completed || taskFields.some(key => task[key] !== edit.after[key])) {
      this.lastEdit = null;
      { return { text: 'As tarefas mudaram desde essa edição, senhor. Confira a tarefa e indique o ajuste desejado antes de prosseguirmos.' }; }
    }
    const { id: _id, completed: _completed, ...input } = edit.before;
    // Preparing a restoration does not consume the confirmed edit.
    this.suggestion = null; this.clarification = undefined;
    this.previousQuery = null; this.socialContext = [];
    const interpretation: Interpretation = { intent: 'update_task', parameters: { ...input, target: task.title, panel: null }, reply: '', clarification: null, requiresConfirmation: false, usesPreviousDraft: false };
    return this.stageWrite(interpretation, task, snapshot, input, false, true);
  }

  private async acceptSuggestion(snapshot: TaskSnapshot, locallyAccepted = false): Promise<ConversationResult> {
    const suggestion = this.suggestion;
    const task = snapshot.tasks.find(t => t.id === suggestion?.id);
    if (!suggestion || this.clock() >= suggestion.expiresAt || snapshot.revision !== suggestion.revision || !task || task.completed) { return this.describeSuggestion(snapshot); }
    // Consume before IPC. Neither an unknown turn nor model prose can redirect this action.
    this.suggestion = null; this.clarification = undefined;
    if (suggestion.kind === 'panel') return { text: `Aqui está “${task.title}”, senhor.`, panel: 'tasks', taskIds: [task.id] };
    this.previousQuery = null;
    { return this.apply({ intent: 'update_task', parameters: { title: null, priority: 'high', project: null, dueDate: null, dueTime: null, target: null, panel: null }, reply: '', clarification: null, requiresConfirmation: false, usesPreviousDraft: false }, task, snapshot, locallyAccepted); }
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

  private async apply(i: Interpretation, task: Task | undefined, snapshot: TaskSnapshot, locallyAccepted = false): Promise<ConversationResult> {
    const generation = this.generation;
    const p = i.parameters;
    if (i.requiresConfirmation && i.intent !== 'delete_task') { return { text: 'Esse pedido requer esclarecimento. Reformule a operação desejada.' }; }
    if (i.intent === 'complete_task' && task?.completed) { this.previousId = task.id; { return { text: `“${task.title}” já está concluída.` }; } }
    let input: TaskInput = {
      title: p.title ?? task?.title ?? '', description: task?.description ?? '', priority: p.priority ?? task?.priority ?? 'normal',
      project: p.project ?? task?.project ?? '', dueDate: p.dueDate ?? task?.dueDate ?? null, dueTime: p.dueTime ?? task?.dueTime ?? null,
    };
    if (i.intent === 'update_task' && task) {
      const corrected = this.correctedInput(i, task, snapshot, input);
      if (!corrected) { this.rememberMeaning(this.requestMessage, task.id, snapshot.revision); { return { text: 'Preciso confirmar quais campos deseja alterar, senhor. Indique o título, o projeto ou os valores a restaurar; nenhuma alteração foi feita.' }; } }
      input = corrected;
    }
    if (i.intent === 'create_task') {
      const duplicates = snapshot.tasks.filter(t => !t.completed && normalize(t.title) === normalize(input.title) && t.dueDate === input.dueDate && t.dueTime === input.dueTime && normalize(t.project) === normalize(input.project));
      if (duplicates.length) {
        this.previousId = duplicates.length === 1 ? duplicates[0].id : null;
        { return { text: `Já existe uma tarefa com esse título e prazo. Não criei outra.`, panel: 'tasks' }; }
      }
    }
    if (i.intent === 'update_task' && task && Object.entries(input).every(([key, value]) => task[key as keyof TaskInput] === value)) {
      this.previousId = task.id; this.rememberMeaning(this.requestMessage, task.id, snapshot.revision); { return { text: `“${task.title}” já está com esses dados.` }; }
    }
    return this.stageWrite(i, task, snapshot, input, locallyAccepted);
  }
  private discardApproval() {
    const staged = this.staged; this.staged = null;
    if (staged) void this.authorization.cancel(staged.proposal.proposalId).catch(() => { /* Old IDs cannot execute without a matching local approval. */ });
  }
  async cancelApproval(id: string): Promise<ConversationResult> {
    if (this.busy || this.staged?.proposal.proposalId !== id) return { text: 'Essa proposta já não está ativa.' };
    this.staged = null; // Never restore an approval after an uncertain IPC outcome.
    this.pending = null; this.clarification = undefined;
    this.busy = true;
    try {
      await this.authorization.cancel(id);
      return { text: 'Está bem, senhor. A proposta foi cancelada.' };
    } catch {
      return { text: 'A proposta foi desativada nesta conversa, mas não consegui confirmar o cancelamento no aplicativo. Não tente reaproveitá-la; confira as tarefas antes de fazer outro pedido.' };
    } finally { this.busy = false; }
  }
  private async stageWrite(i: Interpretation, task: Task | undefined, snapshot: TaskSnapshot, input: TaskInput, locallyAccepted = false, restoring = false): Promise<ConversationResult> {
    const generation = this.generation;
    try {
      const kind = i.intent as WriteKind;
      const baseline: ReviewBaseline = { revision: snapshot.revision, taskCount: snapshot.tasks.length, othersDigest: await taskDigest(snapshot.tasks, task?.id ?? null) };
      if (generation !== this.generation) return { text: 'A conversa foi limpa. Proposta descartada.' };
      const proposal = await this.authorization.prepare({ kind, id: task?.id ?? null, input: kind === 'create_task' || kind === 'update_task' ? input : null, expectedRevision: snapshot.revision });
      if (generation !== this.generation) { void this.authorization.cancel(proposal.proposalId).catch(() => {}); return { text: 'A conversa foi limpa. Proposta descartada.' }; }
      this.previousId = task?.id ?? null;
      this.staged = { proposal: structuredClone(proposal), snapshot: baseline, message: this.requestMessage, restoring, expiresAt: this.clock() + proposal.expiresInSeconds * 1000 };
      if (locallyAccepted && kind !== 'delete_task') return this.commitApproval(proposal.proposalId);
      const result: ConversationResult = { text: reviewSummary(proposal), approval: { id: proposal.proposalId, destructive: kind === 'delete_task' } };
      if (kind === 'delete_task') result.text += ` Ou digite “confirmo excluir ${task!.id}”.`;
      return result;
    } catch { return { text: 'Não consegui preparar essa operação, senhor. Confira as tarefas e repita o pedido; nenhuma escrita foi autorizada.' }; }
  }
  async approve(id: string): Promise<ConversationResult> {
    if (this.busy) return { text: 'Já estou cuidando do pedido anterior.' };
    this.busy = true;
    try { return await this.commitApproval(id); } finally { this.busy = false; }
  }
  private async commitApproval(id: string): Promise<ConversationResult> {
    const staged = this.staged;
    if (!staged || staged.proposal.proposalId !== id) return { text: 'Essa proposta já não está ativa.' };
    this.staged = null; // Consume locally before awaiting the backend.
    if (this.clock() >= staged.expiresAt) { void this.authorization.cancel(id).catch(() => {}); return { text: 'A aprovação expirou. Repita o pedido, senhor.' }; }
    const generation = this.generation;
    const { effect, before } = staged.proposal;
    this.lastEdit = null; // An attempted write may commit even if its reply is lost.
    try {
      const saved = await this.authorization.approve(id);
      const fields: (keyof TaskInput)[] = ['title', 'description', 'priority', 'project', 'dueDate', 'dueTime'];
      let affected = saved.tasks.find(t => t.id === effect.id);
      if (effect.kind === 'create_task') {
        affected = undefined;
        for (const candidate of saved.tasks.filter(t => !t.completed && effect.input && fields.every(k => t[k] === effect.input![k]))) {
          if (await taskDigest(saved.tasks, candidate.id) === staged.snapshot.othersDigest) { affected = candidate; break; }
        }
      }
      const othersUnchanged = await taskDigest(saved.tasks, effect.kind === 'create_task' ? affected?.id ?? null : effect.id) === staged.snapshot.othersDigest;
      const correct = saved.revision === effect.expectedRevision + 1 && saved.tasks.length === staged.snapshot.taskCount + (effect.kind === 'create_task' ? 1 : effect.kind === 'delete_task' ? -1 : 0) && othersUnchanged && (effect.kind === 'delete_task' ? !affected : !!affected && (effect.input ? fields.every(k => affected[k] === effect.input![k]) && affected.completed === (before?.completed ?? false) : affected.completed && !!before && fields.every(k => affected[k] === before[k])));
      if (!correct) return { text: 'Não consegui confirmar o efeito autorizado, senhor. Confira as tarefas antes de repetir.' };
      this.knownRevision = saved.revision;
      if (generation !== this.generation) return { text: 'A conversa foi limpa durante a gravação. Confira o resultado no painel.' };
      this.pending = null; this.clarification = undefined; this.previousQuery = null;
      this.previousId = affected?.id ?? null;
      if (affected) this.rememberMeaning(staged.message, affected.id, saved.revision);
      if (!staged.restoring && effect.kind === 'update_task' && affected && before) this.lastEdit = { before, after: affected, revision: saved.revision, expiresAt: this.clock() + 15 * 60_000, message: staged.message };
      const receipt = { text: effect.kind === 'delete_task' ? this.personality.deleted(before!) : this.personality.saved(effect.kind, affected!, before ?? undefined, new Date(this.clock())), executed: true };
      const result = affected ? this.offer(receipt, [affected], saved.revision) : receipt;
      this.last = { message: normalize(staged.message), result };
      return result;
    } catch { this.lastEdit = null; return { text: 'Não consegui confirmar a operação, senhor. Confira as tarefas antes de repetir; a aprovação foi consumida.' }; }
  }
}
