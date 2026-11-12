import type { Api } from '@shared/ipc';

declare global {
  interface Window {
    api: Api;
    __app?: any;
  }
}

export const api = window.api;
