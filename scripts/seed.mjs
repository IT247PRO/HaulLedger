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
for (const t of [
  'settlement_lines', 'settlements', 'escrow_transactions', 'driver_reimbursements', 'driver_charges', 'recurring_deductions',
  'driver_advances', 'driver_pay_rates', 'invoice_payments', 'invoice_lines', 'invoices', 'expenses', 'fuel_transactions', 'fuel_imports', 'fuel_cards', 'documents',
  'load_events', 'load_stops', 'loads', 'sessions', 'users', 'customers', 'trailers', 'trucks', 'drivers', 'tenants',
]) {
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

// Lanes with loaded miles by state (sums equal the lane miles) for IFTA and fuel stops.
const lanes = [
  ['Dallas', 'TX', 'Atlanta', 'GA', 781, { TX: 190, LA: 190, MS: 155, AL: 170, GA: 76 }],
  ['Houston', 'TX', 'Memphis', 'TN', 563, { TX: 290, AR: 260, TN: 13 }],
  ['Fort Worth', 'TX', 'Phoenix', 'AZ', 1019, { TX: 590, NM: 164, AZ: 265 }],
  ['San Antonio', 'TX', 'Oklahoma City', 'OK', 466, { TX: 340, OK: 126 }],
  ['Laredo', 'TX', 'Chicago', 'IL', 1366, { TX: 580, OK: 236, MO: 290, IL: 260 }],
  ['Dallas', 'TX', 'Denver', 'CO', 794, { TX: 465, NM: 85, CO: 244 }],
  ['Houston', 'TX', 'New Orleans', 'LA', 348, { TX: 120, LA: 228 }],
  ['El Paso', 'TX', 'Los Angeles', 'CA', 801, { TX: 20, NM: 145, AZ: 395, CA: 241 }],
];
const seededLoads = [];

// ~30 days of loads, rotating drivers across the three trucks.
let n = 1001;
for (let day = -30; day <= 2; day += 2) {
  for (const [di, d] of drivers.entries()) {
    if (rand() < 0.45) continue;
    const [oc, os, dc, ds, miles, stateMiles] = pick(lanes);
    const transitDays = Math.max(1, Math.round(miles / 550));
    const pickupDay = day + (di % 2);
    const deliverDay = pickupDay + transitDays;
    const status = deliverDay < 0 ? 'delivered' : pickupDay < 0 ? 'in_transit' : pickupDay === 0 ? 'dispatched' : 'planned';
    const rateCentsPerMile = 220 + Math.floor(rand() * 90); // $2.20–$3.09 all-in
    const id = `demo-load-${n}`;
    const emptyMiles = Math.floor(rand() * 90);
    seededLoads.push({ id, status, miles, emptyMiles, stateMiles, originState: os, pickupDay, deliverDay, driverIndex: di, rateCents: miles * rateCentsPerMile, customer: null });
    out.push(insert('loads', {
      id,
      tenant_id: TENANT,
      load_number: `L-${n}`,
      reference_number: `PO${400_000 + n * 7}`,
      customer_id: (seededLoads[seededLoads.length - 1].customer = pick(customers).id),
      driver_id: d.id,
      truck_id: trucks[di % trucks.length].id,
      trailer_id: trailers[di % trailers.length].id,
      status,
      rate_cents: miles * rateCentsPerMile,
      loaded_miles: miles,
      empty_miles: emptyMiles,
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

// Pay setup: mixed pay per driver, escrow for the owner-operators.
const payRates = [
  ['demo-drv-1', 'percent', 2_800, null],
  ['demo-drv-1', 'per_stop', 5_000, 'extra'],
  ['demo-drv-2', 'per_mile', 60_000, 'all'],
  ['demo-drv-2', 'per_diem', 6_900, null],
  ['demo-drv-3', 'per_mile', 165_000, 'loaded'],
  ['demo-drv-4', 'per_mile', 58_000, 'all'],
  ['demo-drv-4', 'per_diem', 6_000, null],
  ['demo-drv-5', 'per_mile', 55_000, 'loaded'],
];
payRates.forEach(([driver_id, kind, rate, basis], i) =>
  out.push(insert('driver_pay_rates', { id: `demo-rate-${i + 1}`, tenant_id: TENANT, driver_id, kind, rate, basis, effective_from: date(-365) })),
);
out.push(`UPDATE drivers SET escrow_target_cents = 250000, escrow_per_settlement_cents = 10000 WHERE tenant_id = '${TENANT}' AND id IN ('demo-drv-1', 'demo-drv-3');`);
const recurring = [
  ['demo-drv-1', 'occupational_accident', 3_850, 'Occupational accident policy (weekly)'],
  ['demo-drv-1', 'eld', 1_500, 'ELD subscription'],
  ['demo-drv-3', 'insurance', 8_500, 'Physical damage insurance (weekly)'],
  ['demo-drv-3', 'eld', 1_500, 'ELD subscription'],
];
recurring.forEach(([driver_id, category, amount_cents, description], i) =>
  out.push(insert('recurring_deductions', { id: `demo-rec-${i + 1}`, tenant_id: TENANT, driver_id, category, amount_cents, description })),
);
out.push(insert('driver_advances', { id: 'demo-adv-1', tenant_id: TENANT, driver_id: 'demo-drv-1', amount_cents: 20_000, issued_on: date(-3), method: 'comchek', reference: 'CK-88104', memo: 'Trip advance', created_by: owner.id }));
out.push(insert('driver_charges', { id: 'demo-chg-1', tenant_id: TENANT, driver_id: 'demo-drv-3', category: 'equipment_damage', amount_cents: 15_000, incurred_on: date(-5), description: 'Trailer 5303 mud flap (lease addendum B)', created_by: owner.id }));

// Fuel: ~6.4 mpg, bought in the states the truck runs most, on one EFS card per truck.
let fuelN = 0;
const cards = ['4101', '4102', '4103'];
trucks.forEach((t, i) => out.push(insert('fuel_cards', { id: `demo-card-${i + 1}`, tenant_id: TENANT, provider: 'efs', card_last4: cards[i], truck_id: t.id })));
for (const l of seededLoads.filter((x) => x.status === 'delivered' || x.status === 'in_transit')) {
  const totalMiles = l.miles + l.emptyMiles;
  let galMilli = Math.round((totalMiles * 1000) / 6.4);
  const states = Object.entries(l.stateMiles).sort((a, b) => b[1] - a[1]).slice(0, totalMiles > 700 ? 2 : 1);
  states.forEach(([state], k) => {
    const g = k === states.length - 1 ? galMilli : Math.round(galMilli * 0.55);
    galMilli -= g;
    const pricePerGalMilli = 3_590 + Math.floor(rand() * 520); // $3.59–$4.11 in thousandths of a dollar
    fuelN++;
    out.push(insert('fuel_transactions', {
      id: `demo-fuel-${fuelN}`, tenant_id: TENANT, provider: 'efs', external_id: `DEMO-${fuelN}`,
      transacted_at: ts(l.pickupDay + k, 10 + k * 6), card_last4: cards[l.driverIndex % 3], raw_unit: trucks[l.driverIndex % 3].unit_number,
      truck_id: trucks[l.driverIndex % 3].id, driver_id: drivers[l.driverIndex].id, load_id: l.id,
      merchant: pick(["Love's", 'Pilot', 'TA', 'Petro', 'Flying J']), state, product: 'diesel',
      gallons_milli: g, amount_cents: Math.round((g * pricePerGalMilli) / 10_000),
    }));
  });
}

// Fixed and variable costs per truck, plus company overhead.
let expN = 0;
const expense = (row) => out.push(insert('expenses', { id: `demo-exp-${++expN}`, tenant_id: TENANT, created_by: owner.id, ...row }));
for (const t of trucks) {
  expense({ category: 'truck_payment', amount_cents: 245_000, incurred_on: date(-20), vendor: 'Daimler Truck Financial', description: `Unit ${t.unit_number} payment`, truck_id: t.id });
  expense({ category: 'insurance', amount_cents: 115_000, incurred_on: date(-25), vendor: 'Progressive Commercial', description: `Unit ${t.unit_number} liability + cargo`, truck_id: t.id });
  expense({ category: 'maintenance', amount_cents: 18_000 + Math.floor(rand() * 60_000), incurred_on: date(-12), vendor: 'Rush Truck Center', description: 'PM service A', truck_id: t.id });
  expense({ category: 'tolls', amount_cents: 4_000 + Math.floor(rand() * 9_000), incurred_on: date(-6), vendor: 'PrePass', description: 'Tolls', truck_id: t.id });
}
expense({ category: 'tires', amount_cents: 168_000, incurred_on: date(-9), vendor: 'Southern Tire Mart', description: 'Drive tires (8)', truck_id: 'demo-trk-2' });
expense({ category: 'software', amount_cents: 9_900, incurred_on: date(-15), vendor: 'HaulLedger', description: 'Subscription' });
expense({ category: 'office', amount_cents: 31_500, incurred_on: date(-15), vendor: 'Regus', description: 'Office rent' });

// Invoices: delivered loads older than a week are billed; older than ~25 days are paid.
let invN = 0;
for (const l of seededLoads.filter((x) => x.status === 'delivered' && x.deliverDay <= -7)) {
  invN++;
  const id = `demo-inv-${invN}`;
  const issued = date(l.deliverDay + 1);
  const due = date(l.deliverDay + 31);
  const paid = l.deliverDay <= -25;
  out.push(insert('invoices', {
    id, tenant_id: TENANT, invoice_number: `INV-${10000 + invN}`, customer_id: l.customer, status: paid ? 'paid' : 'open', issued_on: issued,
    terms_days: 30, due_on: due, total_cents: l.rateCents, paid_cents: paid ? l.rateCents : 0, paid_on: paid ? date(l.deliverDay + 24) : null, sent_at: ts(l.deliverDay + 1, 16), created_by: dispatcher.id,
  }));
  out.push(insert('invoice_lines', { id: `${id}-1`, tenant_id: TENANT, invoice_id: id, seq: 1, load_id: l.id, kind: 'linehaul', description: `L-${l.id.slice(10)} linehaul`, amount_cents: l.rateCents }));
  if (paid) out.push(insert('invoice_payments', { id: `${id}-p`, tenant_id: TENANT, invoice_id: id, amount_cents: l.rateCents, received_on: date(l.deliverDay + 24), method: 'ach', created_by: owner.id }));
}

process.stdout.write(out.join('\n') + '\n');
process.stderr.write(`Seeded ${n - 1001} loads. Sign in as ${owner.email} / ${PASSWORD}\n`);
