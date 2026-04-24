/**
 * Twilio wrapper — SMS only. Lazy-init client, same env vars as World Hub:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *
 * Ported from World Hub's src/lib/commander/twilio.js but trimmed to just
 * the two exports cron handlers need (sendSMS + isTwilioConfigured).
 * The dozen+ seat/tournament/home-game helpers are app-domain code that
 * doesn't belong in a workers repo.
 */
import twilio from 'twilio';

type TwilioClient = ReturnType<typeof twilio>;

let cached: TwilioClient | null = null;

function getClient(): TwilioClient | null {
  if (cached) return cached;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  cached = twilio(sid, token);
  return cached;
}

export function isTwilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER,
  );
}

/** Minimal E.164 normalizer. Keeps leading + if present, strips everything else. */
function formatPhoneNumber(phone: string): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (hasPlus) return '+' + digits;
  // Assume US if 10 digits, otherwise let Twilio reject
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return '+' + digits;
}

export interface SmsResult {
  success: boolean;
  messageId?: string;
  status?: string;
  reason?: string;
}

export async function sendSMS(to: string, body: string): Promise<SmsResult> {
  const client = getClient();
  if (!client) {
    console.debug('[SMS MOCK]', to, body);
    return { success: false, reason: 'Twilio not configured' };
  }

  const formatted = formatPhoneNumber(to);
  if (!formatted) return { success: false, reason: 'Invalid phone number' };

  try {
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!from) return { success: false, reason: 'TWILIO_PHONE_NUMBER not set' };
    const message = await client.messages.create({ body, from, to: formatted });
    return { success: true, messageId: message.sid, status: message.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[twilio] SMS send error:', msg);
    return { success: false, reason: msg };
  }
}
