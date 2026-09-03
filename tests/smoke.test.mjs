import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3100';

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

describe('ETTA deterministic smoke tests', () => {
  it('returns application settings', async () => {
    const { status, data } = await api('/api/settings');
    assert.equal(status, 200);
    assert.ok(data.settings);
  });

  it('returns projects and task types', async () => {
    const projects = await api('/api/projects');
    const taskTypes = await api('/api/task-types');
    assert.equal(projects.status, 200);
    assert.equal(taskTypes.status, 200);
    assert.ok(Array.isArray(projects.data.projects));
    assert.ok(Array.isArray(taskTypes.data.taskTypes));
  });

  it('returns keywords and routes', async () => {
    const keywords = await api('/api/keywords');
    const routes = await api('/api/routes');
    assert.equal(keywords.status, 200);
    assert.equal(routes.status, 200);
    assert.ok(Array.isArray(keywords.data.keywords));
    assert.ok(Array.isArray(routes.data.routes));
  });

  it('returns entries', async () => {
    const { status, data } = await api('/api/entries?startDate=2026-01-01&endDate=2026-01-07');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.entries));
  });

  it('reports Outlook connection status', async () => {
    const { status, data } = await api('/api/outlook/status');
    assert.equal(status, 200);
    assert.equal(typeof data.connected, 'boolean');
  });

  it('rejects empty Jira push payloads', async () => {
    const { status, data } = await api('/api/jira/push', {
      method: 'POST',
      body: {},
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('returns empty estimates for an empty key list', async () => {
    const { status, data } = await api('/api/jira/estimate', {
      method: 'POST',
      body: { keys: [] },
    });
    assert.equal(status, 200);
    assert.deepEqual(data.estimates, {});
  });

  it('rejects missing Jira keys', async () => {
    const { status, data } = await api('/api/jira/validate', {
      method: 'POST',
      body: {},
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });
});
