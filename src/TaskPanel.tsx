import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { emptyTask, isTaskOverdue, priorityLabels, selectTasks, taskDeadline, type Priority, type Task, type TaskFilter, type TaskInput } from './tasks';
import type { TasksModel } from './useTasks';
import './tasks.css';

export function TaskStatus({ model }: { model: TasksModel }) {
  return <>{model.error && <div className="task-error" role="alert"><p>{model.error}</p><button onClick={() => void model.client.refresh()} disabled={model.busy}>Tentar novamente</button></div>}{!model.ready && !model.error && <p role="status">Carregando tarefas…</p>}</>;
}
export function TaskPriorities({ model, open }: { model: TasksModel; open: () => void }) {
  const tasks = selectTasks(model.snapshot.tasks).slice(0, 3);
  return <><TaskStatus model={model} />{model.ready && <>{tasks.length ? <ol className="priority-list task-priorities">{tasks.map(task => <li key={task.id}><button disabled={model.busy} aria-label={`Concluir ${task.title}`} onClick={() => void model.client.complete(task.id, true)}>✓</button><div><strong>{task.title}</strong><small>{priorityLabels[task.priority]} · {taskDeadline(task, model.now)}</small>{isTaskOverdue(task, model.now) && <span className="task-overdue">Atrasada</span>}</div></li>)}</ol> : <p className="task-empty">Nenhuma tarefa pendente.</p>}</>}<button className="text-action" onClick={open}>Ver todas as tarefas ↗</button></>;
}
export function TaskPanel({ model, close, closeRef, quick = false, initialFilter = 'pending' }: { model: TasksModel; close: () => void; closeRef: RefObject<HTMLButtonElement | null>; quick?: boolean; initialFilter?: TaskFilter }) {
  const [filter, setFilter] = useState<TaskFilter>(initialFilter);
  const [editing, setEditing] = useState<number | null | undefined>(quick ? null : undefined);
  const [draft, setDraft] = useState<TaskInput>(emptyTask);
  const [details, setDetails] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  const tasks = selectTasks(model.snapshot.tasks, filter);
  const disabled = model.busy || !model.ready;
  useEffect(() => { if (editing !== undefined && model.ready) titleRef.current?.focus(); }, [editing, model.ready]);
  function edit(task?: Task) { setDraft(task ? { ...task } : emptyTask()); setEditing(task?.id ?? null); setDetails(!!task); setDeleting(null); setFeedback(''); }
  function cancel() { setEditing(undefined); setDraft(emptyTask()); newRef.current?.focus(); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (editing === undefined || !draft.title.trim()) return;
    if (await model.client.save(editing, draft)) { setFeedback(editing === null ? 'Tarefa criada.' : 'Tarefa atualizada.'); cancel(); }
  }
  return <section className="task-panel" aria-labelledby="tasks-title" onKeyDown={event => {
    if (event.key === 'Escape' && (editing !== undefined || deleting !== null)) { event.stopPropagation(); event.preventDefault(); if (deleting !== null) { setDeleting(null); deleteRef.current?.focus(); } else cancel(); }
  }}>
    <div className="task-heading"><div><p className="eyebrow">PRODUTIVIDADE / LOCAL</p><h2 id="tasks-title">Tarefas</h2></div><button ref={closeRef} className="panel-close" aria-label="Fechar tarefas" onClick={close}>×</button></div>
    <TaskStatus model={model} />
    <div className="task-tools"><label>Exibir<select aria-label="Filtrar tarefas" value={filter} onChange={event => { setFilter(event.target.value as TaskFilter); setDeleting(null); }}><option value="pending">Pendentes</option><option value="completed">Concluídas</option><option value="all">Todas</option></select></label><button ref={newRef} disabled={disabled} onClick={() => edit()}>+ Nova tarefa</button></div>
    {editing !== undefined && <form className="task-form" onSubmit={event => void save(event)}><label>Título<input ref={titleRef} name="title" value={draft.title} maxLength={200} required disabled={disabled} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="O que precisa ser feito?" /></label><button type="button" className="text-action" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Recolher detalhes' : 'Adicionar detalhes opcionais'}</button>{details && <><label>Descrição<textarea name="description" maxLength={5000} value={draft.description} disabled={disabled} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label><div className="task-fields"><label>Prioridade<select name="priority" value={draft.priority} disabled={disabled} onChange={event => setDraft({ ...draft, priority: event.target.value as Priority })}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Prazo<input name="dueDate" type="date" min="0001-01-01" max="9999-12-31" value={draft.dueDate ?? ''} disabled={disabled} onChange={event => setDraft({ ...draft, dueDate: event.target.value || null, dueTime: event.target.value ? draft.dueTime : null })} /></label><label>Horário (opcional)<input name="dueTime" type="time" step="60" value={draft.dueTime ?? ''} disabled={disabled || !draft.dueDate} onChange={event => setDraft({ ...draft, dueTime: event.target.value || null })} /></label></div><label>Projeto<input name="project" maxLength={100} value={draft.project} disabled={disabled} onChange={event => setDraft({ ...draft, project: event.target.value })} placeholder="Nome opcional" /></label></>}<div className="task-actions"><button type="submit" disabled={disabled || !draft.title.trim()}>{editing === null ? 'Criar tarefa' : 'Salvar alterações'}</button><button type="button" disabled={model.busy} onClick={cancel}>Cancelar</button></div></form>}
    <p className="task-feedback" role="status">{feedback}</p>
    {model.ready && <>{!tasks.length && <p className="task-empty">{filter === 'completed' ? 'Nenhuma tarefa concluída.' : filter === 'all' ? 'Sua lista está vazia. Crie sua primeira tarefa.' : 'Tudo em dia. Nenhuma tarefa pendente.'}</p>}<ul className="task-list">{tasks.map(task => <li key={task.id} className={task.completed ? 'task-completed' : ''}><div className="task-item-heading"><h3>{task.title}</h3><span className={`task-priority priority-${task.priority}`}>{priorityLabels[task.priority]}</span></div><div className="task-meta"><span>{taskDeadline(task, model.now)}</span>{isTaskOverdue(task, model.now) && <span className="task-overdue">Atrasada</span>}{task.project && <span>Projeto · {task.project}</span>}<span>{task.completed ? 'Concluída' : 'Pendente'}</span></div>{task.description && <p className="task-description">{task.description}</p>}<div className="task-actions"><button disabled={disabled} onClick={async () => { if (await model.client.complete(task.id, !task.completed)) setFeedback(task.completed ? 'Tarefa reaberta.' : 'Tarefa concluída.'); }}>{task.completed ? 'Reabrir' : 'Concluir'}</button><button disabled={disabled} onClick={() => edit(task)}>Editar</button><button disabled={disabled} onClick={event => { deleteRef.current = event.currentTarget; setDeleting(task.id); }}>Excluir</button></div>{deleting === task.id && <div className="task-confirm" role="group" aria-label={`Confirmar exclusão de ${task.title}`}><p>Excluir “{task.title}”? Esta ação é permanente.</p><div className="task-actions"><button disabled={disabled} onClick={async () => { if (await model.client.delete(task.id)) { setDeleting(null); if (editing === task.id) cancel(); setFeedback('Tarefa excluída.'); newRef.current?.focus(); } }}>Confirmar exclusão</button><button disabled={model.busy} autoFocus onClick={() => { setDeleting(null); deleteRef.current?.focus(); }}>Manter tarefa</button></div></div>}</li>)}</ul></>}
  </section>;
}
