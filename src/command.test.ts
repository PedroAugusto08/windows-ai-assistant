import { describe, expect, it } from 'vitest';
import { demoReply } from './command';

describe('comandos locais de demonstração', () => {
  it('abre a agenda com maiúsculas e acentos', () => {
    expect(demoReply('  PRÓXIMOS COMPROMISSOS  ').panel).toBe('agenda');
    expect(demoReply('abrir agenda').text).toContain('fictícios');
  });
  it('abre tarefas reais e mantém sistema demonstrativo', () => {
    expect(demoReply('minhas prioridades').panel).toBe('tasks');
    expect(demoReply('criar tarefa comprar pão').panel).toBe('chat');
    expect(demoReply('resumo do sistema').text).toContain('Não estou monitorando');
  });
  it('mantém textos desconhecidos na conversa sem alegar execução', () => {
    expect(demoReply('apague meus arquivos')).toEqual(expect.objectContaining({ panel: 'chat', text: expect.stringContaining('Não executei') }));
    expect(demoReply('agendamento')).toEqual(expect.objectContaining({ panel: 'chat' }));
  });
});
