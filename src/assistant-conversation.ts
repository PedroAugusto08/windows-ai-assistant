import { invoke, isTauri } from '@tauri-apps/api/core';
import { AuthorizedTaskConversation, isConversationCancellation, type ConversationResult, type AuthorizedTaskConversationContext } from './authorized-task-conversation';
import { intelligenceFailure, localClock, type IntelligenceRequest, type IntelligencePreview, type Interpretation } from './intelligence';
import { getWeather, placeLabel, weatherText, type WeatherPlace, type WeatherTransport } from './weather';
import type { TaskSnapshot } from './tasks';
import type { ExecutorGoal, ExecutorProposal } from './executor';

export interface AssistantRequest {
  taskContext: IntelligenceRequest;
  cityContext: string | null;
  activeCapability: 'task' | 'weather' | 'browser_search' | null;
  clarification: string | null;
}
export interface AssistantInterpretation {
  executionIntent: 'execute_now' | 'deferred' | 'non_executive' | 'cancel';
  capability: 'task' | 'browser_search' | 'weather' | 'research' | 'clarify' | 'conversation' | 'plan';
  task: Interpretation | null;
  query: string | null;
  city: string | null;
  date: string | null;
  usesCityContext: boolean;
  question: string | null;
  answer?: string | null;
  planTargets?: string[] | null;
}
export interface ConversationMetrics { requestCount: number; latencyMs: number; promptTokens: number | null; outputTokens: number | null }
export interface AssistantPreview { interpretation: AssistantInterpretation; dryRun: true; executed: false; metrics?: ConversationMetrics | null }
export type AssistantInterpreter = (request: AssistantRequest) => Promise<AssistantPreview>;
const desktop = <T>(command: string, args: Record<string, unknown>) => isTauri()
  ? invoke<T>(command, args) : Promise.reject({ code: 'preview_only', message: '' });
const interpret: AssistantInterpreter = request => desktop('interpret_assistant', { request });
export type SearchOpener = (query: string) => Promise<void>;
export type ResponseKind = 'general_answer' | 'clarification' | 'proposal' | 'tool_result' | 'unavailable';
export type AssistantResult = ConversationResult & { weatherAttribution?: true; feedback?: string; responseKind?: ResponseKind };
export interface PlanTransport {
  read(): Promise<TaskSnapshot>;
  prepare(request: ExecutorProposal, expectedRevision: number): Promise<ExecutorGoal>;
}
export interface AssistantConversationContext {
  version: 1;
  activeCapability: AssistantRequest['activeCapability'];
  city: { place: WeatherPlace; expiresAt: number } | null;
  clarification: { original: string; question: string; expiresAt: number; authorizesSearch: boolean } | null;
  choices: { places: WeatherPlace[]; date: string | null; expiresAt: number } | null;
  tasks: AuthorizedTaskConversationContext;
}
const openSearch: SearchOpener = query => desktop('open_browser_search', { query });
const normalized = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function generalAnswer(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000 || /[\u0000-\u0008\u000b-\u001f]/.test(text)) return null;
  // Prose has no receipt channel. Reject direct claims of performed operations;
  // the visible provenance label also applies to explanations and examples.
  if (/\b(?:criei|salvei|gravei|exclui|deletei|removi|alterei|atualizei|conclui|finalizei|executei|autorizei|abri|consultei|pesquisei|acessei|naveguei|i (?:created|deleted|executed|opened|searched))\b/.test(normalized(text))) return null;
  const prose = normalized(text);
  if (/\b(?:esta feito|ja esta pronto|all done|it is done)\b|\bvoce tem \d+ tarefas\b/.test(prose)) return null;
  if (prose.split(/[.!?\n]/).some(sentence => /\b(?:taref\w*|plano\w*|pesquisa\w*|navegador|arquivo\w*|documento\w*|task|plan|browser)\b/.test(sentence)
    && /\b(?:foi|foram|esta|estao|sera|serao|ja|agora|has been|have been|was|were|is now)\b[^.!?\n]{0,100}\b(?:concluid\w*|complet\w*|finalizad\w*|criad\w*|salv\w*|excluid\w*|alterad\w*|executad\w*|autorizad\w*|abert\w*|completed|deleted|created|executed)\b/.test(sentence))) return null;
  return text.trim();
}
function clarificationQuestion(question: string): string {
  const text = normalized(question);
  // Clarification prose cannot smuggle an invented forecast or execution
  // receipt. The model selects what is missing; local text asks for it.
  if (/cidade|localidade|municipio/.test(text)) return 'Qual cidade deseja usar, senhor? Informe também o estado ou país se necessário.';
  if (/data|periodo|dia|sabado|domingo/.test(text)) return 'Para qual data deseja a previsão, senhor?';
  if (/assunto|termo|procurar|pesquisar/.test(text)) return 'Qual assunto deseja procurar no Google, senhor?';
  return generalAnswer(question) && !/[.!]\s/.test(question) ? question : 'Pode esclarecer o que deseja, senhor?';
}

// This is a refusal guard, not a natural-language router. Semantic selection is
// the one structured model call; source text cannot be silently promoted from
// explanation, negation or synthesis to permission to launch a browser.
export function explicitSearchRequest(message: string): boolean {
  const text = normalized(message).trim();
  return /^(?:(?:por favor|jarvis|senhor)[, ]+)*(?:(?:(?:voce )?pode(?:ria)?|(?:eu )?quero(?: que(?: voce)?)?|gostaria de|preciso que(?: voce)?) )?(?:pesquise|pesquisa|pesquisar|procure|procurar|busque|buscar|abra|abrir|abre|faca uma (?:pesquisa|busca))\b/.test(text)
    && !/\b(?:e|para) (?:me )?(?:explique|explicar|resuma|resumir|analise|analisar|compare|comparar|responda|responder|apresente)\b|\b(?:com fontes|com citacoes)\b/.test(text);
}

/** One semantic interpretation per turn; task effects remain behind v1. */
export class AssistantConversation {
  private busy = false;
  private generation = 0;
  private activeCapability: AssistantRequest['activeCapability'] = null;
  private city: { place: WeatherPlace; expiresAt: number } | null = null;
  private clarification: { original: string; question: string; expiresAt: number; authorizesSearch: boolean } | null = null;
  private choices: { places: WeatherPlace[]; date: string | null; expiresAt: number } | null = null;
  constructor(
    private tasks = new AuthorizedTaskConversation(),
    private interpreter: AssistantInterpreter = interpret,
    private opener: SearchOpener = openSearch,
    private clock = () => Date.now(),
    private weather: WeatherTransport = getWeather,
    private plans: PlanTransport = { read: () => desktop('list_tasks', {}), prepare: (request, expectedRevision) => desktop('executor_prepare', { request, expectedRevision }) },
  ) {}
  exportContext(): AssistantConversationContext {
    return structuredClone({ version: 1, activeCapability: this.activeCapability, city: this.city,
      clarification: this.clarification, choices: this.choices, tasks: this.tasks.exportContext() });
  }
  importContext(context: AssistantConversationContext) {
    if (this.busy) throw new Error('Não é possível substituir uma conversa em andamento.');
    const copy = structuredClone(context);
    if (copy.version !== 1 || ![null, 'task', 'weather', 'browser_search'].includes(copy.activeCapability)
      || [copy.city, copy.clarification, copy.choices].some(value => value !== null && (!Number.isFinite(value.expiresAt) || value.expiresAt < 0))
      || (copy.choices !== null && (!Array.isArray(copy.choices.places) || copy.choices.places.length > 20))
      || new TextEncoder().encode(JSON.stringify(copy)).byteLength > 512 * 1024) throw new Error('Contexto de conversa inválido.');
    this.tasks.importContext(copy.tasks);
    this.activeCapability = copy.activeCapability; this.city = copy.city;
    this.clarification = copy.clarification; this.choices = copy.choices;
  }
  clear() { this.generation++; this.activeCapability = null; this.city = null; this.clarification = null; this.choices = null; this.tasks.clear(); }
  private currentCity() {
    if (this.city && this.clock() >= this.city.expiresAt) this.city = null;
    return this.city?.place ?? null;
  }
  private endPendingIntent(): boolean {
    const hadPending = this.clarification !== null || this.choices !== null;
    this.clarification = null;
    this.choices = null;
    this.activeCapability = null;
    // Keep the provider-resolved city as expiring factual data, not an action.
    return hadPending;
  }
  private async cancelIntent(message: string, consumedPending = false): Promise<ConversationResult | null> {
    const hadPending = this.endPendingIntent() || consumedPending;
    // External pending states are created only after leaving the task domain.
    // Cancel them without SQLite; task proposal acknowledgement remains in v1.
    if (hadPending || !this.tasks.hasPendingTurn()) return { text: hadPending ? 'Solicitação pendente cancelada, senhor.' : 'Não há solicitação pendente, senhor.' };
    return this.tasks.send(message);
  }
  private ask(message: string, question: string, authorizesSearch = false, expiresAt = this.clock() + 15 * 60_000): AssistantResult {
    this.clarification = { original: message, question, expiresAt, authorizesSearch };
    return { text: question, responseKind: 'clarification' };
  }
  private async consultWeather(city: string | null, place: WeatherPlace | null, date: string | null, generation: number): Promise<AssistantResult | null> {
    try {
      // New explicit/ambiguous locations cannot accidentally retain the old city.
      if (city !== null) this.city = null;
      const result = await this.weather({ city, place, date });
      if (generation !== this.generation) return null;
      if (result.status === 'choose') {
        this.city = null;
        if (!result.choices.length) return { text: 'Não encontrei uma cidade inequívoca, senhor. Informe cidade, estado e país.' };
        this.choices = { places: result.choices, date, expiresAt: this.clock() + 15 * 60_000 };
        return { text: `Encontrei mais de uma localidade, senhor. Qual delas? Responda com o número ou informe cidade e estado.\n${result.choices.map((p, index) => `${index + 1}. ${placeLabel(p)}`).join('\n')}`, responseKind: 'clarification', weatherAttribution: true, feedback: 'Escolha a cidade na conversa.' };
      }
      const text = weatherText(result.report);
      this.city = { place: structuredClone(result.report.place), expiresAt: this.clock() + 15 * 60_000 };
      this.activeCapability = 'weather';
      this.clarification = null;
      return { text, weatherAttribution: true, feedback: 'Consulta de clima concluída. Detalhes e fontes na conversa.' };
    } catch {
      if (generation !== this.generation) return null;
      return { text: 'Não consegui obter dados meteorológicos válidos da Open-Meteo, senhor. Não tenho uma previsão confirmada. Tente novamente ou informe cidade, estado e uma data nos próximos 16 dias.' };
    }
  }
  async approve(id: string) {
    if (this.busy) return { text: 'Já estou cuidando do pedido anterior.' };
    this.busy = true;
    try { return await this.tasks.approve(id); } finally { this.busy = false; }
  }
  async cancelApproval(id: string) {
    if (this.busy) return { text: 'Já estou cuidando do pedido anterior.' };
    this.busy = true;
    try { return await this.tasks.cancelApproval(id); } finally { this.busy = false; }
  }
  async send(message: string): Promise<AssistantResult | null> {
    if (this.busy) return { text: 'Já estou cuidando do pedido anterior.' };
    if (!message.trim() || message.length > 1000) return { text: 'Informe um pedido com até 1.000 caracteres.' };
    this.busy = true;
    const generation = this.generation;
    try {
      if (isConversationCancellation(message)) {
        return await this.cancelIntent(message);
      }
      const pending = this.choices; this.choices = null;
      const previousClarification = this.clarification;
      const clarification = previousClarification && this.clock() < previousClarification.expiresAt ? previousClarification : null;
      this.clarification = null; // Consume before local returns or a fallible interpretation.
      if ((previousClarification && !clarification) || (pending && this.clock() >= pending.expiresAt)) this.activeCapability = null;
      if (pending && this.clock() < pending.expiresAt) {
        const text = normalized(message).trim();
        const numeric = /^\d+$/.test(text) ? Number(text) - 1 : null;
        const matches = pending.places.filter(p => [p.name, p.admin1, placeLabel(p)].some(value => normalized(value) === text));
        const place = numeric !== null ? pending.places[numeric] : matches.length === 1 ? matches[0] : null;
        if (place) return await this.consultWeather(null, place, pending.date, generation);
        if (numeric !== null) { this.choices = pending; return { text: 'Essa opção não está na lista, senhor. Escolha uma das localidades apresentadas.' }; }
      } else if (pending && /^\d+$/.test(message.trim())) return { text: 'A seleção de cidade expirou, senhor. Informe a cidade novamente.' };
      if (this.tasks.handlesLocalTurn(message)) return await this.tasks.send(message);
      const context = this.tasks.routingContext(message);
      const city = this.currentCity();
      const request: AssistantRequest = {
        taskContext: { message, context: context.context, previousDraft: context.previousDraft, previousTask: context.previousTask,
          pendingSuggestion: context.pendingSuggestion, queryAnchor: context.queryAnchor, restorableFields: context.restorableFields,
          ...localClock(new Date(this.clock())) },
        cityContext: city ? placeLabel(city).slice(0, 250) : null, activeCapability: this.activeCapability,
        clarification: clarification ? `${clarification.original}\n${clarification.question}`.slice(0, 1000) : null,
      };
      const preview = await this.interpreter(request);
      if (generation !== this.generation) return null;
      if (preview.dryRun !== true || preview.executed !== false) throw { code: 'invalid_response', message: '' };
      const i = preview.interpretation;
      if (!['execute_now', 'deferred', 'non_executive', 'cancel'].includes(i.executionIntent)) throw { code: 'invalid_response', message: '' };
      if (i.capability === 'conversation') {
        this.tasks.clear(); this.endPendingIntent();
        const answer = generalAnswer(i.answer);
        if (!answer || i.executionIntent !== 'non_executive' || i.task || i.query || i.city || i.date || i.question || i.usesCityContext || i.planTargets) throw { code: 'invalid_response', message: '' };
        return { text: answer, responseKind: 'general_answer' };
      }
      if (i.executionIntent === 'cancel') {
        return await this.cancelIntent('cancelar', !!(clarification || pending));
      }
      if (i.capability === 'task') {
        if (!i.task) throw { code: 'invalid_response', message: '' };
        if (i.executionIntent !== 'execute_now' && !['conversation', 'clarify', 'unsupported'].includes(i.task.intent)) {
          this.tasks.clear(); this.endPendingIntent();
          return { text: 'Não identifiquei um pedido operacional imediato. Nenhuma alteração foi preparada.', responseKind: 'unavailable' };
        }
        const taskPreview: IntelligencePreview = { interpretation: i.task, dryRun: true, executed: false,
          model: 'habitual', latencyMs: 0, requestCount: 1, promptTokens: null, outputTokens: null };
        this.activeCapability = 'task';
        const result: AssistantResult | null = await this.tasks.send(message, { preview: taskPreview, revision: context.revision });
        if (result) result.responseKind = result.approval ? 'proposal' : result.executed || result.taskIds ? 'tool_result'
          : i.task.intent === 'clarify' || i.task.clarification ? 'clarification' : 'unavailable';
        return result;
      }
      // Switching domain invalidates pending task controls, never approves them.
      this.tasks.clear();
      if (i.capability === 'clarify' && i.executionIntent !== 'deferred') {
        if (!i.question?.trim().endsWith('?') || !generalAnswer(i.question)) throw { code: 'invalid_response', message: '' };
        // General clarifications retain the actual question rather than forcing
        // every ambiguity into the weather/browser command vocabulary.
        const live = clarification && this.clock() < clarification.expiresAt ? clarification : null;
        return this.ask(live?.original ?? message, clarificationQuestion(i.question), i.executionIntent === 'execute_now' && (explicitSearchRequest(message) || !!live?.authorizesSearch), live?.expiresAt);
      }
      // Research has no executor: explain the capability limit even when the
      // model marks an intellectual request non-executive. Deferred requests
      // still follow the existing no-retained-permission protocol below.
      if (i.capability === 'research' && i.executionIntent !== 'deferred') {
        this.endPendingIntent();
        return { text: 'Pesquisar fontes e apresentar uma análise aqui na conversa ainda não está disponível, senhor. Posso abrir uma pesquisa no Google se desejar.', responseKind: 'unavailable' };
      }
      if (i.executionIntent !== 'execute_now') {
        this.endPendingIntent();
        // Deferred conditions are not stored as executable proposals. A later
        // generic confirmation or bare argument cannot inherit this request.
        if (i.executionIntent === 'deferred') return { text: 'O pedido depende de uma condição ou confirmação futura, senhor. Não executei a ação. Quando desejar executá-la, faça um novo pedido direto.' };
        return { text: 'Não identifiquei um pedido de execução imediata, senhor. Deseja realizar uma ação agora? Se desejar, faça o pedido diretamente.' };
      }
      const validClarification = clarification && this.clock() < clarification.expiresAt ? clarification : null;
      const searchPermission = explicitSearchRequest(message) || !!validClarification?.authorizesSearch;
      if (i.capability === 'plan') {
        this.endPendingIntent();
        const targets = i.planTargets;
        if (!targets?.length || targets.length > 20 || targets.some(t => typeof t !== 'string' || !t.trim() || t.length > 200)
          || i.answer || i.task || i.query || i.city || i.date || i.question || i.usesCityContext) throw { code: 'invalid_response', message: '' };
        const snapshot = await this.plans.read();
        if (generation !== this.generation) return null;
        const ids: number[] = [];
        for (const reference of targets) {
          const literal = normalized(reference.trim());
          const input = normalized(message);
          const offset = input.indexOf(literal);
          if (offset < 0 || /[\p{L}\p{N}#]/u.test(input[offset - 1] ?? '') || /[\p{L}\p{N}]/u.test(input[offset + literal.length] ?? '')) return { text: 'Informe explicitamente os títulos exatos ou IDs com # das tarefas que deseja incluir. Nenhum plano foi preparado.', responseKind: 'clarification' };
          const matches = snapshot.tasks.filter(t => !t.completed && (/^#\d+$/.test(reference.trim()) ? t.id === Number(reference.trim().slice(1)) : normalized(t.title) === normalized(reference.trim())));
          if (matches.length !== 1 || ids.includes(matches[0].id)) return { text: 'Não identifiquei todas as tarefas de forma única. Informe os títulos exatos ou os IDs com #. Nenhum plano foi preparado.', responseKind: 'clarification' };
          ids.push(matches[0].id);
        }
        const goal = await this.plans.prepare({ objective: message.slice(0, 500), steps: ids.map((targetId, n) => ({ id: `step-${n + 1}`, operation: 'complete_task', targetId, dependsOn: n ? [`step-${n}`] : [] })), maxOperations: ids.length, durationSeconds: 1800 }, snapshot.revision);
        if (generation !== this.generation) return null;
        if (goal.status !== 'draft' || !goal.plan || goal.plan.steps.length !== ids.length || goal.plan.steps.some((s, n) => s.targetId !== ids[n] || s.operation !== 'complete_task')) throw { code: 'invalid_response', message: '' };
        return { text: `Plano preparado para revisão no Executor: ${ids.map(id => `#${id}`).join(' → ')}. Nenhuma tarefa foi concluída. Confira os alvos e limites no painel Executor; autorizar e iniciar são etapas separadas.`, responseKind: 'proposal' };
      }
      if (i.capability === 'browser_search') {
        const clarifiedSearch = validClarification?.authorizesSearch && message.length <= 150
          && /^[\p{L}\p{M} .,\-]+$/u.test(message) && explicitSearchRequest(`${validClarification.original} ${message}`);
        if (!i.query?.trim() || i.query.length > 1000 || (!explicitSearchRequest(message) && !clarifiedSearch)) return { text: 'Posso abrir uma pesquisa no Google, senhor. Confirme o assunto que deseja procurar no navegador.' };
        let query = i.query;
        const cityReference = /\b(nessa|nesta|essa|esta|mesma) cidade\b/.test(normalized(message));
        if (i.usesCityContext || cityReference) {
          const current = this.currentCity();
          if (!current || !i.usesCityContext || query.split('{city}').length !== 2) return this.ask(validClarification?.original ?? message, 'Qual cidade deseja usar nessa pesquisa, senhor?', searchPermission, validClarification?.expiresAt);
          query = query.replace('{city}', placeLabel(current));
        } else if (query.includes('{city}')) return this.ask(validClarification?.original ?? message, 'Qual cidade deseja usar nessa pesquisa, senhor?', searchPermission, validClarification?.expiresAt);
        try {
          await this.opener(query);
          if (generation !== this.generation) return null;
          this.activeCapability = 'browser_search';
          return { text: `Solicitei ao Windows a abertura de uma pesquisa no Google por “${query}”, senhor. Não consultei nem analisei os resultados.`, executed: true };
        } catch { return { text: 'Não consegui confirmar a abertura da pesquisa, senhor. Não repeti a solicitação.' }; }
      }
      if (i.capability === 'weather') {
        const place = i.usesCityContext ? this.currentCity() : null;
        if ((!i.city && !place) || (i.usesCityContext && i.city)) return this.ask(message, 'Para qual cidade deseja consultar o clima, senhor?');
        return await this.consultWeather(i.usesCityContext ? null : i.city, place, i.date, generation);
      }
      throw { code: 'invalid_response', message: '' };
    } catch (error) {
      if (generation !== this.generation) return null;
      this.endPendingIntent();
      return { text: `${intelligenceFailure(error).message} Não repeti operações. Confira os painéis para resultados já confirmados.`, responseKind: 'unavailable' };
    } finally { this.busy = false; }
  }
}
