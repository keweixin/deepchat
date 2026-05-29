export function hasNativeBridge(): boolean {
  return Boolean((window as any).deepchat);
}
