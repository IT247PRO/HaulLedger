import { z } from 'zod';
import { crudRoutes } from '../lib/crud';
import { optText, usState } from '../lib/validate';

const status = z.enum(['active', 'shop', 'inactive']);
const unitNumber = z.string().trim().min(1).max(50);

const truckFields = {
  unit_number: unitNumber,
  vin: z.string().trim().toUpperCase().max(17).nullable().optional(),
  make: optText,
  model: optText,
  year: z.int().min(1950).max(2100).nullable().optional(),
  plate: optText,
  plate_state: usState.nullable().optional(),
  status: status.optional(),
};

export const trucks = crudRoutes({
  table: 'trucks',
  columns: 'id, unit_number, vin, make, model, year, plate, plate_state, status, created_at, updated_at',
  orderBy: 'unit_number',
  listKey: 'trucks',
  itemKey: 'truck',
  roles: ['owner', 'dispatcher'],
  label: 'Truck',
  createSchema: z.strictObject(truckFields),
  updateSchema: z.strictObject({ ...truckFields, unit_number: unitNumber.optional() }),
});

const trailerFields = {
  unit_number: unitNumber,
  trailer_type: z.enum(['dry_van', 'reefer', 'flatbed', 'step_deck', 'tanker', 'other']).optional(),
  vin: z.string().trim().toUpperCase().max(17).nullable().optional(),
  plate: optText,
  plate_state: usState.nullable().optional(),
  status: status.optional(),
};

export const trailers = crudRoutes({
  table: 'trailers',
  columns: 'id, unit_number, trailer_type, vin, plate, plate_state, status, created_at, updated_at',
  orderBy: 'unit_number',
  listKey: 'trailers',
  itemKey: 'trailer',
  roles: ['owner', 'dispatcher'],
  label: 'Trailer',
  createSchema: z.strictObject(trailerFields),
  updateSchema: z.strictObject({ ...trailerFields, unit_number: unitNumber.optional() }),
});
