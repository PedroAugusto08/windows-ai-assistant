import { useEffect, useRef, type RefObject } from 'react';
import type { ConversationSession, ConversationSnapshot } from './conversation-session';
import { conversationStatus } from './conversation-session';
import { openWeatherSource, weatherSources } from './weather';
import './conversation.css';

const responseLabels = { general_answer: 'Resposta geral · não confirma ações', clarification: 'Esclarecimento', proposal: 'Proposta · requer revisão', tool_result: 'Retorno do aplicativo', unavailable: 'Limitação ou estado do pedido' };

export function Conversation({ snapshot, session, busy, close, closeRef, onDecision, onError, compact = false }: {
  snapshot: ConversationSnapshot; session: ConversationSession; busy: boolean;
  close: () => void; closeRef: RefObject<HTMLButtonElement | null>;
  onDecision: (id: string, apply: boolean) => void; onError: (message: string) => void; compact?: boolean;
}) {
  const log = useRef<HTMLDivElement>(null);
  const lastMessage = snapshot.messages.at(-1);
  const scrollKey = JSON.stringify([snapshot.generation, lastMessage?.id, lastMessage?.approval?.id, lastMessage?.weatherAttribution]);
  useEffect(() => {
    if (!log.current) return;
    log.current.scrollTop = log.current.scrollHeight;
    if (snapshot.messages.at(-1)?.approval || snapshot.messages.at(-1)?.weatherAttribution) log.current.querySelector('.message:last-of-type')?.scrollIntoView({ block: 'start', inline: 'nearest' });
  }, [scrollKey]);
  const foreignApproval = snapshot.approvalOwner !== null && snapshot.approvalOwner !== session.owner;
  return <section className={`conversation shared-conversation ${compact ? 'compact-conversation' : ''}`} aria-labelledby={`${session.owner}-conversation-title`}>
    <div className="conversation-heading"><div><p className="eyebrow">CANAL / TEXTO</p><h2 id={`${session.owner}-conversation-title`}>Conversa</h2></div><button ref={closeRef} className="panel-close" onClick={close} aria-label="Fechar conversa">×</button></div>
    <div className="conversation-meta"><label><input type="checkbox" checked={snapshot.intelligenceEnabled} disabled={busy} onChange={event => void session.setIntelligenceEnabled(event.target.checked)} /> {compact ? 'Inteligência' : 'Inteligência · assistente'}</label><button className="text-action" aria-label="Limpar conversa" disabled={snapshot.status === 'executing'} onClick={() => void session.clear()}>{compact ? 'Limpar' : 'Limpar conversa'}</button></div>
    <p className="conversation-operation" role="status" data-conversation-status={snapshot.status}>{conversationStatus[snapshot.status]}{foreignApproval && ` · Confirme na ${snapshot.approvalOwner === 'dashboard' ? 'Central' : 'janela flutuante'} de origem.`}</p>
    <div ref={log} className="conversation-log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Mensagens da conversa">{!snapshot.messages.length && <p className="conversation-empty">Continue sua conversa por esta janela ou pela Central.</p>}{snapshot.messages.map(message => <article key={message.id} className={`message message-${message.role === 'user' ? 'user' : 'jarvis'}`}><span className="message-author">{message.role === 'user' ? 'VOCÊ' : 'JARVIS'}</span>{message.responseKind && <p className="message-provenance">{responseLabels[message.responseKind]}</p>}<p className="intelligence-message">{message.text}</p>
      {message.weatherAttribution && <p className="weather-attribution" aria-label="Fontes dos dados meteorológicos">{weatherSources.map(source => <a key={source.id} href={source.url} onClick={event => { event.preventDefault(); void openWeatherSource(source.id).catch(() => onError('Não consegui confirmar a abertura da fonte no navegador.')); }}>{source.label}{' '}</a>)}</p>}
      {message.approval && <div className="conversation-approval" role="group" aria-label="Aprovação da operação apresentada"><button type="button" disabled={busy || foreignApproval} onClick={() => onDecision(message.approval!.id, true)}>{message.approval.destructive ? 'Confirmar exclusão' : 'Aplicar alteração'}</button><button type="button" disabled={busy || foreignApproval} onClick={() => onDecision(message.approval!.id, false)}>Cancelar</button></div>}
    </article>)}</div><p className="conversation-footnote">Sessão compartilhada · contexto temporário neste processo.</p>
  </section>;
}
