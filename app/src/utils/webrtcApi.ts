import { localApiRequest } from './localApi';

export interface WebrtcKeyInfo {
  key: string;
  sip: string;
}

/** Temporary (72h) widget session token for the browser softphone — see
 * server/src/zadarma.ts's getWebrtcKey() for why this is the one place a
 * Zadarma credential reaches the browser at all. Fetched fresh on every
 * app load; never cached across sessions. */
export function fetchWebrtcKey(): Promise<WebrtcKeyInfo> {
  return localApiRequest<WebrtcKeyInfo>('/api/webrtc/key');
}
