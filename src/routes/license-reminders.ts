/**
 * GET/POST /cron/license-reminders
 *
 * Ported from pages/api/cron/license-reminders.js (2026-04-24).
 *
 * Daily 9am UTC: scan dealer_documents for gaming licenses expiring within
 * 90 days (or recently expired within 30 days) that haven't had a reminder
 * in the last 7 days. Send OneSignal push per doc, persist the send
 * timestamp to dealer_documents.last_reminder_sent_at so the rate limit
 * survives across serverless cold starts and dispatcher restarts.
 *
 * Idempotence: DB-persisted last_reminder_sent_at, compared against 7-day
 * cutoff in the SELECT itself. Second concurrent fire sees updated
 * timestamps and skips already-notified docs.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const RATE_LIMIT_DAYS = 7;
const SITE_URL = process.env.WORLD_HUB_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://smarter.poker';

interface DealerDoc {
  id: string;
  user_id: string;
  label: string | null;
  state: string | null;
  license_number: string | null;
  expiry_date: string;
  last_reminder_sent_at: string | null;
}

function daysUntil(dateStr: string): number {
  const now = new Date();
  const exp = new Date(dateStr + 'T12:00:00');
  return Math.floor((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function urgencyLabel(days: number): { emoji: string; text: string } {
  if (days < 0) return { emoji: '🔴', text: 'EXPIRED' };
  if (days === 0) return { emoji: '🔴', text: 'expires TODAY' };
  if (days <= 7) return { emoji: '🔴', text: `expires in ${days} day${days !== 1 ? 's' : ''}` };
  return { emoji: '🟡', text: `expires in ${days} days` };
}

export async function licenseReminders(c: Context) {
  const appId = process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID ?? process.env.ONESIGNAL_APP_ID;
  const restKey = process.env.ONESIGNAL_REST_API_KEY;

  if (!appId || !restKey) {
    return c.json({ skipped: true, reason: 'OneSignal not configured' });
  }

  try {
    const supabase = getSupabase();
    const today = new Date();
    const in90Days = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
    const cutoffBack = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rateLimitCutoff = new Date(today.getTime() - RATE_LIMIT_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data: docs, error } = await supabase
      .from('dealer_documents')
      .select('id, user_id, label, state, license_number, expiry_date, last_reminder_sent_at')
      .eq('category', 'gaming_license')
      .not('expiry_date', 'is', null)
      .gte('expiry_date', cutoffBack.toISOString().split('T')[0])
      .lte('expiry_date', in90Days.toISOString().split('T')[0])
      .or(`last_reminder_sent_at.is.null,last_reminder_sent_at.lt.${rateLimitCutoff}`)
      .limit(100);

    if (error) throw error;

    if (!docs || docs.length === 0) {
      return c.json({ sent: 0, skipped: 0 });
    }

    const rows = docs as DealerDoc[];
    let sent = 0;
    let skipped = 0;

    for (const doc of rows) {
      const days = daysUntil(doc.expiry_date);
      const { emoji, text } = urgencyLabel(days);
      const licenseName = doc.label ?? `${doc.state ?? ''} Gaming License`.trim();
      const stateStr = doc.state ? ` (${doc.state})` : '';

      const payload = {
        app_id: appId,
        include_aliases: { external_id: [doc.user_id] },
        target_channel: 'push',
        headings: { en: `${emoji} License Renewal Reminder` },
        contents: { en: `Your ${licenseName}${stateStr} ${text}. Tap to renew now.` },
        url: `${SITE_URL}/hub/bankroll-manager`,
        collapse_id: `license-reminder-${doc.id}`,
        ttl: 86400,
        small_icon: 'ic_stat_notification',
        chrome_web_icon: `${SITE_URL}/icons/icon-192.png`,
        ios_badgeType: 'Increase',
        ios_badgeCount: 1,
        data: { type: 'license_reminder', docId: doc.id, daysUntilExpiry: days },
      };

      try {
        const response = await fetch('https://api.onesignal.com/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Key ${restKey}`,
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        const result = (await response.json()) as { id?: string; errors?: unknown };

        if (result.id) {
          await supabase
            .from('dealer_documents')
            .update({ last_reminder_sent_at: new Date().toISOString() })
            .eq('id', doc.id);
          sent++;
        } else {
          console.warn(`[license-reminders] OneSignal error for doc ${doc.id}:`, result.errors);
          skipped++;
        }
      } catch (pushErr) {
        console.warn(
          `[license-reminders] push error for doc ${doc.id}:`,
          pushErr instanceof Error ? pushErr.message : String(pushErr),
        );
        skipped++;
      }
    }

    return c.json({ sent, skipped, total: rows.length });
  } catch (err) {
    console.error(
      '[license-reminders] fatal:',
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: err instanceof Error ? err.message : 'unknown' }, 500);
  }
}
