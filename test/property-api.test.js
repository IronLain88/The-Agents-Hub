import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const HUB_URL = process.env.HUB_URL || 'http://localhost:4242';

describe('Property API Tests', () => {
  before(async () => {
    const res = await fetch(`${HUB_URL}/api/health`);
    assert.ok(res.ok, 'Hub must be running');
  });

  describe('GET /api/property', () => {
    it('should return property data', async () => {
      const res = await fetch(`${HUB_URL}/api/property`);

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data);
      assert.equal(data.version, 2);
      assert.ok(Array.isArray(data.assets));
    });

    it('should return valid v2 format', async () => {
      const res = await fetch(`${HUB_URL}/api/property`);
      const property = await res.json();

      assert.equal(typeof property.version, 'number');
      assert.equal(typeof property.width, 'number');
      assert.equal(typeof property.height, 'number');
      assert.ok(Array.isArray(property.assets));
    });
  });

  describe('POST /api/property', () => {
    it('should update property', async () => {
      // First get current property
      const getRes = await fetch(`${HUB_URL}/api/property`);
      const currentProperty = await getRes.json();

      // Update it (add a test marker)
      currentProperty.test_timestamp = Date.now();

      const postRes = await fetch(`${HUB_URL}/api/property`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentProperty)
      });

      assert.equal(postRes.status, 200);
      const data = await postRes.json();
      assert.deepEqual(data, { ok: true });
    });

    it('should reject invalid property data', async () => {
      const res = await fetch(`${HUB_URL}/api/property`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: 'data' })
      });

      assert.equal(res.status, 400);
    });

    it('should handle empty assets array', async () => {
      const property = {
        version: 2,
        width: 24,
        height: 32,
        floor: [],
        assets: []
      };

      const res = await fetch(`${HUB_URL}/api/property`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(property)
      });

      assert.equal(res.status, 200);
    });
  });

  describe('GET /api/agents', () => {
    it('should return agents list', async () => {
      const res = await fetch(`${HUB_URL}/api/agents`);

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(typeof data, 'object');
    });
  });

  describe('GET /api/health', () => {
    it('should return ok status', async () => {
      const res = await fetch(`${HUB_URL}/api/health`);

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { status: 'ok' });
    });
  });
});
