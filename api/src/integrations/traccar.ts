// Traccar (Apache 2.0) runs as a sidecar; we only call its REST API.
import { vendorJson } from './http';

export interface TraccarConfig {
  base_url: string;
}
export interface TraccarSecret {
  token?: string;
  email?: string;
  password?: string;
}

function headers(secret: TraccarSecret): Record<string, string> {
  if (secret.token) return { Authorization: `Bearer ${secret.token}`, Accept: 'application/json' };
  return { Authorization: `Basic ${btoa(`${secret.email ?? ''}:${secret.password ?? ''}`)}`, Accept: 'application/json' };
}
const url = (cfg: TraccarConfig, path: string) => `${cfg.base_url.replace(/\/+$/, '')}${path}`;

export interface TraccarDevice { id: number; name: string; uniqueId: string; status?: string; lastUpdate?: string | null; positionId?: number }
export interface TraccarPosition { id: number; deviceId: number; latitude: number; longitude: number; speed: number; course: number; fixTime: string; address?: string | null; attributes?: Record<string, unknown> }

export const traccarDevices = (cfg: TraccarConfig, secret: TraccarSecret) => vendorJson<TraccarDevice[]>('Traccar', url(cfg, '/api/devices'), { headers: headers(secret) });
/** Latest position of every device the account can see. */
export const traccarPositions = (cfg: TraccarConfig, secret: TraccarSecret) => vendorJson<TraccarPosition[]>('Traccar', url(cfg, '/api/positions'), { headers: headers(secret) });

/** Traccar reports speed in knots. */
export function normalizePosition(p: TraccarPosition) {
  return {
    device_id: String(p.deviceId),
    latitude: p.latitude,
    longitude: p.longitude,
    speed_mph: Math.round(p.speed * 1.150779),
    course: p.course,
    fix_time: p.fixTime,
    address: p.address ?? null,
    ignition: typeof p.attributes?.ignition === 'boolean' ? p.attributes.ignition : null,
  };
}
