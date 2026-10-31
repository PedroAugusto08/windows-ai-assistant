import { useEffect, useSyncExternalStore } from 'react';
import { conversationSession, conversationStatus } from './conversation-session';

export function useConversation() {
  const state = useSyncExternalStore(conversationSession.subscribe, conversationSession.getState);
  useEffect(() => {
    void conversationSession.refresh();
    const refresh = () => { if (!document.hidden) void conversationSession.refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const busy = state.submitting || state.snapshot.status === 'processing' || state.snapshot.status === 'executing';
  const last = state.snapshot.messages.at(-1);
  const feedback = state.snapshot.status === 'awaiting_approval' ? 'Revise a operação na conversa. Confirme na janela de origem.'
    : last?.responseKind === 'general_answer' ? 'Resposta disponível na conversa.'
    : last?.responseKind === 'clarification' ? 'Responda ao esclarecimento na conversa.'
    : last?.responseKind === 'proposal' ? 'Confira a proposta no painel Executor.'
    : last?.responseKind === 'unavailable' ? 'Confira o estado do pedido na conversa.'
    : last?.weatherAttribution ? 'Consulta meteorológica disponível na conversa, com fontes.'
    : last && last.text.length > 180 ? 'Resultado disponível na conversa.'
    : last?.text ?? 'Conversa pronta. Envie um pedido pelo campo de comando.';
  return { ...state, busy, session: conversationSession, statusLabel: conversationStatus[state.snapshot.status],
    feedback: state.error || (busy ? conversationStatus[state.snapshot.status] : feedback),
  };
}
