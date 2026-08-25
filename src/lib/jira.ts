import { getSetting } from './db';

export interface JiraCredentials {
  baseUrl: string;
  token: string;
}

export interface JiraUser {
  name: string;
  displayName?: string;
}

export interface WorklogInput {
  issueKey: string;
  timeSpentMinutes: number;
  startedDate: string; // YYYY-MM-DD
  comment?: string;
}

export interface WorklogResult {
  success: boolean;
  worklogId?: string;
  error?: string;
}

/**
 * Get Jira credentials from settings
 */
export function getJiraCredentials(): JiraCredentials | null {
  const baseUrl = getSetting('jira_url');
  const token = getSetting('jira_pat');

  if (!baseUrl || !token) {
    return null;
  }

  return { baseUrl, token };
}

/**
 * Translate a raw fetch/network error into a user-friendly message.
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error.';
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code || '';
  const msg = error.message || '';

  if (code === 'ENOTFOUND' || msg.includes('getaddrinfo')) {
    return 'Could not reach that address. Check the URL for typos — it should look like https://its-pro.ucsd.edu (no trailing slash).';
  }
  if (code === 'ECONNREFUSED') {
    return 'The server refused the connection. Verify the URL is correct and that you are on the UCSD network or VPN.';
  }
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || msg.includes('timeout')) {
    return 'The connection timed out. The server may be slow or unreachable. Try again, or check your network/VPN connection.';
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || msg.includes('certificate') || msg.includes('CERT')) {
    return 'The server certificate could not be verified. Contact your Jira administrator if this persists.';
  }
  if (msg === 'fetch failed') {
    return 'Could not connect to that address. Check the URL, make sure you are on the UCSD network or VPN, and try again.';
  }
  return msg;
}

/**
 * Test Jira connection using the session endpoint
 */
export async function testJiraConnection(baseUrl: string, token: string): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    // Ensure baseUrl doesn't end with a slash
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/rest/auth/1/session`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type') || '';

    if (response.status === 404) {
      return {
        success: false,
        message: 'That address does not have a Jira API. Check that you entered the Jira base URL (e.g. https://its-pro.ucsd.edu), not a Tempo or dashboard link.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        message: 'Your Personal Access Token was rejected. Double-check the token — it must be a Jira Personal Access Token, not your Jira password.',
      };
    }

    if (response.ok) {
      if (!contentType.includes('application/json')) {
        return {
          success: false,
          message: 'The server returned an HTML page instead of a Jira API response. Check that your address is the Jira base URL (e.g. https://its-pro.ucsd.edu), not a Tempo or dashboard link.',
        };
      }
      return {
        success: true,
        message: 'Successfully connected to Jira',
      };
    }

    return {
      success: false,
      message: `Failed to connect: ${response.statusText}`,
    };
  } catch (error) {
    return {
      success: false,
      message: describeFetchError(error),
    };
  }
}

/**
 * Validate a Jira issue key and return its summary
 */
export async function validateJiraIssue(creds: JiraCredentials, issueKey: string): Promise<{
  valid: boolean;
  jiraName?: string;
  error?: string;
}> {
  try {
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/rest/api/2/issue/${issueKey}?fields=summary`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Accept': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type') || '';

    if (response.ok) {
      if (!contentType.includes('application/json')) {
        return {
          valid: false,
          error: 'The server returned an HTML page instead of Jira data. Check that your Jira address is the base server URL (e.g. https://its-pro.ucsd.edu), not a Tempo or dashboard link.',
        };
      }
      try {
        const data = await response.json();
        return {
          valid: true,
          jiraName: data.fields?.summary || 'Unknown Issue',
        };
      } catch {
        return {
          valid: false,
          error: 'Could not parse the response from Jira. Check that your Jira address is correct.',
        };
      }
    }

    // Try to get detailed error message from response
    let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    if (contentType.includes('application/json')) {
      try {
        const errorData = await response.json();
        if (errorData.errorMessages?.length > 0) {
          errorMessage = errorData.errorMessages.join(', ');
        } else if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch {
        // Keep default error message
      }
    }

    if (response.status === 404) {
      return {
        valid: false,
        error: `Issue ${issueKey} was not found. Check the key and try again.`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        valid: false,
        error: 'Your Jira token does not have permission to view issues. Check your Personal Access Token in Settings.',
      };
    }

    return {
      valid: false,
      error: errorMessage,
    };
  } catch (error) {
    return {
      valid: false,
      error: describeFetchError(error),
    };
  }
}

/**
 * Add a worklog entry to a Jira issue
 */
export async function addWorklog(
  creds: JiraCredentials,
  input: WorklogInput
): Promise<WorklogResult> {
  try {
    // Ensure baseUrl doesn't end with a slash
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/rest/api/2/issue/${input.issueKey}/worklog`;

    // Format started time as ISO datetime
    const startedDateTime = `${input.startedDate}T09:00:00.000+0000`;

    // Convert minutes to Jira format (e.g., "1h 30m")
    const hours = Math.floor(input.timeSpentMinutes / 60);
    const minutes = input.timeSpentMinutes % 60;
    let timeSpent = '';
    if (hours > 0) timeSpent += `${hours}h `;
    if (minutes > 0) timeSpent += `${minutes}m`;
    if (!timeSpent) timeSpent = '0m';

    const body: Record<string, unknown> = {
      timeSpent: timeSpent.trim(),
      started: startedDateTime,
    };

    if (input.comment) {
      body.comment = input.comment;
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      let responseData;
      const responseText = await response.text();
      try {
        responseData = responseText ? JSON.parse(responseText) : null;
      } catch {
        // Response wasn't JSON but request succeeded
      }
      return {
        success: true,
        worklogId: responseData?.id?.toString(),
      };
    }

    // Handle specific error cases
    if (response.status === 404) {
      return {
        success: false,
        error: 'Issue not found. Please check the issue key.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        error: 'Authentication failed. Please check your Personal Access Token.',
      };
    }

    // Try to parse error response
    let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    try {
      const errorData = await response.json();
      if (errorData.errorMessages?.length > 0) {
        errorMessage = errorData.errorMessages.join(', ');
      } else if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      // Keep default error message
    }

    return {
      success: false,
      error: errorMessage,
    };
  } catch (error) {
    return {
      success: false,
      error: describeFetchError(error),
    };
  }
}

/**
 * Fetch Jira favorites from Tempo Core API
 */
export async function fetchJiraFavorites(creds: JiraCredentials): Promise<{
  success: boolean;
  favorites?: { jiraKey: string; jiraName: string }[];
  error?: string;
}> {
  try {
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');

    // First request: Get favorite issue keys from Tempo Core
    const favoritesUrl = `${cleanBaseUrl}/rest/tempo-core/1/favorites/issue/`;
    const favoritesResponse = await fetch(favoritesUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    if (!favoritesResponse.ok) {
      if (favoritesResponse.status === 401 || favoritesResponse.status === 403) {
        return { success: false, error: 'Authentication failed. Please check your credentials.' };
      }
      return { success: false, error: `Failed to fetch favorites: ${favoritesResponse.statusText}` };
    }

    const favoriteKeys = await favoritesResponse.json();

    if (!favoriteKeys || !Array.isArray(favoriteKeys) || favoriteKeys.length === 0) {
      return { success: true, favorites: [] };
    }

    // Second request: Get issue details for favorites
    const searchUrl = `${cleanBaseUrl}/rest/api/2/search`;
    const searchResponse = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        jql: `issue in (${favoriteKeys.map((key: string) => `"${key}"`).join(', ')})`,
        fields: ['summary'],
        maxResults: 200,
      }),
    });

    if (!searchResponse.ok) {
      return { success: false, error: `Failed to fetch issue details: ${searchResponse.statusText}` };
    }

    const searchData = await searchResponse.json();
    const issues = searchData.issues || [];

    const favorites = issues.map((issue: { key: string; fields: { summary: string } }) => ({
      jiraKey: issue.key,
      jiraName: issue.fields.summary,
    }));

    return { success: true, favorites };
  } catch (error) {
    return {
      success: false,
      error: describeFetchError(error),
    };
  }
}

/**
 * Push multiple worklogs with rate limiting
 */
export async function pushWorklogs(
  creds: JiraCredentials,
  worklogs: WorklogInput[]
): Promise<{
  success: boolean;
  results: { input: WorklogInput; result: WorklogResult }[];
  pushed: number;
  failed: number;
}> {
  const results: { input: WorklogInput; result: WorklogResult }[] = [];
  let pushed = 0;
  let failed = 0;

  for (const worklog of worklogs) {
    const result = await addWorklog(creds, worklog);
    results.push({ input: worklog, result });

    if (result.success) {
      pushed++;
    } else {
      failed++;
    }

    // Rate limit: 50ms between requests
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return {
    success: failed === 0,
    results,
    pushed,
    failed,
  };
}
/**
 * Search Jira issues by key or summary using JQL.
 * Returns all matching issues for autocomplete.
 */
export async function searchJiraIssues(creds: JiraCredentials, query: string): Promise<{
  success: boolean;
  issues?: { key: string; summary: string }[];
  error?: string;
}> {
  try {
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');

    // Build JQL: match by issue key prefix or summary text
    const safeQuery = query.replace(/"/g, '\"');
    const jql = `key = "${safeQuery}" OR key ~ "${safeQuery}*" OR summary ~ "${safeQuery}*" ORDER BY updated DESC`;
    const apiUrl = `${cleanBaseUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Accept': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      return {
        success: false,
        error: `Search failed: ${response.statusText}`,
      };
    }

    if (!contentType.includes('application/json')) {
      return {
        success: false,
        error: 'Jira returned an unexpected response. Check your server address in Settings.',
      };
    }

    const data = await response.json();

    // The search API returns issues directly
    const issues: { key: string; summary: string }[] = [];
    const rawIssues = data.issues || [];
    for (const issue of rawIssues) {
      if (issue.key) {
        issues.push({
          key: issue.key,
          summary: (issue.fields && issue.fields.summary) || issue.key,
        });
      }
    }

    // Deduplicate by key
    const seen = new Set<string>();
    const deduped = issues.filter((i) => {
      if (seen.has(i.key)) return false;
      seen.add(i.key);
      return true;
    });

    return { success: true, issues: deduped };
  } catch (error) {
    return {
      success: false,
      error: describeFetchError(error),
    };
  }
}