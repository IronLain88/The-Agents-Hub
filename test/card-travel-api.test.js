import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const HUB_URL = process.env.HUB_URL || 'http://localhost:4242';
const headers = { 'Content-Type': 'application/json' };

// Helper: ensure an asset exists
async function ensureAsset(opts) {
  const res = await fetch(`${HUB_URL}/api/assets`, { method: 'POST', headers, body: JSON.stringify(opts) });
  if (res.ok) {
    const { asset } = await res.json();
    return asset.id;
  }
  return null;
}

// Helper: cleanup asset
async function removeAsset(id) {
  if (id) await fetch(`${HUB_URL}/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
}

describe('Card Travel API Tests', () => {
  let inboxId, taskId, archiveId;

  before(async () => {
    const res = await fetch(`${HUB_URL}/api/health`);
    assert.ok(res.ok, 'Hub must be running');

    // Ensure test fixtures exist
    const prop = await fetch(`${HUB_URL}/api/property`).then(r => r.json());
    if (!prop.assets?.some(a => a.station === 'inbox')) {
      inboxId = await ensureAsset({ name: 'Test Inbox', station: 'inbox', x: 0, y: 0 });
    }
    if (!prop.assets?.some(a => a.station === 'test_task' && a.task)) {
      taskId = await ensureAsset({ name: 'Test Task', station: 'test_task', task: true, x: 2, y: 0 });
    }
    if (!prop.assets?.some(a => a.archive)) {
      archiveId = await ensureAsset({ name: 'Test Archive', station: 'test_archive', archive: true, x: 4, y: 0 });
    }

    // Clear inbox and task
    await fetch(`${HUB_URL}/api/inbox`, { method: 'DELETE', headers });
    await fetch(`${HUB_URL}/api/task/test_task/clear`, { method: 'POST', headers });
  });

  after(async () => {
    // Cleanup test fixtures we created
    await removeAsset(inboxId);
    await removeAsset(taskId);
    await removeAsset(archiveId);
  });

  describe('POST /api/inbox/:name/:id/process', () => {
    it('should process an inbox message to a task station', async () => {
      // Send a message
      const sendRes = await fetch(`${HUB_URL}/api/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ from: 'Tester', text: 'Research quantum computing' }),
      });
      assert.ok(sendRes.ok);

      // Get the message ID
      const prop = await fetch(`${HUB_URL}/api/property`).then(r => r.json());
      const inbox = prop.assets.find(a => a.station === 'inbox');
      const msgs = JSON.parse(inbox.content.data);
      const msgId = msgs[msgs.length - 1].id;

      // Process it
      const res = await fetch(`${HUB_URL}/api/inbox/inbox/${msgId}/process`, {
        method: 'POST', headers,
        body: JSON.stringify({ target_station: 'test_task' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);
      assert.ok(data.card_id);

      // Verify task is now pending with card
      const prop2 = await fetch(`${HUB_URL}/api/property`).then(r => r.json());
      const task = prop2.assets.find(a => a.station === 'test_task' && a.task);
      const state = JSON.parse(task.content.data);
      assert.equal(state.status, 'pending');
      assert.ok(state.card);
      assert.equal(state.card.from, 'Tester');
      assert.equal(state.card.source, 'inbox');

      // Verify message removed from inbox
      const inbox2 = prop2.assets.find(a => a.station === 'inbox');
      const msgs2 = JSON.parse(inbox2.content.data);
      assert.ok(!msgs2.some(m => m.id === msgId));
    });

    it('should return 409 when task is busy', async () => {
      // Task is still pending from previous test — send another message
      await fetch(`${HUB_URL}/api/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ from: 'Tester', text: 'Another request' }),
      });
      const prop = await fetch(`${HUB_URL}/api/property`).then(r => r.json());
      const msgs = JSON.parse(prop.assets.find(a => a.station === 'inbox').content.data);
      const msgId = msgs[msgs.length - 1].id;

      const res = await fetch(`${HUB_URL}/api/inbox/inbox/${msgId}/process`, {
        method: 'POST', headers,
        body: JSON.stringify({ target_station: 'test_task' }),
      });
      assert.equal(res.status, 409);
    });

    it('should return 404 for nonexistent message', async () => {
      // Clear task first
      await fetch(`${HUB_URL}/api/task/test_task/clear`, { method: 'POST', headers });

      const res = await fetch(`${HUB_URL}/api/inbox/inbox/nonexistent/process`, {
        method: 'POST', headers,
        body: JSON.stringify({ target_station: 'test_task' }),
      });
      assert.equal(res.status, 404);
    });

    it('should return 404 for nonexistent task station', async () => {
      await fetch(`${HUB_URL}/api/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ from: 'Tester', text: 'Orphan' }),
      });
      const prop = await fetch(`${HUB_URL}/api/property`).then(r => r.json());
      const msgs = JSON.parse(prop.assets.find(a => a.station === 'inbox').content.data);
      const msgId = msgs[msgs.length - 1].id;

      const res = await fetch(`${HUB_URL}/api/inbox/inbox/${msgId}/process`, {
        method: 'POST', headers,
        body: JSON.stringify({ target_station: 'nonexistent_task' }),
      });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/archive/:station', () => {
    it('should archive a completed card', async () => {
      // Setup: clear and process a message through
      await fetch(`${HUB_URL}/api/inbox`, { method: 'DELETE', headers });
      await fetch(`${HUB_URL}/api/task/test_task/clear`, { method: 'POST', headers });

      await fetch(`${HUB_URL}/api/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ from: 'Archiver', text: 'Archive me' }),
      });
      const prop = await fetch(`${HUB_URL}/api/property`).then(r => r.json());
      const msgs = JSON.parse(prop.assets.find(a => a.station === 'inbox').content.data);
      const msgId = msgs[0].id;

      // Process to task
      await fetch(`${HUB_URL}/api/inbox/inbox/${msgId}/process`, {
        method: 'POST', headers,
        body: JSON.stringify({ target_station: 'test_task' }),
      });

      // Complete the task
      await fetch(`${HUB_URL}/api/task/test_task/claim`, {
        method: 'POST', headers,
        body: JSON.stringify({ agent_id: 'test-agent' }),
      });
      await fetch(`${HUB_URL}/api/task/test_task/result`, {
        method: 'POST', headers,
        body: JSON.stringify({ result: '<p>Research complete</p>' }),
      });

      // Archive it
      const res = await fetch(`${HUB_URL}/api/archive/test_task`, { method: 'POST', headers });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);

      // Verify task is back to idle
      const prop2 = await fetch(`${HUB_URL}/api/property`).then(r => r.json());
      const task = prop2.assets.find(a => a.station === 'test_task' && a.task);
      const state = JSON.parse(task.content.data);
      assert.equal(state.status, 'idle');

      // Verify card is in archive
      const archive = prop2.assets.find(a => a.archive);
      const cards = JSON.parse(archive.content.data);
      assert.ok(cards.length > 0);
      assert.equal(cards[0].from, 'Archiver');
      assert.equal(cards[0].result, '<p>Research complete</p>');
      assert.ok(cards[0].completedAt);
    });

    it('should return 409 when task has no card', async () => {
      // Task is idle now (no card)
      const res = await fetch(`${HUB_URL}/api/archive/test_task`, { method: 'POST', headers });
      assert.equal(res.status, 409);
    });

    it('should return 404 for nonexistent task station', async () => {
      const res = await fetch(`${HUB_URL}/api/archive/fake_station`, { method: 'POST', headers });
      assert.equal(res.status, 404);
    });
  });
});
