import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import type { Role } from './api';
import { Login, Signup } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { LoadsList, NewLoad } from './pages/Loads';
import { LoadDetail } from './pages/LoadDetail';
import { Drivers } from './pages/Drivers';
import { Equipment } from './pages/Equipment';
import { Customers } from './pages/Customers';
import { Users } from './pages/Users';
import { MyLoads } from './pages/MyLoads';

const NAV: { to: string; label: string; roles: Role[] }[] = [
  { to: '/', label: 'Dashboard', roles: ['owner', 'dispatcher'] },
  { to: '/', label: 'My loads', roles: ['driver'] },
  { to: '/loads', label: 'Loads', roles: ['owner', 'dispatcher'] },
  { to: '/drivers', label: 'Drivers', roles: ['owner', 'dispatcher'] },
  { to: '/equipment', label: 'Equipment', roles: ['owner', 'dispatcher'] },
  { to: '/customers', label: 'Customers', roles: ['owner', 'dispatcher'] },
  { to: '/users', label: 'Team logins', roles: ['owner'] },
];

export function App() {
  const { me, loading, logout } = useAuth();
  if (loading) return null;
  if (!me) {
    return (
      <Routes>
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  const staff = me.role !== 'driver';
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold text-blue-800">HaulLedger</span>
          <nav className="flex flex-wrap gap-1 text-sm">
            {NAV.filter((n) => n.roles.includes(me.role)).map((n) => (
              <NavLink
                key={n.label}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) => `rounded px-2 py-1 ${isActive ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:text-slate-900'}`}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-500">
            <span>
              {me.name} · {me.tenant_name}
            </span>
            <button className="btn-secondary" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={staff ? <Dashboard /> : <MyLoads />} />
          <Route path="/loads/:id" element={<LoadDetail />} />
          {staff && (
            <>
              <Route path="/loads" element={<LoadsList />} />
              <Route path="/loads/new" element={<NewLoad />} />
              <Route path="/drivers" element={<Drivers />} />
              <Route path="/equipment" element={<Equipment />} />
              <Route path="/customers" element={<Customers />} />
            </>
          )}
          {me.role === 'owner' && <Route path="/users" element={<Users />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
