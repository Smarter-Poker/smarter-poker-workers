import { getSupabase } from './supabase.js';
import * as Sentry from '@sentry/node';

type Prepared = { busy: boolean; queued?: number; next_due_at?: string | null; oldest_pending_at?: string | null };
type Dispatched = { ok: boolean; reminderProtocol: number; claimed: number; sent: number; skipped: number; failed: number; uncertain: number };
type Dependencies = {
  prepare: (signal: AbortSignal) => Promise<Prepared>;
  dispatch: (signal: AbortSignal) => Promise<Dispatched>;
  report: (error: unknown) => void;
};

// Timers wake the owner. Tournament start/registration records and atomic
// receipts are the durable source, reconstructed at every boot and retry.
export class TournamentReminderWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private running = false;
  private generation = 0;
  private state = {
    status: 'stopped', inFlight: false, lastPreparedAt: null as string | null,
    lastDispatchAt: null as string | null, nextWakeAt: null as string | null,
    oldestPendingAt: null as string | null, consecutiveFailures: 0,
    queued: 0, sent: 0, skipped: 0, failedAttempts: 0, uncertain: 0,
  };
  constructor(private readonly dependencies: Dependencies) {}
  snapshot() { return { ...this.state, running: this.running, protocol: 1 }; }
  start() {
    if (this.running) return;
    this.running = true;
    this.state.status = 'starting';
    const generation = ++this.generation;
    void this.tick(generation);
  }
  stop() {
    this.running = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.state.status = 'stopped';
    this.state.inFlight = false;
    this.state.nextWakeAt = null;
  }
  private async tick(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    this.state.inFlight = true;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => this.running && generation === this.generation;
    let delay = 30_000;
    try {
      const prepared = await this.dependencies.prepare(controller.signal);
      if (!current()) return;
      if (!prepared || typeof prepared.busy !== 'boolean') throw new Error('Invalid reminder prepare result');
      this.state.lastPreparedAt = new Date().toISOString();
      if (prepared.busy) {
        delay = 1000;
      } else {
        this.state.queued += prepared.queued || 0;
        this.state.oldestPendingAt = prepared.oldest_pending_at || null;
        if (prepared.next_due_at) {
          const due = Date.parse(prepared.next_due_at);
          if (!Number.isFinite(due)) throw new Error('Invalid reminder deadline');
          delay = Math.max(500, Math.min(30_000, due - Date.now()));
        }
        if (prepared.oldest_pending_at) {
          const result = await this.dependencies.dispatch(controller.signal);
          if (!current()) return;
          if (result?.reminderProtocol !== 1 || typeof result.claimed !== 'number') throw new Error('Reminder sender protocol unavailable');
          this.state.lastDispatchAt = new Date().toISOString();
          this.state.sent += result.sent;
          this.state.skipped += result.skipped;
          this.state.failedAttempts += result.failed;
          this.state.uncertain += result.uncertain;
          if (!result.ok) throw new Error('Reminder dispatch has unresolved outcomes');
          if (result.claimed > 0) delay = 500;
        }
      }
      this.state.consecutiveFailures = 0;
      this.state.status = 'running';
    } catch (error) {
      if (!current()) return;
      this.state.consecutiveFailures++;
      this.state.status = 'retrying';
      delay = Math.min(30_000, 1000 * 2 ** Math.min(this.state.consecutiveFailures - 1, 5));
      if (this.state.consecutiveFailures === 1) this.dependencies.report(error);
    } finally {
      if (generation === this.generation) {
        this.state.inFlight = false;
        this.controller = null;
        if (this.running) {
          this.state.nextWakeAt = new Date(Date.now() + delay).toISOString();
          this.timer = setTimeout(() => void this.tick(generation), delay);
          this.timer.unref();
        }
      }
    }
  }
}

export const tournamentReminderWorker = new TournamentReminderWorker({
  async prepare(signal) {
    const { data, error } = await getSupabase().rpc('prepare_tournament_reminders', { p_limit: 300 })
      .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    if (error) throw new Error(`Reminder preparation failed: ${error.code || 'unknown'}`);
    return data as Prepared;
  },
  async dispatch(signal) {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new Error('Reminder service authentication is not configured');
    const response = await fetch('https://smarter.poker/api/internal/tournament-reminders', {
      method: 'POST', headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(80_000)]),
    });
    if (!response.ok) throw new Error(`Reminder sender HTTP ${response.status}`);
    return await response.json() as Dispatched;
  },
  report(error) {
    console.error('[tournament-reminders]', error instanceof Error ? error.message : 'Execution failed');
    Sentry.captureException(error);
  },
});
