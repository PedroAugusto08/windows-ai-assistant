import { memo, useEffect, useId, useRef } from 'react';
import { configureSignal, coreStates, normalizeIntensity, type CoreState } from './core-state';
import './core.css';

function point(radius: number, degrees: number) {
  const radians = (degrees - 90) * Math.PI / 180;
  return [200 + radius * Math.cos(radians), 200 + radius * Math.sin(radians)];
}
function arc(radius: number, start: number, end: number) {
  const [x1, y1] = point(radius, start);
  const [x2, y2] = point(radius, end);
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}
const ticks = Array.from({ length: 120 }, (_, i) => {
  const major = i % 10 === 0;
  const [x1, y1] = point(major ? 177 : 181, i * 3);
  const [x2, y2] = point(186, i * 3);
  return { x1, y1, x2, y2, major };
});
const segments = [[8, 62], [78, 136], [188, 242], [258, 316]];

interface CoreProps {
  state: CoreState;
  active: boolean;
  reducedMotion: boolean;
  intensity: number;
  compact?: boolean;
}

export const JarvisCore = memo(function JarvisCore({ state, active, reducedMotion, intensity, compact = false }: CoreProps) {
  const root = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g, '');
  const moving = active && !reducedMotion && state !== 'economy';

  useEffect(() => {
    const lens = root.current?.querySelector<HTMLElement>('.core-lens');
    const response = root.current?.querySelector<HTMLElement>('.core-response');
    const update = (value: number) => {
      // Propriedades diretas evitam invalidar estilos herdados pelos SVGs.
      if (!lens) return;
      const signal = normalizeIntensity(value);
      lens.style.transform = `scale(${1 + signal * (state === 'speaking' ? 0.12 : 0.08)})`;
      lens.style.opacity = String(state === 'listening' || state === 'speaking' ? 0.38 + signal * 0.62 : 0.86);
      // Arcos com geometria fixa: variar a opacidade evita ampliar a lente rasterizada.
      if (response) response.style.opacity = String(state === 'speaking' ? 0.24 + signal * 0.76 : state === 'listening' ? 0.08 + signal * 0.24 : 0);
    };
    update(state === 'economy' ? 0 : reducedMotion ? normalizeIntensity(intensity) : state === 'listening' ? intensity * 0.47 : state === 'speaking' ? 0 : 0.2);
    return configureSignal(moving, state, intensity, update);
  }, [moving, state, intensity, reducedMotion]);

  return <div ref={root} className={`jarvis-core ${compact ? 'core-compact' : ''} ${moving ? '' : 'core-still'}`} data-state={state} role="img" aria-label={`Núcleo JARVIS: ${coreStates[state].label}`}>
    <svg viewBox="0 0 400 400" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--core-cyan)" />
          <stop offset=".5" stopColor="var(--core-electric)" stopOpacity=".72" />
          <stop offset="1" stopColor="var(--core-cyan)" />
        </linearGradient>
        <radialGradient id={`${id}-cavity`}>
          <stop offset="0" stopColor="var(--core-casing)" stopOpacity=".2" />
          <stop offset=".82" stopColor="var(--core-electric)" stopOpacity=".09" />
          <stop offset="1" stopColor="var(--core-casing)" />
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="104" fill={`url(#${id}-cavity)`} />
      <g className="core-frame" fill="none">
        <circle cx="200" cy="200" r="193" />
        <circle cx="200" cy="200" r="172" />
        <circle cx="200" cy="200" r="142" />
        <circle cx="200" cy="200" r="106" />
        <path d="M 200 3 V 15 M 200 385 V 397 M 3 200 H 15 M 385 200 H 397" className="core-axis" />
      </g>
      <g className="core-ticks">
        {ticks.filter((_, i) => !compact || i % 3 === 0).map((tick, i) => <line key={i} {...{ x1: tick.x1, y1: tick.y1, x2: tick.x2, y2: tick.y2 }} className={tick.major ? 'major-tick' : ''} />)}
      </g>
      {!compact && <g className="core-registration" fill="none">
        <path d="M 72 94 L 90 94 L 99 103 M 301 297 L 310 306 L 328 306 M 70 307 L 86 307 M 314 93 L 330 93" />
        {[45, 135, 225, 315].map(angle => {
          const [cx, cy] = point(172, angle);
          return <circle key={angle} cx={cx} cy={cy} r="3" />;
        })}
        <path d={arc(99, 16, 79)} className="core-data-track" />
        <path d={arc(99, 196, 259)} className="core-data-track" />
      </g>}
      <g className="core-iris" fill="none" stroke={`url(#${id}-edge)`}>
        <circle cx="200" cy="200" r="104" className="core-iris-seat" />
        <path d={arc(104, 4, 167)} className="core-iris-halo" />
        <path d={arc(104, 184, 347)} className="core-iris-halo" />
        <path d={arc(104, 4, 167)} />
        <path d={arc(104, 184, 347)} />
        <circle cx="200" cy="200" r="96" className="core-iris-inner" />
      </g>
    </svg>
    <div className="core-rotor" aria-hidden="true"><svg viewBox="0 0 400 400" focusable="false">
      <g fill="none">
        {segments.map(([start, end]) => <g key={start}>
          <path d={arc(162, start, end)} className="core-track" />
          <path d={arc(162, start, start + 24)} className="core-segment-halo" />
          <path d={arc(162, start, start + 24)} className="core-segment" />
          <path d={arc(162, start + 28, end - 2)} className="core-segment-code" />
          <path d={arc(151, start + 3, end - 3)} className="core-track-fine" />
        </g>)}
        <path d={arc(131, 32, 117)} className="core-data-track" />
        <path d={arc(131, 212, 297)} className="core-data-track" />
        <path d={arc(116, 126, 177)} className="core-track-fine" />
        <path d={arc(116, 306, 357)} className="core-track-fine" />
      </g>
    </svg></div>
    <div className="core-field" aria-hidden="true"><svg viewBox="0 0 400 400" focusable="false">
      <defs>
        <radialGradient id={`${id}-field`}>
          <stop offset="0" stopColor="var(--core-ice)" stopOpacity=".75" />
          <stop offset=".16" stopColor="var(--core-cyan)" stopOpacity=".52" />
          <stop offset=".52" stopColor="var(--core-electric)" stopOpacity=".24" />
          <stop offset="1" stopColor="var(--core-electric)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="105" fill={`url(#${id}-field)`} />
    </svg></div>
    <div className="core-lens" aria-hidden="true"><svg viewBox="0 0 400 400" focusable="false">
      <defs>
        <radialGradient id={`${id}-lens`}>
          <stop offset="0" stopColor="var(--core-ice)" />
          <stop offset=".24" stopColor="var(--core-cyan)" stopOpacity=".85" />
          <stop offset=".7" stopColor="var(--core-electric)" stopOpacity=".16" />
          <stop offset="1" stopColor="var(--core-electric)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g>
        <circle cx="200" cy="200" r="72" fill={`url(#${id}-lens)`} />
        <ellipse cx="200" cy="200" rx="46" ry="11" fill={`url(#${id}-lens)`} />
        <ellipse cx="200" cy="200" rx="11" ry="46" fill={`url(#${id}-lens)`} />
        <path d="M 200 191 L 209 200 L 200 209 L 191 200 Z" fill="var(--core-ice)" opacity=".9" />
      </g>
      <g className="core-signal" fill="none">
        <circle cx="200" cy="200" r="69" />
        <path d="M 177 200 H 185 M 215 200 H 223 M 200 177 V 185 M 200 215 V 223" />
      </g>
    </svg></div>
    <div className="core-response" aria-hidden="true"><svg viewBox="0 0 400 400" focusable="false">
      <g className="core-response-rings" fill="none">
        {[18, 108, 198, 288].map(start => <path key={start} d={arc(112, start, start + 54)} />)}
        <circle cx="200" cy="200" r="88" className="core-response-inner" />
      </g>
    </svg></div>
  </div>;
});
