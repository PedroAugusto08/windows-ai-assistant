import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { JarvisCore } from './JarvisCore';
import { DemoAgenda } from './CoreDemo';
import { coreStates, type DemoState } from './core-state';
import { type ContextPanel } from './command';
import './command-center.css';
import { TaskPanel, TaskPriorities } from './TaskPanel';
import { useTasks } from './useTasks';
import { useConversation } from './useConversation';
import { Conversation } from './Conversation';

function InformationPanel({ title, code, children }: { title: string; code: string; children: ReactNode }) {
  return <details className="information-panel" open>
    <summary><span className="panel-code" aria-hidden="true">{code}</span><h2>{title}</h2><span className="collapse-mark" aria-hidden="true">⌄</span></summary>
    <div className="information-content">{children}</div>
  </details>;
}

export function CommandCenter({ economy, active }: { economy: boolean; active: boolean }) {
  const tasks = useTasks();
  const conversation = useConversation();
  const { snapshot, session, busy: interpreting } = conversation;
  const intelligenceEnabled = snapshot.intelligenceEnabled;
  const messages = snapshot.messages;
  const [queryTaskIds, setQueryTaskIds] = useState<number[] | null>(null);
  const [panel, setPanel] = useState<ContextPanel>(null);
  const [expanded, setExpanded] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1000px)').matches);
  const [information, setInformation] = useState(true);
  const [state, setState] = useState<DemoState>('available');
  const [intensity, setIntensity] = useState(0.7);
  const [command, setCommand] = useState('');
  const [feedback, setFeedback] = useState('');
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const input = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const restoringFocus = useRef(false);
  const effectiveState = economy ? 'economy' : interpreting ? snapshot.status === 'executing' ? 'executing' : 'processing' : state;
  const realStatus = snapshot.status === 'idle' ? coreStates[effectiveState].label : conversation.statusLabel;
  const hasSignal = state === 'listening' || state === 'speaking';
  const contextOccupiesCenter = !!panel && (narrow || expanded);

  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const layout = matchMedia('(max-width: 1000px)');
    const changed = () => setReducedMotion(query.matches);
    const resized = () => setNarrow(layout.matches);
    query.addEventListener('change', changed);
    layout.addEventListener('change', resized);
    return () => { query.removeEventListener('change', changed); layout.removeEventListener('change', resized); };
  }, []);
  useEffect(() => {
    if (panel) (submitted.current ? input.current : closeRef.current)?.focus({ preventScroll: true });
    else if (restoringFocus.current) {
      const target = returnFocus.current;
      if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
      else input.current?.focus({ preventScroll: true });
    }
    submitted.current = false;
    restoringFocus.current = false;
  }, [panel, narrow]);

  function closePanel() {
    restoringFocus.current = true;
    setPanel(null);
    setExpanded(false);
  }
  function openPanel(value: Exclude<ContextPanel, null>, source: HTMLElement | null) {
    if (panel === value) { closePanel(); return; }
    setQueryTaskIds(null);
    returnFocus.current = source;
    setExpanded(value === 'tasks');
    setPanel(value);
  }
  async function decideApproval(id: string, apply: boolean) {
    setFeedback('');
    await session.decide(id, apply);
    input.current?.focus({ preventScroll: true });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = command.trim();
    if (!text || interpreting) { input.current?.focus(); return; }
    setCommand(''); setFeedback('');
    returnFocus.current = input.current;
    submitted.current = panel !== 'chat';
    setExpanded(false); setPanel('chat');
    const generation = snapshot.generation;
    const result = await session.send(text);
    if (!result && session.getState().snapshot.generation === generation) setCommand(current => current || text);
    if (result?.panel) {
      setQueryTaskIds(result.taskIds ?? null);
      setExpanded(result.panel === 'tasks'); setPanel(result.panel);
    }
    input.current?.focus({ preventScroll: true });
  }

  const approvalOpen = messages.some(message => !!message.approval);
  return <section className={`command-center ${information ? '' : 'information-hidden'} ${panel ? 'context-open' : ''} ${contextOccupiesCenter ? 'context-centered' : ''} ${approvalOpen ? 'approval-open' : ''}`} aria-label="Central de Comando" onKeyDown={event => {
    if (event.key === 'Escape' && panel) {
      event.preventDefault();
      if (expanded && !narrow && panel !== 'tasks') { setExpanded(false); expandRef.current?.focus({ preventScroll: true }); }
      else closePanel();
    }
  }}>
    <div className="command-heading"><div><p className="eyebrow">CENTRAL DE COMANDO</p><span className="workspace-subtitle">Seu dia. Seu espaço. Ao seu comando.</span></div><span className="fiction-label">CONTROLE LOCAL</span></div>
    <div className="command-toolbar" role="group" aria-label="Painéis da Central">
      <button aria-label={information ? 'Recolher informações' : 'Mostrar informações'} aria-expanded={information} aria-controls="command-information" onClick={() => setInformation(!information)}><span aria-hidden="true">{information ? '−' : '+'}</span> Informações</button>
      <div><button aria-expanded={panel === 'tasks'} aria-controls="command-context" onClick={event => openPanel('tasks', event.currentTarget)}>Tarefas</button><button aria-expanded={panel === 'agenda'} aria-controls="command-context" onClick={event => openPanel('agenda', event.currentTarget)}><span aria-hidden="true">▤</span> Agenda</button><button aria-expanded={panel === 'chat'} aria-controls="command-context" onClick={event => openPanel('chat', event.currentTarget)}><span aria-hidden="true">◇</span> Conversa</button></div>
    </div>
    <div className="command-stage">
      <aside id="command-information" className="command-information" hidden={!information} aria-label="Informações e prioridades">
        <InformationPanel title="Sistema" code="01"><div className="data-caption">VALORES FICTÍCIOS</div><div className="system-reading"><span>CPU</span><strong>8<small>%</small></strong></div><div className="meter" aria-hidden="true"><span style={{ width: '8%' }} /></div><div className="system-reading memory-reading"><span>Memória</span><strong>7 <small>/ 16 GB</small></strong></div><div className="meter" aria-hidden="true"><span style={{ width: '44%' }} /></div><div className="system-footnote"><span>Windows 11 · exemplo</span><span>Sem monitoramento</span></div></InformationPanel>
        <InformationPanel title="Próximos compromissos" code="02"><div className="data-caption">AGENDA DE EXEMPLO · 24 OUT</div><ol className="compact-agenda"><li><time>09:00</time><div><strong>Planejar a manhã</strong><span>20 min · organização</span></div></li><li><time>14:30</time><div><strong>Revisar uma ideia</strong><span>45 min · projeto</span></div></li></ol><button className="text-action" aria-expanded={panel === 'agenda'} aria-controls="command-context" onClick={event => openPanel('agenda', event.currentTarget)}>Ver agenda completa <span aria-hidden="true">↗</span></button></InformationPanel>
        <InformationPanel title="Prioridades" code="03"><div className="data-caption">TAREFAS LOCAIS · PENDENTES</div><TaskPriorities model={tasks} open={() => openPanel('tasks', document.activeElement as HTMLElement)} /></InformationPanel>
      </aside>
      <div className="command-core-region" hidden={contextOccupiesCenter}><div className="command-core-focus">
        <div className="core-instrument"><span className="instrument-caption" aria-hidden="true">PRESENÇA LOCAL</span><button className="core-access" aria-label={panel === 'chat' ? 'Recolher conversa com JARVIS' : 'Abrir conversa com JARVIS'} aria-expanded={panel === 'chat'} aria-controls="command-context" onClick={event => openPanel('chat', event.currentTarget)}><JarvisCore state={effectiveState} active={active && !contextOccupiesCenter} reducedMotion={reducedMotion} intensity={intensity} /></button><span className="instrument-coordinate" aria-hidden="true">J / 02</span></div>
        <h1 className="core-name">J.A.R.V.I.S</h1><div className="core-status" role="status"><span className="status-dot" />{realStatus}</div><p className="core-description">{snapshot.status === 'processing' ? 'Interpretando o pedido; nenhuma conclusão antecipada.' : snapshot.status === 'executing' ? 'Aguardando o resultado da operação.' : snapshot.status === 'awaiting_approval' ? 'Revise a operação na conversa.' : coreStates[effectiveState].description}</p>
        <span className="core-local-note">{intelligenceEnabled ? 'PESQUISA · CLIMA · TAREFAS LOCAIS' : 'LOCAL · DEMONSTRAÇÃO'}</span>
      </div>
      <details className="core-simulation"><summary>Simular estados do núcleo <span aria-hidden="true">⌄</span></summary><div className="simulation-content"><div className="state-controls" role="group" aria-label="Estados simulados">{(['available', 'listening', 'processing', 'speaking'] as const).map(value => <button key={value} className="state-button" aria-pressed={state === value} disabled={economy} onClick={() => setState(value)}>{coreStates[value].label}</button>)}</div><div className="signal-controls"><label>Intensidade<input type="range" min="0" max="100" value={Math.round(intensity * 100)} disabled={!hasSignal || economy} onChange={event => setIntensity(Number(event.target.value) / 100)} /><output>{Math.round(intensity * 100)}%</output></label></div><p>Somente animação. Sem captura ou reprodução de áudio.</p></div></details>
      </div>
      <div id="command-context" className="command-context" hidden={!panel}>
        {contextOccupiesCenter && <div className="context-presence" role="status"><span className="status-dot" /><strong>J.A.R.V.I.S</strong><span>{realStatus}</span></div>}
        {panel === 'tasks' && <TaskPanel initialFilter={queryTaskIds ? 'all' : 'pending'} model={queryTaskIds ? { ...tasks, snapshot: { ...tasks.snapshot, tasks: tasks.snapshot.tasks.filter(task => queryTaskIds.includes(task.id)) } } : tasks} close={closePanel} closeRef={closeRef} />}
        {panel === 'agenda' && <DemoAgenda close={closePanel} closeRef={closeRef} actions={!narrow && <button ref={expandRef} className="agenda-expand" aria-pressed={expanded} aria-controls="command-context" onClick={() => setExpanded(!expanded)}>{expanded ? 'Voltar à agenda lateral' : 'Expandir agenda'}<span aria-hidden="true">{expanded ? ' ↙' : ' ↗'}</span></button>} />}
        {panel === 'chat' && <Conversation snapshot={snapshot} session={session} busy={interpreting} close={closePanel} closeRef={closeRef} onDecision={(id, apply) => void decideApproval(id, apply)} onError={setFeedback} />}

      </div>
    </div>
    <div className="command-dock"><div className="command-suggestions" role="group" aria-label="Comandos de exemplo"><span>EXPERIMENTE</span>{['Como está o tempo em Belo Horizonte?', 'Pesquise notebooks ASUS', 'O que tenho para hoje?'].map(value => <button key={value} onClick={() => { setCommand(value); input.current?.focus(); }}>{value}<span aria-hidden="true">↗</span></button>)}</div><form className="command-form" aria-busy={interpreting} onSubmit={submit}><span className="command-prompt" aria-hidden="true">›</span><label className="sr-only" htmlFor="jarvis-command">Comando para JARVIS</label><input ref={input} id="jarvis-command" value={command} onChange={event => setCommand(event.target.value)} maxLength={1000} autoComplete="off" placeholder="Como posso ajudar, senhor?" aria-describedby="command-feedback" /><button type="submit" disabled={!command.trim() || interpreting || !conversation.ready} aria-label={intelligenceEnabled ? 'Enviar pedido ao JARVIS' : 'Enviar comando demonstrativo'}><span aria-hidden="true">↑</span></button></form><div className="command-dock-meta"><p id="command-feedback" role="status">{feedback || conversation.error || (snapshot.revision >= 0 ? conversation.feedback : 'Experimente um comando ou abra um painel.')}</p><span>ENTER PARA ENVIAR · ESC PARA RECOLHER</span></div></div>
  </section>;
}
