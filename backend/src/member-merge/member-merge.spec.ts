import { describe, expect, it } from 'vitest';
import { lookupResolutionKey, normalizeLookupValue } from './member-merge.service';

describe('member merge lookup values', () => {
  it('resolves integer-like values by lookup old_id', () => {
    expect(normalizeLookupValue('001')).toEqual({
      key: 'n:1',
      kind: 'number',
      text: '001',
      number: 1,
    });
    expect(normalizeLookupValue(12)).toEqual({
      key: 'n:12',
      kind: 'number',
      text: '12',
      number: 12,
    });
  });

  it('resolves text values by normalized lookup name', () => {
    expect(normalizeLookupValue(' Central Province ')).toEqual({
      key: 's:central province',
      kind: 'name',
      text: 'Central Province',
      number: null,
    });
  });

  it('treats blank and spreadsheet null markers as empty references', () => {
    expect(normalizeLookupValue(null)).toBeNull();
    expect(normalizeLookupValue(' N/A ')).toBeNull();
  });

  it('rejects numeric old_id values outside the safe integer range', () => {
    expect(() => normalizeLookupValue('9007199254740992')).toThrow(/outside the supported numeric range/);
  });

  it('distinguishes identical branch old_id values belonging to different banks', () => {
    const branch = normalizeLookupValue('116');
    if (!branch) throw new Error('Branch lookup value was not normalized');
    expect(lookupResolutionKey(branch, 'bank-1')).not.toBe(lookupResolutionKey(branch, 'bank-2'));
  });
});
