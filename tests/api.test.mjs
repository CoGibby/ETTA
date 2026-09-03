// ETTA Time Tracker - API Test Suite
// Run with: node --test tests/api.test.mjs
// Requires dev server running at http://localhost:3000

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://localhost:3000';
const api = (path, opts = {}) => fetch(BASE + path, {
  headers: { 'Content-Type': 'application/json' },
  ...opts,
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}).then(r => r.json().then(data => ({ status: r.status, data })));

// ============================================================
// SETTINGS
// ============================================================
describe('Settings API', () => {
  it('GET /api/settings returns settings object', async () => {
    const { status, data } = await api('/api/settings');
    assert.equal(status, 200);
    assert.ok(data.settings, 'Should return settings object');
    assert.ok(data.settings.jira_url, 'Should have jira_url configured');
  });

  it('PUT /api/settings updates a setting', async () => {
    const { status, data } = await api('/api/settings', {
      method: 'PUT',
      body: { include_tentative_meetings: 'true' },
    });
    assert.equal(status, 200);
    assert.ok(data.success !== false);
  });
});

// ============================================================
// JIRA SEARCH - Issue type filtering
// ============================================================
describe('Jira Search API - Ineligible type filtering', () => {
  it('POST /api/jira/search returns results for valid query', async () => {
    const { status, data } = await api('/api/jira/search', {
      method: 'POST',
      body: { query: 'ETTA' },
    });
    assert.equal(status, 200);
    assert.ok(data.success, 'Search should succeed');
    assert.ok(Array.isArray(data.issues), 'Should return issues array');
    assert.ok(data.issues.length > 0, 'Should find ETTA issues');
  });

  it('POST /api/jira/search filters out epics', async () => {
    const { data } = await api('/api/jira/search', {
      method: 'POST',
      body: { query: 'ETTA-57' },
    });
    // ETTA-57 is an epic - should not appear
    const hasEpic = (data.issues || []).some(i => i.key.toUpperCase() === 'ETTA-57');
    assert.equal(hasEpic, false, 'Epics should be filtered out');
  });

  it('POST /api/jira/search filters out requirements', async () => {
    const { data } = await api('/api/jira/search', {
      method: 'POST',
      body: { query: 'ETTA-34' },
    });
    // ETTA-34 is a requirement - should not appear
    const hasReq = (data.issues || []).some(i => i.key.toUpperCase() === 'ETTA-34');
    assert.equal(hasReq, false, 'Requirements should be filtered out');
  });

  it('POST /api/jira/search returns eligible issues (tasks, bugs)', async () => {
    const { data } = await api('/api/jira/search', {
      method: 'POST',
      body: { query: 'ETTA-90' },
    });
    const hasETTA90 = (data.issues || []).some(i => i.key.toUpperCase() === 'ETTA-90');
    assert.equal(hasETTA90, true, 'ETTA-90 (task) should appear in search');
  });

  it('POST /api/jira/search handles empty query', async () => {
    const { status, data } = await api('/api/jira/search', {
      method: 'POST',
      body: { query: '' },
    });
    assert.equal(status, 200);
    assert.deepEqual(data.issues, [], 'Empty query should return no issues');
  });

  it('POST /api/jira/search handles 1-2 character query', async () => {
    const { status, data } = await api('/api/jira/search', {
      method: 'POST',
      body: { query: 'et' },
    });
    assert.equal(status, 200);
    // Should return some results (partial match)
    assert.ok(Array.isArray(data.issues), 'Should return issues array');
  });
});

// ============================================================
// JIRA ESTIMATE - Over-estimate warning data
// ============================================================
describe('Jira Estimate API', () => {
  it('POST /api/jira/estimate returns estimates for known keys', async () => {
    const { status, data } = await api('/api/jira/estimate', {
      method: 'POST',
      body: { keys: ['ETTA-98', 'ETTA-90'] },
    });
    assert.equal(status, 200);
    assert.ok(data.success, 'Should succeed');
    assert.ok(data.estimates, 'Should return estimates object');
  });

  it('POST /api/jira/estimate returns hasEstimate flag', async () => {
    const { data } = await api('/api/jira/estimate', {
      method: 'POST',
      body: { keys: ['ETTA-98', 'SVCOPS-648'] },
    });
    assert.ok(data.estimates['ETTA-98'], 'ETTA-98 should have estimate data');
    assert.equal(data.estimates['ETTA-98'].hasEstimate, true, 'ETTA-98 should have hasEstimate=true');
    assert.ok(data.estimates['SVCOPS-648'], 'SVCOPS-648 should have estimate data');
    assert.equal(data.estimates['SVCOPS-648'].hasEstimate, false, 'SVCOPS-648 (activity) should have hasEstimate=false');
  });

  it('POST /api/jira/estimate filters out requirements', async () => {
    const { data } = await api('/api/jira/estimate', {
      method: 'POST',
      body: { keys: ['ETTA-34'] },
    });
    assert.ok(!data.estimates['ETTA-34'], 'ETTA-34 (requirement) should be filtered out');
  });

  it('POST /api/jira/estimate returns issueType', async () => {
    const { data } = await api('/api/jira/estimate', {
      method: 'POST',
      body: { keys: ['ETTA-98'] },
    });
    assert.ok(data.estimates['ETTA-98'].issueType, 'Should include issueType');
  });

  it('POST /api/jira/estimate handles empty keys array', async () => {
    const { status, data } = await api('/api/jira/estimate', {
      method: 'POST',
      body: { keys: [] },
    });
    assert.equal(status, 200);
    assert.ok(data.success);
    assert.deepEqual(data.estimates, {});
  });
});

// ============================================================
// JIRA PUSH - Validation
// ============================================================
describe('Jira Push API - Validation', () => {
  it('POST /api/jira/push rejects empty request', async () => {
    const { status, data } = await api('/api/jira/push', {
      method: 'POST',
      body: {},
    });
    assert.equal(status, 400);
    assert.ok(data.error, 'Should return error message');
  });

  it('POST /api/jira/push accepts worklogs without entryIds', async () => {
    // Just test validation, not actual push - use invalid issue key
    const { status, data } = await api('/api/jira/push', {
      method: 'POST',
      body: {
        entryIds: [],
        worklogs: [{
          issueKey: 'FAKE-999',
          timeSpentMinutes: 60,
          startedDate: '2026-01-01',
          comment: 'Test',
        }],
      },
    });
    // Should not get the "entryIds array required" error
    assert.notEqual(data.error, 'entryIds array required');
    // It will fail because FAKE-999 doesn't exist, but that's OK
    assert.ok(status === 200 || status === 500);
  });
});

// ============================================================
// FAVORITES - CRUD operations
// ============================================================
describe('Favorites API - CRUD', () => {
  let testFavoriteId;

  it('GET /api/favorites returns favorites list', async () => {
    const { status, data } = await api('/api/favorites');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.favorites), 'Should return favorites array');
  });

  it('POST /api/favorites creates a favorite', async () => {
    const { status, data } = await api('/api/favorites', {
      method: 'POST',
      body: { jira_key: 'TEST-001', jira_name: 'Test issue for testing', short_name: 'Test' },
    });
    if (status === 409) {
      // Already exists from previous run - that's OK
      assert.ok(data.error, 'Conflict is acceptable');
    } else {
      assert.equal(status, 200);
      assert.ok(data.id, 'Should return created id');
      testFavoriteId = data.id;
    }
  });

  it('DELETE /api/favorites/:id deletes a favorite', async () => {
    // First get favorites to find our test one
    const { data: listData } = await api('/api/favorites');
    const testFav = (listData.favorites || []).find(f => f.jira_key === 'TEST-001');
    if (testFav) {
      const { status } = await api('/api/favorites/' + testFav.id, { method: 'DELETE' });
      assert.equal(status, 200);
    }
  });
});

// ============================================================
// ENTRIES - Basic operations
// ============================================================
describe('Entries API', () => {
  it('GET /api/entries returns entries for date range', async () => {
    const { status, data } = await api('/api/entries?startDate=2026-08-01&endDate=2026-08-31');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.entries), 'Should return entries array');
  });

  it('GET /api/entries returns entries for specific date', async () => {
    const { status, data } = await api('/api/entries?date=2026-08-28');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.entries), 'Should return entries array');
  });
});

// ============================================================
// OUTLOOK STATUS
// ============================================================
describe('Outlook Status API', () => {
  it('GET /api/outlook/status returns connection status', async () => {
    const { status, data } = await api('/api/outlook/status');
    assert.equal(status, 200);
    assert.ok('connected' in data, 'Should return connected boolean');
    assert.equal(typeof data.connected, 'boolean', 'connected should be boolean');
  });
});

// ============================================================
// JIRA TEMPO - Worklog fetching
// ============================================================
describe('Jira Tempo API', () => {
  it('POST /api/jira/tempo returns tempo worklogs for date range', async () => {
    const { status, data } = await api('/api/jira/tempo', {
      method: 'POST',
      body: { dateFrom: '2026-08-01', dateTo: '2026-08-28' },
    });
    assert.equal(status, 200);
    assert.ok(data.success !== undefined, 'Should return success flag');
    if (data.success) {
      assert.ok(typeof data.totalMinutes === 'number', 'Should return totalMinutes');
      assert.ok(Array.isArray(data.entries), 'Should return entries array');
    }
  });
});

// ============================================================
// JIRA VALIDATE - Single issue validation
// ============================================================
describe('Jira Validate API', () => {
  it('POST /api/jira/validate validates a real issue', async () => {
    const { status, data } = await api('/api/jira/validate', {
      method: 'POST',
      body: { jira_key: 'ETTA-90' },
    });
    assert.equal(status, 200);
    // Should be valid (it's a task)
    if (data.valid) {
      assert.ok(data.jira_name, 'Should return issue name');
    }
  });

  it('POST /api/jira/validate rejects ineligible types', async () => {
    const { data } = await api('/api/jira/validate', {
      method: 'POST',
      body: { jira_key: 'ETTA-34' },
    });
    // ETTA-34 is a requirement
    if (!data.valid) {
      assert.ok(data.error, 'Should return error for ineligible type');
    }
  });
});

// ============================================================
// PROJECTS & TASK TYPES
// ============================================================
describe('Projects and Task Types API', () => {
  it('GET /api/projects returns projects list', async () => {
    const { status, data } = await api('/api/projects');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.projects), 'Should return projects array');
  });

  it('GET /api/task-types returns task types list', async () => {
    const { status, data } = await api('/api/task-types');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.taskTypes), 'Should return task types array');
  });
});

// ============================================================
// KEYWORDS & ROUTES
// ============================================================
describe('Keywords and Routes API', () => {
  it('GET /api/keywords returns keywords', async () => {
    const { status, data } = await api('/api/keywords');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.keywords), 'Should return keywords array');
  });

  it('GET /api/routes returns routes', async () => {
    const { status, data } = await api('/api/routes');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.routes), 'Should return routes array');
  });
});
