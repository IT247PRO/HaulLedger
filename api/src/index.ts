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
import { ifta } from './routes/ifta';
import { dqf } from './routes/dqf';
import { dvirs, maintenance } from './routes/maintenance';
import { hos, integrations, loadboard, tracking } from './routes/integrations';
import { factoring } from './routes/factoring';
import { crm } from './routes/crm';
import { rateCalculator } from './routes/rates';
import { billing, stripeWebhook } from './routes/billing';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Internal error' }, 500);
});
app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/api/auth', auth);
// Signed by Stripe, not by a session.
app.route('/api/stripe/webhook', stripeWebhook);

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
api.route('/ifta', ifta);
api.route('/dqf', dqf);
api.route('/maintenance', maintenance);
api.route('/dvirs', dvirs);
api.route('/integrations', integrations);
api.route('/tracking', tracking);
api.route('/hos', hos);
api.route('/loadboard', loadboard);
api.route('/factoring', factoring);
api.route('/crm', crm);
api.route('/rate-calculator', rateCalculator);
api.route('/billing', billing);
api.route('/', pay);
app.route('/api', api);

export default app;
