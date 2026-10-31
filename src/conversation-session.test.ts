import { describe, expect, it, vi } from 'vitest';
import type { AssistantResult } from './assistant-conversation';
import { AssistantConversation } from './assistant-conversation';
import type { BeginTurn, ConversationSnapshot, EngineFactory, SessionTransport } from './conversation-session';

vi.hoisted(() => { Object.defineProperty(globalThis, 'location', { value: { search: '' }, configurable: true }); });
import { ConversationSession } from './conversation-session';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const snapshot = (patch: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
  revision: 0, generation: 0, messages: [{ id: 'greeting', role: 'assistant', text: 'Olá.' }],
  status: 'idle', activeOwner: null, approvalOwner: null, contextOwner: null, authorityOwner: null,
  intelligenceEnabled: true, context: null, ...patch,
});
const begin = (patch: Partial<BeginTurn> = {}): BeginTurn => ({ token: 'turn-1', snapshot: snapshot({ revision: 1, status: 'processing', activeOwner: 'dashboard' }), context: null, replayed: false, ...patch });
const context = () => new AssistantConversation().exportContext();
const engine = (send = vi.fn().mockResolvedValue({ text: 'Resposta.' })): ReturnType<EngineFactory> => ({
  importContext: vi.fn(), exportContext: vi.fn(context), send,
  approve: vi.fn().mockResolvedValue({ text: 'Aprovação.' }), cancelApproval: vi.fn().mockResolvedValue({ text: 'Cancelamento.' }),
});
function transport(handler: (command: string, args?: Record<string, unknown>) => Promise<unknown> | unknown, attach: (args?: Record<string, unknown>) => Promise<unknown> | unknown = () => snapshot()) {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  let event: ((value: ConversationSnapshot) => void) | undefined;
  const wire: SessionTransport = {
    call: async <T,>(command: string, args?: Record<string, unknown>) => { calls.push({ command, args }); return await (command === 'conversation_attach' ? attach(args) : handler(command, args)) as T; },
    subscribe: vi.fn(async callback => { event = callback; return vi.fn(); }),
  };
  return { wire, calls, emit: (value: ConversationSnapshot) => { event?.(value); } };
}

describe('conversation session subscribers', () => {
  it('subscribes before reading and ignores snapshots/events older than the accepted revision', async () => {
    const firstRead = deferred<ConversationSnapshot>(); let subscribed = false;
    const wire = transport(command => {
      expect(command).toBe('conversation_snapshot'); expect(subscribed).toBe(true); return firstRead.promise;
    }, () => { expect(subscribed).toBe(true); return snapshot(); });
    const originalSubscribe = wire.wire.subscribe;
    wire.wire.subscribe = async callback => { subscribed = true; return originalSubscribe(callback); };
    const session = new ConversationSession(wire.wire, 'dashboard'); const started = session.refresh();
    await vi.waitFor(() => expect(wire.calls).toHaveLength(2));
    expect(wire.calls.map(value => value.command)).toEqual(['conversation_attach', 'conversation_snapshot']);
    wire.emit(snapshot({ revision: 5, messages: [{ id: 'latest', role: 'assistant', text: 'Mais recente.' }] }));
    firstRead.resolve(snapshot({ revision: 1 })); await started;
    wire.emit(snapshot({ revision: 2 }));
    expect(session.getState().snapshot.revision).toBe(5); expect(session.getState().snapshot.messages[0].id).toBe('latest');
    expect(session.getState().ready).toBe(true);
  });

  it('keeps independent UI subscribers synchronized and does not duplicate their subscriptions on refresh', async () => {
    const listeners = new Set<(value: ConversationSnapshot) => void>(); let current = snapshot(); let subscriptions = 0; let reads = 0;
    const attachments: string[] = [];
    const wire: SessionTransport = {
      subscribe: async callback => { subscriptions++; listeners.add(callback); return () => { listeners.delete(callback); }; },
      call: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command === 'conversation_attach') { attachments.push(args?.clientId as string); return current as T; }
        expect(command).toBe('conversation_snapshot'); reads++; return current as T;
      },
    };
    const central = new ConversationSession(wire, 'dashboard'); const floating = new ConversationSession(wire, 'assistant');
    const centralChanged = vi.fn(); const floatingChanged = vi.fn(); central.subscribe(centralChanged); floating.subscribe(floatingChanged);
    await Promise.all([central.refresh(), floating.refresh()]); await central.refresh();
    expect(subscriptions).toBe(2); expect(reads).toBe(3); expect(attachments).toHaveLength(2); expect(new Set(attachments).size).toBe(2);
    current = snapshot({ revision: 8, status: 'executing', activeOwner: 'assistant' }); listeners.forEach(callback => callback(current));
    expect(central.getState().snapshot).toEqual(floating.getState().snapshot);
    expect(centralChanged).toHaveBeenCalled(); expect(floatingChanged).toHaveBeenCalled();
    await floating.refresh(); expect(subscriptions).toBe(2); expect(attachments).toHaveLength(2); expect(floating.getState().snapshot.revision).toBe(8);
  });

  it('keeps equal-revision snapshots stable when focus refreshes an unchanged conversation', async () => {
    const current = snapshot({ revision: 4 });
    const wire = transport(() => structuredClone(current), () => structuredClone(current));
    const session = new ConversationSession(wire.wire, 'dashboard'); await session.refresh();
    const accepted = session.getState().snapshot;
    const updated = vi.fn(); session.subscribe(updated);
    await session.refresh(); wire.emit(structuredClone(current));
    expect(session.getState().snapshot).toBe(accepted);
    expect(session.getState().snapshot.messages).toBe(accepted.messages);
    expect(updated).not.toHaveBeenCalled();
  });

  it('becomes ready after a successful attach even when a newer event preceded its older snapshot', async () => {
    const attached = deferred<ConversationSnapshot>();
    const wire = transport(command => command === 'conversation_snapshot' ? snapshot({ revision: 1 }) : snapshot(), () => attached.promise);
    const session = new ConversationSession(wire.wire, 'dashboard'); const pending = session.refresh();
    await vi.waitFor(() => expect(wire.calls.some(call => call.command === 'conversation_attach')).toBe(true));
    wire.emit(snapshot({ revision: 5 })); expect(session.getState().ready).toBe(false);
    attached.resolve(snapshot({ revision: 1 })); await pending;
    expect(session.getState().snapshot.revision).toBe(5); expect(session.getState().ready).toBe(true);
  });

  it('surfaces a synchronization failure without claiming the session is ready', async () => {
    const wire = transport(() => { throw Error('Private connection detail'); }, () => { throw Error('Private connection detail'); }); const session = new ConversationSession(wire.wire, 'dashboard');
    await session.refresh(); await session.send('Não enviar');
    expect(session.getState().ready).toBe(false); expect(session.getState().error).toContain('sincronizar');
    expect(session.getState().error).not.toContain('Private'); expect(wire.calls.map(value => value.command)).toEqual(['conversation_attach']);
  });

  it('attaches again after reload with a new instance id, but not on focus refresh of the same client', async () => {
    const wire = transport(() => snapshot());
    const first = new ConversationSession(wire.wire, 'dashboard'); await first.refresh(); await first.refresh();
    const reloaded = new ConversationSession(wire.wire, 'dashboard'); await reloaded.refresh(); await reloaded.refresh();
    const attaches = wire.calls.filter(value => value.command === 'conversation_attach');
    expect(attaches).toHaveLength(2); expect(attaches[0].args?.clientId).not.toBe(attaches[1].args?.clientId);
    for (const call of attaches) expect(call.args?.clientId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('coalesces concurrent initial refreshes into one attach for a client', async () => {
    const attached = deferred<ConversationSnapshot>(); let attaches = 0;
    const wire = transport(() => snapshot(), () => { attaches++; return attached.promise; });
    const session = new ConversationSession(wire.wire, 'dashboard'); const first = session.refresh(); const second = session.refresh();
    await vi.waitFor(() => expect(attaches).toBeGreaterThan(0));
    const attachCountBeforeResolution = attaches; attached.resolve(snapshot()); await Promise.all([first, second]);
    expect(attachCountBeforeResolution).toBe(1);
  });

  it('does not become ready when an event arrives before a failed attach', async () => {
    const attached = deferred<ConversationSnapshot>(); const wire = transport(() => snapshot(), () => attached.promise);
    const session = new ConversationSession(wire.wire, 'dashboard'); const refreshing = session.refresh();
    await vi.waitFor(() => expect(wire.calls.some(value => value.command === 'conversation_attach')).toBe(true));
    wire.emit(snapshot({ revision: 8 })); attached.reject(Error('Attach denied')); await refreshing;
    expect(session.getState().ready).toBe(false);
    wire.emit(snapshot({ revision: 9 })); expect(session.getState().ready).toBe(false);
    await session.send('Não deve iniciar antes de attach'); expect(wire.calls.some(value => value.command === 'conversation_begin')).toBe(false);
  });
});

describe('conversation session turns', () => {
  it('recovers a lost accepted begin response by replaying its exact request and finishing without effects', async () => {
    let current = snapshot(); let attempts = 0;
    const factory = vi.fn<EngineFactory>();
    const wire = transport((command, args) => {
      if (command === 'conversation_snapshot') return current;
      if (command === 'conversation_begin') {
        attempts++;
        if (attempts === 1) { current = begin().snapshot; throw Error('Response lost after acceptance'); }
        return begin({ replayed: true, snapshot: current });
      }
      if (command === 'conversation_finish') {
        expect(args?.token).toBe('turn-1'); expect(args?.context).toBeNull();
        expect((args?.result as { text: string }).text).toMatch(/não consegui confirmar|interrompid/i);
        current = snapshot({ revision: 2, messages: [{ id: 'interrupted', role: 'assistant', text: (args?.result as { text: string }).text }] });
        return current;
      }
      throw Error('Unexpected command');
    });
    const session = new ConversationSession(wire.wire, 'dashboard', factory, () => '00000000-0000-4000-8000-000000000099');
    await session.refresh(); await session.send('Pedido aceito');
    const begins = wire.calls.filter(call => call.command === 'conversation_begin');
    expect(begins).toHaveLength(2); expect(begins[1].args).toEqual(begins[0].args);
    expect(begins[0].args).toEqual({ requestId: '00000000-0000-4000-8000-000000000099', expectedRevision: 0, action: { kind: 'send', text: 'Pedido aceito' } });
    expect(factory).not.toHaveBeenCalled();
    expect(wire.calls.some(call => call.command === 'conversation_effect')).toBe(false);
    expect(wire.calls.filter(call => call.command === 'conversation_finish')).toHaveLength(1);
    expect(session.getState().snapshot.status).toBe('idle');
    expect(session.getState().snapshot.messages[0].text).toMatch(/não consegui confirmar|interrompid/i);
  });

  it('never reexecutes an engine or effects when begin returns a replay receipt', async () => {
    const factory = vi.fn<EngineFactory>();
    const wire = transport(command => command === 'conversation_snapshot' ? snapshot() : begin({ replayed: true, snapshot: snapshot({ revision: 7, messages: [{ id: 'receipt', role: 'assistant', text: 'Resultado anterior.' }] }) }));
    const session = new ConversationSession(wire.wire, 'dashboard', factory, () => '00000000-0000-4000-8000-000000000001'); await session.refresh(); await session.send('Pedido');
    expect(factory).not.toHaveBeenCalled(); expect(wire.calls.map(value => value.command)).toEqual(['conversation_attach', 'conversation_snapshot', 'conversation_begin']);
    expect(session.getState().snapshot.messages[0].id).toBe('receipt'); expect(session.getState().submitting).toBe(false);
  });

  it('does not add optimistic messages or run an engine after a rejected begin', async () => {
    const initial = snapshot(); const factory = vi.fn<EngineFactory>();
    const wire = transport(command => { if (command === 'conversation_begin') throw Error('Revision conflict'); return initial; });
    const session = new ConversationSession(wire.wire, 'dashboard', factory, () => '00000000-0000-4000-8000-000000000001'); await session.refresh(); await session.send('Texto rejeitado');
    expect(session.getState().snapshot.messages).toEqual(initial.messages); expect(factory).not.toHaveBeenCalled();
    expect(wire.calls.map(value => value.command)).toEqual(['conversation_attach', 'conversation_snapshot', 'conversation_begin', 'conversation_begin', 'conversation_snapshot']);
    expect(wire.calls[2].args).toEqual({ requestId: '00000000-0000-4000-8000-000000000001', expectedRevision: 0, action: { kind: 'send', text: 'Texto rejeitado' } });
    expect(wire.calls[3].args).toEqual(wire.calls[2].args);
    expect(session.getState().error).not.toBe('');
  });

  it('imports committed context before processing and finishes with the exported context', async () => {
    const imported = context(); imported.activeCapability = 'weather'; const exported = context(); exported.activeCapability = 'browser_search';
    const instance = engine(vi.fn(async () => { expect(instance.importContext).toHaveBeenCalledWith(imported); return { text: 'Resultado.', panel: 'tasks', taskIds: [2] }; }));
    vi.mocked(instance.exportContext).mockReturnValue(exported);
    const factory = vi.fn<EngineFactory>().mockReturnValue(instance);
    const wire = transport(command => command === 'conversation_snapshot' ? snapshot() : command === 'conversation_begin' ? begin({ context: imported }) : snapshot({ revision: 2 }));
    const session = new ConversationSession(wire.wire, 'dashboard', factory); await session.refresh();
    expect(await session.send('Continuar')).toEqual({ panel: 'tasks', taskIds: [2] });
    expect(factory).toHaveBeenCalledTimes(1); expect(wire.calls.at(-1)).toEqual({ command: 'conversation_finish', args: { token: 'turn-1', context: exported, result: { text: 'Resultado.', panel: 'tasks', taskIds: [2], responseKind: 'tool_result' } } });
  });

  it.each([true, false])('routes explicit approval/cancellation to the accepted engine (apply=%s)', async apply => {
    const instance = engine(); const wire = transport(command => command === 'conversation_snapshot' ? snapshot({ status: 'awaiting_approval', approvalOwner: 'dashboard' }) : command === 'conversation_begin' ? begin() : snapshot({ revision: 2 }));
    const session = new ConversationSession(wire.wire, 'dashboard', () => instance); await session.refresh(); await session.decide('proposal-1', apply);
    expect(apply ? instance.approve : instance.cancelApproval).toHaveBeenCalledWith('proposal-1'); expect(instance.send).not.toHaveBeenCalled();
    expect(wire.calls[2].args?.action).toEqual({ kind: apply ? 'approve' : 'cancel', proposalId: 'proposal-1' });
    // The fixture grants the turn. Window ownership is enforced/tested by Rust, not established here.
  });

  it('serializes background cancellation before interpretation and drains outstanding effects before finishing', async () => {
    const firstCancel = deferred<unknown>(); const finalCancel = deferred<unknown>(); let cancellationCount = 0;
    const wire = transport((command, args) => {
      if (command === 'conversation_snapshot') return snapshot(); if (command === 'conversation_begin') return begin();
      if (command === 'conversation_effect') {
        if (args?.operation === 'cancel_operation') return ++cancellationCount === 1 ? firstCancel.promise : finalCancel.promise;
        return { interpreted: true };
      }
      return snapshot({ revision: 2 });
    });
    const factory: EngineFactory = effect => engine(vi.fn(async () => {
      void effect('cancel_operation', { proposalId: 'old' }).catch(() => {});
      await effect('interpret_assistant', { request: { message: 'Novo pedido' } });
      void effect('cancel_operation', { proposalId: 'obsolete' }).catch(() => {});
      return { text: 'Resposta.' };
    }));
    const session = new ConversationSession(wire.wire, 'dashboard', factory); await session.refresh(); const running = session.send('Novo pedido');
    await vi.waitFor(() => expect(cancellationCount).toBe(1));
    expect(wire.calls.filter(value => value.command === 'conversation_effect').map(value => value.args?.operation)).toEqual(['cancel_operation']);
    firstCancel.resolve(undefined); await vi.waitFor(() => expect(cancellationCount).toBe(2));
    expect(wire.calls.some(value => value.command === 'conversation_finish')).toBe(false);
    finalCancel.resolve(undefined); await running;
    expect(wire.calls.filter(value => value.command === 'conversation_effect').map(value => value.args?.operation)).toEqual(['cancel_operation', 'interpret_assistant', 'cancel_operation']);
    expect(wire.calls.at(-1)?.command).toBe('conversation_finish');
  });

  it('also drains outstanding effects before reporting an engine failure', async () => {
    const cancellation = deferred<unknown>(); let effectStarted = false;
    const wire = transport(command => {
      if (command === 'conversation_snapshot') return snapshot(); if (command === 'conversation_begin') return begin();
      if (command === 'conversation_effect') { effectStarted = true; return cancellation.promise; }
      return snapshot({ revision: 2 });
    });
    const factory: EngineFactory = effect => engine(vi.fn(async () => {
      void effect('cancel_operation', { proposalId: 'old' }).catch(() => {});
      throw Error('Engine failed after scheduling cancellation');
    }));
    const session = new ConversationSession(wire.wire, 'dashboard', factory); await session.refresh(); const running = session.send('Pedido');
    await vi.waitFor(() => expect(effectStarted).toBe(true));
    const finishedBeforeDrain = wire.calls.some(value => value.command === 'conversation_finish');
    cancellation.resolve(undefined); await running;
    expect(finishedBeforeDrain).toBe(false);
    expect(wire.calls.find(value => value.command === 'conversation_finish')?.args?.context).toBeNull();
  });

  it('keeps a newer cleared generation when an old engine finishes late and Rust rejects its token', async () => {
    const completion = deferred<AssistantResult>(); let current = snapshot();
    const wire = transport(command => {
      if (command === 'conversation_snapshot') return current;
      if (command === 'conversation_begin') { current = begin().snapshot; return begin(); }
      if (command === 'conversation_clear') { current = snapshot({ revision: 3, generation: 1, messages: [{ id: 'clean', role: 'assistant', text: 'Conversa limpa.' }] }); return current; }
      if (command === 'conversation_finish') throw Error('Revoked token');
      throw Error('Unexpected command');
    });
    const instance = engine(vi.fn(() => completion.promise)); const session = new ConversationSession(wire.wire, 'dashboard', () => instance);
    await session.refresh(); const pending = session.send('Pedido antigo'); await vi.waitFor(() => expect(instance.send).toHaveBeenCalled());
    await session.clear(); completion.resolve({ text: 'Resposta antiga.' }); await pending;
    expect(session.getState().snapshot.generation).toBe(1); expect(session.getState().snapshot.revision).toBe(3);
    expect(session.getState().snapshot.messages).toEqual([{ id: 'clean', role: 'assistant', text: 'Conversa limpa.' }]);
    expect(session.getState().submitting).toBe(false);
  });

  it('runs only the engine whose concurrent begin was accepted by the shared transport', async () => {
    const completion = deferred<AssistantResult>(); let current = snapshot(); let claimed = false; let begins = 0;
    const wire = transport(command => {
      if (command === 'conversation_snapshot') return current;
      if (command === 'conversation_begin') { begins++; if (claimed) throw Error('Busy'); claimed = true; current = begin().snapshot; return begin(); }
      if (command === 'conversation_finish') { current = snapshot({ revision: 2 }); return current; }
      throw Error('Unexpected command');
    });
    const centralFactory = vi.fn<EngineFactory>().mockReturnValue(engine(vi.fn(() => completion.promise))); const floatingFactory = vi.fn<EngineFactory>().mockReturnValue(engine());
    const central = new ConversationSession(wire.wire, 'dashboard', centralFactory); const floating = new ConversationSession(wire.wire, 'assistant', floatingFactory);
    await Promise.all([central.refresh(), floating.refresh()]);
    const a = central.send('Pedido A'); const b = floating.send('Pedido B');
    await vi.waitFor(() => expect(centralFactory).toHaveBeenCalledTimes(1)); completion.resolve({ text: 'Único resultado.' }); await Promise.all([a, b]);
    expect(begins).toBe(3); expect(floatingFactory).not.toHaveBeenCalled();
    expect(wire.calls.filter(value => value.command === 'conversation_finish')).toHaveLength(1);
    // This proves the client respects arbitration results; actual mutual exclusion belongs to Rust tests.
  });

  it('does not submit while processing elsewhere and shares the canonical demo mode without an engine', async () => {
    const factory = vi.fn<EngineFactory>(); let current = snapshot({ status: 'processing', activeOwner: 'assistant' });
    const wire = transport(command => command === 'conversation_snapshot' ? current : command === 'conversation_begin' ? begin({ snapshot: snapshot({ revision: 2, status: 'processing' }) }) : snapshot({ revision: 3, intelligenceEnabled: false }), () => current);
    const session = new ConversationSession(wire.wire, 'dashboard', factory); await session.refresh(); await session.send('Bloqueado');
    expect(wire.calls).toHaveLength(2); current = snapshot({ revision: 1 }); wire.emit(current);
    await session.setIntelligenceEnabled(false); expect(factory).not.toHaveBeenCalled(); expect(session.getState().snapshot.intelligenceEnabled).toBe(false);
    expect(wire.calls[2].args?.action).toEqual({ kind: 'demo', text: 'Demonstração local ativada.', intelligenceEnabled: false });
  });

  it.each(['sim', 'Pode ser', 'por favor', 'não', 'cancelar'])('keeps a foreign suggestion intact and directs "%s" to the origin', async text => {
    const shared = context(); shared.tasks.suggestion = { id: 1, revision: 3, kind: 'priority', expiresAt: Date.now() + 900_000 };
    const current = snapshot({ revision: 3, context: shared, authorityOwner: 'dashboard', contextOwner: 'dashboard' });
    const before = structuredClone(current); const factory = vi.fn<EngineFactory>();
    const wire = transport(() => current, () => current); const session = new ConversationSession(wire.wire, 'assistant', factory); await session.refresh();
    await session.send(text);
    expect(session.getState().error).toContain('Central'); expect(session.getState().error).toContain('origem');
    expect(wire.calls.map(value => value.command)).toEqual(['conversation_attach', 'conversation_snapshot']);
    expect(session.getState().snapshot).toEqual(before); expect(factory).not.toHaveBeenCalled();
  });

  it.each(['cancelar', 'não', 'confirmo excluir 1'])('keeps a staged foreign operation intact for "%s"', async text => {
    const shared = context(); shared.tasks.staged = {
      proposal: { proposalId: 'foreign-proposal', effect: { kind: 'delete_task', id: 1, input: null, expectedRevision: 3 }, before: null, expiresInSeconds: 900 },
      snapshot: { revision: 3, taskCount: 0, othersDigest: '0'.repeat(64) }, message: 'Excluir tarefa', restoring: false, expiresAt: Date.now() + 900_000,
    };
    const current = snapshot({ revision: 3, context: shared, authorityOwner: 'assistant', approvalOwner: 'assistant', contextOwner: 'assistant', status: 'awaiting_approval' });
    const before = structuredClone(current); const factory = vi.fn<EngineFactory>();
    const wire = transport(() => current, () => current); const session = new ConversationSession(wire.wire, 'dashboard', factory); await session.refresh(); await session.send(text);
    expect(session.getState().error).toContain('janela flutuante'); expect(session.getState().error).toContain('origem');
    expect(wire.calls.map(value => value.command)).toEqual(['conversation_attach', 'conversation_snapshot']);
    expect(session.getState().snapshot).toEqual(before); expect(factory).not.toHaveBeenCalled();
  });
});
