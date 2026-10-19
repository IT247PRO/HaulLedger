import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { ErrorText, Field, formValues } from '../components/ui';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="mb-1 text-center text-2xl font-semibold text-blue-800">HaulLedger</p>
        <p className="mb-6 text-center text-sm text-slate-500">{title}</p>
        <div className="card">{children}</div>
      </div>
    </div>
  );
}

export function Login() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    try {
      await login(v.email ?? '', v.password ?? '');
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Shell title="Sign in to your carrier">
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Email">
          <input className="input" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password">
          <input className="input" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <ErrorText error={error} />
        <button className="btn w-full">Sign in</button>
        <p className="text-center text-sm text-slate-500">
          New carrier? <Link className="text-blue-700" to="/signup">Create an account</Link>
        </p>
      </form>
    </Shell>
  );
}

export function Signup() {
  const { signup } = useAuth();
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    try {
      await signup({ company_name: v.company_name ?? '', name: v.name ?? '', email: v.email ?? '', password: v.password ?? '' });
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Shell title="Set up your carrier">
      <form className="space-y-3" onSubmit={submit}>
        <Field label="Company name">
          <input className="input" name="company_name" required />
        </Field>
        <Field label="Your name">
          <input className="input" name="name" required />
        </Field>
        <Field label="Email">
          <input className="input" name="email" type="email" required />
        </Field>
        <Field label="Password (10+ characters)">
          <input className="input" name="password" type="password" minLength={10} required />
        </Field>
        <ErrorText error={error} />
        <button className="btn w-full">Create account</button>
        <p className="text-center text-sm text-slate-500">
          Have an account? <Link className="text-blue-700" to="/">Sign in</Link>
        </p>
      </form>
    </Shell>
  );
}
