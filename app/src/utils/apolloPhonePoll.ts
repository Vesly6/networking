import { pollPhoneReveal, pickBestPhoneNumber, type ApolloPhoneNumber } from './apolloApi';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Apollo's own docs just say "can take several minutes" with no hard
// number — matches ApolloContactSearchModal.tsx's own cap, chosen there
// after a live lookup was confirmed to resolve at 210s, past the old 180s
// cap this codebase used to use.
const PHONE_POLL_MAX_MS = 5 * 60 * 1000;

export interface ApolloPhoneEnrichResult {
  person?: { contact?: { phone_numbers?: ApolloPhoneNumber[] } } | null;
  request_id?: string;
  phone_enrichment?: { message?: string };
}

/** Resolves the mobile number from an enrichPerson({reveal_phone_number:
 * true}) result — the sync-check-then-poll sequence every phone-reveal
 * call site in this app needs. Checks Apollo's synchronous
 * contact.phone_numbers FIRST (a real, previously-fixed bug: skipping
 * this order throws away an instant answer and pays the full "can take
 * several minutes" polling cost for nothing), then falls back to polling
 * GET /webhook_result via pollPhoneReveal using the TOP-LEVEL request_id
 * — never phone_enrichment.request_id, which looks right but is a
 * different id the polling endpoint always rejects. Never throws —
 * resolves { phone: null, message } instead so callers don't need their
 * own try/catch just for this part. Callers own their own
 * usePendingPhoneSearchStore start/finish, since only the caller knows
 * the right key for its own in-flight guard. */
export async function resolveApolloPhone(result: ApolloPhoneEnrichResult): Promise<{ phone: string | null; message?: string }> {
  const contactPhones = result.person?.contact?.phone_numbers;
  if (contactPhones) {
    const mobile = pickBestPhoneNumber(contactPhones)?.sanitized_number;
    return mobile ? { phone: mobile } : { phone: null, message: 'Rastas tik ne mobilaus tipo numeris' };
  }
  if (!result.request_id) {
    return { phone: null, message: result.phone_enrichment?.message ?? 'Telefono numeris nerastas' };
  }
  const deadline = Date.now() + PHONE_POLL_MAX_MS;
  for (;;) {
    const poll = await pollPhoneReveal(result.request_id);
    if (poll.status === 'ready') {
      const phone = pickBestPhoneNumber(poll.phoneNumbers)?.sanitized_number ?? null;
      return phone ? { phone } : { phone: null, message: 'Rastas tik ne mobilaus tipo numeris' };
    }
    if (poll.status === 'error') return { phone: null, message: poll.message };
    if (Date.now() >= deadline) return { phone: null, message: 'Telefono numeris dar nerastas — bandykite dar kartą po kelių minučių' };
    await sleep(Math.min(Math.max(poll.retryAfterSeconds, 5), 20) * 1000);
  }
}
