import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Task, TaskInput, TaskSnapshot } from './tasks';
export type WriteKind = 'create_task' | 'update_task' | 'complete_task' | 'delete_task';
export interface WriteEffect { kind: WriteKind; id: number | null; input: TaskInput | null; expectedRevision: number }
export interface ReviewProposal { proposalId: string; effect: WriteEffect; before: Task | null; expiresInSeconds: number }
export interface AuthorizationTransport {
  prepare(effect: WriteEffect): Promise<ReviewProposal>;
  approve(proposalId: string): Promise<TaskSnapshot>;
  cancel(proposalId: string): Promise<void>;
}
const desktop = <T>(command: string, args: Record<string, unknown>) => isTauri() ? invoke<T>(command, args) : Promise.reject(new Error('A prévia web não grava tarefas.'));
export const conversationAuthorization: AuthorizationTransport = {
  prepare: effect => desktop('prepare_operation', { effect }),
  approve: proposalId => desktop('approve_operation', { proposalId }),
  cancel: proposalId => desktop('cancel_operation', { proposalId }),
};
const labels: Record<keyof TaskInput, string> = { title: 'Título', description: 'Descrição', priority: 'Prioridade', project: 'Projeto', dueDate: 'Data', dueTime: 'Horário' };
const value = (key: keyof TaskInput, v: string | null) => v === null || v === '' ? 'sem definição' : key === 'priority' ? ({ low: 'baixa', normal: 'normal', high: 'alta' }[v] ?? v) : JSON.stringify(v);
export function reviewSummary(p: ReviewProposal): string {
  const e = p.effect;
  const target = p.before ? `${JSON.stringify(p.before.title)} (#${e.id})` : '';
  if (e.kind === 'delete_task') return `Excluir ${target}? Confirme a exclusão ou cancele, senhor.`;
  if (e.kind === 'complete_task') return `Concluir ${target}?`;
  const fields = Object.keys(labels) as (keyof TaskInput)[];
  if (e.kind === 'create_task') return `Criar tarefa:\n${fields.map(k => `${labels[k]}: ${value(k, e.input![k])}`).join('\n')}\nEstado inicial: pendente. Deseja aplicar, senhor?`;
  return `Alterar ${target}:\n${fields.filter(k => p.before![k] !== e.input![k]).map(k => `${labels[k]}: ${value(k, p.before![k])} → ${value(k, e.input![k])}`).join('\n')}\nDeseja aplicar, senhor?`;
}
