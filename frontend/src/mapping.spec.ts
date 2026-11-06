import { describe, expect, it } from 'vitest';
import { normalizeHeader, suggestTarget, TargetColumn } from './mapping';

const columns: TargetColumn[] = [
  {
    name: 'old_id',
    label: 'Old ID',
    typeLabel: 'NUMBER',
    requiredOnInsert: true,
    businessKey: true,
    lookupTable: null,
    generateOnInsert: false,
  },
  {
    name: 'date_of_birth',
    label: 'Date Of Birth',
    typeLabel: 'DATE',
    requiredOnInsert: false,
    businessKey: false,
    lookupTable: null,
    generateOnInsert: false,
  },
  {
    name: 'id',
    label: 'ID',
    typeLabel: 'VARCHAR2(36)',
    requiredOnInsert: false,
    businessKey: false,
    lookupTable: null,
    generateOnInsert: true,
  },
];

describe('column matching', () => {
  it('normalizes human-readable headers', () => {
    expect(normalizeHeader('Date of Birth')).toBe('date_of_birth');
  });

  it('matches exact and fuzzy headers but omits generated columns', () => {
    expect(suggestTarget('Old ID', columns)).toBe('old_id');
    expect(suggestTarget('date birth', columns)).toBe('date_of_birth');
    expect(suggestTarget('id', columns)).toBeNull();
  });
});
