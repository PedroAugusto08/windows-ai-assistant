import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureSignal, normalizeIntensity, simulatedIntensity } from './core-state';

afterEach(() => vi.useRealTimers());

describe('sinal visual simulado', () => {
  it('normaliza intensidades externas inválidas antes da renderização', () => {
    expect([-1, 0, .5, 1, 2, NaN, Infinity].map(normalizeIntensity)).toEqual([0, 0, .5, 1, 1, 0, 0]);
  });

  it('produz escuta e fala variáveis, determinísticas e limitadas pela intensidade', () => {
    for (const state of ['listening', 'speaking'] as const) {
      const samples = Array.from({ length: 100 }, (_, i) => simulatedIntensity(i / 20, state, .7));
      expect(Math.max(...samples)).toBeLessThanOrEqual(.7);
      expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
      expect(new Set(samples).size).toBeGreaterThan(50);
      expect(simulatedIntensity(1, state, 0)).toBe(0);
      expect(simulatedIntensity(1, state, .4)).toBe(simulatedIntensity(1, state, .8) / 2);
    }
    for (const state of ['available', 'processing', 'economy'] as const) {
      expect(simulatedIntensity(1, state, 1)).toBe(0);
    }
  });


  it('escuta respira devagar sem pulsos fortes ou regulares', () => {
    const samples = Array.from({ length: 400 }, (_, i) => simulatedIntensity(i / 20, 'listening', 1));
    const changes = samples.slice(1).map((sample, index) => Math.abs(sample - samples[index]));
    const sharpChanges = changes.filter(change => change > 0.15);
    expect(Math.min(...samples)).toBeGreaterThan(.25);
    expect(Math.max(...samples)).toBeLessThan(.7);
    expect(Math.max(...changes)).toBeLessThan(.04);
    expect(sharpChanges).toHaveLength(0);
  });

  it('fala em grupos silábicos de alturas variadas, com pausas naturais e padrão estável', () => {
    const samples = Array.from({ length: 560 }, (_, i) => simulatedIntensity(i / 20, 'speaking', 1));
    const pauses = samples.filter(sample => sample < .015);
    expect(Math.max(...samples)).toBeGreaterThan(.65);
    expect(pauses.length).toBeGreaterThan(60);
    expect(pauses.length).toBeLessThan(320);
    expect(samples).toEqual(Array.from({ length: 560 }, (_, i) => simulatedIntensity(i / 20, 'speaking', 1)));
    expect(samples.some((sample, i) => sample > .5 && samples[i + 1] < .1)).toBe(true);
  });

  it('não agenda trabalho quando suspenso ou fora dos estados de sinal', () => {
    vi.useFakeTimers();
    const update = vi.fn();
    for (const state of ['available', 'processing', 'economy'] as const) configureSignal(true, state, 1, update)();
    for (const state of ['listening', 'speaking'] as const) configureSignal(false, state, 1, update)();
    configureSignal(true, 'speaking', 0, update)();
    expect(vi.getTimerCount()).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('limita a frequência, cancela ao suspender e retoma sem acumular timers', () => {
    vi.useFakeTimers();
    const update = vi.fn();
    const stop = configureSignal(true, 'speaking', .8, update);
    vi.advanceTimersByTime(1000);
    expect(update).toHaveBeenCalledTimes(21);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    vi.advanceTimersByTime(1000);
    expect(update).toHaveBeenCalledTimes(21);
    expect(vi.getTimerCount()).toBe(0);
    const resume = configureSignal(true, 'listening', .8, update);
    expect(vi.getTimerCount()).toBe(1);
    resume();
    expect(vi.getTimerCount()).toBe(0);
  });
});
