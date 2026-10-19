import { env } from 'cloudflare:workers';
import app from '../src/index';

export interface Res<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(
    path,
    { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
    env,
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

let seq = 0;
const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;
export const PASSWORD = 'correct-horse-battery';

/** A carrier with an owner, dispatcher, one driver login, and equipment ready to dispatch. */
export async function makeCarrier(name: string) {
  const ownerEmail = `${unique('owner')}@${name.toLowerCase()}.test`;
  const signup = await api('POST', '/api/auth/signup', {
    body: { company_name: name, name: `${name} Owner`, email: ownerEmail, password: PASSWORD },
  });
  if (signup.status !== 201) throw new Error(`signup failed: ${JSON.stringify(signup.body)}`);
  const owner = signup.body.token as string;

  const driver = (await api('POST', '/api/drivers', {
    token: owner,
    body: { first_name: 'Dana', last_name: name, pay_track: '1099', license_expires_on: '2030-01-01', medical_expires_on: '2030-01-01' },
  })).body.driver;
  const otherDriver = (await api('POST', '/api/drivers', {
    token: owner,
    body: { first_name: 'Other', last_name: name, pay_track: 'w2' },
  })).body.driver;
  const truck = (await api('POST', '/api/trucks', { token: owner, body: { unit_number: '101' } })).body.truck;
  const trailer = (await api('POST', '/api/trailers', { token: owner, body: { unit_number: '5301' } })).body.trailer;
  const customer = (await api('POST', '/api/customers', { token: owner, body: { name: `${name} Logistics` } })).body.customer;

  const login = async (role: 'dispatcher' | 'driver', driverId?: string) => {
    const email = `${unique(role)}@${name.toLowerCase()}.test`;
    const created = await api('POST', '/api/users', {
      token: owner,
      body: { email, name: `${name} ${role}`, role, driver_id: driverId, password: PASSWORD },
    });
    if (created.status !== 201) throw new Error(`user create failed: ${JSON.stringify(created.body)}`);
    return (await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).body.token as string;
  };
  const dispatcher = await login('dispatcher');
  const driverToken = await login('driver', driver.id);

  const load = (await api('POST', '/api/loads', {
    token: owner,
    body: {
      customer_id: customer.id,
      driver_id: driver.id,
      truck_id: truck.id,
      trailer_id: trailer.id,
      rate_cents: 250_000,
      loaded_miles: 812,
      stops: [
        { kind: 'pickup', city: 'Dallas', state: 'TX' },
        { kind: 'delivery', city: 'Atlanta', state: 'GA' },
      ],
    },
  })).body.load;

  return { tokens: { owner, dispatcher, driver: driverToken }, driver, otherDriver, truck, trailer, customer, load };
}

export type Carrier = Awaited<ReturnType<typeof makeCarrier>>;

export const stops = [
  { kind: 'pickup', city: 'Memphis', state: 'TN' },
  { kind: 'delivery', city: 'Chicago', state: 'IL' },
];
