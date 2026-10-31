import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DelegationGrant, DelegationReceipt, DelegationTransport } from './delegation';
export interface PlanStep { id: string; operation: 'complete_task'; targetId: number; dependsOn: string[] }
export interface ExecutorGoal {
  id: string; objective: string | null; owner: string; status: string;
  planRevision: number; expectedRevision: number; consumed: number; budget: number; reason: string | null;
  plan: { steps: PlanStep[]; targets: { id: number; title: string }[]; omittedSteps: string[] } | null;
  grant: DelegationGrant;
  steps: { id: string; status: string; receipt: DelegationReceipt | null; currentTaskState: string }[];
  attempts: { requestId: string; planRevision: number; stepId: string; status: string; createdAt: number }[];
}
export interface ExecutorSnapshot { revision: number; goals: ExecutorGoal[] }
export interface ExecutorProposal { objective: string; steps: PlanStep[]; maxOperations: number; durationSeconds: number }
export const executorStatus: Record<string, string> = {
  draft: 'Revise e autorize', ready: 'Autorizado · aguardando início', running: 'Em execução',
  blocked: 'Bloqueado · requer revisão', interrupted: 'Interrompido no reinício',
  completed: 'Etapas autorizadas confirmadas', cancelled: 'Cancelado', revoked: 'Revogado',
};
interface ClientState { snapshot: ExecutorSnapshot; ready: boolean; busy: boolean; error: string }
/** Hydration, events and focus only read canonical Rust state. No automatic resubmission. */
export class ExecutorClient {
  private state: ClientState = { snapshot: { revision: -1, goals: [] }, ready: false, busy: false, error: '' };
  private listeners = new Set<() => void>();
  private sequence = 0;
  constructor(private transport: DelegationTransport) {}
  getState = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<ClientState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  async refresh() {
    const sequence = ++this.sequence;
    try {
      const snapshot = await this.transport.call<ExecutorSnapshot>('executor_history');
      if (sequence === this.sequence && snapshot.revision >= this.state.snapshot.revision) this.update({ snapshot, ready: true });
    } catch { if (sequence === this.sequence) this.update({ ready: false, error: 'Não consegui consultar o executor. Atualize para conferir o estado canônico.' }); }
  }
  private async act(command: string, args: Record<string, unknown>) {
    if (this.state.busy) return;
    this.update({ busy: true, error: '' });
    try { await this.transport.call(command, args); }
    catch (reason) {
      const detail = typeof reason === 'string' && reason.length <= 300 ? ` ${reason}` : '';
      this.update({ error: `Não confirmei a solicitação.${detail} Consulte o andamento. Não haverá reenvio automático.` });
    } finally { await this.refresh(); this.update({ busy: false }); }
  }
  prepare(request: ExecutorProposal) { return this.act('executor_prepare', { request: structuredClone(request) }); }
  review(goalId: string, omitStepIds: string[] = []) { return this.act('executor_review', { goalId, omitStepIds: [...omitStepIds] }); }
  consent(planId: string) { return this.act('executor_consent', { planId }); }
  start(planId: string) { return this.act('executor_start', { planId }); }
  end(goalId: string, reason: 'cancelled' | 'revoked' | 'blocked') { return this.act('executor_end', { goalId, reason }); }
}
export const executorClient = new ExecutorClient({ call: (command, args) => isTauri() ? invoke(command, args) : Promise.reject(new Error('Disponível no desktop.')) });
export const subscribeExecutor = (fn: () => void) => isTauri() ? listen('executor-changed', fn) : Promise.resolve(() => {});
