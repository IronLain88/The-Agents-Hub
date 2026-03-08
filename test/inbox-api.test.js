import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const HUB_URL = process.env.HUB_URL || 'http://localhost:4242';
const headers = { 'Content-Type': 'application/json' };

describe('Queue-based Inbox Tests', () => {
  before(async () => {
    const res = await fetch(`${HUB_URL}/api/health`);
    assert.ok(res.ok, 'Hub must be running');

    // Ensure property has an inbox asset
    const propRes = await fetch(`${HUB_URL}/api/property`);
    const prop = await propRes.json();
    const hasInbox = prop.assets?.some(a => a.station === 'inbox');
    if (!hasInbox) {
      await fetch(`${HUB_URL}/api/assets`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: 'Inbox', station: 'inbox', x: 0, y: 0 }),
      });
    }
    // Clear inbox queue
    await fetch(`${HUB_URL}/api/queue/inbox`, { method: 'DELETE', headers });
  });

  describe('POST /api/queue/inbox', () => {
    it('should create a message DTO', async () => {
      const res = await fetch(`${HUB_URL}/api/queue/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ by: 'Test', data: 'Hello' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);
      assert.ok(data.dto.id);
      assert.equal(data.count, 1);
    });

    it('should reject empty data', async () => {
      const res = await fetch(`${HUB_URL}/api/queue/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ by: 'Test', data: '' }),
      });
      assert.equal(res.status, 400);
    });

    it('should reject missing by', async () => {
      const res = await fetch(`${HUB_URL}/api/queue/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ data: 'Hello' }),
      });
      assert.equal(res.status, 400);
    });

    it('should accumulate DTOs', async () => {
      await fetch(`${HUB_URL}/api/queue/inbox`, { method: 'DELETE', headers });

      for (let i = 0; i < 3; i++) {
        await fetch(`${HUB_URL}/api/queue/inbox`, {
          method: 'POST', headers,
          body: JSON.stringify({ by: 'Test', data: `Message ${i}` }),
        });
      }

      const res = await fetch(`${HUB_URL}/api/queue/inbox`, { headers });
      const { dtos } = await res.json();
      assert.equal(dtos.length, 3);
      assert.equal(dtos[0].trail[0].data, 'Message 0');
      assert.equal(dtos[2].trail[0].data, 'Message 2');
    });
  });

  describe('DELETE /api/queue/inbox', () => {
    it('should clear all messages', async () => {
      await fetch(`${HUB_URL}/api/queue/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ by: 'Test', data: 'To be cleared' }),
      });

      const res = await fetch(`${HUB_URL}/api/queue/inbox`, { method: 'DELETE', headers });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);

      const listRes = await fetch(`${HUB_URL}/api/queue/inbox`, { headers });
      const { dtos } = await listRes.json();
      assert.equal(dtos.length, 0);
    });
  });
});
