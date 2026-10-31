export function shouldTick(economy: boolean, nativeVisible: boolean, pageVisible: boolean) {
  return !economy && nativeVisible && pageVisible;
}
