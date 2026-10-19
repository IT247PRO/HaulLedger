import { beforeAll, describe, expect, it } from 'vitest';
import { api, deliveredLoad, makeCarrier, stops, today, upload, type Carrier } from './helpers';

let c: Carrier;
let other: Carrier;
beforeAll(async () => {
  c = await makeCarrier('Comply');
  other = await makeCarrier('OtherComply');
});

const quarter = () => {
  const d = today();
  return `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
};

describe('IFTA', () => {
  it('builds the quarter from state miles and fuel, and flags every gap', async () => {
    const owner = c.tokens.owner;
    const load = await deliveredLoad(c, { body: { loaded_miles: 600, empty_miles: 40 } });
    const short = await deliveredLoad(c, { body: { loaded_miles: 300, empty_miles: 0 } });
    const put = await api('PUT', `/api/ifta/loads/${load.id}/miles`, { token: c.tokens.dispatcher, body: { miles: [{ state: 'TX', miles: 440 }, { state: 'OK', miles: 200 }] } });
    expect(put.status).toBe(200);
    expect(put.body.warnings).toEqual([]);
    const bad = await api('PUT', `/api/ifta/loads/${short.id}/miles`, { token: owner, body: { miles: [{ state: 'TX', miles: 250 }] } });
    expect(bad.body.warnings[0]).toContain('add up to 250');
    await api('POST', '/api/ifta/miles', { token: owner, body: { truck_id: c.truck.id, traveled_on: today(), state: 'TX', miles: 60, note: 'Bobtail to shop' } });

    const fuel = (state: string, gallons_milli: number, truck_id: string | null = c.truck.id) =>
      api('POST', '/api/fuel/transactions', { token: owner, body: { transacted_at: new Date().toISOString(), state, product: 'diesel', gallons_milli, amount_cents: 1000, truck_id } });
    await fuel('TX', 120_000);
    await fuel('OK', 30_000);
    await fuel('AR', 10_000, null); // not tied to a truck: excluded and flagged
    await api('POST', '/api/fuel/transactions', { token: owner, body: { transacted_at: new Date().toISOString(), state: 'TX', product: 'reefer', gallons_milli: 40_000, amount_cents: 1000, truck_id: c.truck.id } });

    const r = (await api('GET', `/api/ifta/report?quarter=${quarter()}`, { token: c.tokens.dispatcher })).body;
    // TX 440 + 250 + 60 = 750, OK 200 → 950 mi over 150 gal (reefer fuel is not IFTA fuel)
    expect(r.total_miles).toBe(950);
    expect(r.total_gallons_milli).toBe(150_000);
    expect(r.mpg_x100).toBe(633);
    expect(r.lines.map((l: any) => [l.state, l.miles, l.tax_paid_gallons_milli])).toEqual([['OK', 200, 30_000], ['TX', 750, 120_000]]);
    expect(r.complete).toBe(false);
    expect(r.warnings.join('\n')).toContain(`${short.load_number}: state miles add up to 250, load shows 300`);
    expect(r.warnings.join('\n')).toContain('1 fuel purchases are not tied to a truck');
    expect(r.warnings.join('\n')).toContain('No ' + quarter() + ' tax rate entered for: OK, TX');
  });

  it('computes tax once rates are entered (owner only), and exports CSV', async () => {
    const rates = { quarter: quarter(), fuel_type: 'diesel', rates: [{ state: 'TX', rate_x10000: 2000 }, { state: 'OK', rate_x10000: 1900 }] };
    expect((await api('PUT', '/api/ifta/rates', { token: c.tokens.dispatcher, body: rates })).status).toBe(403);
    expect((await api('PUT', '/api/ifta/rates', { token: c.tokens.owner, body: rates })).status).toBe(200);
    const r = (await api('GET', `/api/ifta/report?quarter=${quarter()}`, { token: c.tokens.owner })).body;
    expect(r.missing_rates).toEqual([]);
    expect(typeof r.total_tax_due_cents).toBe('number');
    const csv = await (await import('./helpers')).fetchRaw(c.tokens.owner, `/api/ifta/report.csv?quarter=${quarter()}`);
    const text = await csv.text();
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(text.split('\r\n')[0]).toBe('Jurisdiction,Total miles,Taxable gallons,Tax-paid gallons,Net taxable gallons,Tax rate,Tax due');
    expect(text).toContain('Fleet MPG,6.33');
  });

  it('is staff-only and tenant-scoped', async () => {
    expect((await api('GET', `/api/ifta/report?quarter=${quarter()}`, { token: c.tokens.driver })).status).toBe(403);
    const r = (await api('GET', `/api/ifta/report?quarter=${quarter()}`, { token: other.tokens.owner })).body;
    expect(r.total_miles).toBe(0);
    expect((await api('PUT', `/api/ifta/loads/${c.load.id}/miles`, { token: other.tokens.owner, body: { miles: [{ state: 'TX', miles: 1 }] } })).status).toBe(404);
    expect((await api('POST', '/api/ifta/miles', { token: other.tokens.owner, body: { truck_id: c.truck.id, traveled_on: today(), state: 'TX', miles: 1 } })).status).toBe(400);
    expect((await api('GET', '/api/ifta/report?quarter=2026-Q9', { token: c.tokens.owner })).status).toBe(400);
  });
});

describe('DQF', () => {
  it('tracks each driver against 391.51 and keeps the medical card in sync', async () => {
    const owner = c.tokens.owner;
    const doc = await upload(owner, { kind: 'dqf', driver_id: c.driver.id });
    const add = (body: Record<string, unknown>) => api('POST', `/api/dqf/${c.driver.id}/items`, { token: c.tokens.dispatcher, body });
    expect((await add({ item_type: 'application', completed_on: '2026-01-05', document_id: doc.body.document.id })).status).toBe(201);
    expect((await add({ item_type: 'medical_certificate', completed_on: '2026-01-06' })).status).toBe(400); // needs expiry
    expect((await add({ item_type: 'medical_certificate', completed_on: '2026-01-06', expires_on: '2032-01-06' })).status).toBe(201);
    expect((await add({ item_type: 'bogus', completed_on: '2026-01-06' })).status).toBe(400);

    const driver = (await api('GET', `/api/drivers/${c.driver.id}`, { token: owner })).body.driver;
    expect(driver.medical_expires_on).toBe('2032-01-06');

    const file = (await api('GET', `/api/dqf/${c.driver.id}`, { token: owner })).body;
    const st = Object.fromEntries(file.requirements.map((r: any) => [r.type, r.status]));
    expect(st).toMatchObject({ application: 'complete', medical_certificate: 'complete', registry_verification: 'missing', road_test: 'missing' });
    expect(file.overall).toBe('attention');
    expect(file.requirements.find((r: any) => r.type === 'application').cite).toBe('391.21');

    const list = (await api('GET', '/api/dqf', { token: c.tokens.dispatcher })).body.drivers;
    expect(list.find((d: any) => d.driver_id === c.driver.id)).toMatchObject({ overall: 'attention', complete: 2 });
  });

  it("drivers read only their own file; nobody reads another tenant's", async () => {
    expect((await api('GET', `/api/dqf/${c.driver.id}`, { token: c.tokens.driver })).status).toBe(200);
    expect((await api('GET', `/api/dqf/${c.otherDriver.id}`, { token: c.tokens.driver })).status).toBe(404);
    expect((await api('GET', '/api/dqf', { token: c.tokens.driver })).status).toBe(403);
    expect((await api('POST', `/api/dqf/${c.driver.id}/items`, { token: c.tokens.driver, body: { item_type: 'application', completed_on: '2026-01-01' } })).status).toBe(403);
    expect((await api('GET', `/api/dqf/${c.driver.id}`, { token: other.tokens.owner })).status).toBe(404);
    expect((await api('POST', `/api/dqf/${c.driver.id}/items`, { token: other.tokens.owner, body: { item_type: 'application', completed_on: '2026-01-01' } })).status).toBe(404);
  });
});

describe('maintenance & DVIR', () => {
  it('a DVIR defect keeps the truck out of dispatch until the repair is certified', async () => {
    const dvir = await api('POST', '/api/dvirs', {
      token: c.tokens.driver,
      body: {
        truck_id: c.truck.id, trailer_id: c.trailer.id, kind: 'post_trip', odometer: 412_345, signature_name: 'Dana Comply',
        defects: [{ unit: 'truck', component: 'lighting_reflectors', description: 'Left marker lamp out' }],
      },
    });
    expect(dvir.status).toBe(201);
    expect(dvir.body.dvir).toMatchObject({ status: 'defects_open', driver_id: c.driver.id, defects: [expect.objectContaining({ component: 'lighting_reflectors' })] });
    expect((await api('GET', `/api/trucks/${c.truck.id}`, { token: c.tokens.owner })).body.truck).toBeTruthy();

    const load = (await api('POST', '/api/loads', { token: c.tokens.owner, body: { driver_id: c.driver.id, truck_id: c.truck.id, stops } })).body.load;
    const blocked = await api('POST', `/api/loads/${load.id}/status`, { token: c.tokens.owner, body: { status: 'dispatched' } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('truck 101');

    expect((await api('POST', `/api/dvirs/${dvir.body.dvir.id}/certify`, { token: c.tokens.driver, body: { result: 'repaired', certified_name: 'Me' } })).status).toBe(403);
    const cert = await api('POST', `/api/dvirs/${dvir.body.dvir.id}/certify`, { token: c.tokens.dispatcher, body: { result: 'repaired', certified_name: 'Shop Lead', notes: 'Replaced lamp' } });
    expect(cert.body.dvir.status).toBe('repaired');
    expect((await api('POST', `/api/dvirs/${dvir.body.dvir.id}/certify`, { token: c.tokens.dispatcher, body: { result: 'repaired', certified_name: 'Shop Lead' } })).status).toBe(409);
    expect((await api('POST', `/api/loads/${load.id}/status`, { token: c.tokens.owner, body: { status: 'dispatched' } })).status).toBe(200);

    // the next driver reviews the last report on the truck
    const lastOnTruck = (await api('GET', `/api/dvirs?truck_id=${c.truck.id}`, { token: c.tokens.driver })).body.dvirs;
    expect(lastOnTruck[0].certified_name).toBe('Shop Lead');
    expect((await api('POST', `/api/dvirs/${lastOnTruck[0].id}/review`, { token: c.tokens.driver })).status).toBe(200);
  });

  it('a clean DVIR does not block; drivers cannot file for someone else', async () => {
    const ok = await api('POST', '/api/dvirs', { token: c.tokens.driver, body: { truck_id: c.truck.id, kind: 'pre_trip', signature_name: 'Dana Comply', defects: [] } });
    expect(ok.body.dvir.status).toBe('satisfactory');
    expect((await api('POST', '/api/dvirs', { token: c.tokens.driver, body: { driver_id: c.otherDriver.id, truck_id: c.truck.id, kind: 'pre_trip', signature_name: 'X Y', defects: [] } })).status).toBe(403);
  });

  it('PM schedules come due by miles; service records reset them and post an expense', async () => {
    const owner = c.tokens.owner;
    const s = await api('POST', '/api/maintenance/schedules', { token: owner, body: { truck_id: c.truck.id, name: 'Oil & filter', interval_miles: 25_000, last_done_odometer: 388_000, last_done_on: '2026-05-01' } });
    expect(s.status).toBe(201);
    let sched = (await api('GET', '/api/maintenance/schedules', { token: c.tokens.dispatcher })).body.schedules.find((x: any) => x.id === s.body.schedule.id);
    expect(sched).toMatchObject({ status: 'due_soon', miles_remaining: 655 }); // odometer 412,345 from the DVIR
    const rec = await api('POST', '/api/maintenance/records', {
      token: owner,
      body: { truck_id: c.truck.id, performed_on: today(), odometer: 412_600, vendor: 'Rush', description: 'Oil & filter service', cost_cents: 38_950, pm_schedule_id: s.body.schedule.id },
    });
    expect(rec.status).toBe(201);
    sched = (await api('GET', '/api/maintenance/schedules', { token: owner })).body.schedules.find((x: any) => x.id === s.body.schedule.id);
    expect(sched).toMatchObject({ status: 'ok', next_due_odometer: 437_600 });
    const expenses = (await api('GET', `/api/expenses?truck_id=${c.truck.id}`, { token: owner })).body.expenses;
    expect(expenses).toEqual([expect.objectContaining({ category: 'maintenance', amount_cents: 38_950 })]);
    expect((await api('POST', '/api/maintenance/schedules', { token: owner, body: { trailer_id: c.trailer.id, name: 'x', interval_miles: 1 } })).status).toBe(400);
  });

  it('maintenance is staff-only and tenant-scoped', async () => {
    expect((await api('GET', '/api/maintenance/schedules', { token: c.tokens.driver })).status).toBe(403);
    expect((await api('GET', '/api/maintenance/records', { token: other.tokens.owner })).body.records).toEqual([]);
    expect((await api('GET', '/api/dvirs', { token: other.tokens.owner })).body.dvirs).toEqual([]);
    expect((await api('POST', '/api/dvirs', { token: other.tokens.driver, body: { truck_id: c.truck.id, kind: 'pre_trip', signature_name: 'X Y', defects: [] } })).status).toBe(400);
    const any = (await api('GET', '/api/dvirs', { token: c.tokens.owner })).body.dvirs[0];
    expect((await api('POST', `/api/dvirs/${any.id}/review`, { token: other.tokens.driver })).status).toBe(404);
  });
});
