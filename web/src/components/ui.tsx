import type { ReactNode } from 'react';
import { STATUS_LABEL } from '../api';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
}

const STATUS_COLOR: Record<string, string> = {
  planned: 'bg-slate-100 text-slate-700',
  dispatched: 'bg-blue-100 text-blue-800',
  at_pickup: 'bg-amber-100 text-amber-800',
  in_transit: 'bg-indigo-100 text-indigo-800',
  delivered: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-700',
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-slate-100 text-slate-600',
  shop: 'bg-amber-100 text-amber-800',
  draft: 'bg-amber-100 text-amber-800',
  finalized: 'bg-blue-100 text-blue-800',
  paid: 'bg-green-100 text-green-800',
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  rejected: 'bg-red-100 text-red-700',
};

export function Badge({ value }: { value: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[value] ?? 'bg-slate-100'}`}>
      {STATUS_LABEL[value] ?? value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function Loading() {
  return <p className="text-sm text-slate-500">Loading…</p>;
}

/** Form values from <input name>; empty strings become null so optional fields clear. */
export function formValues(form: HTMLFormElement): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = String(v).trim() === '' ? null : String(v).trim();
  return out;
}
