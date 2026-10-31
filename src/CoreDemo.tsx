import { useEffect, useRef, useState } from 'react';
import { JarvisCore } from './JarvisCore';
import { coreStates, type DemoState } from './core-state';
import { TaskPanel } from './TaskPanel';
import { useTasks } from './useTasks';
import { useConversation } from './useConversation';
import { Conversation } from './Conversation';

export function DemoAgenda({ close, closeRef, actions }: { close: () => void; closeRef: React.RefObject<HTMLButtonElement | null>; actions?: React.ReactNode }) {
  return <section className="demo-agenda" aria-labelledby="agenda-title">
    <div className="agenda-heading"><div><p className="eyebrow">PAINEL / 01</p><h2 id="agenda-title">Uma visão do seu dia.</h2></div><button ref={closeRef} className="panel-close" onClick={close} aria-label="Fechar painel de agenda">×</button></div>
    <div className="fiction-label">DEMONSTRAÇÃO · DADOS FICTÍCIOS</div>
    {actions && <div className="agenda-view-controls">{actions}</div>}
    <div className="agenda-date"><strong>24</strong><div>Quinta-feira<small>OUTUBRO · EXEMPLO</small></div><span>03 itens</span></div>
    <ol className="agenda-timeline">
      <li><time>09:00</time><div><strong>Planejar a manhã</strong><p>Reservar um momento para as prioridades.</p></div><span className="agenda-duration">20 min</span></li>
      <li><time>14:30</time><div><strong>Revisar uma ideia</strong><p>Dar espaço ao próximo projeto.</p></div><span className="agenda-duration">45 min</span></li>
      <li><time>17:00</time><div><strong>Desacelerar</strong><p>Organizar o que fica para amanhã.</p></div><span className="agenda-duration">15 min</span></li>
    </ol>
    <p className="agenda-note">Uma prévia da expansão de painéis. Os itens não são editáveis e não são salvos.</p>
  </section>;
}

export function CoreDemo({ economy, active, compact }: { economy: boolean; active: boolean; compact: boolean }) {
  const [state, setState] = useState<DemoState>('available');
  const [intensity, setIntensity] = useState(0.7);
  const tasks = useTasks();
  const [panel, setPanel] = useState<'agenda' | 'tasks' | 'chat' | null>(null);
  const conversation = useConversation();
  const [command, setCommand] = useState('');
  const [chatError, setChatError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const [quickTaskRequest, setQuickTaskRequest] = useState(0);
  const [queryTaskIds, setQueryTaskIds] = useState<number[] | null>(null);
  const panelOpen = panel !== null;
  const returnFocus = useRef<HTMLElement | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const effectiveState = economy ? 'economy' : conversation.busy ? conversation.snapshot.status === 'executing' ? 'executing' : 'processing' : state;
  const realStatus = conversation.snapshot.status === 'idle' ? coreStates[effectiveState].label : conversation.statusLabel;
  const hasSignal = state === 'listening' || state === 'speaking';

  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReducedMotion(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);

  function close() {
    setPanel(null);
    requestAnimationFrame(() => (returnFocus.current?.isConnected ? returnFocus.current : input.current ?? trigger.current)?.focus());
  }
  useEffect(() => {
    if (panelOpen && !(panel === 'tasks' && quickTaskRequest)) closeRef.current?.focus();
  }, [panelOpen, panel, quickTaskRequest]);
  function openAgenda(source: HTMLElement) {
    returnFocus.current = source;
    if (panel === 'agenda') close(); else setPanel('agenda');
  }

  return <section className={`core-demo ${compact ? 'demo-compact' : ''} ${panel === 'chat' ? 'assistant-chat-open' : ''}`} aria-label="Demonstração do núcleo JARVIS" onKeyDown={event => {
    if (event.key === 'Escape' && panelOpen) { event.preventDefault(); close(); }
  }}>
    <div className="workspace-heading"><p className="eyebrow">{compact ? 'ASSISTENTE FLUTUANTE' : 'CENTRAL DE COMANDO'}</p><span className="demo-version">NÚCLEO / V0.1</span></div>
    <div className={`core-workspace ${panelOpen ? 'panel-open' : ''}`}>
      <div className="core-position"><div className="core-focus">
        <div className="core-instrument"><span className="instrument-caption" aria-hidden="true">PRESENÇA LOCAL</span><button className="core-access" onClick={event => openAgenda(event.currentTarget)} aria-label={panel === 'agenda' ? 'Recolher painel de agenda' : 'Expandir painel de agenda'} aria-expanded={panel === 'agenda'} aria-controls="agenda-demo"><JarvisCore state={effectiveState} active={active && panel !== 'chat'} reducedMotion={reducedMotion} intensity={intensity} compact={compact} /></button><span className="instrument-coordinate" aria-hidden="true">J / 01</span></div>
        <h1 className="core-name">J.A.R.V.I.S</h1>
        <div className="core-status" role="status"><span className="status-dot" />{realStatus}</div>
        <p className="core-description">{conversation.snapshot.status === 'processing' ? 'Interpretando o pedido; nenhuma conclusão antecipada.' : conversation.snapshot.status === 'executing' ? 'Aguardando o resultado da operação.' : conversation.snapshot.status === 'awaiting_approval' ? 'Revise a operação na conversa.' : coreStates[effectiveState].description}</p>
      </div></div>
      <div id="agenda-demo" className="demo-panel" inert={!panelOpen} aria-hidden={!panelOpen}>{panel === 'chat' ? <Conversation snapshot={conversation.snapshot} session={conversation.session} busy={conversation.busy} close={close} closeRef={closeRef} compact onError={setChatError} onDecision={(id, apply) => { void conversation.session.decide(id, apply).finally(() => input.current?.focus({ preventScroll: true })); }} /> : panel === 'tasks' ? <TaskPanel key={quickTaskRequest} initialFilter={queryTaskIds ? 'all' : 'pending'} model={queryTaskIds ? { ...tasks, snapshot: { ...tasks.snapshot, tasks: tasks.snapshot.tasks.filter(task => queryTaskIds.includes(task.id)) } } : tasks} close={close} closeRef={closeRef} quick={quickTaskRequest > 0} /> : <DemoAgenda close={close} closeRef={closeRef} />}</div>
    </div>
    <div className="task-actions assistant-task-controls"><button aria-expanded={panel === 'chat'} aria-controls="agenda-demo" onClick={event => { returnFocus.current = event.currentTarget; if (panel === 'chat') close(); else setPanel('chat'); }}>Conversa</button><button aria-expanded={panel === 'tasks'} aria-controls="agenda-demo" onClick={event => { returnFocus.current = event.currentTarget; if (panel === 'tasks') close(); else { setQueryTaskIds(null); setQuickTaskRequest(0); setPanel('tasks'); } }}>Tarefas</button><button onClick={event => { returnFocus.current = event.currentTarget; setQueryTaskIds(null); setQuickTaskRequest(value => value + 1); setPanel('tasks'); }}>+ Nova tarefa</button></div>
    <div className="assistant-conversation-dock"><form aria-busy={conversation.busy} onSubmit={event => {
      event.preventDefault();
      if (!command.trim() || conversation.busy) return;
      const text = command.trim(); setCommand(''); setChatError(''); setPanel('chat'); returnFocus.current = input.current;
      const generation = conversation.snapshot.generation;
      void conversation.session.send(text).then(result => { if (!result && conversation.session.getState().snapshot.generation === generation) setCommand(current => current || text); if (result?.panel === 'tasks') { setQueryTaskIds(result.taskIds ?? null); setQuickTaskRequest(0); setPanel('tasks'); } else if (result?.panel === 'agenda') setPanel('agenda'); }).finally(() => input.current?.focus({ preventScroll: true }));
    }}><label className="sr-only" htmlFor="assistant-command">Comando para JARVIS</label><input ref={input} id="assistant-command" value={command} onChange={event => setCommand(event.target.value)} maxLength={1000} autoComplete="off" placeholder="Como posso ajudar, senhor?" aria-describedby="assistant-command-feedback" /><button type="submit" disabled={!command.trim() || conversation.busy || !conversation.ready} aria-label="Enviar pedido ao JARVIS">↑</button></form><p id="assistant-command-feedback" role="status" hidden={panel === 'chat' && !chatError && !conversation.error}>{chatError || conversation.feedback}</p></div>
    <div className="demo-console">
      <div className="demo-console-heading"><span>SIMULAR ESTADO</span><span>Sem captura ou reprodução de áudio</span></div>
      <div className="demo-controls"><div className="state-controls" role="group" aria-label="Estados simulados">{(['available', 'listening', 'processing', 'speaking'] as const).map((value, index) => <button key={value} className="state-button" aria-pressed={state === value} disabled={economy} onClick={() => setState(value)}><span className="state-number" aria-hidden="true">0{index + 1}</span>{coreStates[value].label}</button>)}</div>
      <button ref={trigger} className="agenda-trigger" onClick={event => openAgenda(event.currentTarget)} aria-expanded={panel === 'agenda'} aria-controls="agenda-demo"><span aria-hidden="true">{panel === 'agenda' ? '−' : '+'}</span>{panel === 'agenda' ? 'Recolher agenda' : 'Abrir agenda demo'}</button></div>
      <div className="signal-controls"><label className={!hasSignal || economy ? 'signal-disabled' : ''}>Intensidade simulada<input type="range" min="0" max="100" step="1" value={Math.round(intensity * 100)} disabled={!hasSignal || economy} onChange={event => setIntensity(Number(event.target.value) / 100)} /><output>{Math.round(intensity * 100)}%</output></label><span>{economy ? 'Simulação suspensa pelo modo econômico.' : reducedMotion ? 'Movimento reduzido: visual estático.' : hasSignal ? 'Sinal de demonstração ativo.' : 'Selecione escuta ou fala para variar o sinal.'}</span></div>
    </div>
  </section>;
}
