import { describe, expect, it, vi } from 'vitest';
import { IntelligenceSession, intelligenceFailure, localClock, previewText, type IntelligenceParameters, type IntelligencePreview, type IntelligenceTransport } from './intelligence';
const params: IntelligenceParameters = { title: 'Estudar', priority: null, project: null, dueDate: '2026-10-09', dueTime: null, target: null, panel: null };
function preview(patch: Partial<IntelligencePreview['interpretation']> = {}): IntelligencePreview {
  return { dryRun: true, executed: false, model: 'gemini-3.5-flash-lite', latencyMs: 50, requestCount: 1, promptTokens: 100, outputTokens: 40,
    interpretation: { intent: 'create_task', parameters: { ...params }, reply: 'Interpretei a tarefa.', clarification: null, requiresConfirmation: false, usesPreviousDraft: false, ...patch } };
}
describe('inteligência em dry-run', () => {
  it('encaminha o rascunho nas três mensagens sem enviar tarefas reais', async () => {
    const transport = vi.fn<IntelligenceTransport>().mockResolvedValueOnce(preview()).mockResolvedValueOnce(preview({ usesPreviousDraft: true, parameters: { ...params, dueTime: '19:00' } })).mockResolvedValueOnce(preview({ usesPreviousDraft: true, parameters: { ...params, dueTime: '19:00', priority: 'high' } }));
    const session = new IntelligenceSession(transport);
    await session.interpret('Tenho que estudar amanhã.'); await session.interpret('Coloca para as 19h.');
    const result = await session.interpret('E prioridade alta.');
    expect(transport.mock.calls[1][0].previousDraft).toEqual(params);
    expect(transport.mock.calls[2][0].previousDraft).toEqual({ ...params, dueTime: '19:00' });
    expect(transport.mock.calls[2][0].context).toEqual(['Tenho que estudar amanhã.', 'Coloca para as 19h.']);
    expect(Object.keys(transport.mock.calls[0][0]).sort()).toEqual(['message', 'context', 'previousDraft', 'localNow', 'timeZone'].sort());
    expect(result?.interpretation.parameters.priority).toBe('high'); expect(result?.executed).toBe(false);
  });
  it('limita contexto a seis turnos e limpa rascunho ao mudar de assunto', async () => {
    const transport = vi.fn<IntelligenceTransport>().mockResolvedValue(preview({ intent: 'conversation' }));
    const session = new IntelligenceSession(transport);
    for (let i = 0; i < 9; i++) await session.interpret(`mensagem ${i}`);
    expect(transport.mock.calls[8][0].context).toEqual(['mensagem 2', 'mensagem 3', 'mensagem 4', 'mensagem 5', 'mensagem 6', 'mensagem 7']);
    expect(transport.mock.calls[8][0].previousDraft).toBeNull();
    session.clear(); await session.interpret('coloca às 19h'); expect(transport.mock.calls[9][0].context).toEqual([]);
  });
  it('expira contexto em quinze minutos', async () => {
    let now = 1000; const transport = vi.fn<IntelligenceTransport>().mockResolvedValue(preview());
    const session = new IntelligenceSession(transport, () => now);
    await session.interpret('Estudar amanhã'); now += 16 * 60_000; await session.interpret('às 19h');
    expect(transport.mock.calls[1][0].previousDraft).toBeNull(); expect(transport.mock.calls[1][0].context).toEqual([]);
  });
  it('descarta resposta pendente depois de limpar e impede envio duplicado', async () => {
    let resolve!: (p: IntelligencePreview) => void;
    const transport = vi.fn<IntelligenceTransport>().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(preview());
    const session = new IntelligenceSession(transport); const pending = session.interpret('Estudar');
    await expect(session.interpret('Duplicado')).rejects.toMatchObject({ code: 'busy' });
    session.clear(); resolve(preview()); expect(await pending).toBeNull();
    await session.interpret('Outra'); expect(transport.mock.calls[1][0].previousDraft).toBeNull();
  });
  it('preserva contexto após erro, sem retentar nem registrar mensagem falha', async () => {
    const transport = vi.fn<IntelligenceTransport>().mockResolvedValueOnce(preview()).mockRejectedValueOnce({ code: 'timeout' }).mockResolvedValueOnce(preview());
    const session = new IntelligenceSession(transport); await session.interpret('Estudar');
    await expect(session.interpret('às 19h')).rejects.toMatchObject({ code: 'timeout' }); await session.interpret('prioridade alta');
    expect(transport).toHaveBeenCalledTimes(3); expect(transport.mock.calls[2][0].context).toEqual(['Estudar']);
  });
  it('recusa envelopes de execução e entradas fora dos limites', async () => {
    const transport = vi.fn<IntelligenceTransport>().mockResolvedValue({ ...preview(), executed: true } as unknown as IntelligencePreview);
    const session = new IntelligenceSession(transport);
    await expect(session.interpret('x')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(session.interpret('x'.repeat(1001))).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('representa relógio local com offset, sem converter o dia para UTC', () => {
    const now = new Date(2026, 11, 31, 23, 30, 0);
    const clock = localClock(now);
    expect(clock.localNow).toMatch(/^2026-12-31T23:30:00[+-]\d{2}:\d{2}$/);
    expect(new Date(clock.localNow).getTime()).toBe(now.getTime());
    expect(clock.timeZone).toBeTruthy();
  });
  it('sanitiza falhas e explica confirmação sem alegar execução', () => {
    expect(intelligenceFailure('secret')).toEqual({ code: 'unknown', message: 'Não foi possível interpretar o comando.', retryAfterSeconds: null });
    expect(intelligenceFailure({ code: 'rate_limit', message: 'secret', retryAfterSeconds: 60 })).toMatchObject({ retryAfterSeconds: 60 });
    expect(intelligenceFailure({ code: 'network', message: 'secret' }).message).not.toContain('secret');
    const text = previewText(preview({ intent: 'delete_task', requiresConfirmation: true }));
    expect(text).toContain('Nenhuma ação executada'); expect(text).toContain('Confirmação necessária');
  });
  it('prévia web não envia solicitações à API', async () => {
    await expect(new IntelligenceSession().interpret('Estudar')).rejects.toMatchObject({ code: 'preview_only' });
  });
});
