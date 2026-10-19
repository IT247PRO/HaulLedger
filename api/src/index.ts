import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './types';
import { requireAuth } from './lib/auth';
import { auth } from './routes/auth';
import { users } from './routes/users';
import { drivers } from './routes/drivers';
import { trucks, trailers } from './routes/equipment';
import { customers } from './routes/customers';
import { loads } from './routes/loads';
import { alerts } from './routes/alerts';
import { documents } from './routes/documents';
import { pay } from './routes/pay';
import { settlements } from './routes/settlements';
import { invoices } from './routes/invoices';
import { expenses } from './routes/expenses';
import { fuel } from './routes/fuel';
import { reports } from './routes/reports';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});
app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/api/auth', auth);

// Everything below requires a session; tenant scope comes from that session.
const api = new Hono<AppEnv>();
api.use('*', requireAuth);
api.route('/users', users);
api.route('/drivers', drivers);
api.route('/trucks', trucks);
api.route('/trailers', trailers);
api.route('/customers', customers);
api.route('/loads', loads);
api.route('/alerts', alerts);
api.route('/documents', documents);
api.route('/settlements', settlements);
api.route('/invoices', invoices);
api.route('/expenses', expenses);
api.route('/fuel', fuel);
api.route('/reports', reports);
api.route('/', pay);
app.route('/api', api);

export default app;
