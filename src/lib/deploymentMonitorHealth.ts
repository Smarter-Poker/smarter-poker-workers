import { getSupabase } from './supabase.js';
import { OperationalAlertDeliveryError, operationalEventKey, recordOperationalAlert } from './operationalAlerts.js';

const SOURCE = 'workers.deploy-error-poll';
const ALERT_NAME = 'DeploymentMonitorUnavailable';

/**
 * The latest durable delivery is the state, including retries of an older row.
 * Recovery does not mark an investigation fixed; it records that this exact
 * Vercel read now works. A later failure starts a distinct incident episode.
 */
export async function recordDeploymentMonitorHealth(
  status: 'firing' | 'resolved', payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { data, error } = await getSupabase()
      .from('operational_alert_events')
      .select('event_key,status')
      .eq('source', SOURCE)
      .eq('alertname', ALERT_NAME)
      .order('last_received_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const previous = data?.[0] as { event_key: string; status: string } | undefined;
    if (previous && (!previous.event_key || !['firing', 'resolved'].includes(previous.status))) {
      throw new Error('invalid deployment monitor health state');
    }
    if (status === 'resolved' && previous?.status !== 'firing') return;
    const eventKey = status === 'firing' && previous?.status === 'firing'
      ? previous.event_key
      : operationalEventKey('deployment-monitor', status, previous?.event_key ?? 'initial');
    await recordOperationalAlert({
      source: SOURCE,
      eventKey,
      alertname: ALERT_NAME,
      status,
      severity: status === 'firing' ? 'critical' : 'info',
      payload,
    });
  } catch (error) {
    if (error instanceof OperationalAlertDeliveryError) throw error;
    throw new OperationalAlertDeliveryError(error instanceof Error ? error.message : String(error));
  }
}
