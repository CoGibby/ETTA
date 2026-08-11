import { getProjectKeywordMap, getTaskTypeKeywordMap, getUnifiedRouteMap, getSetting, JiraSource, ProjectSource, TaskTypeSource } from './db';

export interface ClassificationResult {
  project: string | null;
  projectSource: ProjectSource;
  taskType: string | null;
  taskTypeSource: TaskTypeSource;
  jiraIssue: string | null;
  jiraSource: JiraSource;
}

/**
 * Tokenize text into lowercase words for matching
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(word => word.length > 0);
}

/**
 * Find a matching keyword in text, supporting both single words and multi-word phrases
 * Multi-word phrases are matched via substring search, single words via exact token match
 */
export function findKeywordMatch(
  text: string,
  tokens: string[],
  keywordMap: Map<string, string>
): string | null {
  const lowerText = text.toLowerCase();

  // First, try to match multi-word phrases (keywords containing spaces)
  // Sort by length descending to match longer phrases first
  const phraseKeywords = Array.from(keywordMap.keys())
    .filter(k => k.includes(' '))
    .sort((a, b) => b.length - a.length);

  for (const phrase of phraseKeywords) {
    if (lowerText.includes(phrase)) {
      return keywordMap.get(phrase)!;
    }
  }

  // Then, try single-word token matching
  for (const token of tokens) {
    if (keywordMap.has(token)) {
      return keywordMap.get(token)!;
    }
  }

  return null;
}

/**
 * Extract Jira issue from text using Time Tracking pattern
 * Matches: "Time Tracking: XXX-123" or "Time-Tracking: XXX-123" (case-insensitive)
 * Also handles HTML entities and various whitespace/formatting from Outlook
 */
export function extractJiraIssue(text: string): string | null {
  // Clean up common HTML entities and formatting that Outlook might add
  const cleanedText = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, ' ')  // Remove HTML tags
    .replace(/\r\n/g, '\n')     // Normalize line endings
    .replace(/\s+/g, ' ');      // Normalize whitespace

  // Match "Time Tracking:" or "Time-Tracking:" followed by a Jira issue key
  // Allow for various whitespace/formatting between label and issue key
  // Pattern allows: "Time Tracking: ABC-123", "Time-Tracking:ABC-123", "time tracking ABC-123"
  const pattern = /time[- _]?tracking[:\s]*([A-Z]+-\d+)/i;
  const match = cleanedText.match(pattern);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Extract Jira issue from meeting title if it starts with [ISSUE-123]
 */
export function extractJiraFromTitle(title: string): string | null {
  const pattern = /^\[([A-Z]+-\d+)\]/i;
  const match = title.match(pattern);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Classify a source based on keyword rules
 * @param subject - The subject/title of the source
 * @param body - The body content of the source
 * @param sourceType - Optional source type ('email' or 'meeting') for source-based routing
 */
export function classifySource(
  subject: string,
  body: string,
  sourceType?: 'email' | 'meeting'
): ClassificationResult {
  const projectMap = getProjectKeywordMap();
  const taskTypeMap = getTaskTypeKeywordMap();

  const subjectTokens = tokenize(subject);

  // Find project match (subject only per spec)
  // Supports both single-word and multi-word phrase keywords
  let project: string | null = null;
  let projectSource: ProjectSource = null;
  const projectMatch = findKeywordMatch(subject, subjectTokens, projectMap);
  if (projectMatch) {
    project = projectMatch;
    projectSource = 'keyword';
  }

  // Find task type match (subject only per spec)
  // Supports both single-word and multi-word phrase keywords
  let taskType: string | null = null;
  let taskTypeSource: TaskTypeSource = null;
  const taskTypeMatch = findKeywordMatch(subject, subjectTokens, taskTypeMap);
  if (taskTypeMatch) {
    taskType = taskTypeMatch;
    taskTypeSource = 'keyword';
  }

  // Track how the Jira was assigned
  let jiraIssue: string | null = null;
  let jiraSource: JiraSource = null;

  // Extract Jira issue from title first, then body
  jiraIssue = extractJiraFromTitle(subject);
  if (jiraIssue) {
    jiraSource = 'extracted';
  }
  if (!jiraIssue) {
    jiraIssue = extractJiraIssue(body);
    if (jiraIssue) {
      jiraSource = 'extracted';
    }
  }
  if (!jiraIssue) {
    // Also check body tokens for any Jira-like pattern
    jiraIssue = extractJiraIssue(subject);
    if (jiraIssue) {
      jiraSource = 'extracted';
    }
  }

  // If no explicit Jira found, try unified route lookup with priority resolution
  // Priority: 1) project + task_type + source_type, 2) project + task_type, 3) project + source_type (fallback)
  if (!jiraIssue && project) {
    const { threeField, twoFieldTaskType, twoFieldSourceType } = getUnifiedRouteMap();

    // Priority 1: 3-field match (project + task_type + source_type) - most specific
    if (taskType && sourceType) {
      const threeFieldKey = `${project}|${taskType}|${sourceType}`;
      const route = threeField.get(threeFieldKey);
      if (route) {
        jiraIssue = route.jiraKey;
        jiraSource = 'route';
      }
    }

    // Priority 2: 2-field match with task_type (project + task_type)
    if (!jiraIssue && taskType) {
      const twoFieldKey = `${project}|${taskType}`;
      const route = twoFieldTaskType.get(twoFieldKey);
      if (route) {
        jiraIssue = route.jiraKey;
        jiraSource = 'route';
      }
    }

    // Priority 3: 2-field match with source_type (project + source_type) - fallback
    // Only used when task_type is not identified OR when no task_type route matched
    if (!jiraIssue && sourceType) {
      const sourceRouteKey = `${project}|${sourceType}`;
      const route = twoFieldSourceType.get(sourceRouteKey);
      if (route) {
        jiraIssue = route.jiraKey;
        jiraSource = 'route';
        // If this route assigns a task type and we don't have one, use it
        if (!taskType && route.assignsTaskType) {
          taskType = route.assignsTaskType;
          taskTypeSource = 'route';
        }
      }
    }
  }

  // ETTA-34: Placeholder fallback for entries with no Jira code.
  // Assigns uncoded sources (emails and meetings) to a configurable placeholder issue
  // so time is captured even when no keyword/route/extraction matched. Lowest precedence:
  // any manual/route/extracted assignment above wins. Users can reassign after the fact.
  if (!jiraIssue) {
    const placeholderKey = getSetting('placeholder_jira_issue');
    if (placeholderKey) {
      jiraIssue = placeholderKey;
      jiraSource = 'placeholder';
    }
  }

  return { project, projectSource, taskType, taskTypeSource, jiraIssue, jiraSource };
}

/**
 * Get default email duration from settings (in minutes) - legacy function
 */
export function getEmailDuration(): number {
  const setting = getSetting('email_duration_minutes');
  if (setting) {
    const value = parseInt(setting, 10);
    if (!isNaN(value) && value > 0) {
      return value;
    }
  }
  return 15; // Default to 15 minutes
}

/**
 * Calculate email duration based on character count
 * Uses configurable thresholds: short (10min), medium (20min), long (30min)
 */
export function calculateEmailDuration(body: string): number {
  const charCount = (body || '').length;

  // Get thresholds from settings, with defaults from spec
  const shortThresholdSetting = getSetting('email_short_threshold');
  const mediumThresholdSetting = getSetting('email_medium_threshold');
  const shortMinutesSetting = getSetting('email_short_minutes');
  const mediumMinutesSetting = getSetting('email_medium_minutes');
  const longMinutesSetting = getSetting('email_long_minutes');

  const shortThreshold = shortThresholdSetting ? parseInt(shortThresholdSetting, 10) : 600;
  const mediumThreshold = mediumThresholdSetting ? parseInt(mediumThresholdSetting, 10) : 1200;
  const shortMinutes = shortMinutesSetting ? parseInt(shortMinutesSetting, 10) : 10;
  const mediumMinutes = mediumMinutesSetting ? parseInt(mediumMinutesSetting, 10) : 20;
  const longMinutes = longMinutesSetting ? parseInt(longMinutesSetting, 10) : 30;

  if (charCount < shortThreshold) {
    return shortMinutes;
  } else if (charCount < mediumThreshold) {
    return mediumMinutes;
  } else {
    return longMinutes;
  }
}

/**
 * Calculate meeting duration from start/end times
 */
export function calculateMeetingDuration(startTime: string, endTime: string): number {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const durationMs = end.getTime() - start.getTime();
  const durationMinutes = Math.round(durationMs / (1000 * 60));
  return Math.max(durationMinutes, 15); // Minimum 15 minutes
}

/**
 * Round duration to 15-minute increments
 */
export function roundToQuarterHour(minutes: number): number {
  return Math.ceil(minutes / 15) * 15;
}

/**
 * Format duration for display (e.g., "1h 30m" or "45m")
 */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours === 0) {
    return `${mins}m`;
  }
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

/**
 * Parse duration string back to minutes
 */
export function parseDuration(duration: string): number {
  const hoursMatch = duration.match(/(\d+)h/);
  const minsMatch = duration.match(/(\d+)m/);

  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const mins = minsMatch ? parseInt(minsMatch[1], 10) : 0;

  return hours * 60 + mins;
}
