export type ContextPanel = 'chat' | 'agenda' | 'tasks' | null;

// Correspondência local e explícita; nunca executa ações desktop.
export function demoReply(command: string): { panel: Exclude<ContextPanel, null>; text: string } {
  const normalized = command.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/\b(agenda|compromissos)\b/.test(normalized)) return { panel: 'agenda', text: 'Esta é sua agenda de exemplo. Os três compromissos são fictícios; nenhum evento foi consultado ou criado.' };
  if (/\b(tarefas|prioridades)\b/.test(normalized)) return { panel: 'tasks', text: 'Suas tarefas locais estão no painel. Use Nova tarefa para criar; o campo de comando não cria tarefas.' };
  if (/\b(sistema|cpu|memoria)\b/.test(normalized)) return { panel: 'chat', text: 'O painel mostra CPU em 8% e memória em 7 de 16 GB apenas como exemplos visuais. Não estou monitorando o computador.' };
  return { panel: 'chat', text: 'Recebi seu texto nesta demonstração. Experimente “abrir agenda”, “minhas prioridades” ou “resumo do sistema”. Não executei nenhuma ação no computador.' };
}
