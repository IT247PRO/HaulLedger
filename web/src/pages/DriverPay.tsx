import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatCents, formatPayRate, label, parseDollars, parseScaled, PAY_KIND_LABEL } from '../api';
import { ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

const CHARGE_CATEGORIES = {
  w2: ['benefits', 'garnishment', 'uniform', 'equipment_damage', 'other'],
  '1099': ['fuel', 'insurance', 'cargo_insurance', 'occupational_accident', 'truck_lease', 'eld', 'plates_permits', 'maintenance', 'equipment_damage', 'other'],
} as const;
const today = () => new Date().toISOString().slice(0, 10);

/** Owner's pay setup for one driver: rates, escrow terms, and everything that feeds a settlement. */
export function DriverPay() {
  const { id } = useParams();
  const driver = useApi<{ driver: any }>(`/drivers/${id}`);
  const rates = useApi<{ pay_rates: any[] }>(`/pay-rates?driver_id=${id}`);
  const advances = useApi<{ advances: any[] }>(`/advances?driver_id=${id}`);
  const charges = useApi<{ charges: any[] }>(`/charges?driver_id=${id}`);
  const recurring = useApi<{ recurring_deductions: any[] }>(`/recurring-deductions?driver_id=${id}`);
  const reimbursements = useApi<{ reimbursements: any[] }>(`/reimbursements?driver_id=${id}`);
  const d = driver.data?.driver;
  const escrow = useApi<any>(d?.pay_track === '1099' ? `/escrow?driver_id=${id}` : null);
  if (!d) return driver.error ? <ErrorText error={driver.error} /> : <Loading />;
  const track = d.pay_track as 'w2' | '1099';

  return (
    <div className="space-y-6">
      <PageHeader title={`Pay — ${d.first_name} ${d.last_name}`}>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-sm">{track === 'w2' ? 'W-2 company driver' : '1099 contractor / owner-operator'}</span>
        <Link className="btn-secondary" to="/settlements">Settlements</Link>
      </PageHeader>

      <Panel title="Pay rates" hint="Rates of different kinds combine on each load (e.g. per mile + extra stops). End a rate to change it; history is kept.">
        <PayRateForm driverId={d.id} track={track} onDone={rates.reload} />
        <Table
          head={['Kind', 'Rate', 'From', 'To', '']}
          rows={(rates.data?.pay_rates ?? []).map((r) => [
            PAY_KIND_LABEL[r.kind],
            formatPayRate(r),
            r.effective_from,
            r.effective_to ?? 'open',
            !r.effective_to && <EndRate key="end" id={r.id} onDone={rates.reload} />,
          ])}
        />
      </Panel>

      {track === '1099' && <EscrowPanel driver={d} escrow={escrow.data} reload={() => { escrow.reload(); driver.reload(); }} />}

      <Panel title="Advances" hint="Cash, Comchek or fuel-card advances. Recovered on the next settlement, line by line.">
        <MoneyForm
          fields={[{ name: 'issued_on', label: 'Issued', type: 'date', def: today() }, { name: 'method', label: 'Method', options: ['cash', 'comchek', 'efs_check', 'fuel_card', 'ach', 'other'] }, { name: 'reference', label: 'Check / ref #' }, { name: 'memo', label: 'Memo' }]}
          submit={(v) => api('/advances', { method: 'POST', body: { driver_id: d.id, ...v } })}
          onDone={advances.reload}
        />
        <Table head={['Issued', 'Method', 'Reference', 'Amount', 'Settled']} rows={(advances.data?.advances ?? []).map((a) => [a.issued_on, label(a.method), a.reference ?? '—', formatCents(a.amount_cents), a.settled ? 'Yes' : 'Pending'])} />
      </Panel>

      <Panel title="Recurring deductions" hint="Taken on every settlement while active. Each one is recorded as its own charge so the line has a source.">
        <MoneyForm
          fields={[{ name: 'category', label: 'Category', options: [...CHARGE_CATEGORIES[track]] }, { name: 'description', label: 'Description', required: true }]}
          submit={(v) => api('/recurring-deductions', { method: 'POST', body: { driver_id: d.id, ...v } })}
          onDone={recurring.reload}
        />
        <Table
          head={['Category', 'Description', 'Per settlement', 'Status']}
          rows={(recurring.data?.recurring_deductions ?? []).map((r) => [
            label(r.category),
            r.description,
            formatCents(r.amount_cents),
            <button key="t" className="text-blue-700" onClick={() => void api(`/recurring-deductions/${r.id}`, { method: 'PATCH', body: { active: !r.active } }).then(recurring.reload)}>{r.active ? 'Active — pause' : 'Paused — resume'}</button>,
          ])}
        />
      </Panel>

      <Panel title="One-off deductions" hint={track === 'w2' ? 'Payroll-style items only. Tax withholding is handled by payroll.' : 'Lease charges. Fuel-card purchases are added by the fuel import.'}>
        <MoneyForm
          fields={[{ name: 'category', label: 'Category', options: [...CHARGE_CATEGORIES[track]] }, { name: 'incurred_on', label: 'Date', type: 'date', def: today() }, { name: 'description', label: 'Description', required: true }]}
          submit={(v) => api('/charges', { method: 'POST', body: { driver_id: d.id, ...v } })}
          onDone={charges.reload}
        />
        <Table head={['Date', 'Category', 'Description', 'Amount', 'Settled']} rows={(charges.data?.charges ?? []).map((ch) => [ch.incurred_on, label(ch.category), ch.description, formatCents(ch.amount_cents), ch.settled ? 'Yes' : 'Pending'])} />
      </Panel>

      <Panel title="Reimbursements" hint="Drivers submit lumper, scale and toll receipts from their phone; approve them here.">
        <MoneyForm
          fields={[{ name: 'category', label: 'Category', options: ['lumper', 'scale', 'tolls', 'parking', 'repair', 'fuel', 'other'] }, { name: 'incurred_on', label: 'Date', type: 'date', def: today() }, { name: 'description', label: 'Description', required: true }]}
          submit={(v) => api('/reimbursements', { method: 'POST', body: { driver_id: d.id, ...v } })}
          onDone={reimbursements.reload}
        />
        <Table
          head={['Date', 'Category', 'Description', 'Amount', 'Receipt', 'Status']}
          rows={(reimbursements.data?.reimbursements ?? []).map((r) => [
            r.incurred_on,
            label(r.category),
            r.description,
            formatCents(r.amount_cents),
            r.document_id ? <a key="r" className="text-blue-700" href={`/api/documents/${r.document_id}/file`} target="_blank" rel="noreferrer">View</a> : '—',
            r.settled ? 'Paid' : r.status === 'pending' ? (
              <span key="s" className="flex gap-2">
                <button className="text-green-700" onClick={() => void api(`/reimbursements/${r.id}`, { method: 'PATCH', body: { status: 'approved' } }).then(reimbursements.reload)}>Approve</button>
                <button className="text-red-700" onClick={() => void api(`/reimbursements/${r.id}`, { method: 'PATCH', body: { status: 'rejected' } }).then(reimbursements.reload)}>Reject</button>
              </span>
            ) : label(r.status),
          ])}
        />
      </Panel>
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-medium">{title}</h2>
        {hint && <p className="text-sm text-slate-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-400">Nothing yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

interface FieldSpec { name: string; label: string; type?: string; def?: string; options?: string[]; required?: boolean }

/** A one-line form: an amount in dollars plus a few fields. */
function MoneyForm({ fields, submit, onDone }: { fields: FieldSpec[]; submit: (v: Record<string, unknown>) => Promise<unknown>; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const amount = parseDollars(String(f.get('amount') ?? ''));
    if (!amount) return setError('Enter an amount like 125.00');
    const v: Record<string, unknown> = { amount_cents: amount };
    for (const spec of fields) {
      const value = String(f.get(spec.name) ?? '').trim();
      if (value) v[spec.name] = value;
    }
    try {
      await submit(v);
      setError(null);
      form.reset();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={onSubmit}>
      <Field label="Amount $"><input className="input w-28" name="amount" inputMode="decimal" required /></Field>
      {fields.map((s) => (
        <Field key={s.name} label={s.label}>
          {s.options ? (
            <select className="input" name={s.name}>{s.options.map((o) => <option key={o} value={o}>{label(o)}</option>)}</select>
          ) : (
            <input className="input" name={s.name} type={s.type ?? 'text'} defaultValue={s.def} required={s.required} />
          )}
        </Field>
      ))}
      <button className="btn">Add</button>
      <div className="w-full"><ErrorText error={error} /></div>
    </form>
  );
}

function PayRateForm({ driverId, track, onDone }: { driverId: string; track: 'w2' | '1099'; onDone: () => void }) {
  const [kind, setKind] = useState('per_mile');
  const [error, setError] = useState<string | null>(null);
  const unit: Record<string, { label: string; places: number; placeholder: string }> = {
    per_mile: { label: '$ per mile', places: 5, placeholder: '0.625' },
    percent: { label: '% of gross', places: 2, placeholder: '28' },
    per_stop: { label: '$ per stop', places: 2, placeholder: '50.00' },
    hourly: { label: '$ per hour', places: 2, placeholder: '27.50' },
    per_diem: { label: '$ per day', places: 2, placeholder: '69.00' },
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const rate = parseScaled(String(f.get('rate')), unit[kind]!.places);
    if (rate === null) return setError(`Rate must look like ${unit[kind]!.placeholder}`);
    try {
      await api('/pay-rates', {
        method: 'POST',
        body: { driver_id: driverId, kind, rate, basis: f.get('basis') || null, effective_from: f.get('effective_from') },
      });
      setError(null);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const kinds = Object.keys(PAY_KIND_LABEL).filter((k) => k !== 'per_diem' || track === 'w2');
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <Field label="Kind">
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => <option key={k} value={k}>{PAY_KIND_LABEL[k]}</option>)}
        </select>
      </Field>
      <Field label={unit[kind]!.label}><input className="input w-28" name="rate" placeholder={unit[kind]!.placeholder} required /></Field>
      {kind === 'per_mile' && (
        <Field label="Miles paid"><select className="input" name="basis"><option value="loaded">Loaded miles</option><option value="all">Loaded + empty</option></select></Field>
      )}
      {kind === 'per_stop' && (
        <Field label="Stops paid"><select className="input" name="basis"><option value="extra">Extra stops only</option><option value="all">Every stop</option></select></Field>
      )}
      <Field label="Effective from"><input className="input" type="date" name="effective_from" defaultValue={today()} required /></Field>
      <button className="btn">Add rate</button>
      <div className="w-full"><ErrorText error={error} /></div>
    </form>
  );
}

function EndRate({ id, onDone }: { id: string; onDone: () => void }) {
  return (
    <button
      className="text-blue-700"
      onClick={() => {
        const date = prompt('Last day this rate applies (YYYY-MM-DD)', today());
        if (date) void api(`/pay-rates/${id}/end`, { method: 'POST', body: { effective_to: date } }).then(onDone).catch((e: Error) => alert(e.message));
      }}
    >
      End rate
    </button>
  );
}

function EscrowPanel({ driver, escrow, reload }: { driver: any; escrow: any; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function saveTerms(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const target = parseDollars(String(f.get('target') || '0'));
    const per = parseDollars(String(f.get('per') || '0'));
    if (target === null || per === null) return setError('Amounts must look like 2500.00');
    try {
      await api(`/drivers/${driver.id}`, { method: 'PATCH', body: { escrow_target_cents: target, escrow_per_settlement_cents: per } });
      setError(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Panel title="Maintenance escrow" hint="Held from each settlement until the target is reached (49 CFR 376.12(k)). Post interest at least quarterly; releases are paid on the next settlement.">
      <form className="flex flex-wrap items-end gap-2" onSubmit={saveTerms}>
        <Field label="Target $"><input className="input w-32" name="target" defaultValue={(driver.escrow_target_cents / 100).toFixed(2)} /></Field>
        <Field label="Hold per settlement $"><input className="input w-32" name="per" defaultValue={(driver.escrow_per_settlement_cents / 100).toFixed(2)} /></Field>
        <button className="btn-secondary">Save terms</button>
        <p className="ml-auto text-sm">Balance <strong className="tabular-nums">{formatCents(escrow?.balance_cents ?? 0)}</strong></p>
      </form>
      <ErrorText error={error} />
      <MoneyForm
        fields={[{ name: 'kind', label: 'Entry', options: ['interest', 'release', 'withdrawal'] }, { name: 'occurred_on', label: 'Date', type: 'date', def: today() }, { name: 'memo', label: 'Memo (required)', required: true }]}
        submit={(v) => api('/escrow', { method: 'POST', body: { driver_id: driver.id, ...v } })}
        onDone={reload}
      />
      <Table
        head={['Date', 'Entry', 'Memo', 'Amount', 'Balance']}
        rows={(escrow?.ledger ?? []).map((e: any) => [e.occurred_on, label(e.kind), e.memo ?? e.settlement_number ?? '', formatCents(e.amount_cents), formatCents(e.balance_cents)])}
      />
    </Panel>
  );
}
