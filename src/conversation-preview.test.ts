import { expect, it } from 'vitest';
import { createConversationPreview } from './conversation-preview';
import type { BeginTurn, ConversationSnapshot } from './conversation-session';

it('keeps web demonstrations usable and page-local without exposing a desktop effect', async () => {
  const first = createConversationPreview('dashboard'), second = createConversationPreview('assistant');
  const begin = await first.call<BeginTurn>('conversation_begin', { expectedRevision: 0, action: { kind: 'demo', text: 'minhas tarefas', intelligenceEnabled: false } });
  expect(begin.snapshot.intelligenceEnabled).toBe(false);
  await expect(first.call('conversation_effect', { token: begin.token, operation: 'approve_operation' })).rejects.toMatchObject({ code: 'preview_only' });
  const finished = await first.call<ConversationSnapshot>('conversation_finish', { token: begin.token, result: { text: 'Demonstração; nenhuma ação executada.' } });
  expect(finished.messages).toHaveLength(2);
  expect((await second.call<ConversationSnapshot>('conversation_snapshot')).messages).toHaveLength(0);
  const next = await first.call<BeginTurn>('conversation_begin', { expectedRevision: finished.revision, action: { kind: 'demo', text: 'agenda' } });
  expect(next.snapshot.intelligenceEnabled).toBe(false);
});
