import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const HUB_URL = process.env.HUB_URL || 'http://localhost:3000';

describe('Signal API Tests', () => {
  before(async () => {
    // Verify hub is running
    try {
      const res = await fetch(`${HUB_URL}/api/health`);
      assert.ok(res.ok, 'Hub server must be running for tests');
    } catch (err) {
      throw new Error('Hub server is not running. Start it with: cd hub-server && npm start');
    }
  });

  describe('POST /api/signals/fire', () => {
    it('should fire a manual signal successfully', async () => {
      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ station: 'TestSignal' })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { ok: true });
    });

    it('should return 400 when station is missing', async () => {
      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);
      assert.match(data.error, /station.*required/i);
    });

    it('should fire signal with payload when allowed', async () => {
      const payload = { test: 'data', timestamp: Date.now() };
      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'ManualSignal 1',
          payload
        })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { ok: true });
    });

    it('should handle special characters in station name', async () => {
      const res = await fetch(`${HUB_URL}/api/signals/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ station: 'Test Signal #1 @ 2024' })
      });

      assert.equal(res.status, 200);
    });
  });

  describe('POST /api/signals/set-interval', () => {
    let originalProperty;

    before(async () => {
      // Save current property
      const getRes = await fetch(`${HUB_URL}/api/property`);
      originalProperty = await getRes.json();

      // Create a test property with a signal
      const testProperty = {
        version: 2,
        width: 24,
        height: 32,
        floor: [],
        assets: [
          {
            id: 'test-signal',
            station: 'TestSignal',
            trigger: 'manual',
            trigger_interval: 60,
            position: { x: 5, y: 5 }
          }
        ]
      };

      await fetch(`${HUB_URL}/api/property`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testProperty)
      });
    });

    after(async () => {
      // Restore original property
      if (originalProperty) {
        await fetch(`${HUB_URL}/api/property`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(originalProperty)
        });
      }
    });

    it('should update signal interval', async () => {
      const res = await fetch(`${HUB_URL}/api/signals/set-interval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'TestSignal',
          interval: 120
        })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);
      assert.equal(data.station, 'TestSignal');
      assert.equal(data.interval, 120);
    });

    it('should return 400 when parameters missing', async () => {
      const res = await fetch(`${HUB_URL}/api/signals/set-interval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ station: 'Test' })
      });

      assert.equal(res.status, 400);
    });

    it('should validate interval is a positive number', async () => {
      const res = await fetch(`${HUB_URL}/api/signals/set-interval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station: 'Test',
          interval: -5
        })
      });

      assert.equal(res.status, 400);
    });
  });
});
