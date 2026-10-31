import { describe, expect, it, vi } from 'vitest';
import { shouldTick } from './activity';
import { configureClock } from './clock';
describe('atividade não essencial', () => {
  it('só permite atividade com janela visível e modo normal', () => {
    for (const economy of [false, true]) for (const nativeVisible of [false, true]) for (const pageVisible of [false, true]) {
      expect(shouldTick(economy, nativeVisible, pageVisible)).toBe(!economy && nativeVisible && pageVisible);
    }
  });
  it('suspende e retoma o relógio sem deixar timers após limpeza', () => {
    vi.useFakeTimers();
    const update = vi.fn();
    const stop = configureClock(true, update);
    vi.advanceTimersByTime(2000);
    expect(update).toHaveBeenCalledTimes(3);
    stop();
    configureClock(false, update)();
    vi.advanceTimersByTime(2000);
    expect(update).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    const resume = configureClock(true, update);
    expect(update).toHaveBeenCalledTimes(4);
    resume();
    vi.useRealTimers();
  });
});
