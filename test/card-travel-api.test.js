import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const HUB_URL = process.env.HUB_URL || 'http://localhost:4242';
const headers = { 'Content-Type': 'application/json' };

async function ensureAsset(opts) {
  const res = await fetch(`${HUB_URL}/api/assets`, { method: 'POST', headers, body: JSON.stringify(opts) });
  if (res.ok) {
    const { asset } = await res.json();
    return asset.id;
  }
  return null;
}

async function removeAsset(id) {
  if (id) await fetch(`${HUB_URL}/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
}

describe('DTO Queue & Task Flow Tests', () => {
  let inboxId, taskId, archiveId;

  before(async () => {
    const res = await fetch(`${HUB_URL}/api/health`);
    assert.ok(res.ok, 'Hub must be running');

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

    // Clear queues and task
    await fetch(`${HUB_URL}/api/queue/inbox`, { method: 'DELETE', headers });
    await fetch(`${HUB_URL}/api/queue/test_archive`, { method: 'DELETE', headers });
    await fetch(`${HUB_URL}/api/task/test_task/clear`, { method: 'POST', headers });
  });

  after(async () => {
    await removeAsset(inboxId);
    await removeAsset(taskId);
    await removeAsset(archiveId);
  });

  describe('Queue-based inbox flow', () => {
    it('should create a DTO in inbox queue', async () => {
      const res = await fetch(`${HUB_URL}/api/queue/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ by: 'Tester', data: 'Research quantum computing' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);
      assert.ok(data.dto.id);
      assert.equal(data.dto.trail[0].by, 'Tester');
    });

    it('should forward inbox DTO to task station', async () => {
      // Get the DTO from inbox
      const listRes = await fetch(`${HUB_URL}/api/queue/inbox`, { headers });
      const { dtos } = await listRes.json();
      assert.ok(dtos.length > 0);
      const dtoId = dtos[0].id;

      // Forward to task station
      const res = await fetch(`${HUB_URL}/api/queue/inbox/${dtoId}/forward`, {
        method: 'POST', headers,
        body: JSON.stringify({ target_station: 'test_task', by: 'System', data: 'Forwarded for processing' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);

      // Verify task is now pending
      const prop = await fetch(`${HUB_URL}/api/property`).then(r => r.json());
      const task = prop.assets.find(a => a.station === 'test_task' && a.task);
      const state = JSON.parse(task.content.data);
      assert.equal(state.status, 'pending');
      assert.ok(state.dtoId);
    });

    it('should forward completed work to archive', async () => {
      // Complete the task
      await fetch(`${HUB_URL}/api/task/test_task/claim`, {
        method: 'POST', headers,
        body: JSON.stringify({ agent_id: 'test-agent' }),
      });
      await fetch(`${HUB_URL}/api/task/test_task/result`, {
        method: 'POST', headers,
        body: JSON.stringify({ result: '<p>Research complete</p>' }),
      });

      // Get DTO from task queue
      const listRes = await fetch(`${HUB_URL}/api/queue/test_task`, { headers });
      const { dtos } = await listRes.json();
      assert.ok(dtos.length > 0);
      const dtoId = dtos[0].id;

      // Forward to archive
      const res = await fetch(`${HUB_URL}/api/queue/test_task/${dtoId}/forward`, {
        method: 'POST', headers,
        body: JSON.stringify({ target_station: 'test_archive', by: 'Agent', data: 'Research complete' }),
      });
      assert.equal(res.status, 200);

      // Verify archive has the DTO
      const archiveRes = await fetch(`${HUB_URL}/api/queue/test_archive`, { headers });
      const archive = await archiveRes.json();
      assert.ok(archive.dtos.length > 0);
      assert.ok(archive.dtos[0].trail.length >= 2);
    });
  });

  describe('Queue clear', () => {
    it('should clear all DTOs from a station', async () => {
      // Add a DTO
      await fetch(`${HUB_URL}/api/queue/inbox`, {
        method: 'POST', headers,
        body: JSON.stringify({ by: 'Tester', data: 'To be cleared' }),
      });

      const res = await fetch(`${HUB_URL}/api/queue/inbox`, { method: 'DELETE', headers });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.ok);

      // Verify empty
      const listRes = await fetch(`${HUB_URL}/api/queue/inbox`, { headers });
      const { dtos } = await listRes.json();
      assert.equal(dtos.length, 0);
    });
  });
});
