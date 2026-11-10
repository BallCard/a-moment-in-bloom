import { useSyncExternalStore } from 'react';
import { store, type AppState } from './store';

/** 细粒度订阅 store，避免拖动时把整个应用重渲染一遍。 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
