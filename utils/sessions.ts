// sessions.ts — read/write the per-origin editing sessions in
// chrome.storage.local under a single key. Sessions are the source of truth for
// off-page changes; the current page's live rows come from the engine.

import type { Sessions, Session } from '@/utils/types';

export const SESSIONS_KEY = 'redline_sessions';

export function getSessions(): Promise<Sessions> {
  return new Promise((res) => {
    try {
      chrome.storage.local.get(SESSIONS_KEY, (r) => res((r && r[SESSIONS_KEY]) || {}));
    } catch {
      res({});
    }
  });
}

export function setSessions(obj: Sessions): Promise<void> {
  return new Promise((res) => {
    try {
      chrome.storage.local.set({ [SESSIONS_KEY]: obj }, () => res());
    } catch {
      res();
    }
  });
}

export async function getSession(origin: string): Promise<Session | null> {
  if (!origin) return null;
  const s = await getSessions();
  return s[origin] || null;
}
