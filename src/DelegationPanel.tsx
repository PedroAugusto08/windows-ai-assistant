import { useEffect, useState, useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { delegationClient as client, delegationStatus, originLabel, subscribeDelegations } from './delegation';
import { taskClient } from './tasks';
import './delegation.css';

export function DelegationPanel({ owner }: { owner: string }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const tasks = useSyncExternalStore(taskClient.subscribe, taskClient.getState);
  const [objective, setObjective] = useState('');
  const [targets, setTargets] = useState<number[]>([]);
  const [limit, setLimit] = useState(20);
  const [minutes, setMinutes] = useState(30);
  const [open, setOpen] = useState(false);
  const native = isTauri();
  useEffect(() => {
    if (!native) return;
    void client.refresh();
    const refresh = () => { void client.refresh(); };
    let disposed = false; let off = () => {};
    void subscribeDelegations(refresh).then(unlisten => { if (disposed) unlisten(); else off = unlisten; });
    window.addEventListener('focus', refresh);
    return () => { disposed = true; off(); window.removeEventListener('focus', refresh); };
  }, [native]);
  useEffect(() => { if (open && native) { void client.refresh(); void taskClient.refresh(); } }, [open, native]);
  const grants = state.grants.filter(g => !g.executorGoalId);
  const active = grants.filter(g => g.status === 'active');
  const date = (seconds: number) => new Date(seconds * 1000).toLocaleString('pt-BR');
  const draft = state.draft;
  return <details className="delegation-panel" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Delegações · {active.length} ativa(s)</summary>
    <div className="delegation-content">
      <p>Delegue a conclusão de tarefas específicas. Cada execução altera uma tarefa; criar, editar e excluir seguem as aprovações habituais.</p>
      {!native && <p role="status">Consentimento e execução disponíveis no aplicativo desktop.</p>}
      <button type="button" disabled={!native || state.busy} onClick={() => { void client.refresh(); void taskClient.refresh(); }}>Atualizar delegações e tarefas</button>
      {state.error && <p role="alert">{state.error}</p>}
      {state.feedback && <p role="status">{state.feedback}</p>}
      {state.recoveryBlocked && <div role="alert"><p>A recuperação local não pôde ser reconhecida. Novas execuções estão bloqueadas. Consulte os recibos antes de descartar o registro.</p><button disabled={state.busy} onClick={() => client.dismissUncertainty()}>Descartar recuperação inválida</button></div>}
      {state.pending && <div className="delegation-uncertain"><p>Resultado pendente para #{state.pending.targetId}. Reenviar usa os mesmos parâmetros e a mesma chave; um efeito confirmado não será duplicado.</p><button disabled={state.busy} onClick={() => void client.resend()}>Reenviar mesma operação</button><button disabled={state.busy} onClick={() => client.dismissUncertainty()}>Descartar reenvio</button></div>}
      {draft?.scope ? <section aria-label="Revisão da delegação" className="delegation-review">
        <h3>Revise antes de conceder</h3>
        <p>Objetivo: {draft.scope.objective}</p>
        <p>Somente concluir tarefas locais, com risco moderado. Origem: {originLabel(draft.owner)}. Até {draft.maxOperations} alterações durante {draft.scope.durationSeconds / 60} minutos, sem renovação.</p>
        <ul>{draft.scope.targets.map(t => <li key={t.id}>{t.title} (#{t.id})</li>)}</ul>
        <p>Dados: estado destas tarefas. Destino: banco local; nenhum envio autorizado a provedores. Excluir continua exigindo confirmação específica.</p>
        <p>Limpar a conversa mantém a delegação. Reiniciar preserva o histórico e encerra a execução autorizada.</p>
        <div className="delegation-actions"><button disabled={state.busy || draft.owner !== owner} onClick={() => void client.consent()}>Conceder delegação</button><button disabled={state.busy} onClick={() => void client.end(draft.id, 'cancelled')}>Cancelar rascunho</button></div>
      </section> : <form aria-label="Nova delegação" onSubmit={event => { event.preventDefault(); void client.prepare({ objective, targetIds: targets, maxOperations: limit, durationSeconds: minutes * 60 }); }}>
        <label>Objetivo<input value={objective} maxLength={500} required disabled={state.busy} onChange={event => setObjective(event.target.value)} /></label>
        <fieldset disabled={!native || state.busy || !tasks.ready}><legend>Tarefas permitidas · selecione até 20</legend>
          {!tasks.snapshot.tasks.some(t => !t.completed) && <p>Nenhuma tarefa pendente disponível.</p>}
          {tasks.snapshot.tasks.filter(t => !t.completed).map(task => <label key={task.id}><input type="checkbox" checked={targets.includes(task.id)} onChange={event => setTargets(ids => event.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} />{task.title} (#{task.id})</label>)}
        </fieldset>
        <div className="delegation-limits"><label>Limite de alterações<input type="number" min={1} max={20} required value={limit} onChange={event => setLimit(event.target.valueAsNumber)} /></label><label>Validade em minutos<input type="number" min={1} max={30} required value={minutes} onChange={event => setMinutes(event.target.valueAsNumber)} /></label></div>
        <button type="submit" disabled={!native || !state.ready || state.busy || !objective.trim() || targets.length < 1 || targets.length > 20}>Revisar delegação</button>
      </form>}
      <section aria-label="Histórico de delegações"><h3>Autoridade e histórico</h3><p>Detalhes por 30 dias após encerramento; recibos mínimos preservados para evitar duplicações. Todas as delegações ativas e até 100 registros encerrados recentes.</p>
        {!grants.length && <p>Nenhuma delegação registrada.</p>}
        {grants.map(g => <article key={g.id} className="delegation-record"><h4>{g.scope?.objective ?? 'Detalhes removidos pela retenção'}</h4><p>{delegationStatus[g.status] ?? 'Estado incompatível'} · {originLabel(g.owner)} · {g.used}/{g.maxOperations} alterações</p>{g.expiresAt && <p>Validade até {date(g.expiresAt)}</p>}
          {g.status === 'active' && <><div className="delegation-actions"><button disabled={state.busy} onClick={() => void client.end(g.id, 'revoked')}>Revogar delegação</button><button disabled={state.busy} onClick={() => void client.end(g.id, 'cancelled')}>Cancelar objetivo</button><button disabled={state.busy} onClick={() => void client.end(g.id, 'completed')}>Encerrar como concluído</button></div>
            {g.owner !== owner ? <p>Execução disponível somente na {originLabel(g.owner)} de origem.</p> : g.scope?.targets.map(t => <button key={t.id} disabled={state.busy || state.recoveryBlocked || !!state.pending || !!g.expiresAt && Date.now() >= g.expiresAt * 1000 || tasks.snapshot.tasks.find(task => task.id === t.id)?.completed !== false} onClick={() => void client.execute(g.id, t.id)}>Concluir #{t.id} · {t.title}</button>)}
          </>}
          {g.status === 'draft' && <button disabled={state.busy} onClick={() => void client.end(g.id, 'cancelled')}>Cancelar rascunho pendente</button>}
        </article>)}
        <h4>Recibos confirmados</h4>{state.receipts.map(r => <p key={r.requestId}>Tarefa #{r.targetId} concluída · revisão {r.beforeRevision} → {r.revision} · consumo {r.used} · {date(r.committedAt)} · recibo <code>{r.requestId}</code></p>)}
      </section>
    </div>
  </details>;
}
