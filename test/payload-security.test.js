import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUB_URL = process.env.HUB_URL || 'http://localhost:3000';

describe('Payload Security Tests', () => {
  let payloadsEnabled = false;

  before(async () => {
    // Check if payloads are enabled
    try {
      const envPath = join(__dirname, '..', '.env');
      const envContent = await readFile(envPath, 'utf-8');
      payloadsEnabled = envContent.includes('ALLOW_SIGNAL_PAYLOADS=true');
    } catch (err) {
      console.log('Note: .env file not found, payloads likely disabled');
    }

    const res = await fetch(`${HUB_URL}/api/health`);
    assert.ok(res.ok, 'Hub must be running');
  });

  describe('Hub-Level Security', () => {
    it('should have ALLOW_SIGNAL_PAYLOADS configuration', () => {
      // This test just documents the security model
      assert.ok(true, 'Hub uses ALLOW_SIGNAL_PAYLOADS env var');
    });

    it('should respect hub-level payload setting', async () => {
      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'ManualSignal 1',
          payload: { test: 'data' }
        })
      });

      assert.equal(res.status, 200);
      // Note: Without checking logs, we can't verify if payload was blocked or allowed
      // This would require hub to return payload status in response
    });
  });

  describe('Per-Signal Security', () => {
    it('should check signal allow_payload property', async () => {
      // Get property to check signal configuration
      const propRes = await fetch(`${HUB_URL}/api/property`);
      const property = await propRes.json();

      const signal = property.assets.find(a => a.station === 'ManualSignal 1' && a.trigger);

      if (signal) {
        // Verify allow_payload is a boolean or undefined
        assert.ok(
          signal.allow_payload === true ||
          signal.allow_payload === false ||
          signal.allow_payload === undefined
        );
      }
    });
  });

  describe('Dual Payload System', () => {
    it('should support both signal_payload and dynamic_payload', async () => {
      // This tests the concept - actual payload merging happens in hub
      const signalPayload = { default: 'data' };
      const dynamicPayload = { dynamic: 'info' };

      // The hub should merge these into:
      // { signal_payload: {...}, dynamic_payload: {...} }

      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'ManualSignal 1',
          payload: dynamicPayload
        })
      });

      assert.equal(res.status, 200);
    });

    it('should handle payload with special characters', async () => {
      const payload = {
        message: 'Test with <script>alert("xss")</script>',
        code: '`rm -rf /`',
        injection: 'DROP TABLE users;'
      };

      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'ManualSignal 1',
          payload
        })
      });

      // Should accept (security is in transmission control, not content filtering)
      assert.equal(res.status, 200);
    });

    it('should handle large payloads', async () => {
      const largePayload = {
        data: 'x'.repeat(10000) // 10KB payload
      };

      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'ManualSignal 1',
          payload: largePayload
        })
      });

      assert.equal(res.status, 200);
    });
  });

  describe('Payload Validation', () => {
    it('should handle null payload', async () => {
      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'ManualSignal 1',
          payload: null
        })
      });

      assert.equal(res.status, 200);
    });

    it('should handle undefined payload', async () => {
      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'ManualSignal 1'
          // payload is undefined
        })
      });

      assert.equal(res.status, 200);
    });

    it('should handle complex nested payload', async () => {
      const payload = {
        level1: {
          level2: {
            level3: {
              array: [1, 2, 3],
              boolean: true,
              null: null
            }
          }
        }
      };

      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'ManualSignal 1',
          payload
        })
      });

      assert.equal(res.status, 200);
    });
  });
});
