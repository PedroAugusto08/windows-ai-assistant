import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AssistantConversation, type AssistantResult, type AssistantConversationContext, type ResponseKind } from './assistant-conversation';
import { AuthorizedTaskConversation, requiresOriginAuthority } from './authorized-task-conversation';
import type { AuthorizationTransport } from './conversation-authorization';
import { IntelligenceSession } from './intelligence';
import { TaskClient, taskClient, type TaskSnapshot } from './tasks';
import { demoReply, type ContextPanel } from './command';
import { createConversationPreview } from './conversation-preview';

export type ConversationStatus = 'idle' | 'processing' | 'executing' | 'awaiting_approval';
export interface SessionMessage {
  id: string; role: 'user' | 'assistant'; text: string;
  approval?: { id: string; destructive: boolean }; weatherAttribution?: boolean;
  responseKind?: ResponseKind | null;
}
export interface ConversationSnapshot {
  revision: number; generation: number; messages: SessionMessage[];
  status: ConversationStatus; activeOwner: string | null; approvalOwner: string | null;
  contextOwner: string | null; authorityOwner: string | null;
  intelligenceEnabled: boolean; context: AssistantConversationContext | null;
}
export interface SessionAction {
  kind: 'send' | 'approve' | 'cancel' | 'demo'; text?: string; proposalId?: string; intelligenceEnabled?: boolean;
}
export interface BeginTurn { token: string; snapshot: ConversationSnapshot; context: AssistantConversationContext | null; replayed: boolean }
export interface SessionTransport {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  subscribe(callback: (snapshot: ConversationSnapshot) => void): Promise<() => void>;
}
interface SessionState { snapshot: ConversationSnapshot; ready: boolean; submitting: boolean; error: string }
export const conversationStatus = {
  idle: 'Disponível', processing: 'Processando pedido', executing: 'Executando operação', awaiting_approval: 'Aguardando aprovação',
} satisfies Record<ConversationStatus, string>;
const greeting = 'Olá, senhor. Posso consultar o clima, abrir pesquisas no Google e organizar suas tarefas. Alterações nas tarefas continuam sujeitas à sua aprovação.';
const emptySnapshot = (): ConversationSnapshot => ({ revision: -1, generation: 0, messages: [{ id: '0', role: 'assistant', text: greeting }], status: 'idle', activeOwner: null, approvalOwner: null, contextOwner: null, authorityOwner: null, intelligenceEnabled: true, context: null });
export type SessionOutcome = { panel?: ContextPanel; taskIds?: number[] };
type Engine = Pick<AssistantConversation, 'importContext' | 'exportContext' | 'send' | 'approve' | 'cancelApproval'>;
export type EngineFactory = (effect: <T>(operation: string, args: Record<string, unknown>) => Promise<T>) => Engine;
const makeEngine: EngineFactory = effect => {
  const tasks = new TaskClient({ call: (operation, args) => effect<TaskSnapshot>(operation, args ?? {}), subscribe: async () => () => {} }, taskClient.getState().ready ? taskClient.getState().snapshot : undefined);
  const authorization: AuthorizationTransport = {
    prepare: value => effect('prepare_operation', { effect: value }),
    approve: (proposalId: string) => effect<TaskSnapshot>('approve_operation', { proposalId }),
    cancel: (proposalId: string) => effect<void>('cancel_operation', { proposalId }),
  };
  return new AssistantConversation(new AuthorizedTaskConversation(tasks, new IntelligenceSession(request => effect('interpret_command', { request })), undefined, authorization), request => effect('interpret_assistant', { request }), query => effect('open_browser_search', { query }), undefined, request => effect('get_weather', { request }), {
    read: () => effect('list_tasks', {}), prepare: (request, expectedRevision) => effect('executor_prepare', { request, expectedRevision }),
  });
};

/** Each WebView is a subscriber; Rust alone grants turns and stores committed context. */
export class ConversationSession {
  private state: SessionState = { snapshot: emptySnapshot(), ready: false, submitting: false, error: '' };
  private listeners = new Set<() => void>();
  private connecting: Promise<void> | undefined;
  private off: (() => void) | undefined;
  private attached = false;
  private attaching: Promise<void> | undefined;
  private readonly clientId = crypto.randomUUID();
  constructor(private transport: SessionTransport, readonly owner: string, private engineFactory = makeEngine, private requestId = () => crypto.randomUUID()) {}
  getState = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private update(patch: Partial<SessionState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(callback => callback()); }
  private accept(snapshot: ConversationSnapshot) {
    if (snapshot.revision > this.state.snapshot.revision) this.update({ snapshot, ready: this.attached });
    else if (this.state.ready !== this.attached) this.update({ ready: this.attached });
  }
  async refresh() {
    try {
      if (!this.off) {
        this.connecting ??= this.transport.subscribe(snapshot => this.accept(snapshot)).then(off => { this.off = off; });
        await this.connecting;
      }
      if (!this.attached) {
        this.attaching ??= this.transport.call<ConversationSnapshot>('conversation_attach', { clientId: this.clientId }).then(snapshot => { this.attached = true; this.accept(snapshot); }).finally(() => { this.attaching = undefined; });
        await this.attaching;
      }
      this.accept(await this.transport.call<ConversationSnapshot>('conversation_snapshot'));
    } catch { this.update({ error: 'Não consegui sincronizar a conversa. Confira a conexão com o aplicativo antes de enviar.' }); }
    finally { this.connecting = undefined; }
  }
  async clear() {
    try {
      this.accept(await this.transport.call<ConversationSnapshot>('conversation_clear', { expectedRevision: this.state.snapshot.revision }));
      this.update({ error: '' });
    } catch { this.update({ error: 'Não consegui limpar a conversa. Uma operação pode estar em execução ou a sessão mudou; confira o estado e tente novamente.' }); await this.refresh(); }
  }
  private async run(action: SessionAction): Promise<SessionOutcome | undefined> {
    if (!this.state.ready || this.state.submitting || ['processing', 'executing'].includes(this.state.snapshot.status)) return;
    const snapshot = this.state.snapshot;
    if (action.kind === 'send' && snapshot.authorityOwner && snapshot.authorityOwner !== this.owner && snapshot.context?.tasks && requiresOriginAuthority(action.text ?? '', snapshot.context.tasks)) {
      this.update({ error: `Confirme ou cancele a proposta na ${snapshot.authorityOwner === 'dashboard' ? 'Central' : 'janela flutuante'} de origem. O contexto continua compartilhado.` });
      return;
    }
    this.update({ submitting: true, error: '' });
    let turn: BeginTurn | undefined;
    const beginArgs = { requestId: this.requestId(), expectedRevision: snapshot.revision, action };
    let effects = Promise.resolve();
    try {
      turn = await this.transport.call<BeginTurn>('conversation_begin', beginArgs);
      this.accept(turn.snapshot);
      if (turn.replayed) return; // Recovering a receipt never reruns the engine or tools.
      const token = turn.token;
      const effect = <T>(operation: string, args: Record<string, unknown>): Promise<T> => {
        const call = effects.then(() => this.transport.call<T>('conversation_effect', { token, operation, args }));
        effects = call.then(() => {}, () => {});
        return call;
      };
      let result: AssistantResult;
      let context: AssistantConversationContext | null = null;
      let outcome: SessionOutcome;
      if (action.kind === 'demo') {
        const reply = demoReply(action.text ?? '');
        result = { text: reply.text, panel: reply.panel === 'agenda' ? 'chat' : reply.panel };
        outcome = { panel: reply.panel };
      } else {
        const engine = this.engineFactory(effect);
        if (turn.context) engine.importContext(turn.context);
        result = (action.kind === 'approve' ? await engine.approve(action.proposalId!) : action.kind === 'cancel' ? await engine.cancelApproval(action.proposalId!) : await engine.send(action.text!)) ?? { text: 'O pedido foi interrompido. Nenhum resultado novo foi confirmado.' };
        result.responseKind ??= result.approval ? 'proposal' : result.executed || result.weatherAttribution || result.taskIds ? 'tool_result' : 'unavailable';
        context = engine.exportContext();
        outcome = { panel: result.panel, taskIds: result.taskIds };
      }
      await effects; // Includes legacy background proposal invalidations.
      this.accept(await this.transport.call<ConversationSnapshot>('conversation_finish', { token, context, result }));
      return outcome;
    } catch {
      await effects;
      // Recover an accepted begin whose reply was lost. Reuse its receipt;
      // never rerun the engine or tools on this error path.
      if (!turn) {
        try { turn = await this.transport.call<BeginTurn>('conversation_begin', beginArgs); } catch { /* Leave uncertainty visible if IPC remains unavailable. */ }
      }
      if (turn) {
        try { this.accept(await this.transport.call<ConversationSnapshot>('conversation_finish', { token: turn.token, context: null, result: { text: 'Não consegui confirmar o resultado do pedido. Confira as tarefas antes de repetir. Não repeti a operação.' } })); } catch { /* A revoked turn cannot publish into a new generation. */ }
      }
      this.update({ error: 'A sessão mudou ou o pedido não pôde ser confirmado. Confira a conversa e as tarefas antes de enviar novamente.' });
      await this.refresh();
    } finally { this.update({ submitting: false }); }
  }
  send(text: string) { return this.run({ kind: this.state.snapshot.intelligenceEnabled ? 'send' : 'demo', text: text.trim() }); }
  decide(proposalId: string, apply: boolean) { return this.run({ kind: apply ? 'approve' : 'cancel', proposalId }); }
  async setIntelligenceEnabled(enabled: boolean) {
    // The mode change is a canonical, revision-checked turn and discards operational context.
    await this.run({ kind: 'demo', text: enabled ? 'Inteligência habilitada.' : 'Demonstração local ativada.', intelligenceEnabled: enabled });
  }
}
const native = isTauri();
const owner = new URLSearchParams(location.search).get('window') === 'assistant' ? 'assistant' : 'dashboard';
export const conversationSession = new ConversationSession(native ? {
  call: (command, args) => invoke(command, args),
  subscribe: async callback => listen<ConversationSnapshot>('conversation-changed', event => callback(event.payload)),
} : createConversationPreview(owner), owner);
