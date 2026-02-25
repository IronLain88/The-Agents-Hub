import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHeartbeatPayload,
  createManualPayload,
  shouldAllowPayload
} from '../src/lib/payload-merger.js';

describe('Payload Merger', () => {
  describe('shouldAllowPayload', () => {
    it('should allow when both hub and signal allow', () => {
      const asset = { allow_payload: true };
      assert.equal(shouldAllowPayload(true, asset), true);
    });

    it('should block when hub disallows', () => {
      const asset = { allow_payload: true };
      assert.equal(shouldAllowPayload(false, asset), false);
    });

    it('should block when signal disallows', () => {
      const asset = { allow_payload: false };
      assert.equal(shouldAllowPayload(true, asset), false);
    });

    it('should block when signal allow_payload is undefined', () => {
      const asset = {};
      assert.equal(shouldAllowPayload(true, asset), false);
    });

    it('should block when both disallow', () => {
      const asset = { allow_payload: false };
      assert.equal(shouldAllowPayload(false, asset), false);
    });

    it('should handle null asset', () => {
      assert.equal(shouldAllowPayload(true, null), false);
    });
  });

  describe('createHeartbeatPayload', () => {
    it('should return payload when allowed', () => {
      const asset = {
        trigger_payload: { message: 'test', count: 42 }
      };
      const result = createHeartbeatPayload(asset, true);
      assert.deepEqual(result, { message: 'test', count: 42 });
    });

    it('should return undefined when payloads blocked', () => {
      const asset = {
        trigger_payload: { message: 'test' }
      };
      const result = createHeartbeatPayload(asset, false);
      assert.equal(result, undefined);
    });

    it('should return undefined when no trigger_payload', () => {
      const asset = {};
      const result = createHeartbeatPayload(asset, true);
      assert.equal(result, undefined);
    });

    it('should handle null asset', () => {
      const result = createHeartbeatPayload(null, true);
      assert.equal(result, undefined);
    });

    it('should handle string payload', () => {
      const asset = {
        trigger_payload: 'simple string'
      };
      const result = createHeartbeatPayload(asset, true);
      assert.equal(result, 'simple string');
    });

    it('should handle array payload', () => {
      const asset = {
        trigger_payload: [1, 2, 3]
      };
      const result = createHeartbeatPayload(asset, true);
      assert.deepEqual(result, [1, 2, 3]);
    });
  });

  describe('createManualPayload', () => {
    it('should merge both signal_payload and dynamic_payload', () => {
      const asset = {
        trigger_payload: { default: 'config' }
      };
      const dynamicPayload = { dynamic: 'api' };
      const result = createManualPayload(asset, dynamicPayload, true);

      assert.deepEqual(result, {
        signal_payload: { default: 'config' },
        dynamic_payload: { dynamic: 'api' }
      });
    });

    it('should include only signal_payload when no dynamic', () => {
      const asset = {
        trigger_payload: { default: 'config' }
      };
      const result = createManualPayload(asset, undefined, true);

      assert.deepEqual(result, {
        signal_payload: { default: 'config' }
      });
    });

    it('should include only dynamic_payload when no signal', () => {
      const asset = {};
      const dynamicPayload = { dynamic: 'api' };
      const result = createManualPayload(asset, dynamicPayload, true);

      assert.deepEqual(result, {
        dynamic_payload: { dynamic: 'api' }
      });
    });

    it('should return undefined when payloads blocked', () => {
      const asset = {
        trigger_payload: { default: 'config' }
      };
      const dynamicPayload = { dynamic: 'api' };
      const result = createManualPayload(asset, dynamicPayload, false);

      assert.equal(result, undefined);
    });

    it('should return undefined when no payloads present', () => {
      const asset = {};
      const result = createManualPayload(asset, undefined, true);

      assert.equal(result, undefined);
    });

    it('should handle null asset', () => {
      const dynamicPayload = { test: 'data' };
      const result = createManualPayload(null, dynamicPayload, true);

      assert.deepEqual(result, {
        dynamic_payload: { test: 'data' }
      });
    });

    it('should handle string payloads', () => {
      const asset = {
        trigger_payload: 'configured string'
      };
      const dynamicPayload = 'api string';
      const result = createManualPayload(asset, dynamicPayload, true);

      assert.deepEqual(result, {
        signal_payload: 'configured string',
        dynamic_payload: 'api string'
      });
    });

    it('should handle array payloads', () => {
      const asset = {
        trigger_payload: [1, 2, 3]
      };
      const dynamicPayload = [4, 5, 6];
      const result = createManualPayload(asset, dynamicPayload, true);

      assert.deepEqual(result, {
        signal_payload: [1, 2, 3],
        dynamic_payload: [4, 5, 6]
      });
    });

    it('should handle null dynamic_payload explicitly', () => {
      const asset = {
        trigger_payload: { default: 'config' }
      };
      const result = createManualPayload(asset, null, true);

      assert.deepEqual(result, {
        signal_payload: { default: 'config' },
        dynamic_payload: null
      });
    });
  });
});
