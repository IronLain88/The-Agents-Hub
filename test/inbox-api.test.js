import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const HUB_URL = process.env.HUB_URL || 'http://localhost:4242';

describe('Inbox API Tests', () => {
  before(async () => {
    const res = await fetch(`${HUB_URL}/api/health`);
    assert.ok(res.ok, 'Hub must be running');

    // Ensure property has an inbox asset
    const propRes = await fetch(`${HUB_URL}/api/property`);
    const prop = await propRes.json();
    const hasInbox = prop.assets?.some(a => a.station === 'inbox');
    if (!hasInbox) {
      await fetch(`${HUB_URL}/api/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Inbox', station: 'inbox', x: 0, y: 0 }),
      });
    }
  });

  describe('POST /api/inbox', () => {
    it('should append a message', async () => {
      const res = await fetch(`${HUB_URL}/api/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Test', text: 'Hello' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);
      assert.equal(typeof data.count, 'number');
    });

    it('should reject empty text', async () => {
      const res = await fetch(`${HUB_URL}/api/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Test', text: '' }),
      });
      assert.equal(res.status, 400);
    });

    it('should reject missing from', async () => {
      const res = await fetch(`${HUB_URL}/api/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' }),
      });
      assert.equal(res.status, 400);
    });

    it('should accumulate messages', async () => {
      // Clear first
      await fetch(`${HUB_URL}/api/inbox`, { method: 'DELETE' });

      // Send 3 messages
      for (let i = 0; i < 3; i++) {
        await fetch(`${HUB_URL}/api/inbox`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'Test', text: `Message ${i}` }),
        });
      }

      // Read via board endpoint
      const res = await fetch(`${HUB_URL}/api/board/inbox`);
      if (res.ok) {
        const board = await res.json();
        const msgs = JSON.parse(board.content.data);
        assert.equal(msgs.length, 3);
        assert.equal(msgs[0].text, 'Message 0');
        assert.equal(msgs[2].text, 'Message 2');
      }
    });
  });

  describe('DELETE /api/inbox', () => {
    it('should clear all messages', async () => {
      // Send a message first
      await fetch(`${HUB_URL}/api/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Test', text: 'To be cleared' }),
      });

      const res = await fetch(`${HUB_URL}/api/inbox`, { method: 'DELETE' });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);

      // Verify inbox is empty via board endpoint
      const boardRes = await fetch(`${HUB_URL}/api/board/inbox`);
      if (boardRes.ok) {
        const board = await boardRes.json();
        const msgs = JSON.parse(board.content.data);
        assert.equal(msgs.length, 0);
      }
    });
  });
});
