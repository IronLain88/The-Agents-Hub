import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addAssetSchema } from '../src/lib/validation.js';

describe('Validation Schemas', () => {
  describe('addAssetSchema — archive field', () => {
    it('should accept archive: true', () => {
      const result = addAssetSchema.safeParse({ name: 'Archive Box', archive: true });
      assert.ok(result.success);
      assert.equal(result.data.archive, true);
    });

    it('should accept without archive', () => {
      const result = addAssetSchema.safeParse({ name: 'Regular Desk' });
      assert.ok(result.success);
      assert.equal(result.data.archive, undefined);
    });

    it('should reject archive as string', () => {
      const result = addAssetSchema.safeParse({ name: 'Bad', archive: 'yes' });
      assert.ok(!result.success);
    });
  });
});
