import { useEffect, useState, useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { executorClient as client, executorStatus, subscribeExecutor } from './executor';
import { originLabel } from './delegation';
import { taskClient } from './tasks';
import './delegation.css';
import './executor.css';

export function ExecutorPanel({ owner }: { owner: string }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const tasks = useSyncExternalStore(taskClient.subscribe, taskClient.getState);
  const [objective, setObjective] = useState('');
  const [ids, setIds] = useState<number[]>([]);
  const [budget, setBudget] = useState(20);
  const [minutes, setMinutes] = useState(30);
  const native = isTauri();
  useEffect(() => {
    if (!native) return;
    let disposed = false; let off = () => {};
    const refresh = () => { void client.refresh(); };
    void subscribeExecutor(refresh).then(fn => { if (disposed) fn(); else { off = fn; refresh(); } }).catch(refresh);
    window.addEventListener('focus', refresh);
    // Events are hints; polling recovers a lost event without resending work.
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 2000);
    return () => { disposed = true; off(); clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [native]);
  useEffect(() => {
    const pending = new Set(tasks.snapshot.tasks.filter(t => !t.completed).map(t => t.id));
    setIds(current => current.filter(id => pending.has(id)));
  }, [tasks.snapshot]);
  const goals = state.snapshot.goals;
  const active = goals.find(g => g.status === 'running' || g.status === 'ready');
  return <details className="delegation-panel executor-panel" onToggle={event => { if (event.currentTarget.open && native) { void client.refresh(); void taskClient.refresh(); } }}>
    <summary>Executor · {active ? executorStatus[active.status] : 'sequências locais'}</summary>
    <div className="delegation-content">
      <p>Escolha tarefas pendentes na ordem desejada. O JARVIS concluirá uma por vez, respeitando a autorização e as dependências.</p>
      {!native && <p role="status">O executor está disponível no aplicativo desktop.</p>}
      <p>Criar, editar, reabrir e excluir continuam exigindo suas aprovações individuais. A conversa e a IA não autorizam esta sequência.</p>
      <button disabled={!native || state.busy} onClick={() => { void client.refresh(); void taskClient.refresh(); }}>Atualizar andamento</button>
      {state.error && <p role="alert">{state.error}</p>}
      <form aria-label="Nova sequência" onSubmit={event => {
        event.preventDefault();
        void client.prepare({ objective, maxOperations: budget, durationSeconds: minutes * 60, steps: ids.map((id, index) => ({ id: `step-${index + 1}`, operation: 'complete_task', targetId: id, dependsOn: index ? [`step-${index}`] : [] })) });
      }}>
        <label>Objetivo da sequência<input required maxLength={500} value={objective} disabled={state.busy} onChange={event => setObjective(event.target.value)} /></label>
        <fieldset disabled={!native || !tasks.ready || state.busy}><legend>Selecione até 20 tarefas · ordem de seleção</legend>
          {tasks.snapshot.tasks.filter(t => !t.completed).map(t => <label key={t.id}><input type="checkbox" checked={ids.includes(t.id)} disabled={!ids.includes(t.id) && ids.length >= 20} onChange={event => setIds(current => event.target.checked ? [...current, t.id] : current.filter(id => id !== t.id))} />{t.title} (#{t.id}){ids.includes(t.id) && ` · etapa ${ids.indexOf(t.id) + 1}`}</label>)}
          {!tasks.snapshot.tasks.some(t => !t.completed) && <p>Crie ou selecione tarefas pendentes pelo painel Tarefas ou pela conversa.</p>}
        </fieldset>
        <div className="delegation-limits"><label>Orçamento total<input required type="number" min={1} max={20} value={budget} onChange={e => setBudget(e.target.valueAsNumber)} /></label><label>Validade em minutos<input required type="number" min={1} max={30} value={minutes} onChange={e => setMinutes(e.target.valueAsNumber)} /></label></div>
        <button type="submit" disabled={!native || !state.ready || state.busy || !objective.trim() || !ids.length}>Conferir sequência</button>
      </form>
      <section aria-label="Andamento do executor"><h3>Objetivos e etapas</h3>
        {!goals.length && <p>Nenhuma sequência registrada.</p>}
        {goals.map(g => { const external = g.steps.filter(s => s.status === 'pending' && ['completed', 'missing'].includes(s.currentTaskState)).map(s => s.id); return <article className="delegation-record executor-goal" key={g.id} data-goal-id={g.id}>
          <h4>{g.objective ?? 'Detalhes removidos pela retenção'}</h4>
          <p role="status">{executorStatus[g.status]} · {originLabel(g.owner)} · plano {g.planRevision}</p>
          <p>Consumo acumulado: {g.consumed}/{g.budget}. Saldo do objetivo: {g.budget - g.consumed}. Saldo desta concessão: {g.grant.status === 'active' && (!g.grant.expiresAt || Date.now() < g.grant.expiresAt * 1000) ? g.grant.maxOperations - g.grant.used : 0}.</p>
          {g.reason && <p>{g.reason}</p>}
          <progress max={g.plan?.steps.length || 1} value={g.steps.filter(s => s.status === 'succeeded').length} aria-label="Etapas confirmadas pelo executor" />
          {g.plan && g.plan.omittedSteps.length > 0 && <p>Retiradas explicitamente nesta revisão: {g.plan.omittedSteps.join(', ')}. Essas etapas não contam como sucesso do executor.</p>}
          {g.plan && <ol>{g.plan.steps.map(s => { const result = g.steps.find(r => r.id === s.id); return <li key={s.id}>
            Concluir #{s.targetId} · {g.plan?.targets.find(t => t.id === s.targetId)?.title} — {result?.status === 'succeeded' ? 'confirmada pelo executor' : result?.status === 'admitted' ? 'tentativa admitida' : result?.currentTaskState === 'completed' ? 'concluída por outro caminho · requer revisão' : result?.currentTaskState === 'missing' ? 'tarefa ausente · requer revisão' : 'pendente'}
            {result && <span> · estado atual da tarefa: {result.currentTaskState === 'completed' ? 'concluída' : result.currentTaskState === 'pending' ? 'pendente' : 'ausente'}</span>}
            {s.dependsOn.length > 0 && <span> · depende de {s.dependsOn.join(', ')}</span>}
            {result?.receipt && <p>Recibo <code>{result.receipt.requestId}</code> · revisão {result.receipt.beforeRevision} → {result.receipt.revision}</p>}
          </li>; })}</ol>}
          {g.status === 'draft' && <div className="delegation-review executor-review">
            <p>Somente concluir os IDs pendentes acima; até {g.grant.maxOperations} alterações por {g.grant.scope ? g.grant.scope.durationSeconds / 60 : 0} minutos a partir do consentimento, sem renovação implícita. Risco moderado. Dados: estado local das tarefas. Destino: SQLite local; nenhum envio autorizado a provedores. Origem: {originLabel(g.owner)}.</p>
            <p>Autorizar não inicia. Reiniciar interrompe e exige nova revisão e consentimento. Limpar a conversa não cancela o objetivo. Efeitos confirmados permanecem; não há rollback automático.</p>
            <p>Objetivo <code>{g.id}</code> · revisão de tarefas {g.expectedRevision}. Consumo anterior: {g.consumed}; saldo total: {g.budget - g.consumed}.</p>
            <button disabled={state.busy || g.owner !== owner} onClick={() => void client.consent(g.grant.id)}>Autorizar este plano</button>
          </div>}
          {g.status === 'ready' && <button disabled={state.busy || g.owner !== owner} onClick={() => void client.start(g.grant.id)}>Iniciar sequência autorizada</button>}
          {['draft', 'blocked', 'interrupted'].includes(g.status) && g.plan && g.consumed < g.budget && <button disabled={state.busy || g.owner !== owner} onClick={() => void client.review(g.id)}>Revisar restante para nova autorização</button>}
          {['blocked', 'interrupted', 'draft'].includes(g.status) && external.length > 0 && <button disabled={state.busy || g.owner !== owner} onClick={() => void client.review(g.id, external)}>Revisar retirando etapas externas: {external.join(', ')}</button>}
          {g.attempts.length > 0 && <details className="executor-attempts"><summary>Tentativas registradas · {g.attempts.length}</summary><ul>{g.attempts.map(a => <li key={a.requestId}>Plano {a.planRevision} · {a.stepId} · {a.status === 'succeeded' ? 'efeito confirmado' : a.status === 'not_committed' ? 'sem efeito confirmado · nova autorização necessária' : 'admitida · consulte o resultado'} · <code>{a.requestId}</code></li>)}</ul></details>}
          {['ready', 'running'].includes(g.status) && <button disabled={state.busy} onClick={() => void client.end(g.id, 'blocked')}>Interromper para revisar</button>}
          {g.owner !== owner && !['completed', 'cancelled', 'revoked'].includes(g.status) && <p>Revisão, consentimento e início somente na {originLabel(g.owner)} de origem. Você pode cancelar ou revogar aqui.</p>}
          {!['completed', 'cancelled', 'revoked'].includes(g.status) && <div className="delegation-actions"><button disabled={state.busy} onClick={() => void client.end(g.id, 'cancelled')}>Cancelar sequência</button><button disabled={state.busy} onClick={() => void client.end(g.id, 'revoked')}>Revogar autoridade do plano</button></div>}
        </article>; })}
      </section>
      <p>Detalhes operacionais: 30 dias após encerramento. Recibos mínimos são preservados para deduplicação. Atualizar ou recarregar consulta o estado; não repete etapas.</p>
    </div>
  </details>;
}
