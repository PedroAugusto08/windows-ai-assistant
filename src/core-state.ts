export const coreStates = {
  available: { label: 'Disponível', description: 'Por perto, quando precisar.' },
  listening: { label: 'Escutando', description: 'Acompanhando um sinal simulado.' },
  processing: { label: 'Processando', description: 'Organizando uma solicitação fictícia.' },
  executing: { label: 'Executando', description: 'Aguardando o resultado real de uma operação.' },
  speaking: { label: 'Falando', description: 'Respondendo com intensidade simulada.' },
  economy: { label: 'Econômico', description: 'Movimento suspenso. Presença mantida.' },
} as const;

export type CoreState = keyof typeof coreStates;
export type DemoState = Exclude<CoreState, 'economy' | 'executing'>;

// Contrato normalizado para uma futura fonte de intensidade; não acessa áudio.
export function normalizeIntensity(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function createSpeechSyllables() {
  let seed = 0x4a415256;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const syllables: { start: number; duration: number; emphasis: number }[] = [];
  let time = 0;
  const loopDuration = 18;

  while (time < loopDuration) {
    const words = 4 + Math.floor(random() * 3);
    for (let word = 0; word < words; word += 1) {
      const count = 1 + Math.floor(random() * 3);
      for (let syllable = 0; syllable < count; syllable += 1) {
        const duration = 0.2 + random() * 0.11;
        syllables.push({ start: time, duration, emphasis: 0.55 + random() * 0.45 });
        time += duration;
        if (syllable < count - 1) time += 0.025 + random() * 0.045;
      }
      if (word < words - 1) time += 0.09 + random() * 0.14;
    }
    time += 0.32 + random() * 0.48;
  }

  return { duration: time, syllables };
}

const speechPattern = createSpeechSyllables();

function speechEnvelope(seconds: number) {
  const time = ((seconds % speechPattern.duration) + speechPattern.duration) % speechPattern.duration;
  for (const syllable of speechPattern.syllables) {
    if (time < syllable.start) break;
    const phase = (time - syllable.start) / syllable.duration;
    if (phase >= 0 && phase <= 1) return Math.pow(Math.sin(Math.PI * phase), 0.8) * syllable.emphasis;
  }
  return 0;
}

export function simulatedIntensity(seconds: number, state: CoreState, strength: number) {
  if (state !== 'listening' && state !== 'speaking') return 0;
  const normalizedStrength = normalizeIntensity(strength);
  if (state === 'speaking') return normalizedStrength * speechEnvelope(seconds);

  // Escuta é uma respiração lenta e discreta, sem batidas ou cadência repetitiva.
  const breath = 0.47
    + 0.09 * Math.sin(seconds * 0.47 + 0.8)
    + 0.035 * Math.sin(seconds * 0.83 + 2.1)
    + 0.018 * Math.sin(seconds * 1.19 + 0.4);
  return normalizedStrength * normalizeIntensity(breath);
}

// 20 Hz, apenas com sinal ativo. Cleanup cancela o timer da simulação.
export function configureSignal(
  active: boolean,
  state: CoreState,
  strength: number,
  update: (intensity: number) => void,
) {
  if (!active || normalizeIntensity(strength) === 0 || (state !== 'listening' && state !== 'speaking')) return () => {};
  const started = performance.now();
  const tick = () => update(simulatedIntensity((performance.now() - started) / 1000, state, strength));
  tick();
  const timer = setInterval(tick, 50);
  return () => clearInterval(timer);
}
