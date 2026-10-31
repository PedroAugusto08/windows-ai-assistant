import { invoke, isTauri } from '@tauri-apps/api/core';

export type IntelligenceIntent = 'create_task' | 'query_tasks' | 'update_task' | 'complete_task' | 'delete_task' | 'open_panel' | 'conversation' | 'clarify' | 'unsupported' | 'accept_suggestion' | 'decline_suggestion';
export type RestorableField = 'title' | 'project' | 'priority' | 'dueDate' | 'dueTime';
export interface IntelligenceParameters {
  titleSuffix?: string | null; restoreFields?: RestorableField[] | null;
  queryPeriod?: 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'week_of_date' | null;
  status?: 'pending' | 'completed' | 'all' | 'overdue' | null;
  title: string | null; priority: 'low' | 'normal' | 'high' | null; project: string | null;
  dueDate: string | null; dueTime: string | null; target: string | null; panel: 'tasks' | 'agenda' | 'chat' | 'system' | null;
}
export interface Interpretation {
  intent: IntelligenceIntent; parameters: IntelligenceParameters; reply: string;
  clarification: string | null; requiresConfirmation: boolean; usesPreviousDraft: boolean;
}
export interface IntelligencePreview {
  interpretation: Interpretation; dryRun: true; executed: false; model: string;
  latencyMs: number; requestCount: number; promptTokens: number | null; outputTokens: number | null;
}
export interface IntelligenceRequest {
  message: string; context: string[]; previousDraft: IntelligenceParameters | null; localNow: string; timeZone: string; previousTask?: boolean; pendingSuggestion?: 'priority' | 'panel' | null; queryAnchor?: string | null; restorableFields?: RestorableField[];
}
export interface IntelligenceFailure { code: string; message: string; retryAfterSeconds: number | null }
export function intelligenceFailure(error: unknown): IntelligenceFailure {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const e = error as IntelligenceFailure;
    const messages: Record<string, string> = {
      not_configured: 'Configure GEMINI_API_KEY no ambiente local do JARVIS.',
      busy: 'Já há uma interpretação em andamento.', session_limit: 'Limite local de 20 chamadas por sessão atingido.',
      rate_limit: 'Limite de requisições atingido. Aguarde antes de tentar novamente.',
      timeout: 'Gemini excedeu o tempo de resposta. Tente novamente mais tarde.',
      network: 'Não foi possível conectar ao Gemini.', authentication: 'A chave local não tem acesso ao modelo.',
      model_unavailable: 'gemini-3.5-flash-lite indisponível para este projeto.',
      unavailable: 'Gemini temporariamente indisponível.', invalid_input: 'Mensagem ou contexto fora dos limites.',
      invalid_response: 'Gemini retornou uma interpretação inválida.', blocked_response: 'Resposta bloqueada ou incompleta.',
      api_error: 'A API recusou a solicitação.', preview_only: 'A inteligência está disponível no aplicativo Tauri. A prévia web não envia mensagens ao Gemini.',
    };
    return { code: e.code, message: messages[e.code] ?? 'Não foi possível interpretar o comando.', retryAfterSeconds: typeof e.retryAfterSeconds === 'number' && Number.isFinite(e.retryAfterSeconds) ? Math.max(0, Math.min(3600, e.retryAfterSeconds)) : null };
  }
  // Never display arbitrary IPC/provider exception strings.
  return { code: 'unknown', message: 'Não foi possível interpretar o comando.', retryAfterSeconds: null };
}
export function localClock(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const offset = -now.getTimezoneOffset();
  const pad = (value: number) => String(value).padStart(2, '0');
  return { timeZone, localNow: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}` };
}
export type IntelligenceTransport = (request: IntelligenceRequest) => Promise<IntelligencePreview>;
const desktopTransport: IntelligenceTransport = request => {
  if (!isTauri()) return Promise.reject({ code: 'preview_only', message: '' });
  return invoke<IntelligencePreview>('interpret_command', { request });
};
export interface IntelligenceSessionContext {
  version: 1;
  context: string[];
  draft: IntelligenceParameters | null;
  updatedAt: number;
}
// Volatile context can be hydrated from the canonical session, never from demo chat.
export class IntelligenceSession {
  private context: string[] = [];
  private draft: IntelligenceParameters | null = null;
  private updatedAt = 0;
  private generation = 0;
  private pending = false;
  constructor(private transport: IntelligenceTransport = desktopTransport, private clock = () => Date.now()) {}
  exportContext(): IntelligenceSessionContext {
    return structuredClone({ version: 1, context: this.context, draft: this.draft, updatedAt: this.updatedAt });
  }
  importContext(context: IntelligenceSessionContext) {
    if (this.pending) throw new Error('Não é possível substituir uma interpretação em andamento.');
    const copy = structuredClone(context);
    if (copy.version !== 1 || !Array.isArray(copy.context) || copy.context.length > 6
      || copy.context.some(value => typeof value !== 'string' || value.length > 1000)
      || !Number.isFinite(copy.updatedAt) || copy.updatedAt < 0) throw new Error('Contexto de inteligência inválido.');
    this.context = copy.context; this.draft = copy.draft; this.updatedAt = copy.updatedAt;
  }
  clear() { this.context = []; this.draft = null; this.updatedAt = 0; this.generation++; }
  async interpret(message: string, actionContext?: { previousTask: boolean; clarification?: string; conversation?: string[]; pendingSuggestion?: 'priority' | 'panel' | null; queryAnchor?: string | null; taskContext?: string[]; restorableFields?: RestorableField[] }): Promise<IntelligencePreview | null> {
    if (this.pending) throw { code: 'busy', message: '' };
    if (!message.trim() || message.length > 1000) throw { code: 'invalid_input', message: '' };
    if (this.updatedAt && this.clock() - this.updatedAt > 15 * 60_000) this.clear();
    const generation = this.generation;
    this.pending = true;
    try {
      const preview = await this.transport({ message, context: actionContext ? [...new Set([...(actionContext.taskContext ?? []), ...(actionContext.clarification ? [actionContext.clarification] : actionContext.taskContext?.length ? [] : actionContext.conversation ?? [])])].slice(0, 3) : [...this.context], previousDraft: actionContext ? null : this.draft ? { ...this.draft } : null, ...(actionContext ? { previousTask: actionContext.previousTask, pendingSuggestion: actionContext.pendingSuggestion ?? null, queryAnchor: actionContext.queryAnchor ?? null, restorableFields: actionContext.restorableFields ?? [] } : {}), ...localClock(new Date(this.clock())) });
      if (generation !== this.generation) return null;
      if (preview.dryRun !== true || preview.executed !== false) throw { code: 'invalid_response', message: '' };
      // Only successful user turns and a compact draft are retained, not assistant prose.
      this.context = [...this.context, message].slice(-6);
      this.draft = preview.interpretation.intent === 'create_task' && !preview.interpretation.clarification ? { ...preview.interpretation.parameters } : null;
      this.updatedAt = this.clock();
      return preview;
    } finally { this.pending = false; }
  }
}
export function previewText(preview: IntelligencePreview) {
  const i = preview.interpretation;
  return `Interpretação: ${i.intent}. Nenhuma ação executada.\n${i.reply}${i.clarification ? `\nEsclarecimento: ${i.clarification}` : ''}${i.requiresConfirmation ? '\nConfirmação necessária antes de uma eventual execução. A execução permanece desativada.' : ''}`;
}
