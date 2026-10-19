import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/lib/csv';
import { classifyProduct, normalizeRow, parseDateTime, parseGallons, parseMoney, resolveColumns } from '../src/lib/fuel-import';

describe('parseCsv', () => {
  it('handles quotes, embedded commas, escaped quotes, CRLF and a BOM', () => {
    const text = '﻿a,b,c\r\n"Pilot #412, Texarkana","say ""hi""",3\r\n\r\nx,,z\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['Pilot #412, Texarkana', 'say "hi"', '3'],
      ['x', '', 'z'],
    ]);
  });
});

describe('money and volume parsing (no floats)', () => {
  it('parses dollars to cents', () => {
    expect(parseMoney('$1,234.56')).toBe(123_456);
    expect(parseMoney('412.3')).toBe(41_230);
    expect(parseMoney('(12.00)')).toBe(-1_200);
    expect(parseMoney('-0.50')).toBe(-50);
    expect(parseMoney('3.4567')).toBe(346); // sub-cent rounds half-up
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });
  it('parses gallons to thousandths', () => {
    expect(parseGallons('120.456')).toBe(120_456);
    expect(parseGallons('1,050.5')).toBe(1_050_500);
    expect(parseGallons('98.12345')).toBe(98_123);
    expect(parseGallons('')).toBe(0);
    expect(parseGallons('x')).toBeNull();
  });
});

describe('dates', () => {
  it('reads the formats fuel exports use', () => {
    expect(parseDateTime('10/12/2026', '14:35')).toBe('2026-10-12T14:35:00.000Z');
    expect(parseDateTime('10/12/26 2:05 PM')).toBe('2026-10-12T14:05:00.000Z');
    expect(parseDateTime('2026-10-12')).toBe('2026-10-12T00:00:00.000Z');
    expect(parseDateTime('02/30/2026')).toBeNull();
    expect(parseDateTime('yesterday')).toBeNull();
  });
});

describe('products', () => {
  it('separates IFTA fuel from DEF, reefer and cash', () => {
    expect(classifyProduct('ULSD')).toBe('diesel');
    expect(classifyProduct('DSL #2')).toBe('diesel');
    expect(classifyProduct('B20 BIODIESEL')).toBe('diesel');
    expect(classifyProduct('DEF')).toBe('def');
    expect(classifyProduct('RFR - Reefer Diesel')).toBe('reefer');
    expect(classifyProduct('CADV')).toBe('cash_advance');
    expect(classifyProduct('UNL 87')).toBe('gasoline');
    expect(classifyProduct('SCALE')).toBe('other');
    expect(classifyProduct('', 'gasoline')).toBe('gasoline');
  });
});

describe('column resolution', () => {
  it('finds EFS-style headers', () => {
    const { columns, missing } = resolveColumns(['Card #', 'Tran Date', 'Tran Time', 'Invoice', 'Unit', 'Driver Name', 'Location Name', 'City', 'State/ Prov', 'Item', 'Unit Price', 'Qty', 'Amt']);
    expect(missing).toEqual([]);
    expect(columns).toMatchObject({ card: 0, date: 1, time: 2, transaction_id: 3, unit: 4, driver: 5, merchant: 6, city: 7, state: 8, product: 9, gallons: 11, amount: 12 });
  });
  it('finds Comdata-style headers', () => {
    const { missing, columns } = resolveColumns(['Transaction Date', 'Unit Number', 'Truck Stop Name', 'Truck Stop City', 'Truck Stop State', 'Number of Tractor Gallons', 'Total Amount Due', 'Transaction Number']);
    expect(missing).toEqual([]);
    expect(columns.gallons).toBe(5);
  });
  it('reports what it could not find, and accepts an explicit mapping', () => {
    expect(resolveColumns(['When', 'Where', 'Cost']).missing).toEqual(['date', 'state', 'amount']);
    expect(resolveColumns(['When', 'Where', 'Cost'], { date: 'When', state: 'Where', amount: 'Cost' }).missing).toEqual([]);
  });
  it('normalizes a row and rejects garbage cells', () => {
    const header = ['Tran Date', 'Card #', 'State', 'Qty', 'Amt', 'Item'];
    const { columns } = resolveColumns(header);
    expect(normalizeRow(['10/12/2026', '7083 0512 3456 7890', 'tx', '120.5', '$481.80', 'ULSD'], columns)).toEqual({
      row: expect.objectContaining({ card_last4: '7890', state: 'TX', gallons_milli: 120_500, amount_cents: 48_180, product: 'diesel' }),
    });
    expect(normalizeRow(['10/12/2026', '1', 'Texas', '1', '1', 'ULSD'], columns)).toEqual({ error: 'unreadable state "Texas"' });
  });
});
