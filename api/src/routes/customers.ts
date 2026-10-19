import { z } from 'zod';
import { crudRoutes } from '../lib/crud';
import { optText } from '../lib/validate';

const fields = {
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['broker', 'shipper']).optional(),
  mc_number: optText,
  email: z.email().nullable().optional(),
  phone: optText,
  billing_address: optText,
};

export const customers = crudRoutes({
  table: 'customers',
  columns: 'id, name, kind, mc_number, email, phone, billing_address, created_at, updated_at',
  orderBy: 'name',
  listKey: 'customers',
  itemKey: 'customer',
  roles: ['owner', 'dispatcher'],
  label: 'Customer',
  createSchema: z.strictObject(fields),
  updateSchema: z.strictObject({ ...fields, name: fields.name.optional() }),
});
