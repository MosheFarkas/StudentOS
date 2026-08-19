import { describe, expect, it } from 'vitest';
import { summarizeShape } from './recorder.mjs';

/**
 * A recording is taken against a real student's live portal, so the report can
 * easily end up holding their grades. Redaction is the default, and these
 * tests exist to make sure it stays that way.
 */
describe('summarizeShape', () => {
  it('keeps structure and drops values', () => {
    const shape = summarizeShape({ studentId: 88213, name: 'Lucas Liu', gpa: 3.91 });
    expect(shape).toEqual({ studentId: 'number', name: 'string<short>', gpa: 'number' });
  });

  it('never emits a source string value when redacting', () => {
    const secret = 'Failed — parent conference requested';
    const serialized = JSON.stringify(
      summarizeShape({ comment: secret, nested: [{ comment: secret }] }),
    );
    expect(serialized).not.toContain('parent conference');
    expect(serialized).not.toContain('Failed');
  });

  it('marks dates so an adapter author can spot due-date fields', () => {
    expect(summarizeShape({ dueDate: '2026-09-14T23:59:00Z' })).toEqual({
      dueDate: 'string<date>',
    });
  });

  it('bands string length so ids are distinguishable from prose', () => {
    expect(summarizeShape('abc')).toBe('string<short>');
    expect(summarizeShape('x'.repeat(100))).toBe('string<medium>');
    expect(summarizeShape('x'.repeat(500))).toBe('string<long>');
  });

  it('collapses arrays to one sample plus a count', () => {
    expect(summarizeShape([{ id: 1 }, { id: 2 }, { id: 3 }])).toEqual([
      { id: 'number' },
      '…3 items',
    ]);
  });

  it('passes values through when raw is explicitly requested', () => {
    expect(summarizeShape({ name: 'Lucas' }, { raw: true })).toEqual({ name: 'Lucas' });
  });

  it('terminates on deeply nested structures', () => {
    let deep = { v: 1 };
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    expect(() => JSON.stringify(summarizeShape(deep))).not.toThrow();
  });

  it('handles null and empty collections', () => {
    expect(summarizeShape({ a: null, b: [], c: {} })).toEqual({ a: 'null', b: [], c: {} });
  });
});
