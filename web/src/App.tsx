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
import { Settlements } from './pages/Settlements';
import { SettlementSheet } from './pages/SettlementSheet';
import { DriverPay } from './pages/DriverPay';
import { MyPay } from './pages/MyPay';
import { Billing, InvoiceView } from './pages/Billing';
import { Expenses } from './pages/Expenses';
import { Fuel } from './pages/Fuel';
import { Reports } from './pages/Reports';
import { Ifta } from './pages/Ifta';
import { DqfFile, DqfList } from './pages/Dqf';
import { Maintenance } from './pages/Maintenance';
import { Inspection } from './pages/Inspection';
import { Settings } from './pages/Settings';
import { Tracking } from './pages/Tracking';
import { BookLoad } from './pages/BookLoad';
import { RateCalculator } from './pages/RateCalculator';
import { CustomerProfile } from './pages/CustomerProfile';

const NAV: { group: string; items: { to: string; label: string; roles: Role[] }[] }[] = [
  {
    group: 'Dispatch',
    items: [
      { to: '/', label: 'Dashboard', roles: ['owner', 'dispatcher'] },
      { to: '/', label: 'My loads', roles: ['driver'] },
      { to: '/inspection', label: 'Inspection', roles: ['driver'] },
      { to: '/loads', label: 'Loads', roles: ['owner', 'dispatcher'] },
      { to: '/fleet', label: 'Fleet', roles: ['owner', 'dispatcher'] },
      { to: '/drivers', label: 'Drivers', roles: ['owner', 'dispatcher'] },
      { to: '/equipment', label: 'Equipment', roles: ['owner', 'dispatcher'] },
      { to: '/customers', label: 'Customers', roles: ['owner', 'dispatcher'] },
    ],
  },
  {
    group: 'Money',
    items: [
      { to: '/billing', label: 'Billing', roles: ['owner', 'dispatcher'] },
      { to: '/settlements', label: 'Settlements', roles: ['owner'] },
      { to: '/settlements', label: 'My settlements', roles: ['driver'] },
      { to: '/pay', label: 'My pay & receipts', roles: ['driver'] },
      { to: '/fuel', label: 'Fuel', roles: ['owner', 'dispatcher'] },
      { to: '/expenses', label: 'Expenses', roles: ['owner', 'dispatcher'] },
      { to: '/reports', label: 'Reports', roles: ['owner'] },
      { to: '/rate-calculator', label: 'Rate calculator', roles: ['owner'] },
    ],
  },
  {
    group: 'Compliance',
    items: [
      { to: '/ifta', label: 'IFTA', roles: ['owner', 'dispatcher'] },
      { to: '/dqf', label: 'DQ files', roles: ['owner', 'dispatcher'] },
      { to: '/maintenance', label: 'Maintenance', roles: ['owner', 'dispatcher'] },
    ],
  },
  {
    group: 'Settings',
    items: [
      { to: '/users', label: 'Team logins', roles: ['owner'] },
      { to: '/settings', label: 'Integrations & billing', roles: ['owner'] },
    ],
  },
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
      <header className="border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold text-blue-800">HaulLedger</span>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {NAV.map((g) => ({ ...g, items: g.items.filter((n) => n.roles.includes(me.role)) }))
              .filter((g) => g.items.length)
              .map((g) => (
                <div key={g.group} className="flex flex-wrap items-center gap-1">
                  {staff && <span className="mr-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">{g.group}</span>}
                  {g.items.map((n) => (
                    <NavLink
                      key={n.label}
                      to={n.to}
                      end={n.to === '/'}
                      className={({ isActive }) => `rounded px-2 py-1 ${isActive ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      {n.label}
                    </NavLink>
                  ))}
                </div>
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
      <main className="mx-auto max-w-6xl px-4 py-6 print:p-0">
        <Routes>
          <Route path="/" element={staff ? <Dashboard /> : <MyLoads />} />
          <Route path="/loads/:id" element={<LoadDetail />} />
          {me.role !== 'dispatcher' && <Route path="/settlements" element={<Settlements />} />}
          {me.role !== 'dispatcher' && <Route path="/settlements/:id" element={<SettlementSheet />} />}
          {me.role === 'driver' && <Route path="/pay" element={<MyPay />} />}
          {me.role === 'driver' && <Route path="/inspection" element={<Inspection />} />}
          <Route path="/dqf/:id" element={<DqfFile />} />
          {me.role === 'owner' && <Route path="/drivers/:id/pay" element={<DriverPay />} />}
          {staff && (
            <>
              <Route path="/loads" element={<LoadsList />} />
              <Route path="/loads/new" element={<NewLoad />} />
              <Route path="/loads/book" element={<BookLoad />} />
              <Route path="/fleet" element={<Tracking />} />
              <Route path="/customers/:id" element={<CustomerProfile />} />
              <Route path="/drivers" element={<Drivers />} />
              <Route path="/equipment" element={<Equipment />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/billing" element={<Billing />} />
              <Route path="/invoices/:id" element={<InvoiceView />} />
              <Route path="/expenses" element={<Expenses />} />
              <Route path="/fuel" element={<Fuel />} />
              <Route path="/ifta" element={<Ifta />} />
              <Route path="/dqf" element={<DqfList />} />
              <Route path="/maintenance" element={<Maintenance />} />
            </>
          )}
          {me.role === 'owner' && <Route path="/users" element={<Users />} />}
          {me.role === 'owner' && <Route path="/reports" element={<Reports />} />}
          {me.role === 'owner' && <Route path="/rate-calculator" element={<RateCalculator />} />}
          {me.role === 'owner' && <Route path="/settings" element={<Settings />} />}
          {me.role === 'owner' && <Route path="/billing/subscription" element={<Settings />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
