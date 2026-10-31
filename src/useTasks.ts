import { useEffect, useState, useSyncExternalStore } from 'react';
import { taskClient } from './tasks';

export function useTasks() {
  const state = useSyncExternalStore(taskClient.subscribe, taskClient.getState);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, 15_000);
    window.addEventListener('focus', tick);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick); };
  }, []);
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void taskClient.start().then(cleanup => { if (disposed) cleanup(); else off = cleanup; });
    const refresh = () => { if (!document.hidden) void taskClient.refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { disposed = true; off?.(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return { ...state, client: taskClient, now };
}
export type TasksModel = ReturnType<typeof useTasks>;
