export function configureClock(active: boolean, update: () => void): () => void {
  if (!active) return () => {};
  update();
  const timer = setInterval(update, 1000);
  return () => clearInterval(timer);
}
