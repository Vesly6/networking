import { localApiRequest } from './localApi';

/** The reply-mapping feature's saved campaign→destination-table choices
 * for the current company — see PushReplyRowsModal.tsx, which reads this
 * to pre-fill a suggestion, and writes to it via saveInstantlyTableMapping
 * when the "remember this mapping" checkbox is checked. */
export function fetchInstantlyTableMap() {
  return localApiRequest<{ map: Record<string, string> }>('/api/instantly/table-map');
}

export function saveInstantlyTableMapping(campaignName: string, tableName: string) {
  return localApiRequest<{ ok: true }>('/api/instantly/table-map', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaignName, tableName }),
  });
}
