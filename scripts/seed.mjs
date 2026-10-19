#!/usr/bin/env node
// Emits SQL for a demo carrier: 3 trucks, 5 drivers, ~1 month of loads.
// Usage: pnpm db:seed:local   (re-runnable; it replaces the demo tenant)
import { webcrypto as crypto } from 'node:crypto';

const TENANT = 'demo-tenant';
const PASSWORD = 'demo-password-123';
const DAY = 86_400_000;

// Deterministic PRNG so every seed produces the same month.
let state = 42;
const rand = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const insert = (table, row) =>
  `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(q).join(', ')});`;
const date = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const ts = (offsetDays, hour = 8) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  const b64 = (u8) => Buffer.from(u8).toString('base64url');
  return `pbkdf2$100000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

const out = [];
// Children first so foreign keys never block the reset.
for (const t of ['load_events', 'load_stops', 'loads', 'sessions', 'users', 'customers', 'trailers', 'trucks', 'drivers', 'tenants']) {
  out.push(`DELETE FROM ${t} WHERE ${t === 'tenants' ? 'id' : 'tenant_id'} = '${TENANT}';`);
}
out.push(insert('tenants', { id: TENANT, name: 'Lone Star Freight LLC' }));

const drivers = [
  { id: 'demo-drv-1', first_name: 'Marcus', last_name: 'Reed', pay_track: '1099', license_state: 'TX', medical_expires_on: date(12) },
  { id: 'demo-drv-2', first_name: 'Angela', last_name: 'Torres', pay_track: 'w2', license_state: 'TX', medical_expires_on: date(400) },
  { id: 'demo-drv-3', first_name: 'Dwayne', last_name: 'Hollis', pay_track: '1099', license_state: 'OK', medical_expires_on: date(220) },
  { id: 'demo-drv-4', first_name: 'Priya', last_name: 'Nair', pay_track: 'w2', license_state: 'TX', medical_expires_on: date(300), license_expires_on: date(-3) },
  { id: 'demo-drv-5', first_name: 'Cody', last_name: 'Whitfield', pay_track: 'w2', license_state: 'LA', medical_expires_on: date(510) },
];
for (const [i, d] of drivers.entries()) {
  out.push(insert('drivers', {
    tenant_id: TENANT,
    license_class: 'A',
    license_number: `D${String(48_210_337 + i * 7919)}`,
    license_expires_on: date(365 * 2 + i * 40),
    hired_on: date(-400 - i * 90),
    phone: `214-555-01${i}${i}`,
    ...d,
  }));
}

const trucks = [
  { id: 'demo-trk-1', unit_number: '101', make: 'Freightliner', model: 'Cascadia', year: 2022 },
  { id: 'demo-trk-2', unit_number: '102', make: 'Kenworth', model: 'T680', year: 2021 },
  { id: 'demo-trk-3', unit_number: '103', make: 'Peterbilt', model: '579', year: 2023 },
];
for (const t of trucks) out.push(insert('trucks', { tenant_id: TENANT, plate_state: 'TX', ...t }));
const trailers = ['5301', '5302', '5303', '5304'].map((u, i) => ({ id: `demo-trl-${i + 1}`, unit_number: u, trailer_type: i === 3 ? 'reefer' : 'dry_van' }));
for (const t of trailers) out.push(insert('trailers', { tenant_id: TENANT, ...t }));

const customers = [
  { id: 'demo-cus-1', name: 'Coyote Logistics', kind: 'broker', mc_number: 'MC-561135' },
  { id: 'demo-cus-2', name: 'TQL', kind: 'broker', mc_number: 'MC-411443' },
  { id: 'demo-cus-3', name: 'Gulf Coast Plastics', kind: 'shipper' },
];
for (const c of customers) out.push(insert('customers', { tenant_id: TENANT, ...c }));

const owner = { id: 'demo-usr-owner', email: 'owner@demo.haulledger.test', name: 'Ray Delgado', role: 'owner', driver_id: null };
const dispatcher = { id: 'demo-usr-dispatch', email: 'dispatch@demo.haulledger.test', name: 'Kim Osei', role: 'dispatcher', driver_id: null };
const driverUsers = drivers.map((d, i) => ({
  id: `demo-usr-drv-${i + 1}`,
  email: `${d.first_name.toLowerCase()}@demo.haulledger.test`,
  name: `${d.first_name} ${d.last_name}`,
  role: 'driver',
  driver_id: d.id,
}));
for (const u of [owner, dispatcher, ...driverUsers]) {
  out.push(insert('users', { tenant_id: TENANT, password_hash: await hashPassword(PASSWORD), ...u }));
}

const lanes = [
  ['Dallas', 'TX', 'Atlanta', 'GA', 781],
  ['Houston', 'TX', 'Memphis', 'TN', 563],
  ['Fort Worth', 'TX', 'Phoenix', 'AZ', 1019],
  ['San Antonio', 'TX', 'Oklahoma City', 'OK', 466],
  ['Laredo', 'TX', 'Chicago', 'IL', 1366],
  ['Dallas', 'TX', 'Denver', 'CO', 794],
  ['Houston', 'TX', 'New Orleans', 'LA', 348],
  ['El Paso', 'TX', 'Los Angeles', 'CA', 801],
];

// ~30 days of loads, rotating drivers across the three trucks.
let n = 1001;
for (let day = -30; day <= 2; day += 2) {
  for (const [di, d] of drivers.entries()) {
    if (rand() < 0.45) continue;
    const [oc, os, dc, ds, miles] = pick(lanes);
    const transitDays = Math.max(1, Math.round(miles / 550));
    const pickupDay = day + (di % 2);
    const deliverDay = pickupDay + transitDays;
    const status = deliverDay < 0 ? 'delivered' : pickupDay < 0 ? 'in_transit' : pickupDay === 0 ? 'dispatched' : 'planned';
    const rateCentsPerMile = 220 + Math.floor(rand() * 90); // $2.20–$3.09 all-in
    const id = `demo-load-${n}`;
    out.push(insert('loads', {
      id,
      tenant_id: TENANT,
      load_number: `L-${n}`,
      reference_number: `PO${400_000 + n * 7}`,
      customer_id: pick(customers).id,
      driver_id: d.id,
      truck_id: trucks[di % trucks.length].id,
      trailer_id: trailers[di % trailers.length].id,
      status,
      rate_cents: miles * rateCentsPerMile,
      loaded_miles: miles,
      empty_miles: Math.floor(rand() * 90),
      commodity: pick(['General freight', 'Paper products', 'Resin', 'Canned goods', 'Auto parts']),
      weight_lbs: 20_000 + Math.floor(rand() * 22_000),
      dispatched_at: status === 'planned' ? null : ts(pickupDay - 1, 15),
      delivered_at: status === 'delivered' ? ts(deliverDay, 14) : null,
    }));
    out.push(insert('load_stops', { id: `${id}-s1`, tenant_id: TENANT, load_id: id, seq: 1, kind: 'pickup', city: oc, state: os, scheduled_start: ts(pickupDay, 8) }));
    out.push(insert('load_stops', { id: `${id}-s2`, tenant_id: TENANT, load_id: id, seq: 2, kind: 'delivery', city: dc, state: ds, scheduled_start: ts(deliverDay, 10) }));
    const path = ['planned', 'dispatched', 'at_pickup', 'in_transit', 'delivered'];
    const steps = path.slice(0, path.indexOf(status) + 1);
    steps.forEach((to, i) => {
      const at = [ts(pickupDay - 2, 12), ts(pickupDay - 1, 15), ts(pickupDay, 8), ts(pickupDay, 11), ts(deliverDay, 14)][i];
      out.push(insert('load_events', {
        id: `${id}-e${i}`,
        tenant_id: TENANT,
        load_id: id,
        from_status: i === 0 ? null : steps[i - 1],
        to_status: to,
        user_id: i <= 1 ? dispatcher.id : driverUsers[di].id,
        created_at: at,
      }));
    });
    n++;
  }
}

process.stdout.write(out.join('\n') + '\n');
process.stderr.write(`Seeded ${n - 1001} loads. Sign in as ${owner.email} / ${PASSWORD}\n`);
