import { useState, type FormEvent } from 'react';
import { api, formatCents, formatScaled, parseScaled } from '../api';
import { ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

/** Owner settings: subscription, integrations, factoring companies. */
export function Settings() {
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />
      <Subscription />
      <Integrations />
      <FactoringCompanies />
    </div>
  );
}

function Subscription() {
  const { data, error } = useApi<any>('/billing');
  const [msg, setMsg] = useState<string | null>(null);
  const go = async (path: string, body?: unknown) => {
    try {
      const res = await api<{ url: string }>(path, { method: 'POST', body });
      window.location.href = res.url;
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section className="card space-y-3" id="subscription">
      <h2 className="font-medium">Subscription</h2>
      <ErrorText error={error} />
      {!data ? <Loading /> : (
        <>
          <p className="text-sm">Status: <strong>{data.subscription_status === 'none' ? 'No subscription' : data.subscription_status}</strong>{data.plan && ` · ${data.plans[data.plan].label} plan`}{data.current_period_end && ` · renews ${data.current_period_end.slice(0, 10)}`}</p>
          <p className="text-sm text-slate-500">One flat price per carrier with unlimited users — never per user, never per load, and nothing taken from your freight.</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.plans as Record<string, { label: string; monthly_cents: number }>).map(([key, p]) => (
              <button key={key} className={data.plan === key ? 'btn-secondary' : 'btn'} disabled={!data.configured || data.plan === key} onClick={() => void go('/billing/checkout', { plan: key })}>
                {p.label} — {formatCents(p.monthly_cents)}/mo
              </button>
            ))}
            {data.has_customer && <button className="btn-secondary" onClick={() => void go('/billing/portal')}>Manage billing</button>}
          </div>
          {!data.configured && <p className="text-xs text-amber-700">Billing is not configured on this deployment (Stripe keys not set).</p>}
          <ErrorText error={msg} />
        </>
      )}
    </section>
  );
}

const FIELDS: Record<string, { config: string[]; secret: { name: string; label: string; type?: string }[] }> = {
  traccar: { config: ['base_url'], secret: [{ name: 'token', label: 'API token', type: 'password' }] },
  samsara: { config: [], secret: [{ name: 'api_token', label: 'API token', type: 'password' }] },
  motive: { config: [], secret: [{ name: 'api_key', label: 'API key', type: 'password' }] },
};

function Integrations() {
  const { data, reload } = useApi<{ integrations: any[] }>('/integrations');
  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-medium">Integrations</h2>
        <p className="text-sm text-slate-500">Credentials are encrypted at rest and never shown again after saving.</p>
      </div>
      {!data ? <Loading /> : data.integrations.map((i) => <IntegrationRow key={i.provider} i={i} onChange={reload} />)}
    </section>
  );
}

function IntegrationRow({ i, onChange }: { i: any; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const spec = FIELDS[i.provider];
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const config = Object.fromEntries((spec?.config ?? []).map((k) => [k, String(f.get(k) ?? '')]));
    const secret = Object.fromEntries((spec?.secret ?? []).map((s) => [s.name, String(f.get(s.name) ?? '')]));
    try {
      await api(`/integrations/${i.provider}`, { method: 'PUT', body: { config, secret } });
      setOpen(false);
      setMsg('Saved');
      onChange();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }
  async function test() {
    try {
      const r = await api<{ detail: string }>(`/integrations/${i.provider}/test`, { method: 'POST' });
      setMsg(`Connected: ${r.detail}`);
    } catch (err) {
      setMsg((err as Error).message);
    }
  }
  return (
    <div className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{i.label} {i.connected && <span className="ml-2 text-green-700">connected</span>}</p>
        <div className="flex gap-2">
          {i.available ? (
            <>
              {i.connected && <button className="btn-secondary" onClick={() => void test()}>Test</button>}
              <button className="btn-secondary" onClick={() => setOpen(!open)}>{i.connected ? 'Update' : 'Connect'}</button>
              {i.connected && <button className="btn-secondary" onClick={() => void api(`/integrations/${i.provider}`, { method: 'DELETE' }).then(onChange)}>Disconnect</button>}
            </>
          ) : <span className="text-slate-500">Not available yet</span>}
        </div>
      </div>
      {i.note && <p className="mt-1 text-slate-500">{i.note}</p>}
      {open && spec && (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={save}>
          {spec.config.map((k) => <Field key={k} label="Server URL"><input className="input w-72" name={k} type="url" placeholder="https://gps.yourcompany.com" defaultValue={i.config?.[k] ?? ''} required /></Field>)}
          {spec.secret.map((s) => <Field key={s.name} label={s.label}><input className="input w-72" name={s.name} type={s.type ?? 'text'} autoComplete="off" required /></Field>)}
          <button className="btn">Save</button>
        </form>
      )}
      {msg && <p className="mt-1">{msg}</p>}
    </div>
  );
}

function FactoringCompanies() {
  const { data, reload } = useApi<{ companies: any[] }>('/factoring/companies');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const fee = parseScaled(String(f.get('fee') || '0'), 2);
    if (fee === null) return setError('Fee is a percentage like 2.5');
    try {
      await api('/factoring/companies', { method: 'POST', body: { name: f.get('name'), submission_email: f.get('submission_email'), fee_bp: fee, recourse: f.get('recourse') === 'on' } });
      form.reset();
      setError(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <section className="card space-y-3">
      <div><h2 className="font-medium">Factoring companies</h2><p className="text-sm text-slate-500">Invoices are submitted to your factor's schedule inbox with the rate con, BOL and POD attached.</p></div>
      <ul className="text-sm">{data?.companies.map((f) => <li key={f.id}>{f.name} · {f.submission_email} · fee {formatScaled(f.fee_bp, 2)}% · {f.recourse ? 'recourse' : 'non-recourse'}</li>)}</ul>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <Field label="Name"><input className="input" name="name" placeholder="RTS Financial" required /></Field>
        <Field label="Schedule email"><input className="input" type="email" name="submission_email" required /></Field>
        <Field label="Fee %"><input className="input w-20" name="fee" placeholder="2.5" /></Field>
        <label className="flex items-center gap-1 pb-2 text-sm"><input type="checkbox" name="recourse" /> Recourse</label>
        <button className="btn">Add</button>
      </form>
      <ErrorText error={error} />
    </section>
  );
}
