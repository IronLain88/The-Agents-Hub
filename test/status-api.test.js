import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const HUB_URL = process.env.HUB_URL || 'http://localhost:4242';

describe('GET /api/status', () => {
  before(async () => {
    const res = await fetch(`${HUB_URL}/api/health`);
    assert.ok(res.ok, 'Hub must be running');
  });

  it('should return 200 with correct shape', async () => {
    const res = await fetch(`${HUB_URL}/api/status`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(Array.isArray(data.agents));
    assert.equal(typeof data.inbox, 'object');
    assert.equal(typeof data.inbox.count, 'number');
    assert.ok(Array.isArray(data.activity));
    assert.ok(Array.isArray(data.stations));
  });

  it('should return at most 5 activity entries', async () => {
    const res = await fetch(`${HUB_URL}/api/status`);
    const data = await res.json();
    assert.ok(data.activity.length <= 5);
  });

  it('should include agent fields', async () => {
    // Post a test agent state first
    await fetch(`${HUB_URL}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'test-status-agent',
        agent_name: 'StatusTest',
        state: 'reading',
        detail: 'Testing status',
        group: 'gathering',
        sprite: '',
        owner_id: 'test',
        owner_name: 'Test',
      }),
    });

    const res = await fetch(`${HUB_URL}/api/status`);
    const data = await res.json();
    const agent = data.agents.find(a => a.name === 'StatusTest');
    assert.ok(agent, 'Test agent should appear in status');
    assert.equal(agent.state, 'reading');
    assert.equal(agent.idle, false);
    assert.equal(typeof agent.detail, 'string');
  });
});
