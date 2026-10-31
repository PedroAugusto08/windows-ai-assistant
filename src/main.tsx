import { ExecutorPanel } from './ExecutorPanel';
import { DelegationPanel } from './DelegationPanel';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { shouldTick } from './activity';
import { configureClock } from './clock';
import { CoreDemo } from './CoreDemo';
import { CommandCenter } from './CommandCenter';
import { useConversation } from './useConversation';
import './styles.css';

const native = isTauri();
const assistant = new URLSearchParams(location.search).get('window') === 'assistant';
const label = assistant ? 'assistant' : 'dashboard';

function App() {
  const conversation = useConversation();
  const [economy, setEconomy] = useState(false);
  const [visible, setVisible] = useState(!assistant || !native);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [ready, setReady] = useState(!native);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState(new Date());
  const active = shouldTick(economy, visible, pageVisible);

  useEffect(() => {
    const changed = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    let disposed = false;
    const cleanups: (() => void)[] = [];
    if (native) {
      // Registrar eventos antes de ler o estado para não perder alterações durante a inicialização.
      void (async () => {
        const economyOff = await listen<boolean>('economy-changed', event => setEconomy(event.payload));
        if (disposed) { economyOff(); return; }
        cleanups.push(economyOff);
        const visibleOff = await listen<boolean>('window-visible', event => setVisible(event.payload));
        if (disposed) { visibleOff(); return; }
        cleanups.push(visibleOff);
        const current = await invoke<boolean>('get_economy');
        const currentVisible = await invoke<boolean>('get_visible');
        if (!disposed) { setEconomy(current); setVisible(currentVisible); setReady(true); }
      })().catch(reason => { if (!disposed) setError(String(reason)); });
    }
    return () => { disposed = true; cleanups.forEach(cleanup => cleanup()); document.removeEventListener('visibilitychange', changed); };
  }, []);

  useEffect(() => configureClock(active, () => setTime(new Date())), [active]);

  async function action(command: string, args?: Record<string, unknown>) {
    setBusy(true); setError('');
    try { await invoke(command, args); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  function toggleEconomy() {
    if (native) void action('set_economy', { enabled: !economy });
    else setEconomy(!economy);
  }
  const disabled = busy || !ready;
  const windowButton = (target: string, text: string, show = true) => (
    <button disabled={disabled || !native} onClick={() => void action('window_action', { label: target, visible: show })}>{text}</button>
  );

  if (!assistant) return <main className={`dashboard command-dashboard ${active ? '' : 'quiet'}`}>
    <header className="command-header"><div className="brand"><span className="brand-mark">J</span><div><strong>J.A.R.V.I.S</strong><small>CENTRAL DE COMANDO / 0.1</small></div></div><div className="status header-status"><span className="status-dot" />{conversation.snapshot.status !== 'idle' ? conversation.statusLabel : economy ? 'Econômico' : 'Disponível'}<time>{time.toLocaleTimeString('pt-BR')}</time></div><div className="desktop-controls">{windowButton('assistant', 'Assistente ↗')}<button aria-pressed={economy} disabled={disabled} onClick={toggleEconomy}>Economia <span className="switch">{economy ? 'ON' : 'OFF'}</span></button><details className="desktop-menu"><summary>Controles</summary><div>{windowButton(label, 'Ocultar esta janela', false)}{windowButton('assistant', 'Abrir assistente ↗')}<button className="exit" disabled={disabled || !native} onClick={() => void action('quit')}>Encerrar JARVIS</button></div></details></div></header>
    {!native && <p className="command-preview">PRÉVIA WEB <span>Controles de janela, bandeja e saída disponíveis no desktop.</span></p>}
    {error && <p className="error" role="alert">{error}</p>}
    <ExecutorPanel owner={label} />
    <DelegationPanel owner={label} />
    <CommandCenter economy={economy} active={active && ready} />
    <footer className="command-footer"><span>JARVIS / PRESENÇA LOCAL</span><span>TAREFAS LOCAIS · AGENDA E SISTEMA DEMONSTRATIVOS</span><span>NÚCLEO / V0.2</span></footer>
  </main>;

  return <main className={`${assistant ? 'assistant' : 'dashboard'} ${active ? '' : 'quiet'}`}>
    <header><div className="brand"><span className="brand-mark">J</span><div><strong>JARVIS</strong><small>CONTROLE LOCAL</small></div></div><span className="badge">{native ? 'DESKTOP · LOCAL' : 'PRÉVIA WEB'}</span></header>
    {!native && <p className="notice">Prévia de interface. Janelas, bandeja e saída exigem o aplicativo desktop.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <ExecutorPanel owner={label} />
    <DelegationPanel owner={label} />
    <CoreDemo economy={economy} active={active && ready} compact={assistant} />
    <div className="status runtime-status"><span className="status-dot"/>{conversation.snapshot.status !== 'idle' ? conversation.statusLabel : economy ? 'Atividades visuais suspensas' : 'Disponível'}<span className="separator">/</span><time>{time.toLocaleTimeString('pt-BR')}</time></div>
    <div className="panels">
      <section className="panel"><p className="eyebrow">01 / JANELAS</p><h2>{assistant ? 'Seu dashboard' : 'Sempre ao alcance'}</h2><p>Fechar uma janela a oculta. Use a bandeja para restaurar cada uma.</p><div className="actions">{windowButton(assistant ? 'dashboard' : 'assistant', assistant ? 'Abrir dashboard ↗' : 'Abrir assistente ↗')}{windowButton(label, 'Ocultar esta janela', false)}</div></section>
      <section className="panel"><p className="eyebrow">02 / ATIVIDADE</p><h2>Menos movimento.</h2><p>O modo econômico suspende o sinal, o relógio e as animações nas duas janelas.</p><button className="economy-button" aria-pressed={economy} disabled={disabled} onClick={toggleEconomy}><span>Modo econômico</span><span className="switch">{economy ? 'ON' : 'OFF'}</span></button></section>
    </div>
    <footer><span>{assistant ? 'JARVIS / ASSISTENTE' : 'LOCAL POR DESIGN · SEM SERVIÇOS EXTERNOS'}</span><button className="exit" disabled={disabled || !native} onClick={() => void action('quit')}>Encerrar JARVIS</button></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
