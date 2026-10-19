import { useState, type FormEvent } from 'react';
import { api, formatCents, formatScaled, parseScaled } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';
import { useReferenceData } from './Loads';

const currentQuarter = () => {
  const d = new Date().toISOString().slice(0, 10);
  return `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
};
const quarters = () => {
  const out: string[] = [];
  let [y, q] = currentQuarter().split('-Q').map(Number) as [number, number];
  for (let i = 0; i < 8; i++) {
    out.push(`${y}-Q${q}`);
    if (--q === 0) { q = 4; y--; }
  }
  return out;
};
const gal = (m: number | null) => (m === null ? '—' : `${m < 0 ? '−' : ''}${formatScaled(Math.abs(m), 3, 3)}`);

export function Ifta() {
  const { me } = useAuth();
  const [quarter, setQuarter] = useState(currentQuarter());
  const [fuelType, setFuelType] = useState('diesel');
  const report = useApi<any>(`/ifta/report?quarter=${quarter}&fuel_type=${fuelType}`);
  const r = report.data;

  return (
    <div className="space-y-4">
      <PageHeader title="IFTA">
        <select className="input w-auto" value={quarter} onChange={(e) => setQuarter(e.target.value)}>{quarters().map((q) => <option key={q}>{q}</option>)}</select>
        <select className="input w-auto" value={fuelType} onChange={(e) => setFuelType(e.target.value)}><option value="diesel">Diesel</option><option value="gasoline">Gasoline</option></select>
        <a className="btn-secondary" href={`/api/ifta/report.csv?quarter=${quarter}&fuel_type=${fuelType}`}>Download CSV</a>
      </PageHeader>
      <ErrorText error={report.error} />
      {!r ? <Loading /> : (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label="Total miles" value={r.total_miles.toLocaleString()} />
            <Stat label="Tax-paid gallons" value={gal(r.total_gallons_milli)} />
            <Stat label="Fleet MPG" value={r.mpg_x100 === null ? '—' : formatScaled(r.mpg_x100, 2)} />
            <Stat label="Net tax due" value={r.total_tax_due_cents === null ? 'Incomplete' : formatCents(r.total_tax_due_cents)} />
          </div>
          {r.warnings.length > 0 && (
            <div className="card border-amber-200 bg-amber-50 text-sm text-amber-900">
              <p className="mb-1 font-medium">Fix before filing ({r.warnings.length})</p>
              <ul className="list-disc space-y-0.5 pl-5">{r.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          <section className="card overflow-x-auto">
            <table className="table">
              <thead><tr><th>Jurisdiction</th><th className="text-right">Miles</th><th className="text-right">Taxable gal</th><th className="text-right">Tax-paid gal</th><th className="text-right">Net taxable gal</th><th className="text-right">Rate</th><th className="text-right">Tax due / (credit)</th></tr></thead>
              <tbody>
                {r.lines.map((l: any) => (
                  <tr key={l.state}>
                    <td className="font-medium">{l.state}</td>
                    <td className="text-right tabular-nums">{l.miles.toLocaleString()}</td>
                    <td className="text-right tabular-nums">{gal(l.taxable_gallons_milli)}</td>
                    <td className="text-right tabular-nums">{gal(l.tax_paid_gallons_milli)}</td>
                    <td className="text-right tabular-nums">{gal(l.net_taxable_gallons_milli)}</td>
                    <td className="text-right tabular-nums">{l.rate_x10000 === null ? <span className="text-amber-700">missing</span> : `$${formatScaled(l.rate_x10000, 4, 4)}`}</td>
                    <td className={`text-right tabular-nums ${l.tax_due_cents < 0 ? 'text-green-700' : ''}`}>{l.tax_due_cents === null ? '—' : formatCents(l.tax_due_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">Taxable gallons = jurisdiction miles ÷ fleet MPG (two decimals). Fuel not tied to a truck, reefer fuel and DEF are excluded.</p>
          </section>
          <section className="card overflow-x-auto">
            <h2 className="mb-2 font-medium">By truck</h2>
            <table className="table"><thead><tr><th>Truck</th><th className="text-right">Miles</th><th className="text-right">Gallons</th><th className="text-right">MPG</th></tr></thead>
              <tbody>{r.trucks.map((t: any) => <tr key={t.unit_number}><td>{t.unit_number}</td><td className="text-right">{t.miles.toLocaleString()}</td><td className="text-right">{gal(t.gallons_milli)}</td><td className="text-right">{t.gallons_milli ? (t.miles / (t.gallons_milli / 1000)).toFixed(2) : '—'}</td></tr>)}</tbody>
            </table>
          </section>
          <OtherMiles quarter={quarter} onDone={report.reload} />
          {me?.role === 'owner' && <Rates quarter={quarter} fuelType={fuelType} onDone={report.reload} />}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="card"><p className="text-xs text-slate-500 uppercase">{label}</p><p className="text-xl font-semibold tabular-nums">{value}</p></div>;
}

function OtherMiles({ quarter, onDone }: { quarter: string; onDone: () => void }) {
  const list = useApi<{ miles: any[] }>(`/ifta/miles?quarter=${quarter}`);
  const ref = useReferenceData();
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api('/ifta/miles', { method: 'POST', body: { truck_id: f.get('truck_id'), traveled_on: f.get('traveled_on'), state: String(f.get('state')).toUpperCase(), miles: Number(f.get('miles')), note: f.get('note') || null } });
      form.reset();
      setError(null);
      list.reload();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <section className="card space-y-3">
      <div><h2 className="font-medium">Miles not on a load</h2><p className="text-sm text-slate-500">Bobtail, repositioning, trips to the shop — they count for IFTA too.</p></div>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <Field label="Truck"><select className="input" name="truck_id" required>{ref.trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}</select></Field>
        <Field label="Date"><input className="input" type="date" name="traveled_on" required /></Field>
        <Field label="State"><input className="input w-16" name="state" maxLength={2} required /></Field>
        <Field label="Miles"><input className="input w-24" type="number" min={1} name="miles" required /></Field>
        <Field label="Note"><input className="input" name="note" /></Field>
        <button className="btn">Add</button>
      </form>
      <ErrorText error={error} />
      <ul className="text-sm">{list.data?.miles.map((m) => <li key={m.id}>{m.traveled_on} · Truck {m.unit_number} · {m.state} {m.miles} mi {m.note && `· ${m.note}`}</li>)}</ul>
    </section>
  );
}

/** Paste the quarter's rates from the IFTA, Inc. rate table: one "ST 0.2000" per line. */
function Rates({ quarter, fuelType, onDone }: { quarter: string; fuelType: string; onDone: () => void }) {
  const current = useApi<{ rates: any[] }>(`/ifta/rates?quarter=${quarter}`);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    const rates: { state: string; rate_x10000: number }[] = [];
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = /^([A-Za-z]{2})[\s,:]+\$?([\d.]+)$/.exec(line);
      const rate = m ? parseScaled(m[2]!, 4) : null;
      if (!m || rate === null) return setMsg(`Could not read "${line}" — use "TX 0.2000"`);
      rates.push({ state: m[1]!.toUpperCase(), rate_x10000: rate });
    }
    try {
      await api('/ifta/rates', { method: 'PUT', body: { quarter, fuel_type: fuelType, rates } });
      setMsg(`Saved ${rates.length} rates`);
      setText('');
      current.reload();
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  const mine = current.data?.rates.filter((r) => r.fuel_type === fuelType) ?? [];
  return (
    <section className="card space-y-2">
      <h2 className="font-medium">{quarter} {fuelType} tax rates</h2>
      <p className="text-sm text-slate-500">Rates change every quarter. Copy them from the IFTA, Inc. tax rate matrix; HaulLedger never assumes a rate.</p>
      {mine.length > 0 && <p className="text-sm">{mine.map((r) => `${r.state} $${formatScaled(r.rate_x10000, 4, 4)}`).join(' · ')}</p>}
      <textarea className="input font-mono" rows={4} placeholder={'TX 0.2000\nOK 0.1900'} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center gap-3"><button className="btn" onClick={() => void save()}>Save rates</button>{msg && <span className="text-sm">{msg}</span>}</div>
    </section>
  );
}
