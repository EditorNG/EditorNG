import { create } from 'zustand';

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';
export interface Toast {
  id: number;
  kind: ToastKind;
  msg: string;
  action?: { label: string; run: () => void };
}

let nextId = 1;
export const useToasts = create<{ list: Toast[] }>(() => ({ list: [] }));

export function toast(kind: ToastKind, msg: string, action?: Toast['action'], ms = kind === 'error' ? 7000 : 3200): void {
  const t: Toast = { id: nextId++, kind, msg, action };
  useToasts.setState((s) => ({ list: [...s.list.slice(-4), t] }));
  setTimeout(() => dismissToast(t.id), ms);
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) }));
}
