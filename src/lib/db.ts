import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './data/keywords.db';
const dbPath = path.resolve(DB_PATH);

// Ensure data directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Initialize base tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('email', 'meeting')),
    subject TEXT,
    body TEXT,
    date TEXT NOT NULL,
    imported_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS task_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    frequency INTEGER DEFAULT 0,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    task_type_id INTEGER REFERENCES task_types(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);
  CREATE INDEX IF NOT EXISTS idx_sources_date ON sources(date);
  CREATE INDEX IF NOT EXISTS idx_keywords_frequency ON keywords(frequency DESC);
  CREATE INDEX IF NOT EXISTS idx_keywords_project ON keywords(project_id);
  CREATE INDEX IF NOT EXISTS idx_keywords_task_type ON keywords(task_type_id);
`);

// Migration: Add source_type column to keywords table if it doesn't exist
try {
  db.exec(`ALTER TABLE keywords ADD COLUMN source_type TEXT NOT NULL DEFAULT 'both'`);
} catch {
  // Column already exists, ignore error
}

// Create index on source_type (after migration ensures column exists)
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_keywords_source_type ON keywords(source_type)`);
} catch {
  // Index might already exist
}

// Add unique index on sources to prevent duplicates (type + subject + date)
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_unique ON sources(type, subject, date)`);
} catch {
  // Index might already exist
}

// Migration: Add duration_minutes column to sources table for meetings
try {
  db.exec(`ALTER TABLE sources ADD COLUMN duration_minutes INTEGER`);
} catch {
  // Column already exists, ignore error
}

// Migration: Add status column to sources table for tracking stale sources
// Values: 'active' (default), 'stale' (cancelled/deleted from Outlook)
try {
  db.exec(`ALTER TABLE sources ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale'))`);
} catch {
  // Column already exists, ignore error
}

// Add index for efficient status filtering
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status)`);
} catch {
  // Index might already exist
}

// Migration: Add external_id column to sources table for stable meeting identification
// GlobalAppointmentID from Outlook survives time/subject changes
try {
  db.exec(`ALTER TABLE sources ADD COLUMN external_id TEXT`);
} catch {
  // Column already exists, ignore error
}

// Add unique index on external_id for sources that have it (meetings)
// This allows duplicate detection by external_id when available
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_external_id ON sources(external_id) WHERE external_id IS NOT NULL AND external_id != ''`);
} catch {
  // Index might already exist
}

// Drop old unique constraint and add new one that includes source_type
// Note: SQLite doesn't support dropping constraints, so we need to recreate table for new DBs
// For existing DBs, the unique constraint on (word, source_type) won't be enforced
// but the code handles this by checking for existing records

// Migration: Create project_keywords table for many-to-many relationship
db.exec(`
  CREATE TABLE IF NOT EXISTS project_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    UNIQUE(project_id, keyword)
  );
  CREATE INDEX IF NOT EXISTS idx_project_keywords_project ON project_keywords(project_id);
`);

// Migration: Create task_type_keywords table for many-to-many relationship
db.exec(`
  CREATE TABLE IF NOT EXISTS task_type_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type_id INTEGER NOT NULL REFERENCES task_types(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    UNIQUE(task_type_id, keyword)
  );
  CREATE INDEX IF NOT EXISTS idx_task_type_keywords_task_type ON task_type_keywords(task_type_id);
`);

// Migration: Create project_email_patterns table for email/domain associations
db.exec(`
  CREATE TABLE IF NOT EXISTS project_email_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    UNIQUE(project_id, pattern)
  );
  CREATE INDEX IF NOT EXISTS idx_project_email_patterns_project ON project_email_patterns(project_id);
`);

export { db };

// Helper functions
export function getSources(type?: string) {
  if (type) {
    return db.prepare('SELECT * FROM sources WHERE type = ? ORDER BY date DESC').all(type);
  }
  return db.prepare('SELECT * FROM sources ORDER BY date DESC').all();
}

export function insertSource(type: string, subject: string, body: string, date: string, durationMinutes?: number, externalId?: string) {
  return db.prepare('INSERT INTO sources (type, subject, body, date, duration_minutes, external_id) VALUES (?, ?, ?, ?, ?, ?)').run(type, subject, body, date, durationMinutes ?? null, externalId ?? null);
}

export function insertSourceIfNew(type: string, subject: string, body: string, date: string, durationMinutes?: number, externalId?: string): { inserted: boolean; id?: number; updated?: boolean } {
  // If external_id is provided (meetings), use it for duplicate detection
  // This survives time/subject changes in Outlook
  if (externalId) {
    const existingByExternalId = db.prepare('SELECT id FROM sources WHERE external_id = ?').get(externalId) as { id: number } | undefined;
    if (existingByExternalId) {
      // Before updating, check if another source would conflict with the new (type, subject, date)
      const conflicting = db.prepare('SELECT id FROM sources WHERE type = ? AND subject = ? AND date = ? AND id != ?').get(type, subject, date, existingByExternalId.id) as { id: number } | undefined;
      if (conflicting) {
        // Delete the conflicting source (it's a stale duplicate without external_id)
        db.prepare('DELETE FROM entries WHERE source_id = ? AND status = ?').run(conflicting.id, 'pending');
        db.prepare('DELETE FROM sources WHERE id = ?').run(conflicting.id);
      }
      // Update existing source with new data (time may have changed)
      db.prepare(`
        UPDATE sources
        SET subject = ?, body = ?, date = ?, duration_minutes = ?, imported_at = datetime('now'), status = 'active'
        WHERE id = ?
      `).run(subject, body, date, durationMinutes ?? null, existingByExternalId.id);
      return { inserted: false, updated: true, id: existingByExternalId.id };
    }
  }

  // Fall back to old behavior: try insert, handle duplicate by (type, subject, date)
  try {
    const result = db.prepare('INSERT INTO sources (type, subject, body, date, duration_minutes, external_id) VALUES (?, ?, ?, ?, ?, ?)').run(type, subject, body, date, durationMinutes ?? null, externalId ?? null);
    return { inserted: true, id: result.lastInsertRowid as number };
  } catch {
    // Duplicate detected (unique constraint violation) - update imported_at and return existing id
    const existing = db.prepare('SELECT id FROM sources WHERE type = ? AND subject = ? AND date = ?').get(type, subject, date) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE sources SET imported_at = datetime('now'), status = 'active' WHERE id = ?").run(existing.id);
    }
    return { inserted: false, id: existing?.id };
  }
}

export function checkSourceExists(type: string, subject: string, date: string): boolean {
  const result = db.prepare('SELECT 1 FROM sources WHERE type = ? AND subject = ? AND date = ?').get(type, subject, date);
  return !!result;
}

export function clearSources() {
  return db.prepare('DELETE FROM sources').run();
}

export function getProjects() {
  return db.prepare(`
    SELECT p.*, COUNT(pk.id) as keyword_count
    FROM projects p
    LEFT JOIN project_keywords pk ON pk.project_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all();
}

export function getProject(id: number) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as { id: number; name: string } | undefined;
  if (!project) return null;
  const keywords = db.prepare('SELECT keyword FROM project_keywords WHERE project_id = ?').all(id) as { keyword: string }[];
  const emailPatterns = db.prepare('SELECT pattern FROM project_email_patterns WHERE project_id = ?').all(id) as { pattern: string }[];
  return { ...project, keywords: keywords.map(k => k.keyword), emailPatterns: emailPatterns.map(e => e.pattern) };
}

export function addProjectKeyword(projectId: number, keyword: string) {
  try {
    return db.prepare('INSERT INTO project_keywords (project_id, keyword) VALUES (?, ?)').run(projectId, keyword.toLowerCase().trim());
  } catch {
    // Keyword already exists for this project
    return { changes: 0 };
  }
}

export function removeProjectKeyword(projectId: number, keyword: string) {
  return db.prepare('DELETE FROM project_keywords WHERE project_id = ? AND keyword = ?').run(projectId, keyword.toLowerCase().trim());
}

export function getProjectKeywords(projectId: number) {
  return db.prepare('SELECT keyword FROM project_keywords WHERE project_id = ?').all(projectId) as { keyword: string }[];
}

export function addProjectEmailPattern(projectId: number, pattern: string) {
  try {
    return db.prepare('INSERT INTO project_email_patterns (project_id, pattern) VALUES (?, ?)').run(projectId, pattern.toLowerCase().trim());
  } catch {
    // Pattern already exists for this project
    return { changes: 0 };
  }
}

export function removeProjectEmailPattern(projectId: number, pattern: string) {
  return db.prepare('DELETE FROM project_email_patterns WHERE project_id = ? AND pattern = ?').run(projectId, pattern.toLowerCase().trim());
}

export function getProjectEmailPatterns(projectId: number) {
  return db.prepare('SELECT pattern FROM project_email_patterns WHERE project_id = ?').all(projectId) as { pattern: string }[];
}

export function createProject(name: string) {
  return db.prepare('INSERT INTO projects (name) VALUES (?)').run(name);
}

export function updateProject(id: number, name: string) {
  // Get old name first to update entries
  const oldProject = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined;
  const oldName = oldProject?.name;

  // Update the project name
  const result = db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);

  // Update all entries that reference the old project name
  if (oldName && oldName !== name) {
    db.prepare('UPDATE entries SET project = ? WHERE project = ?').run(name, oldName);
  }

  return result;
}

export function deleteProject(id: number) {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// Utility to rename project references in entries (for fixing orphaned data)
export function renameProjectInEntries(oldName: string, newName: string) {
  return db.prepare('UPDATE entries SET project = ? WHERE project = ?').run(newName, oldName);
}

export function getTaskTypes() {
  return db.prepare(`
    SELECT t.*, COUNT(tk.id) as keyword_count
    FROM task_types t
    LEFT JOIN task_type_keywords tk ON tk.task_type_id = t.id
    GROUP BY t.id
    ORDER BY t.name
  `).all();
}

export function getTaskType(id: number) {
  const taskType = db.prepare('SELECT * FROM task_types WHERE id = ?').get(id) as { id: number; name: string } | undefined;
  if (!taskType) return null;
  const keywords = db.prepare('SELECT keyword FROM task_type_keywords WHERE task_type_id = ?').all(id) as { keyword: string }[];
  return { ...taskType, keywords: keywords.map(k => k.keyword) };
}

export function addTaskTypeKeyword(taskTypeId: number, keyword: string) {
  try {
    return db.prepare('INSERT INTO task_type_keywords (task_type_id, keyword) VALUES (?, ?)').run(taskTypeId, keyword.toLowerCase().trim());
  } catch {
    // Keyword already exists for this task type
    return { changes: 0 };
  }
}

export function removeTaskTypeKeyword(taskTypeId: number, keyword: string) {
  return db.prepare('DELETE FROM task_type_keywords WHERE task_type_id = ? AND keyword = ?').run(taskTypeId, keyword.toLowerCase().trim());
}

export function getTaskTypeKeywords(taskTypeId: number) {
  return db.prepare('SELECT keyword FROM task_type_keywords WHERE task_type_id = ?').all(taskTypeId) as { keyword: string }[];
}

export function createTaskType(name: string) {
  return db.prepare('INSERT INTO task_types (name) VALUES (?)').run(name);
}

export function updateTaskType(id: number, name: string) {
  // Get old name first to update entries
  const oldTaskType = db.prepare('SELECT name FROM task_types WHERE id = ?').get(id) as { name: string } | undefined;
  const oldName = oldTaskType?.name;

  // Update the task type name
  const result = db.prepare('UPDATE task_types SET name = ? WHERE id = ?').run(name, id);

  // Update all entries that reference the old task type name
  if (oldName && oldName !== name) {
    db.prepare('UPDATE entries SET task_type = ? WHERE task_type = ?').run(name, oldName);
  }

  return result;
}

export function deleteTaskType(id: number) {
  return db.prepare('DELETE FROM task_types WHERE id = ?').run(id);
}

// Utility to rename task type references in entries (for fixing orphaned data)
export function renameTaskTypeInEntries(oldName: string, newName: string) {
  return db.prepare('UPDATE entries SET task_type = ? WHERE task_type = ?').run(newName, oldName);
}

export function getKeywords(options: { sort?: string; limit?: number; unassigned?: boolean; sourceType?: 'subject' | 'body' | 'both' } = {}) {
  let query = 'SELECT k.*, p.name as project_name, t.name as task_type_name FROM keywords k LEFT JOIN projects p ON k.project_id = p.id LEFT JOIN task_types t ON k.task_type_id = t.id';

  const conditions: string[] = [];

  if (options.unassigned) {
    conditions.push('k.project_id IS NULL AND k.task_type_id IS NULL');
  }

  if (options.sourceType) {
    conditions.push(`k.source_type = '${options.sourceType}'`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY k.frequency DESC';

  if (options.limit) {
    query += ` LIMIT ${options.limit}`;
  }

  return db.prepare(query).all();
}

export function getKeyword(id: number) {
  return db.prepare('SELECT * FROM keywords WHERE id = ?').get(id);
}

export function upsertKeyword(word: string, frequency: number, sourceType: 'subject' | 'body' | 'both' = 'both') {
  // Check if word already exists
  const existing = db.prepare('SELECT * FROM keywords WHERE word = ?').get(word) as { id: number; source_type: string; frequency: number } | undefined;

  if (existing) {
    // Determine new source_type: if existing is different from new, upgrade to 'both'
    let newSourceType = sourceType;
    if (existing.source_type !== sourceType && existing.source_type !== 'both' && sourceType !== 'both') {
      newSourceType = 'both';
    } else if (existing.source_type === 'both') {
      newSourceType = 'both'; // Keep 'both' if already set
    }

    return db.prepare('UPDATE keywords SET frequency = ?, source_type = ? WHERE word = ?').run(frequency, newSourceType, word);
  }

  return db.prepare('INSERT INTO keywords (word, frequency, source_type) VALUES (?, ?, ?)').run(word, frequency, sourceType);
}

export function assignKeyword(id: number, projectId: number | null, taskTypeId: number | null) {
  return db.prepare('UPDATE keywords SET project_id = ?, task_type_id = ? WHERE id = ?').run(projectId, taskTypeId, id);
}

export function bulkAssignKeywords(ids: number[], projectId: number | null, taskTypeId: number | null) {
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`UPDATE keywords SET project_id = ?, task_type_id = ? WHERE id IN (${placeholders})`).run(projectId, taskTypeId, ...ids);
}

export function deleteKeyword(id: number) {
  return db.prepare('DELETE FROM keywords WHERE id = ?').run(id);
}

export function clearKeywords(sourceType?: 'subject' | 'body' | 'both') {
  if (sourceType) {
    return db.prepare('DELETE FROM keywords WHERE source_type = ?').run(sourceType);
  }
  return db.prepare('DELETE FROM keywords').run();
}

export function clearAll() {
  // Clear in order to respect foreign key relationships
  db.prepare('DELETE FROM project_keywords').run();
  db.prepare('DELETE FROM task_type_keywords').run();
  db.prepare('DELETE FROM project_email_patterns').run();
  db.prepare('DELETE FROM keywords').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM task_types').run();
  db.prepare('DELETE FROM sources').run();
  return { cleared: true };
}

export function clearTransientData() {
  // Clear transient data (entries, sources, and unassigned keywords)
  // Preserve classifier configuration: projects, task_types, project_keywords, task_type_keywords
  db.prepare('DELETE FROM entries').run();
  db.prepare('DELETE FROM sources').run();
  // Clear keywords that aren't assigned to any project or task type
  db.prepare(`
    DELETE FROM keywords
    WHERE word NOT IN (SELECT LOWER(keyword) FROM project_keywords)
    AND word NOT IN (SELECT LOWER(keyword) FROM task_type_keywords)
  `).run();
  return { cleared: true };
}

export function getKeywordAssignments(word: string) {
  const projects = db.prepare(`
    SELECT p.id, p.name
    FROM projects p
    JOIN project_keywords pk ON pk.project_id = p.id
    WHERE LOWER(pk.keyword) = LOWER(?)
  `).all(word) as { id: number; name: string }[];

  const taskTypes = db.prepare(`
    SELECT t.id, t.name
    FROM task_types t
    JOIN task_type_keywords tk ON tk.task_type_id = t.id
    WHERE LOWER(tk.keyword) = LOWER(?)
  `).all(word) as { id: number; name: string }[];

  return { projects, taskTypes };
}

export function getKeywordsWithAssignments(options: { sourceType?: 'subject' | 'body' | 'both' } = {}) {
  // Get all keywords
  let query = 'SELECT k.* FROM keywords k';
  if (options.sourceType) {
    query += ` WHERE k.source_type = '${options.sourceType}'`;
  }
  query += ' ORDER BY k.frequency DESC';

  const keywords = db.prepare(query).all() as { id: number; word: string; frequency: number; source_type: string }[];

  // Get all project keyword mappings
  const projectKeywords = db.prepare(`
    SELECT pk.keyword, p.id as project_id, p.name as project_name
    FROM project_keywords pk
    JOIN projects p ON p.id = pk.project_id
  `).all() as { keyword: string; project_id: number; project_name: string }[];

  // Get all task type keyword mappings
  const taskTypeKeywords = db.prepare(`
    SELECT tk.keyword, t.id as task_type_id, t.name as task_type_name
    FROM task_type_keywords tk
    JOIN task_types t ON t.id = tk.task_type_id
  `).all() as { keyword: string; task_type_id: number; task_type_name: string }[];

  // Build lookup maps
  const projectMap = new Map<string, { id: number; name: string }[]>();
  for (const pk of projectKeywords) {
    const key = pk.keyword.toLowerCase();
    if (!projectMap.has(key)) projectMap.set(key, []);
    projectMap.get(key)!.push({ id: pk.project_id, name: pk.project_name });
  }

  const taskTypeMap = new Map<string, { id: number; name: string }[]>();
  for (const tk of taskTypeKeywords) {
    const key = tk.keyword.toLowerCase();
    if (!taskTypeMap.has(key)) taskTypeMap.set(key, []);
    taskTypeMap.get(key)!.push({ id: tk.task_type_id, name: tk.task_type_name });
  }

  // Enrich keywords with assignments
  return keywords.map(kw => ({
    ...kw,
    assigned_projects: projectMap.get(kw.word.toLowerCase()) || [],
    assigned_task_types: taskTypeMap.get(kw.word.toLowerCase()) || []
  }));
}

export function getExportData() {
  const projects = db.prepare(`
    SELECT p.id, p.name, GROUP_CONCAT(pk.keyword) as keywords
    FROM projects p
    LEFT JOIN project_keywords pk ON pk.project_id = p.id
    GROUP BY p.id
  `).all() as { id: number; name: string; keywords: string | null }[];

  // Get email patterns for each project
  const projectEmailPatterns = db.prepare(`
    SELECT project_id, GROUP_CONCAT(pattern) as patterns
    FROM project_email_patterns
    GROUP BY project_id
  `).all() as { project_id: number; patterns: string | null }[];

  const emailPatternsMap = new Map<number, string[]>();
  for (const pep of projectEmailPatterns) {
    emailPatternsMap.set(pep.project_id, pep.patterns ? pep.patterns.split(',') : []);
  }

  const taskTypes = db.prepare(`
    SELECT t.name, GROUP_CONCAT(tk.keyword) as keywords
    FROM task_types t
    LEFT JOIN task_type_keywords tk ON tk.task_type_id = t.id
    GROUP BY t.id
  `).all() as { name: string; keywords: string | null }[];

  return {
    projects: projects.map(p => ({
      name: p.name,
      keywords: p.keywords ? p.keywords.split(',') : [],
      emailPatterns: emailPatternsMap.get(p.id) || []
    })),
    taskTypes: taskTypes.map(t => ({
      name: t.name,
      keywords: t.keywords ? t.keywords.split(',') : []
    }))
  };
}

// ============================================================================
// ENTRIES TABLE - Time entries for review and push to Jira
// ============================================================================

// Migration: Create entries table
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('email', 'meeting', 'manual')),
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 15,
    jira_issue TEXT,
    project TEXT,
    task_type TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pushed', 'excluded')),
    pushed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
  CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
  CREATE INDEX IF NOT EXISTS idx_entries_jira ON entries(jira_issue);
`);

// Migration: Add unique constraint on source_id (one entry per source)
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_source ON entries(source_id) WHERE source_id IS NOT NULL`);
} catch {
  // Index might already exist
}

// Migration: Add context_minutes column to entries table for tracking context switching time
try {
  db.exec(`ALTER TABLE entries ADD COLUMN context_minutes INTEGER DEFAULT 0`);
} catch {
  // Column already exists, ignore error
}

// Migration: Add jira_source column to track how jira_issue was assigned
// Values: 'manual' (user assigned), 'route' (auto via route), 'source_route' (auto via source route), 'extracted' (from text)
try {
  db.exec(`ALTER TABLE entries ADD COLUMN jira_source TEXT CHECK (jira_source IN ('manual', 'route', 'source_route', 'extracted'))`);
} catch {
  // Column already exists, ignore error
}

// Migration: Add jira_name column to store the Jira issue summary/title
try {
  db.exec(`ALTER TABLE entries ADD COLUMN jira_name TEXT`);
} catch {
  // Column already exists, ignore error
}

// Migration: Add project_source column to track how project was assigned
// Values: 'manual' (user assigned), 'keyword' (auto via keyword match), 'route' (auto via route)
try {
  db.exec(`ALTER TABLE entries ADD COLUMN project_source TEXT CHECK (project_source IN ('manual', 'keyword', 'route'))`);
} catch {
  // Column already exists, ignore error
}

// Migration: Add task_type_source column to track how task_type was assigned
// Values: 'manual' (user assigned), 'keyword' (auto via keyword match), 'route' (auto via route)
try {
  db.exec(`ALTER TABLE entries ADD COLUMN task_type_source TEXT CHECK (task_type_source IN ('manual', 'keyword', 'route'))`);
} catch {
  // Column already exists, ignore error
}

// Migration: Mark existing non-null project/task_type assignments as 'manual' to preserve user's work
// This is a one-time migration for entries created before source tracking was added
try {
  db.exec(`UPDATE entries SET project_source = 'manual' WHERE project IS NOT NULL AND project_source IS NULL`);
  db.exec(`UPDATE entries SET task_type_source = 'manual' WHERE task_type IS NOT NULL AND task_type_source IS NULL`);
} catch {
  // Migration already ran or table doesn't exist yet
}

export type JiraSource = 'manual' | 'route' | 'source_route' | 'extracted' | 'placeholder' | null;
export type ProjectSource = 'manual' | 'keyword' | 'route' | null;
export type TaskTypeSource = 'manual' | 'keyword' | 'route' | null;

export interface Entry {
  id: number;
  source_id: number | null;
  source_type: 'email' | 'meeting' | 'manual';
  title: string;
  date: string;
  start_time: string | null;
  duration_minutes: number;
  context_minutes: number;
  jira_issue: string | null;
  jira_name: string | null;
  jira_source: JiraSource;
  project: string | null;
  project_source: ProjectSource;
  task_type: string | null;
  task_type_source: TaskTypeSource;
  status: 'pending' | 'pushed' | 'excluded';
  pushed_at: string | null;
  created_at: string;
}

export type SourceStatus = 'active' | 'stale' | null;

export interface EntryWithSourceStatus extends Entry {
  source_status: SourceStatus;
}

export function getEntries(options: {
  date?: string;
  startDate?: string;
  endDate?: string;
  status?: 'pending' | 'pushed' | 'excluded';
  hasJiraIssue?: boolean;
} = {}): EntryWithSourceStatus[] {
  let query = `
    SELECT e.*, s.status as source_status
    FROM entries e
    LEFT JOIN sources s ON e.source_id = s.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (options.date) {
    query += ' AND e.date = ?';
    params.push(options.date);
  }
  if (options.startDate) {
    query += ' AND e.date >= ?';
    params.push(options.startDate);
  }
  if (options.endDate) {
    query += ' AND e.date <= ?';
    params.push(options.endDate);
  }
  if (options.status) {
    query += ' AND e.status = ?';
    params.push(options.status);
  }
  if (options.hasJiraIssue === true) {
    query += ' AND e.jira_issue IS NOT NULL AND e.jira_issue != ""';
  } else if (options.hasJiraIssue === false) {
    query += ' AND (e.jira_issue IS NULL OR e.jira_issue = "")';
  }

  query += ' ORDER BY e.date DESC, e.start_time DESC';

  return db.prepare(query).all(...params) as EntryWithSourceStatus[];
}

export function getEntry(id: number): Entry | null {
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Entry | null;
}

export function createEntry(entry: {
  source_id?: number | null;
  source_type: 'email' | 'meeting' | 'manual';
  title: string;
  date: string;
  start_time?: string | null;
  duration_minutes: number;
  context_minutes?: number;
  jira_issue?: string | null;
  jira_name?: string | null;
  jira_source?: JiraSource;
  project?: string | null;
  project_source?: ProjectSource;
  task_type?: string | null;
  task_type_source?: TaskTypeSource;
  status?: 'pending' | 'pushed' | 'excluded';
}): { id: number } {
  const result = db.prepare(`
    INSERT INTO entries (source_id, source_type, title, date, start_time, duration_minutes, context_minutes, jira_issue, jira_name, jira_source, project, project_source, task_type, task_type_source, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.source_id ?? null,
    entry.source_type,
    entry.title,
    entry.date,
    entry.start_time ?? null,
    entry.duration_minutes,
    entry.context_minutes ?? 0,
    entry.jira_issue ?? null,
    entry.jira_name ?? null,
    entry.jira_source ?? null,
    entry.project ?? null,
    entry.project_source ?? null,
    entry.task_type ?? null,
    entry.task_type_source ?? null,
    entry.status ?? 'pending'
  );
  return { id: result.lastInsertRowid as number };
}

export function updateEntry(id: number, updates: Partial<{
  title: string;
  date: string;
  start_time: string | null;
  duration_minutes: number;
  jira_issue: string | null;
  jira_name: string | null;
  jira_source: JiraSource;
  project: string | null;
  project_source: ProjectSource;
  task_type: string | null;
  task_type_source: TaskTypeSource;
  status: 'pending' | 'pushed' | 'excluded';
  pushed_at: string | null;
}>): { changes: number } {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.date !== undefined) { fields.push('date = ?'); values.push(updates.date); }
  if (updates.start_time !== undefined) { fields.push('start_time = ?'); values.push(updates.start_time); }
  if (updates.duration_minutes !== undefined) { fields.push('duration_minutes = ?'); values.push(updates.duration_minutes); }
  if (updates.jira_issue !== undefined) { fields.push('jira_issue = ?'); values.push(updates.jira_issue); }
  if (updates.jira_name !== undefined) { fields.push('jira_name = ?'); values.push(updates.jira_name); }
  if (updates.jira_source !== undefined) { fields.push('jira_source = ?'); values.push(updates.jira_source); }
  if (updates.project !== undefined) { fields.push('project = ?'); values.push(updates.project); }
  if (updates.project_source !== undefined) { fields.push('project_source = ?'); values.push(updates.project_source); }
  if (updates.task_type !== undefined) { fields.push('task_type = ?'); values.push(updates.task_type); }
  if (updates.task_type_source !== undefined) { fields.push('task_type_source = ?'); values.push(updates.task_type_source); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.pushed_at !== undefined) { fields.push('pushed_at = ?'); values.push(updates.pushed_at); }

  if (fields.length === 0) return { changes: 0 };

  values.push(id);
  const result = db.prepare(`UPDATE entries SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return { changes: result.changes };
}

export function deleteEntry(id: number): { changes: number } {
  const result = db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  return { changes: result.changes };
}

export function bulkUpdateEntries(ids: number[], updates: Partial<{
  jira_issue: string | null;
  jira_name: string | null;
  jira_source: JiraSource;
  project: string | null;
  project_source: ProjectSource;
  task_type: string | null;
  task_type_source: TaskTypeSource;
  status: 'pending' | 'pushed' | 'excluded';
  pushed_at: string | null;
}>): { changes: number } {
  if (ids.length === 0) return { changes: 0 };

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.jira_issue !== undefined) { fields.push('jira_issue = ?'); values.push(updates.jira_issue); }
  if (updates.jira_name !== undefined) { fields.push('jira_name = ?'); values.push(updates.jira_name); }
  if (updates.jira_source !== undefined) { fields.push('jira_source = ?'); values.push(updates.jira_source); }
  if (updates.project !== undefined) { fields.push('project = ?'); values.push(updates.project); }
  if (updates.project_source !== undefined) { fields.push('project_source = ?'); values.push(updates.project_source); }
  if (updates.task_type !== undefined) { fields.push('task_type = ?'); values.push(updates.task_type); }
  if (updates.task_type_source !== undefined) { fields.push('task_type_source = ?'); values.push(updates.task_type_source); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.pushed_at !== undefined) { fields.push('pushed_at = ?'); values.push(updates.pushed_at); }

  if (fields.length === 0) return { changes: 0 };

  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(`UPDATE entries SET ${fields.join(', ')} WHERE id IN (${placeholders})`).run(...values, ...ids);
  return { changes: result.changes };
}

export function getEntryBySourceId(sourceId: number): Entry | null {
  return db.prepare('SELECT * FROM entries WHERE source_id = ?').get(sourceId) as Entry | null;
}

export function clearEntries(): { changes: number } {
  const result = db.prepare('DELETE FROM entries').run();
  return { changes: result.changes };
}

/**
 * Apply routes to existing entries that haven't been manually assigned.
 * This function finds entries where:
 * - jira_source is null or 'route'/'source_route'/'placeholder' (not 'manual' or 'extracted')
 * - project and task_type are both set
 * Then looks up routes and updates jira_issue/jira_source accordingly.
 * ETTA-34: meetings with no Jira code fall back to the placeholder issue instead of being cleared.
 */
export function applyRoutesToEntries(): { updated: number; cleared: number } {
  // Get all entries that can have routes applied (not manually assigned or extracted)
  const entries = db.prepare(`
    SELECT id, project, task_type, source_type, jira_issue, jira_source
    FROM entries
    WHERE (jira_source IS NULL OR jira_source IN ('route', 'source_route', 'placeholder'))
      AND status != 'pushed'
  `).all() as {
    id: number;
    project: string | null;
    task_type: string | null;
    source_type: 'email' | 'meeting' | 'manual';
    jira_issue: string | null;
    jira_source: JiraSource;
  }[];

  // Get the route maps
  const { threeField, twoFieldTaskType, twoFieldSourceType, sourceOnlyType } = getUnifiedRouteMap();
  const placeholderKey = getSetting('placeholder_jira_issue');

  let updated = 0;
  let cleared = 0;

  const updateStmt = db.prepare(`
    UPDATE entries SET jira_issue = ?, jira_source = ? WHERE id = ?
  `);

  for (const entry of entries) {
    let newJiraKey: string | null = null;
    let newJiraSource: JiraSource = null;
    const sourceType = entry.source_type === 'manual' ? null : entry.source_type;

    // Priority 1-3: Routes that require project
    if (entry.project) {
      // Priority 1: 3-field match (project + task_type + source_type)
      if (entry.task_type && sourceType) {
        const threeFieldKey = `${entry.project}|${entry.task_type}|${sourceType}`;
        const route = threeField.get(threeFieldKey);
        if (route) {
          newJiraKey = route.jiraKey;
          newJiraSource = 'route';
        }
      }

      // Priority 2: 2-field match with task_type (project + task_type)
      if (!newJiraKey && entry.task_type) {
        const twoFieldKey = `${entry.project}|${entry.task_type}`;
        const route = twoFieldTaskType.get(twoFieldKey);
        if (route) {
          newJiraKey = route.jiraKey;
          newJiraSource = 'route';
        }
      }

      // Priority 3: 2-field match with source_type (project + source_type) - fallback
      if (!newJiraKey && sourceType) {
        const sourceRouteKey = `${entry.project}|${sourceType}`;
        const route = twoFieldSourceType.get(sourceRouteKey);
        if (route) {
          newJiraKey = route.jiraKey;
          newJiraSource = 'source_route';
        }
      }
    }

    // Priority 4: Source-only match (global fallback, applies regardless of project)
    if (!newJiraKey && sourceType) {
      const route = sourceOnlyType.get(sourceType);
      if (route) {
        newJiraKey = route.jiraKey;
        newJiraSource = 'source_route';
      }
    }

    // Update entry if route found or if we need to clear a stale route assignment
    if (newJiraKey) {
      // Route found - apply it (this upgrades placeholder/route assignments to a real route)
      if (entry.jira_issue !== newJiraKey || entry.jira_source !== newJiraSource) {
        updateStmt.run(newJiraKey, newJiraSource, entry.id);
        updated++;
      }
    } else if (entry.jira_issue && (entry.jira_source === 'route' || entry.jira_source === 'source_route')) {
      // No route found but entry had route-assigned jira - clear it
      updateStmt.run(null, null, entry.id);
      cleared++;
    } else if (!entry.jira_issue && entry.source_type !== 'manual' && placeholderKey) {
      // ETTA-34: source with no Jira code and no matching route -> assign placeholder
      updateStmt.run(placeholderKey, 'placeholder', entry.id);
      updated++;
    }
    // else: jira_source 'placeholder' with no route stays as placeholder (preserved)
  }

  return { updated, cleared };
}

/**
 * Re-apply keyword classification to existing entries
 * Priority: manual > route > keyword
 * Only updates entries where project_source or task_type_source is 'keyword' or null
 * Entries with 'manual' or 'route'/'source_route' sources are protected
 */
export function applyKeywordsToEntries(): { updated: number; cleared: number } {
  // Helper: Tokenize text into lowercase words for matching
  const tokenize = (text: string): string[] => {
    return text
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter(word => word.length > 0);
  };

  // Helper: Find a matching keyword in text
  const findKeywordMatch = (
    text: string,
    tokens: string[],
    keywordMap: Map<string, string>
  ): string | null => {
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
  };

  // Get all entries that can have keywords re-applied
  // Join with sources to get the subject text for keyword matching
  const entries = db.prepare(`
    SELECT e.id, e.project, e.project_source, e.task_type, e.task_type_source, s.subject
    FROM entries e
    LEFT JOIN sources s ON e.source_id = s.id
    WHERE e.status != 'pushed'
      AND (
        (e.project_source IS NULL OR e.project_source = 'keyword')
        OR (e.task_type_source IS NULL OR e.task_type_source = 'keyword')
      )
  `).all() as {
    id: number;
    project: string | null;
    project_source: ProjectSource;
    task_type: string | null;
    task_type_source: TaskTypeSource;
    subject: string | null;
  }[];

  // Get the keyword maps
  const projectMap = getProjectKeywordMap();
  const taskTypeMap = getTaskTypeKeywordMap();

  let updated = 0;
  let cleared = 0;

  const updateStmt = db.prepare(`
    UPDATE entries
    SET project = ?, project_source = ?, task_type = ?, task_type_source = ?
    WHERE id = ?
  `);

  for (const entry of entries) {
    const subject = entry.subject || '';
    const subjectTokens = tokenize(subject);

    let newProject = entry.project;
    let newProjectSource = entry.project_source;
    let newTaskType = entry.task_type;
    let newTaskTypeSource = entry.task_type_source;
    let changed = false;

    // Only update project if source is 'keyword' or null (not manual/route)
    if (entry.project_source === null || entry.project_source === 'keyword') {
      const projectMatch = findKeywordMatch(subject, subjectTokens, projectMap);
      if (projectMatch) {
        if (entry.project !== projectMatch || entry.project_source !== 'keyword') {
          newProject = projectMatch;
          newProjectSource = 'keyword';
          changed = true;
        }
      } else if (entry.project && entry.project_source === 'keyword') {
        // No match but had keyword-assigned project - clear it
        newProject = null;
        newProjectSource = null;
        changed = true;
      }
    }

    // Only update task_type if source is 'keyword' or null (not manual/route)
    if (entry.task_type_source === null || entry.task_type_source === 'keyword') {
      const taskTypeMatch = findKeywordMatch(subject, subjectTokens, taskTypeMap);
      if (taskTypeMatch) {
        if (entry.task_type !== taskTypeMatch || entry.task_type_source !== 'keyword') {
          newTaskType = taskTypeMatch;
          newTaskTypeSource = 'keyword';
          changed = true;
        }
      } else if (entry.task_type && entry.task_type_source === 'keyword') {
        // No match but had keyword-assigned task_type - clear it
        newTaskType = null;
        newTaskTypeSource = null;
        changed = true;
      }
    }

    if (changed) {
      updateStmt.run(newProject, newProjectSource, newTaskType, newTaskTypeSource, entry.id);
      // Count as updated if we gained something, cleared if we lost something
      if ((newProject && !entry.project) || (newTaskType && !entry.task_type) ||
          (newProject !== entry.project && newProject) || (newTaskType !== entry.task_type && newTaskType)) {
        updated++;
      } else {
        cleared++;
      }
    }
  }

  return { updated, cleared };
}

// ============================================================================
// SETTINGS TABLE - Key-value storage for app settings
// ============================================================================

// Migration: Create settings table
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Set default settings (only if not already set)
db.exec(`
  INSERT OR IGNORE INTO settings (key, value) VALUES ('jira_url', 'https://its-pro.ucsd.edu');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('placeholder_jira_issue', 'PPMO-537');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('include_tentative_meetings', 'false');
`);

// Seed default task types with keywords (only if table is empty)
const taskTypeCount = db.prepare('SELECT COUNT(*) as count FROM task_types').get() as { count: number };
if (taskTypeCount.count === 0) {
  const defaultTaskTypes: Record<string, string[]> = {
    management: [
      'check-in', 'connect', 'discuss', 'discussion', 'meet', 'meeting', 'meetings',
      'schedule', 'scheduling', 'stand up', 'stand-up', 'standup', 'sync',
      'touch base', 'touch-base', 'touchbase', 'agenda', 'huddle', 'briefing',
      'debrief', 'alignment', 'weekly', 'daily', 'monthly', 'catchup',
    ],
    documentation: [
      'doc', 'docs', 'document', 'documentation', 'report', 'reporting', 'reports',
      'requirement', 'requirements', 'specs', 'wiki', 'confluence', 'readme',
      'changelog', 'runbook', 'sop', 'procedure', 'guide', 'manual', 'diagram',
    ],
    technical: [
      'api', 'authentication', 'aws', 'azure', 'build', 'code', 'configuration',
      'data', 'database', 'databases', 'debug', 'deploy', 'deployed', 'dev',
      'development', 'error', 'firewall', 'fix', 'implementation', 'integration',
      'integrations', 'migration', 'prod', 'production', 'queries', 'query',
      'refactor', 'saml', 'script', 'scripts', 'server', 'servers', 'setup',
      'sql', 'sso', 'technical', 'test', 'testing', 'uat', 'validation',
      'release', 'rollback', 'monitoring', 'pipeline', 'ci/cd',
    ],
    support: [
      'assistance', 'case', 'incident', 'issue', 'issues', 'request', 'requests',
      'service-now', 'servicedesk', 'servicenow', 'snow', 'support', 'ticket',
      'tickets', 'troubleshooting', 'troubleshoot', 'helpdesk', 'escalation',
      'outage', 'downtime', 'root cause', 'rca', 'workaround', 'resolution',
    ],
    planning: [
      'backlog', 'go-live', 'milestone', 'phase', 'plan', 'planned', 'planning',
      'prioritization', 'priority', 'rfp', 'roadmap', 'scope', 'sow', 'strategy',
      'timeline', 'sprint', 'epic', 'story', 'estimate', 'capacity', 'velocity',
      'retro', 'retrospective', 'deadline', 'kickoff',
    ],
    learning: [
      'conference', 'onboarding', 'quiz', 'recording', 'research', 'training',
      'webinar', 'workshop', 'certification', 'tutorial', 'demo', 'presentation',
      'lunch and learn', 'brown bag', 'shadowing', 'mentoring', 'course',
    ],
    personal: [
      '1-1', '1v1', '1:1', 'one-on-one', 'pto', 'vacation', 'sick', 'leave',
    ],
  };

  const insertTaskType = db.prepare('INSERT INTO task_types (name) VALUES (?)');
  const insertKeyword = db.prepare('INSERT INTO task_type_keywords (task_type_id, keyword) VALUES (?, ?)');

  for (const [taskType, keywords] of Object.entries(defaultTaskTypes)) {
    const result = insertTaskType.run(taskType);
    const taskTypeId = result.lastInsertRowid;
    for (const keyword of keywords) {
      insertKeyword.run(taskTypeId, keyword);
    }
  }
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// Migration (ETTA-34): Recreate entries table to add 'placeholder' to the jira_source CHECK constraint.
// SQLite cannot ALTER a CHECK constraint, so the table must be rebuilt. Guarded by a settings flag
// so it runs exactly once. Placed here (after settings table + getSetting/setSetting are defined) and
// after all entries column-adding ALTERs above, so the rebuild copies every column.
const placeholderMigrationFlag = getSetting('schema_jira_source_placeholder');
if (placeholderMigrationFlag !== '1') {
  // Detect whether the existing CHECK already permits 'placeholder' (fresh DBs: ALTER used the old CHECK).
  // For pre-existing DBs the CHECK lacks 'placeholder', so rebuild the table.
  const tableSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'`).get() as { sql: string } | undefined;
  const needsRebuild = !tableSql?.sql?.includes("'placeholder'");

  if (needsRebuild) {
    db.exec(`
      BEGIN;
      CREATE TABLE entries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('email', 'meeting', 'manual')),
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT,
        duration_minutes INTEGER NOT NULL DEFAULT 15,
        jira_issue TEXT,
        project TEXT,
        task_type TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pushed', 'excluded')),
        pushed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        context_minutes INTEGER DEFAULT 0,
        jira_source TEXT CHECK (jira_source IN ('manual', 'route', 'source_route', 'extracted', 'placeholder')),
        jira_name TEXT,
        project_source TEXT CHECK (project_source IN ('manual', 'keyword', 'route')),
        task_type_source TEXT CHECK (task_type_source IN ('manual', 'keyword', 'route'))
      );
      INSERT INTO entries_new (id, source_id, source_type, title, date, start_time, duration_minutes, jira_issue, project, task_type, status, pushed_at, created_at, context_minutes, jira_source, jira_name, project_source, task_type_source)
        SELECT id, source_id, source_type, title, date, start_time, duration_minutes, jira_issue, project, task_type, status, pushed_at, created_at, context_minutes, jira_source, jira_name, project_source, task_type_source FROM entries;
      DROP TABLE entries;
      ALTER TABLE entries_new RENAME TO entries;
      CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
      CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
      CREATE INDEX IF NOT EXISTS idx_entries_jira ON entries(jira_issue);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_source ON entries(source_id) WHERE source_id IS NOT NULL;
      COMMIT;
    `);
  }
  setSetting('schema_jira_source_placeholder', '1');
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// ============================================================================
// FAVORITES TABLE - Jira favorite issues for quick time entry assignment
// ============================================================================

// Migration: Create favorites table
db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jira_key TEXT NOT NULL UNIQUE,
    jira_name TEXT NOT NULL,
    short_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_favorites_jira_key ON favorites(jira_key);
`);

export interface Favorite {
  id: number;
  jira_key: string;
  jira_name: string;
  short_name: string | null;
  created_at: string;
  updated_at: string;
}

export function getFavorites(): Favorite[] {
  return db.prepare('SELECT * FROM favorites ORDER BY short_name, jira_key').all() as Favorite[];
}

export function getFavorite(id: number): Favorite | null {
  return db.prepare('SELECT * FROM favorites WHERE id = ?').get(id) as Favorite | null;
}

export function getFavoriteByKey(jiraKey: string): Favorite | null {
  return db.prepare('SELECT * FROM favorites WHERE jira_key = ?').get(jiraKey) as Favorite | null;
}

export function createFavorite(jiraKey: string, jiraName: string, shortName?: string): { id: number } {
  const result = db.prepare(
    'INSERT INTO favorites (jira_key, jira_name, short_name) VALUES (?, ?, ?)'
  ).run(jiraKey, jiraName, shortName ?? null);
  return { id: result.lastInsertRowid as number };
}

export function updateFavoriteShortName(id: number, shortName: string | null): { changes: number } {
  const result = db.prepare(
    'UPDATE favorites SET short_name = ?, updated_at = datetime("now") WHERE id = ?'
  ).run(shortName, id);
  return { changes: result.changes };
}

export function upsertFavoriteFromJira(jiraKey: string, jiraName: string): { inserted: boolean; id: number } {
  const existing = getFavoriteByKey(jiraKey);
  if (existing) {
    // Update jira_name but preserve short_name
    db.prepare(
      'UPDATE favorites SET jira_name = ?, updated_at = datetime("now") WHERE jira_key = ?'
    ).run(jiraName, jiraKey);
    return { inserted: false, id: existing.id };
  } else {
    const result = createFavorite(jiraKey, jiraName);
    return { inserted: true, id: result.id };
  }
}

export function deleteFavorite(id: number): { changes: number } {
  const result = db.prepare('DELETE FROM favorites WHERE id = ?').run(id);
  return { changes: result.changes };
}

// ============================================================================
// ROUTES TABLE - Automatic Jira assignment based on project + task type pairs
// ============================================================================

// Migration: Create routes table
db.exec(`
  CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_type_id INTEGER NOT NULL REFERENCES task_types(id) ON DELETE CASCADE,
    jira_key TEXT NOT NULL,
    jira_name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(project_id, task_type_id)
  );
  CREATE INDEX IF NOT EXISTS idx_routes_project ON routes(project_id);
  CREATE INDEX IF NOT EXISTS idx_routes_task_type ON routes(task_type_id);
  CREATE INDEX IF NOT EXISTS idx_routes_lookup ON routes(project_id, task_type_id);
`);

export interface Route {
  id: number;
  project_id: number;
  task_type_id: number;
  jira_key: string;
  jira_name: string;
  created_at: string;
}

export interface RouteWithNames extends Route {
  project_name: string;
  task_type_name: string;
}

export function getRoutes(): RouteWithNames[] {
  return db.prepare(`
    SELECT r.*, p.name as project_name, t.name as task_type_name
    FROM routes r
    JOIN projects p ON p.id = r.project_id
    JOIN task_types t ON t.id = r.task_type_id
    ORDER BY p.name, t.name
  `).all() as RouteWithNames[];
}

export function getRoute(id: number): RouteWithNames | null {
  return db.prepare(`
    SELECT r.*, p.name as project_name, t.name as task_type_name
    FROM routes r
    JOIN projects p ON p.id = r.project_id
    JOIN task_types t ON t.id = r.task_type_id
    WHERE r.id = ?
  `).get(id) as RouteWithNames | null;
}

export function getRouteByProjectAndTaskType(projectId: number, taskTypeId: number): Route | null {
  return db.prepare(
    'SELECT * FROM routes WHERE project_id = ? AND task_type_id = ?'
  ).get(projectId, taskTypeId) as Route | null;
}

export function getRouteByNames(projectName: string, taskTypeName: string): RouteWithNames | null {
  return db.prepare(`
    SELECT r.*, p.name as project_name, t.name as task_type_name
    FROM routes r
    JOIN projects p ON p.id = r.project_id
    JOIN task_types t ON t.id = r.task_type_id
    WHERE p.name = ? AND t.name = ?
  `).get(projectName, taskTypeName) as RouteWithNames | null;
}

export function createRoute(projectId: number, taskTypeId: number, jiraKey: string, jiraName: string): { id: number } {
  const result = db.prepare(
    'INSERT INTO routes (project_id, task_type_id, jira_key, jira_name) VALUES (?, ?, ?, ?)'
  ).run(projectId, taskTypeId, jiraKey, jiraName);
  return { id: result.lastInsertRowid as number };
}

export function deleteRoute(id: number): { changes: number } {
  const result = db.prepare('DELETE FROM routes WHERE id = ?').run(id);
  return { changes: result.changes };
}

export function getRouteMap(): Map<string, { jiraKey: string; jiraName: string }> {
  const rows = db.prepare(`
    SELECT r.jira_key, r.jira_name, p.name as project_name, t.name as task_type_name
    FROM routes r
    JOIN projects p ON p.id = r.project_id
    JOIN task_types t ON t.id = r.task_type_id
  `).all() as { jira_key: string; jira_name: string; project_name: string; task_type_name: string }[];

  const map = new Map<string, { jiraKey: string; jiraName: string }>();
  for (const row of rows) {
    const key = `${row.project_name}|${row.task_type_name}`;
    map.set(key, { jiraKey: row.jira_key, jiraName: row.jira_name });
  }
  return map;
}

// ============================================================================
// SOURCE ROUTES TABLE - Automatic Jira + task type assignment based on project + source type
// ============================================================================

// Migration: Create source_routes table
db.exec(`
  CREATE TABLE IF NOT EXISTS source_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK(source_type IN ('email', 'meeting')),
    jira_key TEXT NOT NULL,
    jira_name TEXT NOT NULL,
    task_type_id INTEGER NOT NULL REFERENCES task_types(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(project_id, source_type)
  );
  CREATE INDEX IF NOT EXISTS idx_source_routes_project ON source_routes(project_id);
  CREATE INDEX IF NOT EXISTS idx_source_routes_lookup ON source_routes(project_id, source_type);
`);

export interface SourceRoute {
  id: number;
  project_id: number;
  source_type: 'email' | 'meeting';
  jira_key: string;
  jira_name: string;
  task_type_id: number;
  created_at: string;
}

export interface SourceRouteWithNames extends SourceRoute {
  project_name: string;
  task_type_name: string;
}

export function getSourceRoutes(): SourceRouteWithNames[] {
  return db.prepare(`
    SELECT sr.*, p.name as project_name, t.name as task_type_name
    FROM source_routes sr
    JOIN projects p ON p.id = sr.project_id
    JOIN task_types t ON t.id = sr.task_type_id
    ORDER BY p.name, sr.source_type
  `).all() as SourceRouteWithNames[];
}

export function getSourceRoute(id: number): SourceRouteWithNames | null {
  return db.prepare(`
    SELECT sr.*, p.name as project_name, t.name as task_type_name
    FROM source_routes sr
    JOIN projects p ON p.id = sr.project_id
    JOIN task_types t ON t.id = sr.task_type_id
    WHERE sr.id = ?
  `).get(id) as SourceRouteWithNames | null;
}

export function getSourceRouteByProjectAndType(projectId: number, sourceType: string): SourceRoute | null {
  return db.prepare(
    'SELECT * FROM source_routes WHERE project_id = ? AND source_type = ?'
  ).get(projectId, sourceType) as SourceRoute | null;
}

export function createSourceRoute(
  projectId: number,
  sourceType: 'email' | 'meeting',
  jiraKey: string,
  jiraName: string,
  taskTypeId: number
): { id: number } {
  const result = db.prepare(
    'INSERT INTO source_routes (project_id, source_type, jira_key, jira_name, task_type_id) VALUES (?, ?, ?, ?, ?)'
  ).run(projectId, sourceType, jiraKey, jiraName, taskTypeId);
  return { id: result.lastInsertRowid as number };
}

export function deleteSourceRoute(id: number): { changes: number } {
  const result = db.prepare('DELETE FROM source_routes WHERE id = ?').run(id);
  return { changes: result.changes };
}

export function getSourceRouteMap(): Map<string, { jiraKey: string; jiraName: string; taskType: string }> {
  const rows = db.prepare(`
    SELECT sr.jira_key, sr.jira_name, sr.source_type, p.name as project_name, t.name as task_type_name
    FROM source_routes sr
    JOIN projects p ON p.id = sr.project_id
    JOIN task_types t ON t.id = sr.task_type_id
  `).all() as { jira_key: string; jira_name: string; source_type: string; project_name: string; task_type_name: string }[];

  const map = new Map<string, { jiraKey: string; jiraName: string; taskType: string }>();
  for (const row of rows) {
    const key = `${row.project_name}|${row.source_type}`;
    map.set(key, { jiraKey: row.jira_key, jiraName: row.jira_name, taskType: row.task_type_name });
  }
  return map;
}

// ============================================================================
// UNIFIED ROUTES TABLE - Merged routes for automatic Jira assignment
// ============================================================================

// Migration: Create unified_routes table
db.exec(`
  CREATE TABLE IF NOT EXISTS unified_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_type_id INTEGER REFERENCES task_types(id) ON DELETE CASCADE,
    source_type TEXT CHECK(source_type IS NULL OR source_type IN ('email', 'meeting')),
    jira_key TEXT NOT NULL,
    jira_name TEXT NOT NULL,
    assigns_task_type_id INTEGER REFERENCES task_types(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    CHECK (task_type_id IS NOT NULL OR source_type IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_unified_routes_project ON unified_routes(project_id);
  CREATE INDEX IF NOT EXISTS idx_unified_routes_lookup ON unified_routes(project_id, task_type_id, source_type);
`);

// Migration: Copy data from routes and source_routes to unified_routes
// Only run migration if unified_routes is empty and old tables have data
try {
  const unifiedCount = (db.prepare('SELECT COUNT(*) as count FROM unified_routes').get() as { count: number }).count;
  const routesCount = (db.prepare('SELECT COUNT(*) as count FROM routes').get() as { count: number }).count;
  const sourceRoutesCount = (db.prepare('SELECT COUNT(*) as count FROM source_routes').get() as { count: number }).count;

  if (unifiedCount === 0 && (routesCount > 0 || sourceRoutesCount > 0)) {
    // Migrate standard routes (task_type_id set, source_type NULL, assigns_task_type_id NULL)
    db.exec(`
      INSERT INTO unified_routes (project_id, task_type_id, source_type, jira_key, jira_name, assigns_task_type_id, created_at)
      SELECT project_id, task_type_id, NULL, jira_key, jira_name, NULL, created_at
      FROM routes
    `);

    // Migrate source routes (task_type_id NULL, source_type set, assigns_task_type_id from task_type_id)
    db.exec(`
      INSERT INTO unified_routes (project_id, task_type_id, source_type, jira_key, jira_name, assigns_task_type_id, created_at)
      SELECT project_id, NULL, source_type, jira_key, jira_name, task_type_id, created_at
      FROM source_routes
    `);
  }
} catch {
  // Migration might fail if old tables don't exist, that's OK
}

// Migration: Allow NULL project_id in unified_routes
// SQLite doesn't support ALTER COLUMN, so we need to recreate the table
try {
  // Check if we need to migrate (if project_id is NOT NULL)
  const tableInfo = db.prepare("PRAGMA table_info(unified_routes)").all() as { name: string; notnull: number }[];
  const projectIdColumn = tableInfo.find((col: { name: string }) => col.name === 'project_id');

  if (projectIdColumn && projectIdColumn.notnull === 1) {
    db.exec(`
      -- Create new table with nullable project_id
      CREATE TABLE unified_routes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        task_type_id INTEGER REFERENCES task_types(id) ON DELETE CASCADE,
        source_type TEXT CHECK(source_type IS NULL OR source_type IN ('email', 'meeting')),
        jira_key TEXT NOT NULL,
        jira_name TEXT NOT NULL,
        assigns_task_type_id INTEGER REFERENCES task_types(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT (datetime('now')),
        CHECK (task_type_id IS NOT NULL OR source_type IS NOT NULL)
      );

      -- Copy data
      INSERT INTO unified_routes_new (id, project_id, task_type_id, source_type, jira_key, jira_name, assigns_task_type_id, created_at)
      SELECT id, project_id, task_type_id, source_type, jira_key, jira_name, assigns_task_type_id, created_at
      FROM unified_routes;

      -- Drop old table
      DROP TABLE unified_routes;

      -- Rename new table
      ALTER TABLE unified_routes_new RENAME TO unified_routes;

      -- Recreate indexes
      CREATE INDEX IF NOT EXISTS idx_unified_routes_project ON unified_routes(project_id);
      CREATE INDEX IF NOT EXISTS idx_unified_routes_lookup ON unified_routes(project_id, task_type_id, source_type);
    `);
  }
} catch {
  // Migration might fail, that's OK
}

export interface UnifiedRoute {
  id: number;
  project_id: number | null;
  task_type_id: number | null;
  source_type: 'email' | 'meeting' | null;
  jira_key: string;
  jira_name: string;
  assigns_task_type_id: number | null;
  created_at: string;
}

export interface UnifiedRouteWithNames extends UnifiedRoute {
  project_name: string | null;
  task_type_name: string | null;
  assigns_task_type_name: string | null;
}

export function getUnifiedRoutes(): UnifiedRouteWithNames[] {
  return db.prepare(`
    SELECT ur.*,
           p.name as project_name,
           t.name as task_type_name,
           at.name as assigns_task_type_name
    FROM unified_routes ur
    LEFT JOIN projects p ON p.id = ur.project_id
    LEFT JOIN task_types t ON t.id = ur.task_type_id
    LEFT JOIN task_types at ON at.id = ur.assigns_task_type_id
    ORDER BY p.name, t.name, ur.source_type
  `).all() as UnifiedRouteWithNames[];
}

export function getUnifiedRoute(id: number): UnifiedRouteWithNames | null {
  return db.prepare(`
    SELECT ur.*,
           p.name as project_name,
           t.name as task_type_name,
           at.name as assigns_task_type_name
    FROM unified_routes ur
    LEFT JOIN projects p ON p.id = ur.project_id
    LEFT JOIN task_types t ON t.id = ur.task_type_id
    LEFT JOIN task_types at ON at.id = ur.assigns_task_type_id
    WHERE ur.id = ?
  `).get(id) as UnifiedRouteWithNames | null;
}

export function createUnifiedRoute(
  projectId: number | null,
  taskTypeId: number | null,
  sourceType: 'email' | 'meeting' | null,
  jiraKey: string,
  jiraName: string,
  assignsTaskTypeId: number | null
): { id: number } {
  const result = db.prepare(`
    INSERT INTO unified_routes (project_id, task_type_id, source_type, jira_key, jira_name, assigns_task_type_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(projectId, taskTypeId, sourceType, jiraKey, jiraName, assignsTaskTypeId);
  return { id: result.lastInsertRowid as number };
}

export function deleteUnifiedRoute(id: number): { changes: number } {
  const result = db.prepare('DELETE FROM unified_routes WHERE id = ?').run(id);
  return { changes: result.changes };
}

// Check for duplicate unified routes (same project + task_type + source_type combination)
export function checkUnifiedRouteDuplicate(
  projectId: number | null,
  taskTypeId: number | null,
  sourceType: 'email' | 'meeting' | null,
  excludeId?: number
): boolean {
  let query = `
    SELECT 1 FROM unified_routes
    WHERE (project_id IS ? OR (project_id IS NULL AND ? IS NULL))
    AND (task_type_id IS ? OR (task_type_id IS NULL AND ? IS NULL))
    AND (source_type IS ? OR (source_type IS NULL AND ? IS NULL))
  `;
  const params: (number | string | null)[] = [projectId, projectId, taskTypeId, taskTypeId, sourceType, sourceType];

  if (excludeId !== undefined) {
    query += ' AND id != ?';
    params.push(excludeId);
  }

  const result = db.prepare(query).get(...params);
  return !!result;
}

// Get unified route map for classifier - returns routes organized by match type for priority resolution
export function getUnifiedRouteMap(): {
  threeField: Map<string, { jiraKey: string; jiraName: string; assignsTaskType: string | null }>;
  twoFieldTaskType: Map<string, { jiraKey: string; jiraName: string }>;
  twoFieldSourceType: Map<string, { jiraKey: string; jiraName: string; assignsTaskType: string | null }>;
  sourceOnlyType: Map<string, { jiraKey: string; jiraName: string; assignsTaskType: string | null }>;
} {
  const rows = db.prepare(`
    SELECT ur.project_id, ur.task_type_id, ur.source_type, ur.jira_key, ur.jira_name,
           p.name as project_name,
           t.name as task_type_name,
           at.name as assigns_task_type_name
    FROM unified_routes ur
    LEFT JOIN projects p ON p.id = ur.project_id
    LEFT JOIN task_types t ON t.id = ur.task_type_id
    LEFT JOIN task_types at ON at.id = ur.assigns_task_type_id
  `).all() as {
    project_id: number | null;
    task_type_id: number | null;
    source_type: string | null;
    jira_key: string;
    jira_name: string;
    project_name: string | null;
    task_type_name: string | null;
    assigns_task_type_name: string | null;
  }[];

  const threeField = new Map<string, { jiraKey: string; jiraName: string; assignsTaskType: string | null }>();
  const twoFieldTaskType = new Map<string, { jiraKey: string; jiraName: string }>();
  const twoFieldSourceType = new Map<string, { jiraKey: string; jiraName: string; assignsTaskType: string | null }>();
  const sourceOnlyType = new Map<string, { jiraKey: string; jiraName: string; assignsTaskType: string | null }>();

  for (const row of rows) {
    if (row.project_id !== null && row.task_type_id !== null && row.source_type !== null) {
      // 3-field match: project + task_type + source_type
      const key = `${row.project_name}|${row.task_type_name}|${row.source_type}`;
      threeField.set(key, {
        jiraKey: row.jira_key,
        jiraName: row.jira_name,
        assignsTaskType: row.assigns_task_type_name
      });
      // Also add to 2-field map as fallback (for manual entries that don't have source_type)
      // Only add if not already present (routes without source_type take precedence)
      const twoFieldKey = `${row.project_name}|${row.task_type_name}`;
      if (!twoFieldTaskType.has(twoFieldKey)) {
        twoFieldTaskType.set(twoFieldKey, { jiraKey: row.jira_key, jiraName: row.jira_name });
      }
    } else if (row.project_id !== null && row.task_type_id !== null && row.source_type === null) {
      // 2-field match: project + task_type (takes precedence over 3-field routes)
      const key = `${row.project_name}|${row.task_type_name}`;
      twoFieldTaskType.set(key, { jiraKey: row.jira_key, jiraName: row.jira_name });
    } else if (row.project_id !== null && row.task_type_id === null && row.source_type !== null) {
      // 2-field match: project + source_type (fallback)
      const key = `${row.project_name}|${row.source_type}`;
      twoFieldSourceType.set(key, {
        jiraKey: row.jira_key,
        jiraName: row.jira_name,
        assignsTaskType: row.assigns_task_type_name
      });
    } else if (row.project_id === null && row.source_type !== null) {
      // 1-field match: source_type only (global fallback, any project)
      sourceOnlyType.set(row.source_type, {
        jiraKey: row.jira_key,
        jiraName: row.jira_name,
        assignsTaskType: row.assigns_task_type_name
      });
    }
  }

  return { threeField, twoFieldTaskType, twoFieldSourceType, sourceOnlyType };
}

// Lookup unified route by names (for API endpoint)
export function getUnifiedRouteByNames(
  projectName: string,
  taskTypeName: string | null,
  sourceType: 'email' | 'meeting' | null
): UnifiedRouteWithNames | null {
  let query = `
    SELECT ur.*,
           p.name as project_name,
           t.name as task_type_name,
           at.name as assigns_task_type_name
    FROM unified_routes ur
    JOIN projects p ON p.id = ur.project_id
    LEFT JOIN task_types t ON t.id = ur.task_type_id
    LEFT JOIN task_types at ON at.id = ur.assigns_task_type_id
    WHERE p.name = ?
  `;
  const params: (string | null)[] = [projectName];

  if (taskTypeName !== null) {
    query += ' AND t.name = ?';
    params.push(taskTypeName);
  } else {
    query += ' AND ur.task_type_id IS NULL';
  }

  if (sourceType !== null) {
    query += ' AND ur.source_type = ?';
    params.push(sourceType);
  } else {
    query += ' AND ur.source_type IS NULL';
  }

  return db.prepare(query).get(...params) as UnifiedRouteWithNames | null;
}

// ============================================================================
// CLASSIFICATION HELPERS - Get keyword mappings for classification
// ============================================================================

export function getProjectKeywordMap(): Map<string, string> {
  const rows = db.prepare(`
    SELECT pk.keyword, p.name as project_name
    FROM project_keywords pk
    JOIN projects p ON p.id = pk.project_id
  `).all() as { keyword: string; project_name: string }[];

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.keyword.toLowerCase(), row.project_name);
  }
  return map;
}

export function getTaskTypeKeywordMap(): Map<string, string> {
  const rows = db.prepare(`
    SELECT tk.keyword, t.name as task_type_name
    FROM task_type_keywords tk
    JOIN task_types t ON t.id = tk.task_type_id
  `).all() as { keyword: string; task_type_name: string }[];

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.keyword.toLowerCase(), row.task_type_name);
  }
  return map;
}

// ============================================================================
// SOURCE HELPERS - For entry generation
// ============================================================================

export interface Source {
  id: number;
  type: 'email' | 'meeting';
  subject: string;
  body: string;
  date: string;
  duration_minutes: number | null;
  imported_at: string;
  status: 'active' | 'stale';
  external_id: string | null;
}

export function getSourcesForGeneration(options: {
  startDate?: string;
  endDate?: string;
  type?: 'email' | 'meeting';
} = {}): Source[] {
  // Only get active sources (exclude stale/cancelled ones)
  let query = "SELECT * FROM sources WHERE status = 'active'";
  const params: string[] = [];

  if (options.startDate) {
    query += ' AND date >= ?';
    params.push(options.startDate);
  }
  if (options.endDate) {
    query += ' AND date <= ?';
    params.push(options.endDate + 'T23:59:59');
  }
  if (options.type) {
    query += ' AND type = ?';
    params.push(options.type);
  }

  query += ' ORDER BY date ASC';

  return db.prepare(query).all(...params) as Source[];
}

export function getSource(id: number): Source | null {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Source | null;
}

export interface SourceStats {
  totalCount: number;
  emailCount: number;
  meetingCount: number;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  lastImportedAt: string | null;
  lastImportDateRangeStart: string | null;
  lastImportDateRangeEnd: string | null;
}

export function getSourceStats(): SourceStats {
  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN type = 'email' THEN 1 ELSE 0 END) as emails,
      SUM(CASE WHEN type = 'meeting' THEN 1 ELSE 0 END) as meetings,
      MIN(date) as date_start,
      MAX(date) as date_end,
      MAX(imported_at) as last_imported
    FROM sources
  `).get() as {
    total: number;
    emails: number;
    meetings: number;
    date_start: string | null;
    date_end: string | null;
    last_imported: string | null;
  };

  // Get date range of the last import batch (items imported within same minute)
  let lastImportDateRange: { date_start: string | null; date_end: string | null } = { date_start: null, date_end: null };
  if (counts.last_imported) {
    lastImportDateRange = db.prepare(`
      SELECT
        MIN(date) as date_start,
        MAX(date) as date_end
      FROM sources
      WHERE strftime('%Y-%m-%d %H:%M', imported_at) = strftime('%Y-%m-%d %H:%M', ?)
    `).get(counts.last_imported) as { date_start: string | null; date_end: string | null };
  }

  return {
    totalCount: counts.total || 0,
    emailCount: counts.emails || 0,
    meetingCount: counts.meetings || 0,
    dateRangeStart: counts.date_start,
    dateRangeEnd: counts.date_end,
    lastImportedAt: counts.last_imported,
    lastImportDateRangeStart: lastImportDateRange.date_start,
    lastImportDateRangeEnd: lastImportDateRange.date_end
  };
}

// ============================================================================
// STALE SOURCE MANAGEMENT - Cleanup cancelled/deleted sources on re-import
// ============================================================================

/**
 * Check if an entry has manual changes that should prevent auto-deletion.
 * Manual changes include:
 * - project set with project_source = 'manual'
 * - task_type set with task_type_source = 'manual'
 * - jira_issue set with jira_source = 'manual'
 * - status = 'excluded' (user explicitly excluded)
 * - status = 'pushed' (already sent to Jira)
 */
export function entryHasManualChanges(entry: Entry | null): boolean {
  if (!entry) return false;

  // Already pushed to Jira - definitely preserve
  if (entry.status === 'pushed') return true;

  // User explicitly excluded this entry
  if (entry.status === 'excluded') return true;

  // Manual project assignment
  if (entry.project && entry.project_source === 'manual') return true;

  // Manual task type assignment
  if (entry.task_type && entry.task_type_source === 'manual') return true;

  // Manual Jira issue assignment
  if (entry.jira_issue && entry.jira_source === 'manual') return true;

  return false;
}

/**
 * Mark a source as stale (cancelled/deleted from Outlook)
 */
export function markSourceAsStale(sourceId: number): { changes: number } {
  const result = db.prepare('UPDATE sources SET status = ? WHERE id = ?').run('stale', sourceId);
  return { changes: result.changes };
}

/**
 * Mark a source as active
 */
export function markSourceAsActive(sourceId: number): { changes: number } {
  const result = db.prepare('UPDATE sources SET status = ? WHERE id = ?').run('active', sourceId);
  return { changes: result.changes };
}

/**
 * Delete a source and its linked entry (used when no manual changes exist)
 */
export function deleteSourceAndEntry(sourceId: number): { sourceDeleted: boolean; entryDeleted: boolean } {
  const entry = getEntryBySourceId(sourceId);
  let entryDeleted = false;

  if (entry) {
    deleteEntry(entry.id);
    entryDeleted = true;
  }

  const result = db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
  return { sourceDeleted: result.changes > 0, entryDeleted };
}

/**
 * Get all sources in a date range by type
 */
export function getSourcesInDateRange(options: {
  startDate: string;
  endDate: string;
  type?: 'email' | 'meeting';
}): Source[] {
  let query = 'SELECT * FROM sources WHERE date >= ? AND date <= ?';
  const params: string[] = [options.startDate, options.endDate + 'T23:59:59'];

  if (options.type) {
    query += ' AND type = ?';
    params.push(options.type);
  }

  return db.prepare(query).all(...params) as Source[];
}

/**
 * Process stale sources after an import.
 * Compares existing sources in DB against imported items.
 * - Deletes sources (and entries) with no manual changes
 * - Marks sources as 'stale' if they have manual changes
 * Returns statistics about what was processed.
 */
export function processStaleSourcesAfterImport(
  importedItems: { type: string; subject: string; date: string; external_id?: string }[],
  startDate: string,
  endDate: string,
  types: ('email' | 'meeting')[]
): { deleted: number; markedStale: number; reactivated: number } {
  // Build Sets for fast lookup
  // For meetings with external_id: use external_id (survives time/subject changes)
  // For emails or meetings without external_id: use type + subject + date-only
  const importedExternalIds = new Set<string>();
  const importedKeys = new Set<string>();

  for (const item of importedItems) {
    if (item.external_id) {
      importedExternalIds.add(item.external_id);
    }
    // Also build the fallback key for items without external_id
    const dateOnly = item.date.split('T')[0];
    const key = `${item.type}|${item.subject || ''}|${dateOnly}`;
    importedKeys.add(key);
  }

  let deleted = 0;
  let markedStale = 0;
  let reactivated = 0;

  // For each type being imported, check existing sources
  for (const type of types) {
    const existingSources = getSourcesInDateRange({ startDate, endDate, type });

    for (const source of existingSources) {
      // Determine if source still exists in import
      let stillExists = false;

      // For sources with external_id (meetings), use external_id for matching
      if (source.external_id) {
        stillExists = importedExternalIds.has(source.external_id);
      } else {
        // Fallback: use type + subject + date-only
        const dateOnly = source.date.split('T')[0];
        const key = `${source.type}|${source.subject || ''}|${dateOnly}`;
        stillExists = importedKeys.has(key);
      }

      if (!stillExists) {
        const entry = getEntryBySourceId(source.id);

        if (entryHasManualChanges(entry)) {
          // Has manual changes - mark as stale, don't delete
          if (source.status !== 'stale') {
            markSourceAsStale(source.id);
            markedStale++;
          }
        } else {
          // No manual changes - safe to delete
          deleteSourceAndEntry(source.id);
          deleted++;
        }
      } else {
        // Source still exists in Outlook - ensure it's marked active
        if (source.status === 'stale') {
          markSourceAsActive(source.id);
          reactivated++;
        }
      }
    }
  }

  return { deleted, markedStale, reactivated };
}

/**
 * Delete entries from stale sources that don't have manual changes.
 * Called during entry generation to clean up stale entries.
 * Returns count of deleted entries.
 */
export function deleteStaleEntriesWithoutManualChanges(options: {
  startDate?: string;
  endDate?: string;
} = {}): { deleted: number } {
  // Find all entries linked to stale sources in the date range
  let query = `
    SELECT e.*
    FROM entries e
    JOIN sources s ON e.source_id = s.id
    WHERE s.status = 'stale'
  `;
  const params: string[] = [];

  if (options.startDate) {
    query += ' AND e.date >= ?';
    params.push(options.startDate);
  }
  if (options.endDate) {
    query += ' AND e.date <= ?';
    params.push(options.endDate);
  }

  const staleEntries = db.prepare(query).all(...params) as Entry[];

  let deleted = 0;
  for (const entry of staleEntries) {
    if (!entryHasManualChanges(entry)) {
      deleteEntry(entry.id);
      deleted++;
    }
  }

  return { deleted };
}
