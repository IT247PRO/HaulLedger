// Hours-of-service from a certified ELD vendor. We never build or certify an ELD;
// we read clocks the vendor already computes. Each vendor's response is mapped in
// one function so a format change is a one-place fix.
import { vendorJson } from './http';

export interface HosClock {
  eld_driver_id: string;
  name: string;
  duty_status: string | null;
  drive_remaining_min: number | null;
  shift_remaining_min: number | null;
  cycle_remaining_min: number | null;
  break_due_in_min: number | null;
}

const minutes = (ms: unknown, unit: 'ms' | 's') => (typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / (unit === 'ms' ? 60_000 : 60)) : null);

// ---- Samsara: GET /fleet/hos/clocks (cursor-paginated)
interface SamsaraClocks {
  data: {
    driver?: { id?: string; name?: string };
    currentDutyStatus?: { hosStatusType?: string };
    clocks?: {
      drive?: { driveRemainingDurationMs?: number };
      shift?: { shiftRemainingDurationMs?: number };
      cycle?: { cycleRemainingDurationMs?: number };
      break?: { timeUntilBreakDurationMs?: number };
    };
  }[];
  pagination?: { endCursor?: string; hasNextPage?: boolean };
}

export function mapSamsara(body: SamsaraClocks): HosClock[] {
  return (body.data ?? [])
    .filter((d) => d.driver?.id)
    .map((d) => ({
      eld_driver_id: String(d.driver!.id),
      name: d.driver?.name ?? '',
      duty_status: d.currentDutyStatus?.hosStatusType ?? null,
      drive_remaining_min: minutes(d.clocks?.drive?.driveRemainingDurationMs, 'ms'),
      shift_remaining_min: minutes(d.clocks?.shift?.shiftRemainingDurationMs, 'ms'),
      cycle_remaining_min: minutes(d.clocks?.cycle?.cycleRemainingDurationMs, 'ms'),
      break_due_in_min: minutes(d.clocks?.break?.timeUntilBreakDurationMs, 'ms'),
    }));
}

export async function samsaraClocks(token: string): Promise<HosClock[]> {
  const out: HosClock[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const body = await vendorJson<SamsaraClocks>('Samsara', `https://api.samsara.com/fleet/hos/clocks${after ? `?after=${encodeURIComponent(after)}` : ''}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    out.push(...mapSamsara(body));
    if (!body.pagination?.hasNextPage || !body.pagination.endCursor) break;
    after = body.pagination.endCursor;
  }
  return out;
}

// ---- Motive (KeepTruckin): GET /v1/available_time (seconds)
interface MotiveAvailable {
  users?: {
    user?: {
      id?: number | string;
      first_name?: string;
      last_name?: string;
      duty_status?: string;
      available_time?: { drive?: number; shift?: number; cycle?: number; break?: number };
    };
  }[];
}

export function mapMotive(body: MotiveAvailable): HosClock[] {
  return (body.users ?? [])
    .map((u) => u.user)
    .filter((u): u is NonNullable<typeof u> => !!u && u.id !== undefined)
    .map((u) => ({
      eld_driver_id: String(u.id),
      name: [u.first_name, u.last_name].filter(Boolean).join(' '),
      duty_status: u.duty_status ?? null,
      drive_remaining_min: minutes(u.available_time?.drive, 's'),
      shift_remaining_min: minutes(u.available_time?.shift, 's'),
      cycle_remaining_min: minutes(u.available_time?.cycle, 's'),
      break_due_in_min: minutes(u.available_time?.break, 's'),
    }));
}

export async function motiveClocks(apiKey: string): Promise<HosClock[]> {
  const out: HosClock[] = [];
  for (let page = 1; page <= 20; page++) {
    const body = await vendorJson<MotiveAvailable>('Motive', `https://api.keeptruckin.com/v1/available_time?per_page=100&page_no=${page}`, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
    });
    const mapped = mapMotive(body);
    out.push(...mapped);
    if (mapped.length < 100) break;
  }
  return out;
}
