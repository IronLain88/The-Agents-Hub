import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processInboxSchema, archiveForwardSchema, addAssetSchema } from '../src/lib/validation.js';

describe('Traveling Cards Schemas', () => {
  describe('processInboxSchema', () => {
    it('should accept valid target_station', () => {
      const result = processInboxSchema.safeParse({ target_station: 'Task_Table' });
      assert.ok(result.success);
      assert.equal(result.data.target_station, 'Task_Table');
    });

    it('should reject empty target_station', () => {
      const result = processInboxSchema.safeParse({ target_station: '' });
      assert.ok(!result.success);
    });

    it('should reject missing target_station', () => {
      const result = processInboxSchema.safeParse({});
      assert.ok(!result.success);
    });
  });

  describe('archiveForwardSchema', () => {
    it('should accept valid from_station', () => {
      const result = archiveForwardSchema.safeParse({ from_station: 'Task_Table' });
      assert.ok(result.success);
    });

    it('should reject empty from_station', () => {
      const result = archiveForwardSchema.safeParse({ from_station: '' });
      assert.ok(!result.success);
    });
  });

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
