import type { IntelligenceParameters } from './intelligence';

export type QueryPeriod = NonNullable<IntelligenceParameters['queryPeriod']>;
export const calendarDate = (d: Date) => `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function parseCalendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setFullYear(year, month - 1, day); date.setHours(12, 0, 0, 0);
  return year >= 1 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
export function queryPeriodBounds(period: QueryPeriod, now: Date, anchor?: string | null): [string, string] {
  const start = period === 'week_of_date' ? anchor && parseCalendarDate(anchor) : new Date(now);
  if (!start) throw new Error('Semana sem data válida.');
  start.setHours(12, 0, 0, 0);
  if (period === 'tomorrow') start.setDate(start.getDate() + 1);
  if (['this_week', 'next_week', 'week_of_date'].includes(period)) start.setDate(start.getDate() - (start.getDay() + 6) % 7 + (period === 'next_week' ? 7 : 0));
  const end = new Date(start);
  if (['this_week', 'next_week', 'week_of_date'].includes(period)) end.setDate(end.getDate() + 6);
  return [calendarDate(start), calendarDate(end)];
}
export function queryBounds(p: IntelligenceParameters, now: Date): [string, string] | null {
  return p.queryPeriod ? queryPeriodBounds(p.queryPeriod, now, p.dueDate) : p.dueDate ? [p.dueDate, p.dueDate] : null;
}
type PeriodRequest = { parameters?: Pick<IntelligenceParameters, 'queryPeriod' | 'dueDate'>; clarification?: string; onlyPeriod: boolean };
const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const monthNames = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const weekPrefix = '\\bsemana (?:do dia|de|do|que contem(?: o dia)?) ';
// Only calendar weeks and their short follow-ups are parsed here; no free intervals.
export function readQueryPeriod(message: string, now: Date, previous: IntelligenceParameters | null): PeriodRequest | null {
  const text = normalize(message);
  const following = /\bsemana seguinte\b/.exec(text);
  const dateMatch = new RegExp(weekPrefix + '(\\d{4}) (\\d{1,2}) (\\d{1,2})\\b').exec(text)
    ?? new RegExp(weekPrefix + '(\\d{1,2})(?: (\\d{1,2})(?: (\\d{4}))?| de (' + monthNames.join('|') + ')(?: de (\\d{4}))?)?\\b').exec(text);
  const relative = /\b(proxima semana|semana que vem|(?:esta|essa|nesta|nessa) semana|amanha|hoje)\b/.exec(text);
  const match = following ?? dateMatch ?? relative;
  if (!match) return null;
  const rest = normalize(text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length));
  const onlyPeriod = /^(?:(?:e|para|agora|so|somente|na|no|a|da|do|nessa|nesta) ?)*$/.test(rest);
  const clarify = (clarification: string): PeriodRequest => ({ clarification, onlyPeriod });
  if (following) {
    const bounds = previous && queryBounds(previous, now);
    if (!bounds) return clarify('A semana seguinte a qual data, senhor?');
    const next = parseCalendarDate(bounds[0])!;
    next.setDate(next.getDate() - (next.getDay() + 6) % 7 + 7);
    return { parameters: { queryPeriod: 'week_of_date', dueDate: calendarDate(next) }, onlyPeriod };
  }
  if (dateMatch) {
    let year: number | undefined, month: number | undefined, day: number;
    if (dateMatch[1].length === 4) [year, month, day] = dateMatch.slice(1, 4).map(Number);
    else {
      day = Number(dateMatch[1]); month = dateMatch[2] ? Number(dateMatch[2]) : dateMatch[4] ? monthNames.indexOf(dateMatch[4]) + 1 : undefined;
      year = dateMatch[3] || dateMatch[5] ? Number(dateMatch[3] || dateMatch[5]) : undefined;
    }
    const bounds = previous && queryBounds(previous, now);
    const explicit = previous?.dueDate && parseCalendarDate(previous.dueDate);
    const base = explicit || (bounds ? parseCalendarDate(bounds[0])! : now);
    if (!month && bounds && !explicit && bounds[0].slice(0, 7) !== bounds[1].slice(0, 7)) return clarify('De qual mês e ano é essa semana, senhor?');
    if (!year && bounds && !explicit && bounds[0].slice(0, 4) !== bounds[1].slice(0, 4)) return clarify('De qual ano é essa data, senhor?');
    if (!year && month && Math.abs(month - (base.getMonth() + 1)) > 6) return clarify('De qual ano é essa data, senhor?');
    year ??= base.getFullYear(); month ??= base.getMonth() + 1;
    const anchor = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!parseCalendarDate(anchor)) return clarify('Essa data não existe no calendário, senhor. Qual data deseja consultar?');
    return { parameters: { queryPeriod: 'week_of_date', dueDate: anchor }, onlyPeriod };
  }
  const period: QueryPeriod = ['proxima semana', 'semana que vem'].includes(relative![1]) ? 'next_week' : relative![1] === 'hoje' ? 'today' : relative![1] === 'amanha' ? 'tomorrow' : 'this_week';
  return { parameters: { queryPeriod: period, dueDate: null }, onlyPeriod };
}
