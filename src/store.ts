import { useSyncExternalStore } from "react";

type Listener = () => void;

/** Tiny observable store shared by the QAM panel, the browse page and the engines. */
export class Store<T extends object> {
  private value: T;
  private listeners = new Set<Listener>();

  constructor(initial: T) {
    this.value = initial;
  }

  get = (): T => this.value;

  set = (patch: Partial<T> | ((prev: T) => Partial<T>)) => {
    const p = typeof patch === "function" ? patch(this.value) : patch;
    const cur = this.value as Record<string, unknown>;
    if (Object.keys(p).every((k) => Object.is(cur[k], (p as Record<string, unknown>)[k]))) return;
    this.value = { ...this.value, ...p };
    this.listeners.forEach((l) => l());
  };

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
