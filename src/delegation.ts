import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TaskSnapshot } from './tasks';

export interface DelegationRequest { objective: string; targetIds: number[]; maxOperations: number; durationSeconds: number }
export interface DelegationScope {
  objective: string; requester: string; tool: string; operation: string;
  targets: { id: number; title: string }[]; data: string; destination: string;
  risk: string; expectedRevision: number; durationSeconds: number;
}
export interface DelegationGrant {
  executorGoalId?: string;
  id: string; version: number; owner: string; status: string; scope: DelegationScope | null;
  maxOperations: number; used: number; createdAt: number; grantedAt: number | null;
  expiresAt: number | null; endedAt: number | null;
}
export interface DelegationExecution { grantId: string; requestId: string; targetId: number; expectedRevision: number }
export interface DelegationReceipt {
  requestId: string; grantId: string; owner: string; targetId: number;
  beforeRevision: number; revision: number; used: number; committedAt: number;
}
interface History { grants: DelegationGrant[]; receipts: DelegationReceipt[] }
export interface DelegationTransport { call<T>(command: string, args?: Record<string, unknown>): Promise<T> }
export interface PendingStorage { load(): string | null; save(value: string | null): void }
interface ClientState extends History {
  busy: boolean; ready: boolean; recoveryBlocked: boolean; error: string; feedback: string;
  draft: DelegationGrant | null; pending: DelegationExecution | null;
}
export const delegationStatus: Record<string, string> = {
  draft: 'Aguardando consentimento', active: 'Ativa', completed: 'Concluída', revoked: 'Revogada',
  cancelled: 'Cancelada', expired: 'Expirada', interrupted: 'Interrompida no reinício',
};
export const originLabel = (owner: string) => owner === 'dashboard' ? 'Central' : 'flutuante';
/** This client never grants authority on hydration, focus, history refresh or replay. */
export class DelegationClient {
  private state: ClientState = { grants: [], receipts: [], busy: false, ready: false, recoveryBlocked: false, error: '', feedback: '', draft: null, pending: null };
  private listeners = new Set<() => void>();
  private refreshSequence = 0;
  constructor(private transport: DelegationTransport, private requestId: () => string = () => crypto.randomUUID(), private storage?: PendingStorage) {
    try {
      const raw = storage?.load();
      if (raw !== null && raw !== undefined) {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('request' in value)) throw new Error('Unknown recovery format');
        const request = value.request as Partial<DelegationExecution> | null;
        const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,128}$/i.test(id);
        if (!request || !validId(request.grantId) || !validId(request.requestId) || !Number.isSafeInteger(request.targetId) || request.targetId! <= 0 || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision! < 0) throw new Error('Invalid recovery request');
        this.state.pending = { grantId: request.grantId, requestId: request.requestId, targetId: request.targetId!, expectedRevision: request.expectedRevision! };
      }
    } catch {
      this.state.recoveryBlocked = true;
      this.state.error = 'Não consegui recuperar o identificador local. Consulte os recibos e descarte explicitamente a recuperação inválida antes de solicitar outro efeito.';
    }
  }
  private pending(request: DelegationExecution | null) {
    // IDs are recovery metadata, never credentials or permission to execute.
    this.storage?.save(request ? JSON.stringify({ version: 1, request }) : null);
    this.update({ pending: request });
  }
  getState = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<ClientState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  async refresh() {
    const sequence = ++this.refreshSequence;
    try {
      const history = await this.transport.call<History>('delegation_history');
      if (sequence === this.refreshSequence) this.update({ ...history, ready: true });
    } catch { if (sequence === this.refreshSequence) this.update({ ready: false, error: 'Não consegui consultar as delegações. Atualize antes de continuar.' }); }
  }
  private async act(action: () => Promise<void>) {
    if (this.state.busy) return;
    this.update({ busy: true, error: '', feedback: '' });
    try { await action(); } catch { this.update({ error: 'Resultado não confirmado. Consulte o histórico; nenhuma tentativa automática será feita.' }); }
    finally { await this.refresh(); this.update({ busy: false }); }
  }
  prepare(request: DelegationRequest) {
    return this.act(async () => {
      this.update({ draft: null });
      const draft = await this.transport.call<DelegationGrant>('delegation_prepare', { request: structuredClone(request) });
      this.update({ draft: structuredClone(draft) });
    });
  }
  consent() {
    const draft = this.state.draft;
    if (!draft || draft.status !== 'draft') return Promise.resolve();
    return this.act(async () => {
      // Only the immutable backend draft ID crosses the consent boundary.
      this.update({ draft: null });
      const granted = await this.transport.call<DelegationGrant>('delegation_consent', { grantId: draft.id });
      this.update({ feedback: granted.status === 'active' ? 'Delegação concedida. Nenhuma tarefa foi alterada.' : `Delegação ${delegationStatus[granted.status]?.toLowerCase() ?? 'encerrada'}.` });
    });
  }
  end(grantId: string, reason: 'revoked' | 'cancelled' | 'completed') {
    return this.act(async () => {
      if (this.state.draft?.id === grantId) this.update({ draft: null });
      const grant = await this.transport.call<DelegationGrant>('delegation_end', { grantId, reason });
      this.update({ feedback: `Delegação ${delegationStatus[grant.status]?.toLowerCase() ?? 'encerrada'}. Efeitos já confirmados permanecem no histórico.` });
    });
  }
  execute(grantId: string, targetId: number) {
    if (this.state.recoveryBlocked) { this.update({ error: 'Resolva a recuperação inválida antes de solicitar outro efeito.' }); return Promise.resolve(); }
    if (this.state.pending) return Promise.resolve();
    return this.act(async () => {
      const snapshot = await this.transport.call<TaskSnapshot>('list_tasks');
      const request = { grantId, targetId, requestId: this.requestId(), expectedRevision: snapshot.revision };
      this.pending(request);
      await this.submit(request);
    });
  }
  resend() {
    const request = this.state.pending;
    if (!request) return Promise.resolve();
    return this.act(() => this.submit(request));
  }
  private async submit(request: DelegationExecution) {
    const receipt = await this.transport.call<DelegationReceipt>('delegation_execute', { request: structuredClone(request) });
    if (receipt.requestId !== request.requestId || receipt.grantId !== request.grantId || receipt.targetId !== request.targetId || receipt.beforeRevision !== request.expectedRevision || receipt.revision !== request.expectedRevision + 1) throw new Error('Receipt mismatch');
    this.pending(null);
    this.update({ feedback: `Conclusão confirmada da tarefa #${receipt.targetId}. Revisão ${receipt.revision}; ${receipt.used} alteração(ões) contabilizada(s).` });
  }
  dismissUncertainty() { if (!this.state.busy) { try { this.pending(null); this.update({ recoveryBlocked: false, error: '', feedback: 'Reenvio descartado. Consulte o histórico antes de solicitar outro efeito.' }); } catch { this.update({ error: 'Não consegui remover o identificador local de recuperação.' }); } } }
}
export const delegationClient = new DelegationClient({
  call: (command, args) => isTauri() ? invoke(command, args) : Promise.reject(new Error('Disponível no desktop.')),
}, undefined, {
  load: () => isTauri() ? localStorage.getItem(pendingKey()) : null,
  save: value => { if (isTauri()) { if (value === null) localStorage.removeItem(pendingKey()); else localStorage.setItem(pendingKey(), value); } },
});
function pendingKey() {
  const owner = new URLSearchParams(location.search).get('window') === 'assistant' ? 'assistant' : 'dashboard';
  return `jarvis-m2-1-pending-${owner}-v1`;
}
export const subscribeDelegations = (fn: () => void) => isTauri() ? listen('delegation-changed', fn) : Promise.resolve(() => {});
