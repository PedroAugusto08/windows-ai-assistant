import type { ConversationSnapshot, SessionAction, SessionTransport, BeginTurn } from './conversation-session';

/** Web-only demonstration: local to this page, never substitutes for Rust acceptance. */
export function createConversationPreview(owner: string): SessionTransport {
  let snapshot: ConversationSnapshot = { revision: 0, generation: 0, messages: [], status: 'idle', activeOwner: null, approvalOwner: null, contextOwner: null, authorityOwner: null, intelligenceEnabled: true, context: null };
  const listeners = new Set<(value: ConversationSnapshot) => void>();
  let activeToken: string | null = null;
  let sequence = 0;
  const publish = () => { snapshot = { ...snapshot, revision: snapshot.revision + 1 }; listeners.forEach(callback => callback(structuredClone(snapshot))); return structuredClone(snapshot); };
  return {
    subscribe: async callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    async call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      if (command === 'conversation_attach' || command === 'conversation_snapshot') return structuredClone(snapshot) as T;
      if (command === 'conversation_effect') throw { code: 'preview_only', message: '' };
      if (command === 'conversation_clear') {
        if (args.expectedRevision !== snapshot.revision) throw Error('Preview revision conflict');
        activeToken = null;
        snapshot = { ...snapshot, generation: snapshot.generation + 1, messages: [], status: 'idle', activeOwner: null, context: null };
        return publish() as T;
      }
      if (command === 'conversation_begin') {
        const action = args.action as SessionAction;
        if (activeToken || args.expectedRevision !== snapshot.revision || !['send', 'demo'].includes(action.kind)) throw Error('Preview turn unavailable');
        activeToken = `preview:${++sequence}`;
        snapshot = { ...snapshot, status: 'processing', activeOwner: owner, intelligenceEnabled: action.intelligenceEnabled ?? snapshot.intelligenceEnabled,
          messages: [...snapshot.messages, { id: `${activeToken}:user`, role: 'user' as const, text: action.text ?? '' }].slice(-60) };
        return { token: activeToken, context: null, snapshot: publish(), replayed: false } as BeginTurn as T;
      }
      if (command === 'conversation_finish') {
        if (!activeToken || args.token !== activeToken) throw Error('Preview turn expired');
        const result = args.result as { text: string };
        snapshot = { ...snapshot, status: 'idle', activeOwner: null, context: null,
          messages: [...snapshot.messages, { id: `${activeToken}:assistant`, role: 'assistant' as const, text: result.text }].slice(-60) };
        activeToken = null;
        return publish() as T;
      }
      throw Error('Desktop capability unavailable in the web preview');
    },
  };
}
