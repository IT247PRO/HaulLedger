import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, parseDollars } from '../api';
import { ErrorText, Field, PageHeader } from '../components/ui';
import { stopsPayload, StopsEditor, type StopDraft } from './Loads';

/** Book a load found on DAT / Truckstop (or offered directly) from its rate confirmation. */
export function BookLoad() {
  const navigate = useNavigate();
  const [stops, setStops] = useState<StopDraft[]>([
    { kind: 'pickup', facility_name: '', city: '', state: '', scheduled_start: '' },
    { kind: 'delivery', facility_name: '', city: '', state: '', scheduled_start: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim() || null;
    const rate = parseDollars(get('rate') ?? '');
    if (!rate) return setError('Enter the rate like 2750.00');
    try {
      const res = await api<{ load_id: string }>('/loadboard/book', {
        method: 'POST',
        body: {
          source: get('source'), posting_id: get('posting_id'),
          broker: { name: get('broker_name'), mc_number: get('mc_number'), email: get('broker_email'), phone: get('broker_phone') },
          reference_number: get('reference_number'), rate_cents: rate, loaded_miles: get('loaded_miles') ? Number(get('loaded_miles')) : null,
          commodity: get('commodity'), weight_lbs: get('weight_lbs') ? Number(get('weight_lbs')) : null, notes: get('notes'), stops: stopsPayload(stops),
        },
      });
      navigate(`/loads/${res.load_id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div>
      <PageHeader title="Book a load from a rate confirmation" />
      <form className="card space-y-4" onSubmit={submit}>
        <p className="text-sm text-slate-500">Copy the rate con details. The broker is matched by MC number (or added), and the load is created ready to dispatch — attach the rate con PDF on the next screen.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Found on"><select className="input" name="source"><option value="dat">DAT</option><option value="truckstop">Truckstop</option><option value="direct">Direct from broker</option><option value="other">Other</option></select></Field>
          <Field label="Posting / order #"><input className="input" name="posting_id" /></Field>
          <Field label="Broker name"><input className="input" name="broker_name" required /></Field>
          <Field label="Broker MC #"><input className="input" name="mc_number" /></Field>
          <Field label="Broker email"><input className="input" type="email" name="broker_email" /></Field>
          <Field label="Broker phone"><input className="input" name="broker_phone" /></Field>
          <Field label="Broker load / ref #"><input className="input" name="reference_number" /></Field>
          <Field label="Rate (all-in $)"><input className="input" name="rate" inputMode="decimal" required /></Field>
          <Field label="Loaded miles"><input className="input" type="number" name="loaded_miles" /></Field>
          <Field label="Commodity"><input className="input" name="commodity" /></Field>
          <Field label="Weight (lbs)"><input className="input" type="number" name="weight_lbs" /></Field>
        </div>
        <StopsEditor stops={stops} onChange={setStops} />
        <Field label="Notes / special instructions"><textarea className="input" name="notes" rows={2} /></Field>
        <ErrorText error={error} />
        <button className="btn">Book load</button>
      </form>
    </div>
  );
}
