'use client';

import { useState, useEffect, useCallback, useMemo, memo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  IconPencil,
  IconTrash,
  IconPlus,
  IconMinus,
  IconUpload,
  IconRefresh,
  IconCheck,
  IconSearch,
  IconEyeOff,
  IconEye,
  IconRoute,
  IconTag,
  IconLoader2,
  IconX,
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
} from '@tabler/icons-react';
import Link from 'next/link';
import { DateRangePicker } from '@/components/DateRangePicker';
import { ProjectTaskTypes } from '@/components/ProjectTaskTypes';
import { DndProvider } from '@/components/dnd/DndProvider';
import { DraggableEntryRow } from '@/components/dnd/DraggableEntryRow';
import { EntryModal, EntryFormData } from '@/components/EntryModal';
import { NavTabs } from '@/components/NavTabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useSharedData } from '@/lib/data-context';

// ============== TYPES ==============

interface Project {
  id: number;
  name: string;
  keyword_count: number;
  keywords?: string[];
  emailPatterns?: string[];
}

interface TaskType {
  id: number;
  name: string;
  keyword_count: number;
  keywords?: string[];
}

type JiraSource = 'manual' | 'route' | 'source_route' | 'extracted' | 'placeholder' | null;
type ProjectSource = 'manual' | 'keyword' | 'route' | null;
type TaskTypeSource = 'manual' | 'keyword' | 'route' | null;

type SourceStatus = 'active' | 'stale' | null;

interface Entry {
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
  source_status: SourceStatus;
}

interface Source {
  id: number;
  type: 'email' | 'meeting';
  subject: string;
  body: string;
  date: string;
  duration_minutes: number | null;
  imported_at: string;
  status: 'active' | 'stale';
}

// ============== HELPERS ==============

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDuration(minutes: number, contextMinutes?: number): string {
  const baseMinutes = contextMinutes ? minutes - contextMinutes : minutes;
  const hours = Math.floor(baseMinutes / 60);
  const mins = baseMinutes % 60;

  let baseStr: string;
  if (hours === 0) baseStr = `${mins}m`;
  else if (mins === 0) baseStr = `${hours}h`;
  else baseStr = `${hours}h ${mins}m`;

  // Show "+ Xm" suffix if context time was added
  if (contextMinutes && contextMinutes > 0) {
    return `${baseStr} + ${contextMinutes}m`;
  }
  return baseStr;
}

function formatDisplayDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(dateStr: string, timeStr: string | null): string {
  const date = new Date(dateStr + 'T00:00:00');
  const datePart = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });

  if (timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const hour12 = hours % 12 || 12;
    const timeFormatted = `${hour12}:${minutes.toString().padStart(2, '0')} ${period}`;
    return `${datePart}, ${timeFormatted}`;
  }

  return datePart;
}

// ============== MAIN COMPONENT ==============

export default function Home() {
  // ============== SHARED STATE FROM CONTEXT ==============
  const {
    projects,
    taskTypes,
    favorites,
    refreshProjects: loadProjects,
    refreshTaskTypes: loadTaskTypes,
    refreshFavorites: loadFavorites
  } = useSharedData();

  // ============== REVIEW TAB STATE ==============
  // Initialize empty to avoid hydration mismatch, set in useEffect
  const [reviewStartDate, setReviewStartDate] = useState('');
  const [reviewEndDate, setReviewEndDate] = useState('');

  // Initialize dates on client side to avoid hydration mismatch
  useEffect(() => {
    // Initialize review dates from localStorage or default to today
    const savedStart = localStorage.getItem('reviewStartDate');
    const savedEnd = localStorage.getItem('reviewEndDate');
    const today = formatDate(new Date());
    if (!reviewStartDate) setReviewStartDate(savedStart || today);
    if (!reviewEndDate) setReviewEndDate(savedEnd || today);
  }, []);

  // Persist date selection to localStorage (skip if empty/initializing)
  useEffect(() => {
    if (reviewStartDate) localStorage.setItem('reviewStartDate', reviewStartDate);
    if (reviewEndDate) localStorage.setItem('reviewEndDate', reviewEndDate);
  }, [reviewStartDate, reviewEndDate]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'untracked' | 'tracked' | 'pushed' | 'not_pushed'>('all');
  const [entrySearchQuery, setEntrySearchQuery] = useState('');
  const [entryProjectFilter, setEntryProjectFilter] = useState<string>('all');
  const [entryTaskTypeFilter, setEntryTaskTypeFilter] = useState<string>('all');
  const [entryTrackingFilter, setEntryTrackingFilter] = useState<string>('all');
  const [minDurationHours, setMinDurationHours] = useState<string>('');
  const [showExcluded, setShowExcluded] = useState(true);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<number>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [isApplyingRoutes, setIsApplyingRoutes] = useState(false);
  const [isApplyingKeywords, setIsApplyingKeywords] = useState(false);
    const [isPushing, setIsPushing] = useState(false);

  // Push dialog state
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushDialogPhase, setPushDialogPhase] = useState<'confirm' | 'pushing' | 'result'>('confirm');
  const [pushResult, setPushResult] = useState<{
    success: boolean;
    pushed: number;
    failed: number;
    error?: string;
  } | null>(null);
  const [entriesToPush, setEntriesToPush] = useState<Entry[]>([]);
  const [skippedEntries, setSkippedEntries] = useState<{ alreadyPushed: number; noJira: number; excluded: number }>({ alreadyPushed: 0, noJira: 0, excluded: 0 });

  // Generate dialog state
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [generateDialogPhase, setGenerateDialogPhase] = useState<'confirm' | 'generating' | 'result'>('confirm');
  const [generateResult, setGenerateResult] = useState<{
    success: boolean;
    generated: number;
    skipped: number;
    error?: string;
  } | null>(null);

  // Entry modal state (shared for create and edit)
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [modalEntryId, setModalEntryId] = useState<number | null>(null);
  const [modalOriginalEntry, setModalOriginalEntry] = useState<Entry | null>(null);
  const [modalInitialValues, setModalInitialValues] = useState<EntryFormData>({
    title: '',
    date: '',
    startTime: '',
    hours: 0,
    minutes: 0,
    project: '',
    taskType: '',
    jiraIssue: '',
  });
  const [externalJiraIssue, setExternalJiraIssue] = useState<string | undefined>(undefined);

  // Source details modal
  const [viewingSource, setViewingSource] = useState<Source | null>(null);
  const lastDialogCloseTime = useRef<number>(0);

  const [entriesPage, setEntriesPage] = useState(0);
  const ENTRIES_PER_PAGE = 20;

  // Project/Task Type editing
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingTaskType, setEditingTaskType] = useState<TaskType | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [editingTaskTypeName, setEditingTaskTypeName] = useState('');
  const [newKeywordForProject, setNewKeywordForProject] = useState('');
  const [newKeywordForTaskType, setNewKeywordForTaskType] = useState('');
  const [newEmailPatternForProject, setNewEmailPatternForProject] = useState('');

  // Create mode for projects/task types
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isCreatingTaskType, setIsCreatingTaskType] = useState(false);
  const [creatingProjectName, setCreatingProjectName] = useState('');
  const [creatingTaskTypeName, setCreatingTaskTypeName] = useState('');

  // Favorite editing
  const [editingFavorite, setEditingFavorite] = useState<{ id: number; jira_key: string; jira_name: string; short_name: string | null } | null>(null);
  const [editingFavoriteShortName, setEditingFavoriteShortName] = useState('');

  // Sticky detection for floating card
  const [isProjectCardSticky, setIsProjectCardSticky] = useState(false);
  const [sentinelElement, setSentinelElement] = useState<HTMLDivElement | null>(null);

  // ============== DATA LOADERS ==============

  const fetchEntries = useCallback(async () => {
    if (!reviewStartDate || !reviewEndDate) return; // Skip if dates not initialized
    setEntriesLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('startDate', reviewStartDate);
      params.append('endDate', reviewEndDate);
      const res = await fetch(`/api/entries?${params}`);
      const data = await res.json();
      setEntries(data.entries || []);
    } catch (error) {
      console.error('Failed to fetch entries:', error);
    } finally {
      setEntriesLoading(false);
    }
  }, [reviewStartDate, reviewEndDate]);

  // Load entries when dates change
  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // Detect when the sticky card is actually stuck
  useEffect(() => {
    if (!sentinelElement) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // When the sentinel is not visible (scrolled past), the card is stuck
        setIsProjectCardSticky(!entry.isIntersecting);
      },
      { threshold: 0, rootMargin: '-17px 0px 0px 0px' } // Account for top-4 (16px) + 1px buffer
    );

    observer.observe(sentinelElement);
    return () => observer.disconnect();
  }, [sentinelElement]);

  // ============== REVIEW TAB HANDLERS ==============

  const filteredEntries = useMemo(() => {
    return entries.filter(entry => {
      // Hide excluded entries if toggle is off
      if (!showExcluded && entry.status === 'excluded') return false;

      // Status filter
      if (filter === 'untracked' && entry.jira_issue) return false;
      if (filter === 'tracked' && (!entry.jira_issue || entry.status === 'pushed')) return false;
      if (filter === 'pushed' && entry.status !== 'pushed') return false;
      if (filter === 'not_pushed' && entry.status === 'pushed') return false;

      // Search filter - check title, jira issue, project, task type
      if (entrySearchQuery.trim()) {
        const query = entrySearchQuery.toLowerCase();
        const matchesSearch =
          entry.title.toLowerCase().includes(query) ||
          (entry.jira_issue && entry.jira_issue.toLowerCase().includes(query)) ||
          (entry.project && entry.project.toLowerCase().includes(query)) ||
          (entry.task_type && entry.task_type.toLowerCase().includes(query));
        if (!matchesSearch) return false;
      }

      // Project filter
      if (entryProjectFilter === 'none' && entry.project !== null) {
        return false;
      } else if (entryProjectFilter !== 'all' && entryProjectFilter !== 'none' && entry.project !== entryProjectFilter) {
        return false;
      }

      // Task type filter
      if (entryTaskTypeFilter === 'none' && entry.task_type !== null) {
        return false;
      } else if (entryTaskTypeFilter !== 'all' && entryTaskTypeFilter !== 'none' && entry.task_type !== entryTaskTypeFilter) {
        return false;
      }

      // No tracking filter
      if (entryTrackingFilter === 'none' && entry.jira_issue !== null) {
        return false;
      }

      // Min duration filter (in hours)
      if (minDurationHours) {
        const minMinutes = parseFloat(minDurationHours) * 60;
        if (!isNaN(minMinutes) && entry.duration_minutes < minMinutes) {
          return false;
        }
      }

      return true;
    });
  }, [entries, filter, entrySearchQuery, entryProjectFilter, entryTaskTypeFilter, entryTrackingFilter, minDurationHours, showExcluded]);

  // Get unique project and task type values from entries for filter dropdowns
  const uniqueEntryProjects = useMemo(() => {
    const projects = new Set<string>();
    entries.forEach(e => { if (e.project) projects.add(e.project); });
    return Array.from(projects).sort();
  }, [entries]);

  const uniqueEntryTaskTypes = useMemo(() => {
    const taskTypes = new Set<string>();
    entries.forEach(e => { if (e.task_type) taskTypes.add(e.task_type); });
    return Array.from(taskTypes).sort();
  }, [entries]);

  const totalMinutes = useMemo(() => {
    return filteredEntries
      .filter(e => e.status !== 'excluded')
      .reduce((sum, e) => sum + e.duration_minutes, 0);
  }, [filteredEntries]);

  // Lookup map for Jira issue names from favorites
  const jiraNameLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const fav of favorites) {
      map.set(fav.jira_key, fav.jira_name);
    }
    return map;
  }, [favorites]);

  // Paginated entries
  const paginatedEntries = useMemo(() => {
    const start = entriesPage * ENTRIES_PER_PAGE;
    return filteredEntries.slice(start, start + ENTRIES_PER_PAGE);
  }, [filteredEntries, entriesPage]);

  const totalEntryPages = Math.ceil(filteredEntries.length / ENTRIES_PER_PAGE);

  // Reset entries page when filter changes
  useEffect(() => {
    setEntriesPage(0);
  }, [filter, entrySearchQuery, entryProjectFilter, entryTaskTypeFilter, entryTrackingFilter, minDurationHours, showExcluded, reviewStartDate, reviewEndDate]);

  
  const toggleEntrySelection = useCallback((id: number) => {
    setSelectedEntryIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSelectAllEntries = useCallback(() => {
    if (selectedEntryIds.size > 0) {
      setSelectedEntryIds(new Set());
    } else {
      setSelectedEntryIds(new Set(filteredEntries.map(e => e.id)));
    }
  }, [filteredEntries, selectedEntryIds.size]);

  const clearEntrySelections = useCallback(() => {
    setSelectedEntryIds(new Set());
  }, []);

  const adjustDuration = useCallback(async (entryId: number, delta: number) => {
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    const newDuration = Math.max(15, entry.duration_minutes + delta);
    const oldDuration = entry.duration_minutes;

    // Optimistic update
    setEntries(prev => prev.map(e =>
      e.id === entryId ? { ...e, duration_minutes: newDuration } : e
    ));

    try {
      await fetch(`/api/entries/${entryId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_minutes: newDuration }),
      });
    } catch (error) {
      console.error('Failed to adjust duration:', error);
      // Revert on error
      setEntries(prev => prev.map(e =>
        e.id === entryId ? { ...e, duration_minutes: oldDuration } : e
      ));
    }
  }, [entries]);

  const deleteEntry = useCallback(async (entryId: number) => {
    if (!confirm('Delete this entry?')) return;

    try {
      await fetch(`/api/entries/${entryId}`, { method: 'DELETE' });
      fetchEntries();
    } catch (error) {
      console.error('Failed to delete entry:', error);
    }
  }, [fetchEntries]);

  const toggleExclude = useCallback(async (entry: Entry) => {
    const newStatus = entry.status === 'excluded' ? 'pending' : 'excluded';
    try {
      setEntries(prev => prev.map(e =>
        e.id === entry.id ? { ...e, status: newStatus } : e
      ));
      await fetch(`/api/entries/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
    } catch (error) {
      console.error('Failed to toggle exclude:', error);
      fetchEntries();
    }
  }, [fetchEntries]);

  const bulkDeleteEntries = useCallback(async () => {
    if (selectedEntryIds.size === 0) return;
    if (!confirm(`Delete ${selectedEntryIds.size} selected entries?`)) return;

    try {
      await Promise.all(
        Array.from(selectedEntryIds).map(id =>
          fetch(`/api/entries/${id}`, { method: 'DELETE' })
        )
      );
      setSelectedEntryIds(new Set());
      fetchEntries();
    } catch (error) {
      console.error('Failed to bulk delete entries:', error);
    }
  }, [selectedEntryIds, fetchEntries]);

  const bulkSetExcludeStatus = useCallback(async (exclude: boolean) => {
    if (selectedEntryIds.size === 0) return;
    const newStatus = exclude ? 'excluded' : 'pending';

    try {
      setEntries(prev => prev.map(e =>
        selectedEntryIds.has(e.id) ? { ...e, status: newStatus } : e
      ));
      await Promise.all(
        Array.from(selectedEntryIds).map(id =>
          fetch(`/api/entries/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus }),
          })
        )
      );
      setSelectedEntryIds(new Set());
    } catch (error) {
      console.error('Failed to bulk update entries:', error);
      fetchEntries();
    }
  }, [selectedEntryIds, fetchEntries]);

  const openEditModal = useCallback((entry: Entry) => {
    setModalMode('edit');
    setModalEntryId(entry.id);
    setModalOriginalEntry(entry);
    setExternalJiraIssue(undefined);
    setModalInitialValues({
      title: entry.title,
      date: entry.date,
      startTime: entry.start_time || '',
      hours: Math.floor(entry.duration_minutes / 60),
      minutes: entry.duration_minutes % 60,
      jiraIssue: entry.jira_issue || '',
      project: entry.project || '',
      taskType: entry.task_type || '',
    });
  }, []);

  const openCreateModal = useCallback(() => {
    setModalMode('create');
    setModalEntryId(null);
    setModalOriginalEntry(null);
    setExternalJiraIssue(undefined);
    setModalInitialValues({
      title: '',
      date: reviewStartDate,
      startTime: '09:00',
      hours: 0,
      minutes: 15,
      jiraIssue: '',
      project: '',
      taskType: '',
    });
  }, [reviewStartDate]);

  const closeModal = useCallback(() => {
    lastDialogCloseTime.current = Date.now();
    setModalMode(null);
    setModalEntryId(null);
    setModalOriginalEntry(null);
    setExternalJiraIssue(undefined);
  }, []);

  // Callback for modal to notify when project/taskType change (for route lookup)
  const handleModalProjectTaskTypeChange = useCallback(async (project: string, taskType: string) => {
    if (!modalMode) return;
    if (!project || !taskType) return;

    try {
      const res = await fetch(`/api/routes/lookup?project=${encodeURIComponent(project)}&taskType=${encodeURIComponent(taskType)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.route?.jira_key) {
          setExternalJiraIssue(data.route.jira_key);
        }
      }
    } catch (error) {
      console.error('Failed to lookup route:', error);
    }
  }, [modalMode]);

  const saveModal = useCallback(async (data: EntryFormData) => {
    if (!data.title || !data.date) {
      alert('Title and date are required');
      return;
    }

    const durationMinutes = data.hours * 60 + data.minutes;
    if (durationMinutes < 1) {
      alert('Duration must be at least 1 minute');
      return;
    }

    const newJiraIssue = data.jiraIssue || null;
    const newProject = data.project || null;
    const newTaskType = data.taskType || null;

    try {
      if (modalMode === 'create') {
        // POST to create new manual entry
        const res = await fetch('/api/entries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_type: 'manual',
            title: data.title,
            date: data.date,
            start_time: data.startTime || null,
            duration_minutes: durationMinutes,
            ...(newProject && { project: newProject }),
            ...(newTaskType && { task_type: newTaskType }),
            ...(newJiraIssue && { jira_issue: newJiraIssue }),
          }),
        });
        if (!res.ok) {
          const resData = await res.json();
          alert('Failed to create entry: ' + resData.error);
          return;
        }
      } else if (modalMode === 'edit' && modalOriginalEntry) {
        // PATCH to update existing entry
        // Determine source fields: if user changed the value, mark as 'manual'
        // If they cleared it, set source to null. If unchanged, keep existing source.
        let jiraSourceUpdate: { jira_source?: JiraSource } = {};
        if (newJiraIssue !== modalOriginalEntry.jira_issue) {
          jiraSourceUpdate = { jira_source: newJiraIssue ? 'manual' : null };
        }

        let projectSourceUpdate: { project_source?: ProjectSource } = {};
        if (newProject !== modalOriginalEntry.project) {
          projectSourceUpdate = { project_source: newProject ? 'manual' : null };
        }

        let taskTypeSourceUpdate: { task_type_source?: TaskTypeSource } = {};
        if (newTaskType !== modalOriginalEntry.task_type) {
          taskTypeSourceUpdate = { task_type_source: newTaskType ? 'manual' : null };
        }

        await fetch(`/api/entries/${modalEntryId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: data.title,
            date: data.date,
            start_time: data.startTime || null,
            duration_minutes: durationMinutes,
            jira_issue: newJiraIssue,
            project: newProject,
            task_type: newTaskType,
            ...jiraSourceUpdate,
            ...projectSourceUpdate,
            ...taskTypeSourceUpdate,
          }),
        });
      }

      closeModal();
      fetchEntries();
    } catch (error) {
      console.error('Failed to save entry:', error);
      alert('Failed to save entry');
    }
  }, [modalMode, modalEntryId, modalOriginalEntry, closeModal, fetchEntries]);

  const viewSourceDetails = useCallback(async (entry: Entry) => {
    if (!entry.source_id || entry.source_type === 'manual') {
      return;
    }

    // Don't open if another dialog is already open
    if (modalMode || viewingSource || editingProject || editingTaskType || editingFavorite || isCreatingProject || isCreatingTaskType) {
      return;
    }

    // Prevent opening if a dialog just closed (within 300ms) to avoid click-through during animations
    if (Date.now() - lastDialogCloseTime.current < 300) {
      return;
    }

    try {
      const res = await fetch(`/api/sources/${entry.source_id}`);
      const data = await res.json();
      if (data.source) {
        setViewingSource(data.source);
      }
    } catch (error) {
      console.error('Failed to fetch source details:', error);
    }
  }, [modalMode, viewingSource, editingProject, editingTaskType, editingFavorite, isCreatingProject, isCreatingTaskType]);

  const openGenerateDialog = useCallback(() => {
    setGenerateResult(null);
    setGenerateDialogPhase('confirm');
    setGenerateDialogOpen(true);
  }, []);

  const closeGenerateDialog = useCallback(() => {
    if (isGenerating) return;
    setGenerateDialogOpen(false);
  }, [isGenerating]);

  const executeGenerate = useCallback(async () => {
    if (isGenerating) return;

    setGenerateDialogPhase('generating');
    setIsGenerating(true);

    try {
      const res = await fetch('/api/entries/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: reviewStartDate,
          endDate: reviewEndDate,
          overwrite: true,
        }),
      });
      const data = await res.json();

      setGenerateResult({
        success: data.success,
        generated: data.generated || 0,
        skipped: data.skipped || 0,
        error: data.error,
      });
      setGenerateDialogPhase('result');

      if (data.success) {
        fetchEntries();
      }
    } catch (error) {
      console.error('Failed to generate entries:', error);
      setGenerateResult({
        success: false,
        generated: 0,
        skipped: 0,
        error: 'Network error - failed to connect to server',
      });
      setGenerateDialogPhase('result');
    } finally {
      setIsGenerating(false);
    }
  }, [isGenerating, reviewStartDate, reviewEndDate, fetchEntries]);

  const applyRoutes = useCallback(async () => {
    setIsApplyingRoutes(true);
    try {
      const res = await fetch('/api/entries/apply-routes', {
        method: 'POST',
      });
      const data = await res.json();
      if (data.success) {
        const messages: string[] = [];
        if (data.updated > 0) messages.push(`${data.updated} entries updated with routes`);
        if (data.cleared > 0) messages.push(`${data.cleared} stale assignments cleared`);
        if (messages.length === 0) messages.push('No changes needed');
        alert(messages.join(', '));
        fetchEntries();
      } else {
        alert('Failed to apply routes: ' + data.error);
      }
    } catch (error) {
      console.error('Failed to apply routes:', error);
      alert('Failed to apply routes');
    } finally {
      setIsApplyingRoutes(false);
    }
  }, [fetchEntries]);

  const applyKeywords = useCallback(async () => {
    setIsApplyingKeywords(true);
    try {
      const res = await fetch('/api/entries/apply-keywords', {
        method: 'POST',
      });
      const data = await res.json();
      if (data.success) {
        const messages: string[] = [];
        if (data.updated > 0) messages.push(`${data.updated} entries updated with keywords`);
        if (data.cleared > 0) messages.push(`${data.cleared} stale assignments cleared`);
        if (messages.length === 0) messages.push('No changes needed');
        alert(messages.join(', '));
        fetchEntries();
      } else {
        alert('Failed to apply keywords: ' + data.error);
      }
    } catch (error) {
      console.error('Failed to apply keywords:', error);
      alert('Failed to apply keywords');
    } finally {
      setIsApplyingKeywords(false);
    }
  }, [fetchEntries]);

  const openPushDialog = useCallback(() => {
    const selectedEntries = filteredEntries.filter(e => selectedEntryIds.has(e.id));

    const entries = selectedEntries.filter(
      e => e.jira_issue && e.status === 'pending'
    );

    // Calculate skipped entries
    const alreadyPushed = selectedEntries.filter(e => e.status === 'pushed').length;
    const noJira = selectedEntries.filter(e => !e.jira_issue && e.status !== 'pushed' && e.status !== 'excluded').length;
    const excluded = selectedEntries.filter(e => e.status === 'excluded').length;

    setSkippedEntries({ alreadyPushed, noJira, excluded });
    setEntriesToPush(entries);
    setPushResult(null);
    setPushDialogPhase('confirm');
    setPushDialogOpen(true);
  }, [filteredEntries, selectedEntryIds]);

  const closePushDialog = useCallback(() => {
    if (isPushing) return; // Don't close while pushing
    setPushDialogOpen(false);
    setEntriesToPush([]);
    setPushResult(null);
  }, [isPushing]);

  const executePush = useCallback(async () => {
    if (isPushing || entriesToPush.length === 0) return;

    setPushDialogPhase('pushing');
    setIsPushing(true);

    try {
      const res = await fetch('/api/jira/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryIds: entriesToPush.map(e => e.id) }),
      });
      const data = await res.json();

      setPushResult({
        success: data.success,
        pushed: data.pushed || 0,
        failed: data.failed || 0,
        error: data.error,
      });
      setPushDialogPhase('result');

      if (data.success) {
        fetchEntries();
        clearEntrySelections();
      }
    } catch (error) {
      console.error('Failed to push to Jira:', error);
      setPushResult({
        success: false,
        pushed: 0,
        failed: entriesToPush.length,
        error: 'Network error - failed to connect to server',
      });
      setPushDialogPhase('result');
    } finally {
      setIsPushing(false);
    }
  }, [isPushing, entriesToPush, fetchEntries, clearEntrySelections]);

  // Helper to lookup and apply route if both project and task type are set
  // If currentJiraSource is 'route' or 'source_route', re-evaluate and update/clear as needed
  // If currentJiraSource is 'manual' or 'extracted', don't touch the jira assignment
  const applyRouteIfExists = useCallback(async (
    entryId: number,
    project: string | null,
    taskType: string | null,
    currentJira: string | null,
    currentJiraSource: JiraSource
  ) => {
    // If Jira was manually assigned or extracted from text, don't auto-change it
    if (currentJiraSource === 'manual' || currentJiraSource === 'extracted') {
      return;
    }

    // If project or task type is missing, can't look up a route
    // But if jira was auto-assigned by a route that no longer applies, clear it
    if (!project || !taskType) {
      if (currentJira && (currentJiraSource === 'route' || currentJiraSource === 'source_route')) {
        // Clear the jira since route no longer applies
        setEntries(prev => prev.map(e =>
          e.id === entryId ? { ...e, jira_issue: null, jira_source: null } : e
        ));
        await fetch(`/api/entries/${entryId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jira_issue: null, jira_source: null }),
        });
      }
      return;
    }

    try {
      const res = await fetch(`/api/routes/lookup?project=${encodeURIComponent(project)}&taskType=${encodeURIComponent(taskType)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.route?.jira_key) {
          // Route found - apply or update the jira
          setEntries(prev => prev.map(e =>
            e.id === entryId ? { ...e, jira_issue: data.route.jira_key, jira_source: 'route' as JiraSource } : e
          ));
          await fetch(`/api/entries/${entryId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jira_issue: data.route.jira_key, jira_source: 'route' }),
          });
        } else if (currentJira && (currentJiraSource === 'route' || currentJiraSource === 'source_route')) {
          // No route found but had auto-assigned jira - clear it
          setEntries(prev => prev.map(e =>
            e.id === entryId ? { ...e, jira_issue: null, jira_source: null } : e
          ));
          await fetch(`/api/entries/${entryId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jira_issue: null, jira_source: null }),
          });
        }
      }
    } catch (error) {
      console.error('Failed to apply route:', error);
    }
  }, []);

  const handleDropOnProject = useCallback(async (entryIds: number[], projectName: string) => {
    // Capture entry data BEFORE optimistic update to avoid stale closure issues
    const entryDataForRoutes = entryIds.map(id => {
      const entry = entries.find(e => e.id === id);
      return entry ? { id, task_type: entry.task_type, jira_issue: entry.jira_issue, jira_source: entry.jira_source } : null;
    }).filter((e): e is NonNullable<typeof e> => e !== null);

    // Optimistic update - set project_source to 'manual' since user is explicitly assigning
    setEntries(prev => prev.map(e =>
      entryIds.includes(e.id) ? { ...e, project: projectName, project_source: 'manual' as ProjectSource } : e
    ));
    try {
      // Single bulk API call
      const res = await fetch('/api/entries', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: entryIds, updates: { project: projectName, project_source: 'manual' } }),
      });
      if (!res.ok) {
        throw new Error(`PATCH failed with status ${res.status}`);
      }
      // Apply routes for each entry using captured data
      for (const entryData of entryDataForRoutes) {
        await applyRouteIfExists(entryData.id, projectName, entryData.task_type || null, entryData.jira_issue || null, entryData.jira_source || null);
      }
      // Clear selections after successful drop
      clearEntrySelections();
    } catch (error) {
      console.error('Failed to assign project:', error);
      fetchEntries(); // Revert on error
    }
  }, [entries, fetchEntries, applyRouteIfExists, clearEntrySelections]);

  const handleDropOnTaskType = useCallback(async (entryIds: number[], taskTypeName: string) => {
    // Capture entry data BEFORE optimistic update to avoid stale closure issues
    const entryDataForRoutes = entryIds.map(id => {
      const entry = entries.find(e => e.id === id);
      return entry ? { id, project: entry.project, jira_issue: entry.jira_issue, jira_source: entry.jira_source } : null;
    }).filter((e): e is NonNullable<typeof e> => e !== null);

    // Optimistic update - set task_type_source to 'manual' since user is explicitly assigning
    setEntries(prev => prev.map(e =>
      entryIds.includes(e.id) ? { ...e, task_type: taskTypeName, task_type_source: 'manual' as TaskTypeSource } : e
    ));
    try {
      // Single bulk API call
      const res = await fetch('/api/entries', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: entryIds, updates: { task_type: taskTypeName, task_type_source: 'manual' } }),
      });
      if (!res.ok) {
        throw new Error(`PATCH failed with status ${res.status}`);
      }
      // Apply routes for each entry using captured data
      for (const entryData of entryDataForRoutes) {
        await applyRouteIfExists(entryData.id, entryData.project || null, taskTypeName, entryData.jira_issue || null, entryData.jira_source || null);
      }
      // Clear selections after successful drop
      clearEntrySelections();
    } catch (error) {
      console.error('Failed to assign task type:', error);
      fetchEntries(); // Revert on error
    }
  }, [entries, fetchEntries, applyRouteIfExists, clearEntrySelections]);

  const handleDropOnFavorite = useCallback(async (entryIds: number[], jiraKey: string) => {
    // Look up jira_name from favorites
    const favorite = favorites.find(f => f.jira_key === jiraKey);
    const jiraName = favorite?.jira_name || null;

    // Optimistic update - set jira_source to 'manual' since user is explicitly assigning
    setEntries(prev => prev.map(e =>
      entryIds.includes(e.id) ? { ...e, jira_issue: jiraKey, jira_name: jiraName, jira_source: 'manual' as JiraSource } : e
    ));
    try {
      // Single bulk API call
      const res = await fetch('/api/entries', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: entryIds, updates: { jira_issue: jiraKey, jira_name: jiraName, jira_source: 'manual' } }),
      });
      if (!res.ok) {
        throw new Error(`PATCH failed with status ${res.status}`);
      }
      // Clear selections after successful drop
      clearEntrySelections();
    } catch (error) {
      console.error('Failed to assign favorite:', error);
      fetchEntries(); // Revert on error
    }
  }, [favorites, fetchEntries, clearEntrySelections]);

  // ============== FAVORITE HANDLERS ==============

  const openFavoriteEditor = useCallback((favorite: { id: number; jira_key: string; jira_name: string; short_name: string | null }) => {
    setEditingFavorite(favorite);
    setEditingFavoriteShortName(favorite.short_name || '');
  }, []);

  const saveFavoriteShortName = useCallback(async () => {
    if (!editingFavorite) return;

    await fetch(`/api/favorites/${editingFavorite.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ short_name: editingFavoriteShortName || null }),
    });

    setEditingFavorite(null);
    loadFavorites();
  }, [editingFavorite, editingFavoriteShortName, loadFavorites]);

  const deleteFavorite = useCallback(async (id: number) => {
    await fetch(`/api/favorites/${id}`, { method: 'DELETE' });
    loadFavorites();
  }, [loadFavorites]);

  // ============== KEYWORD BUILDER TAB HANDLERS ==============


  const openCreateProject = useCallback(() => {
    setCreatingProjectName('');
    setIsCreatingProject(true);
  }, []);

  const handleCreateProject = useCallback(async () => {
    if (!creatingProjectName.trim()) return;
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: creatingProjectName.trim() }),
    });
    if (res.ok) {
      setIsCreatingProject(false);
      setCreatingProjectName('');
      loadProjects();
    }
  }, [creatingProjectName, loadProjects]);

  const handleDeleteProject = useCallback(async (id: number) => {
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    await loadProjects();
  }, [loadProjects]);

  const openCreateTaskType = useCallback(() => {
    setCreatingTaskTypeName('');
    setIsCreatingTaskType(true);
  }, []);

  const handleCreateTaskType = useCallback(async () => {
    if (!creatingTaskTypeName.trim()) return;
    const res = await fetch('/api/task-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: creatingTaskTypeName.trim() }),
    });
    if (res.ok) {
      setIsCreatingTaskType(false);
      setCreatingTaskTypeName('');
      loadTaskTypes();
    }
  }, [creatingTaskTypeName, loadTaskTypes]);

  const handleDeleteTaskType = useCallback(async (id: number) => {
    await fetch(`/api/task-types/${id}`, { method: 'DELETE' });
    await loadTaskTypes();
  }, [loadTaskTypes]);

  const openProjectEditor = useCallback(async (project: Project) => {
    const res = await fetch(`/api/projects/${project.id}`);
    const data = await res.json();
    setEditingProject({ ...project, keywords: data.keywords || [], emailPatterns: data.emailPatterns || [] });
    setEditingProjectName(project.name);
    setNewKeywordForProject('');
    setNewEmailPatternForProject('');
  }, []);

  const openTaskTypeEditor = useCallback(async (taskType: TaskType) => {
    const res = await fetch(`/api/task-types/${taskType.id}`);
    const data = await res.json();
    setEditingTaskType({ ...taskType, keywords: data.keywords || [] });
    setEditingTaskTypeName(taskType.name);
    setNewKeywordForTaskType('');
  }, []);

  const handleUpdateProjectName = useCallback(async () => {
    if (!editingProject || !editingProjectName.trim()) return;

    const res = await fetch(`/api/projects/${editingProject.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editingProjectName.trim() }),
    });

    if (res.ok) {
      const data = await res.json();
      setEditingProject({ ...editingProject, name: data.name, keywords: data.keywords || [] });
      loadProjects();
    }
  }, [editingProject, editingProjectName, loadProjects]);

  const handleUpdateTaskTypeName = useCallback(async () => {
    if (!editingTaskType || !editingTaskTypeName.trim()) return;

    const res = await fetch(`/api/task-types/${editingTaskType.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editingTaskTypeName.trim() }),
    });

    if (res.ok) {
      const data = await res.json();
      setEditingTaskType({ ...editingTaskType, name: data.name, keywords: data.keywords || [] });
      loadTaskTypes();
    }
  }, [editingTaskType, editingTaskTypeName, loadTaskTypes]);

  const handleAddProjectKeyword = useCallback(async () => {
    if (!editingProject || !newKeywordForProject.trim()) return;

    const res = await fetch(`/api/projects/${editingProject.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addKeyword: newKeywordForProject.trim() }),
    });

    if (res.ok) {
      const data = await res.json();
      setEditingProject({ ...editingProject, keywords: data.keywords || [] });
      setNewKeywordForProject('');
      loadProjects();
    }
  }, [editingProject, newKeywordForProject, loadProjects]);

  const handleRemoveProjectKeyword = useCallback(async (keyword: string) => {
    if (!editingProject) return;

    const res = await fetch(`/api/projects/${editingProject.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeKeyword: keyword }),
    });

    if (res.ok) {
      const data = await res.json();
      setEditingProject({ ...editingProject, keywords: data.keywords || [] });
      loadProjects();
    }
  }, [editingProject, loadProjects]);

  const handleAddProjectEmailPattern = useCallback(async () => {
    if (!editingProject || !newEmailPatternForProject.trim()) return;

    const res = await fetch(`/api/projects/${editingProject.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addEmailPattern: newEmailPatternForProject.trim() }),
    });

    if (res.ok) {
      const data = await res.json();
      setEditingProject({ ...editingProject, emailPatterns: data.emailPatterns || [] });
      setNewEmailPatternForProject('');
    }
  }, [editingProject, newEmailPatternForProject]);

  const handleRemoveProjectEmailPattern = useCallback(async (pattern: string) => {
    if (!editingProject) return;

    const res = await fetch(`/api/projects/${editingProject.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeEmailPattern: pattern }),
    });

    if (res.ok) {
      const data = await res.json();
      setEditingProject({ ...editingProject, emailPatterns: data.emailPatterns || [] });
    }
  }, [editingProject]);

  const handleAddTaskTypeKeyword = useCallback(async () => {
    if (!editingTaskType || !newKeywordForTaskType.trim()) return;

    const res = await fetch(`/api/task-types/${editingTaskType.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addKeyword: newKeywordForTaskType.trim() }),
    });

    if (res.ok) {
      const data = await res.json();
      setEditingTaskType({ ...editingTaskType, keywords: data.keywords || [] });
      setNewKeywordForTaskType('');
      loadTaskTypes();
    }
  }, [editingTaskType, newKeywordForTaskType, loadTaskTypes]);

  const handleRemoveTaskTypeKeyword = useCallback(async (keyword: string) => {
    if (!editingTaskType) return;

    const res = await fetch(`/api/task-types/${editingTaskType.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeKeyword: keyword }),
    });

    if (res.ok) {
      const data = await res.json();
      setEditingTaskType({ ...editingTaskType, keywords: data.keywords || [] });
      loadTaskTypes();
    }
  }, [editingTaskType, loadTaskTypes]);

  const projectSelectItems = useMemo(() => (
    projects.map((p) => (
      <SelectItem key={p.id} value={String(p.id)}>
        {p.name}
      </SelectItem>
    ))
  ), [projects]);

  const taskTypeSelectItems = useMemo(() => (
    taskTypes.map((t) => (
      <SelectItem key={t.id} value={String(t.id)}>
        {t.name}
      </SelectItem>
    ))
  ), [taskTypes]);

  // ============== RENDER ==============

  return (
    <div className="container mx-auto p-8 lg:p-12 max-w-7xl">
      {/* Header */}
      <div className="flex justify-between items-center mb-10">
        <h1 className="text-3xl font-bold">Timekeeper</h1>
        <Link href="/settings" prefetch={true}>
          <Button variant="secondary">Settings</Button>
        </Link>
      </div>

      <NavTabs />

      <DndProvider
            selectedEntryIds={selectedEntryIds}
            onDropOnProject={handleDropOnProject}
            onDropOnTaskType={handleDropOnTaskType}
            onDropOnFavorite={handleDropOnFavorite}
          >
          <div className="space-y-8">
            {/* Date Range Selection */}
            <DateRangePicker
              startDate={reviewStartDate}
              endDate={reviewEndDate}
              onStartDateChange={setReviewStartDate}
              onEndDateChange={setReviewEndDate}
              showAllTime
            />

            {/* Create Entries */}
            <Card>
              <CardHeader>
                <CardTitle className="text-xl">Create Entries</CardTitle>
                <p className="text-sm text-slate-500 mt-1">Add entries manually or generate from imported Outlook data (applies keywords and routes automatically)</p>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Button onClick={openCreateModal}>
                      <IconPlus className="h-5 w-5 mr-2" />
                      Manual Entry
                    </Button>
                    <Button onClick={openGenerateDialog} disabled={isGenerating}>
                      <IconRefresh className={`h-5 w-5 mr-2 ${isGenerating ? 'animate-spin' : ''}`} />
                      Generate from Outlook
                    </Button>
                    <div className="h-8 w-px bg-slate-200" />
                    <Button onClick={applyKeywords} disabled={isApplyingKeywords} variant="secondary">
                      <IconTag className={`h-5 w-5 mr-2 ${isApplyingKeywords ? 'animate-spin' : ''}`} />
                      Apply Keywords
                    </Button>
                    <Button onClick={applyRoutes} disabled={isApplyingRoutes} variant="secondary">
                      <IconRoute className={`h-5 w-5 mr-2 ${isApplyingRoutes ? 'animate-spin' : ''}`} />
                      Apply Routes
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Classify Entries */}
            <div ref={setSentinelElement} className="h-0" aria-hidden="true" />
            <div
              className={`sticky top-4 z-10 rounded-xl transition-shadow duration-200 ${
                isProjectCardSticky ? 'shadow-[0_8px_40px_-4px_rgba(59,130,246,0.25)]' : ''
              }`}
            >
              <ProjectTaskTypes
                projects={projects}
                taskTypes={taskTypes}
                favorites={favorites}
                onProjectCreate={openCreateProject}
                onProjectEdit={openProjectEditor}
                onTaskTypeCreate={openCreateTaskType}
                onTaskTypeEdit={openTaskTypeEditor}
                onFavoriteEdit={openFavoriteEditor}
                selectedCount={selectedEntryIds.size}
                onPushToJira={openPushDialog}
                isPushing={isPushing}
              />
            </div>

            {/* Entries List */}
            <Card>
              <CardHeader>
                <div className="flex justify-between items-center">
                  <div>
                    <CardTitle className="text-xl">Review Entries</CardTitle>
                    <p className="text-base text-slate-500 mt-2">
                      {filteredEntries.length}{filteredEntries.length !== entries.length ? ` of ${entries.length}` : ''} entries | {formatDuration(totalMinutes)} total
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {selectedEntryIds.size > 0 && (
                      <>
                        <Button variant="outline" onClick={() => bulkSetExcludeStatus(true)}>
                          <IconEyeOff className="w-4 h-4 mr-1" />
                          Exclude
                        </Button>
                        <Button variant="outline" onClick={() => bulkSetExcludeStatus(false)}>
                          <IconEye className="w-4 h-4 mr-1" />
                          Include
                        </Button>
                        <Button variant="destructive" onClick={bulkDeleteEntries}>
                          <IconTrash className="w-4 h-4 mr-1" />
                          Delete
                        </Button>
                        <div className="h-6 w-px bg-slate-300" />
                      </>
                    )}
                    <Button variant="secondary" onClick={toggleSelectAllEntries}>
                      {selectedEntryIds.size > 0 ? `Deselect (${selectedEntryIds.size})` : 'Select All'}
                    </Button>
                  </div>
                </div>
                {entries.length > 0 && (
                  <div className="flex flex-col gap-3 mt-4">
                    {/* Row 1: Category filters and toggles */}
                    <div className="flex flex-wrap gap-3 items-center">
                      <Select value={entryProjectFilter} onValueChange={setEntryProjectFilter}>
                        <SelectTrigger className="w-40 h-12">
                          <SelectValue placeholder="All projects" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All projects</SelectItem>
                          <SelectItem value="none">No project</SelectItem>
                          {uniqueEntryProjects.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={entryTaskTypeFilter} onValueChange={setEntryTaskTypeFilter}>
                        <SelectTrigger className="w-40 h-12">
                          <SelectValue placeholder="All task types" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All task types</SelectItem>
                          <SelectItem value="none">No task type</SelectItem>
                          {uniqueEntryTaskTypes.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={entryTrackingFilter} onValueChange={setEntryTrackingFilter}>
                        <SelectTrigger className="w-40 h-12">
                          <SelectValue placeholder="All tracking" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All tracking</SelectItem>
                          <SelectItem value="none">No Jira issue</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
                        <SelectTrigger className="w-40 h-12">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All statuses</SelectItem>
                          <SelectItem value="untracked">Untracked</SelectItem>
                          <SelectItem value="tracked">Tracked</SelectItem>
                          <SelectItem value="pushed">Pushed</SelectItem>
                          <SelectItem value="not_pushed">Not Pushed</SelectItem>
                        </SelectContent>
                      </Select>
                      <div className="relative">
                        <Input
                          type="number"
                          placeholder="Min hours"
                          value={minDurationHours}
                          onChange={(e) => setMinDurationHours(e.target.value)}
                          className="w-36 pr-8"
                          min="0"
                          step="0.5"
                        />
                        {minDurationHours && (
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">h</span>
                        )}
                      </div>
                      <Button
                        variant={showExcluded ? "outline" : "secondary"}
                        onClick={() => setShowExcluded(!showExcluded)}
                        className="flex items-center gap-1.5 h-12"
                      >
                        {showExcluded ? (
                          <IconEye className="w-4 h-4" />
                        ) : (
                          <IconEyeOff className="w-4 h-4" />
                        )}
                        Excluded
                      </Button>
                      {(entrySearchQuery || entryProjectFilter !== 'all' || entryTaskTypeFilter !== 'all' || entryTrackingFilter !== 'all' || minDurationHours || !showExcluded) && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEntrySearchQuery('');
                            setEntryProjectFilter('all');
                            setEntryTaskTypeFilter('all');
                            setEntryTrackingFilter('all');
                            setMinDurationHours('');
                            setShowExcluded(true);
                          }}
                          className="text-slate-500 hover:text-slate-700 h-12"
                        >
                          Clear filters
                        </Button>
                      )}
                    </div>
                    {/* Row 2: Search box directly above table */}
                    <div className="relative w-[31.5rem]">
                      <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                        placeholder="Search entries..."
                        value={entrySearchQuery}
                        onChange={(e) => setEntrySearchQuery(e.target.value)}
                        className="pl-9 w-full"
                      />
                    </div>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                {entriesLoading ? (
                  <div className="p-12 text-center text-slate-500 text-lg">Loading...</div>
                ) : entries.length === 0 ? (
                  <div className="p-12 text-center text-slate-500">
                    <p className="text-lg mb-4">No entries for this date range.</p>
                    <Button variant="link" onClick={openGenerateDialog} disabled={isGenerating}>
                      Generate entries from imported sources
                    </Button>
                  </div>
                ) : filteredEntries.length === 0 ? (
                  <p className="text-slate-400 text-sm py-4">
                    No entries match your filters.
                  </p>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center font-semibold text-base text-slate-700 border-b-2 border-slate-200 pb-2 mb-2">
                      <div className="w-14 p-4"></div>
                      <div className="w-12 p-4"></div>
                      <div className="w-44 p-4">Date/Time</div>
                      <div className="flex-1 p-4">Event</div>
                      <div className="w-32 p-4">Duration</div>
                      <div className="w-60 shrink-0 p-4 text-center">Actions</div>
                    </div>
                    {paginatedEntries.map((entry) => (
                      <DraggableEntryRow
                        key={entry.id}
                        entryId={entry.id}
                        entryTitle={entry.title}
                        selectedEntryIds={selectedEntryIds}
                      >
                      <div
                        className={`flex items-center transition-colors cursor-pointer border-b border-slate-100 py-1 ${
                          entry.source_status === 'stale'
                            ? 'bg-red-50/50 opacity-60 hover:opacity-80'
                            : entry.status === 'excluded'
                              ? 'bg-amber-50/50 opacity-60 hover:opacity-80'
                              : 'hover:bg-slate-50'
                        } ${selectedEntryIds.has(entry.id) ? 'bg-blue-50/50 ring-1 ring-blue-200' : ''}`}
                        onClick={(e) => {
                          const target = e.target as HTMLElement;
                          if (!target.closest('button, input, a, select')) {
                            toggleEntrySelection(entry.id);
                          }
                        }}
                        onPointerDown={(e) => {
                          // Stop propagation for interactive elements to prevent drag interference
                          const target = e.target as HTMLElement;
                          if (target.closest('button, input, a')) {
                            e.stopPropagation();
                          }
                        }}
                      >
                        <div className="w-14 p-4">
                          <input
                            type="checkbox"
                            checked={selectedEntryIds.has(entry.id)}
                            onChange={() => toggleEntrySelection(entry.id)}
                            className="w-5 h-5 rounded"
                          />
                        </div>
                        <div className="w-12 p-4">
                          {entry.status === 'pushed' ? (
                            <Badge variant="green-light" className="p-1">
                              <IconCheck className="w-4 h-4" />
                            </Badge>
                          ) : (
                            <Badge variant="red-light" className="p-1">
                              <IconX className="w-4 h-4" />
                            </Badge>
                          )}
                        </div>
                        <div className="w-44 p-4">
                          <div className="text-base text-slate-600">{formatDateTime(entry.date, entry.start_time)}</div>
                          <div className="text-sm text-slate-500 capitalize">{entry.source_type}</div>
                        </div>
                        <div className="flex-1 p-4">
                          <div className="flex flex-col gap-2">
                            {entry.source_id && entry.source_type !== 'manual' ? (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  viewSourceDetails(entry);
                                }}
                                onPointerDown={(e) => e.stopPropagation()}
                                className="truncate max-w-md text-left text-base hover:text-blue-600 hover:underline cursor-pointer"
                                title={`Click to view ${entry.source_type} details`}
                              >
                                {entry.title}
                              </button>
                            ) : (
                              <span className="truncate max-w-md text-base" title={entry.title}>
                                {entry.title}
                              </span>
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                              {entry.source_status === 'stale' && (
                                <span className="inline-flex items-center px-3 py-1 bg-red-100 text-red-700 rounded-full text-sm font-medium" title="Source was cancelled/deleted in Outlook">
                                  Stale
                                </span>
                              )}
                              {entry.project && (
                                <span className="inline-flex items-center px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-medium">
                                  {entry.project}
                                </span>
                              )}
                              {entry.task_type && (
                                <span className="inline-flex items-center px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
                                  {entry.task_type}
                                </span>
                              )}
                              {entry.jira_issue ? (
                                <TooltipProvider delayDuration={300}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span
                                        className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium cursor-default ${
                                          entry.jira_source === 'placeholder'
                                            ? 'bg-slate-100 text-slate-500 border border-dashed border-slate-400'
                                            : 'bg-purple-100 text-purple-700'
                                        }`}
                                      >
                                        {entry.jira_issue}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {entry.jira_source === 'placeholder' ? (
                                        <p className="max-w-xs">Placeholder assignment — no matching Jira code. Reassign to the correct issue.</p>
                                      ) : (entry.jira_name || jiraNameLookup.get(entry.jira_issue)) ? (
                                        <p className="max-w-xs">{entry.jira_name || jiraNameLookup.get(entry.jira_issue)}</p>
                                      ) : null}
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              ) : (
                                <span className="inline-flex items-center px-3 py-1 bg-slate-200 text-slate-500 rounded-full text-sm font-medium">
                                  Untracked
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="w-32 p-4 text-base text-slate-600 whitespace-nowrap">
                          {formatDuration(entry.duration_minutes, entry.context_minutes)}
                        </div>
                        <div className="w-60 shrink-0 p-4">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              onClick={() => adjustDuration(entry.id, -15)}
                              title="Decrease duration"
                              className="size-9 aspect-square rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors cursor-pointer"
                            >
                              <IconMinus className="w-4 h-4 text-slate-600" />
                            </button>
                            <button
                              onClick={() => adjustDuration(entry.id, 15)}
                              title="Increase duration"
                              className="size-9 aspect-square rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors cursor-pointer"
                            >
                              <IconPlus className="w-4 h-4 text-slate-600" />
                            </button>
                            <button
                              onClick={() => openEditModal(entry)}
                              title="Edit entry"
                              className="size-9 aspect-square rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors cursor-pointer"
                            >
                              <IconPencil className="w-4 h-4 text-slate-600" />
                            </button>
                            <button
                              onClick={() => toggleExclude(entry)}
                              title={entry.status === 'excluded' ? 'Include entry' : 'Exclude entry'}
                              className={`size-9 aspect-square rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                                entry.status === 'excluded'
                                  ? 'bg-amber-100 hover:bg-amber-200'
                                  : 'bg-slate-100 hover:bg-amber-100'
                              }`}
                            >
                              {entry.status === 'excluded' ? (
                                <IconEye className="w-4 h-4 text-amber-600" />
                              ) : (
                                <IconEyeOff className="w-4 h-4 text-slate-600" />
                              )}
                            </button>
                            <button
                              onClick={() => deleteEntry(entry.id)}
                              title="Delete entry"
                              className="size-9 aspect-square rounded-full bg-slate-100 hover:bg-red-100 hover:text-red-600 flex items-center justify-center transition-colors cursor-pointer"
                            >
                              <IconTrash className="w-4 h-4 text-slate-600" />
                            </button>
                          </div>
                        </div>
                      </div>
                      </DraggableEntryRow>
                    ))}
                    {/* Pagination */}
                    {totalEntryPages > 1 && (
                      <div className="flex items-center justify-center gap-4 py-4">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEntriesPage(p => Math.max(0, p - 1))}
                          disabled={entriesPage === 0}
                          className="text-slate-600 hover:text-slate-900"
                        >
                          Previous
                        </Button>
                        <span className="text-sm text-slate-500 flex items-center">
                          {entriesPage * ENTRIES_PER_PAGE + 1}-{Math.min((entriesPage + 1) * ENTRIES_PER_PAGE, filteredEntries.length)} of {filteredEntries.length}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEntriesPage(p => Math.min(totalEntryPages - 1, p + 1))}
                          disabled={entriesPage >= totalEntryPages - 1}
                          className="text-slate-600 hover:text-slate-900"
                        >
                          Next
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          </DndProvider>

      {/* ============== DIALOGS ============== */}

      {/* Create/Edit Entry Modal */}
      {modalMode && (
        <EntryModal
          mode={modalMode}
          isOpen
          onClose={closeModal}
          onSave={saveModal}
          projects={projects}
          taskTypes={taskTypes}
          initialValues={modalInitialValues}
          onProjectTaskTypeChange={handleModalProjectTaskTypeChange}
          externalJiraIssue={externalJiraIssue}
        />
      )}

      {/* Generate Entries Dialog */}
      <Dialog open={generateDialogOpen} onOpenChange={(open) => {
        if (!open && !isGenerating) {
          lastDialogCloseTime.current = Date.now();
          closeGenerateDialog();
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          {generateDialogPhase === 'confirm' && (
            <>
              <DialogHeader className="pb-2">
                <DialogTitle className="flex items-center gap-3 text-xl">
                  <IconRefresh className="w-6 h-6 text-blue-600" />
                  Generate Entries
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="bg-slate-50 rounded-lg px-4 py-3">
                  <p className="text-base text-slate-700">
                    <span className="font-semibold">{reviewStartDate}</span> to <span className="font-semibold">{reviewEndDate}</span>
                  </p>
                </div>
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <IconPlus className="w-5 h-5 text-green-600 mt-0.5 shrink-0" />
                    <p className="text-base text-slate-600"><span className="font-medium text-slate-700">Created:</span> New entries from imported sources</p>
                  </div>
                  <div className="flex gap-3">
                    <IconRefresh className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
                    <p className="text-base text-slate-600"><span className="font-medium text-slate-700">Updated:</span> Re-apply keywords, routes, Jira extraction</p>
                  </div>
                  <div className="flex gap-3">
                    <IconCheck className="w-5 h-5 text-slate-400 mt-0.5 shrink-0" />
                    <p className="text-base text-slate-600"><span className="font-medium text-slate-700">Kept:</span> Manual assignments, pushed entries, excluded status</p>
                  </div>
                  <div className="flex gap-3">
                    <IconTrash className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
                    <p className="text-base text-slate-600"><span className="font-medium text-slate-700">Removed:</span> Entries from deleted/cancelled sources</p>
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <Button variant="outline" onClick={closeGenerateDialog}>
                  Cancel
                </Button>
                <Button onClick={executeGenerate}>
                  <IconRefresh className="w-4 h-4 mr-2" />
                  Generate
                </Button>
              </div>
            </>
          )}

          {generateDialogPhase === 'generating' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3 text-xl">
                  <IconLoader2 className="w-6 h-6 text-blue-600 animate-spin" />
                  Generating Entries
                </DialogTitle>
              </DialogHeader>
              <div className="py-8">
                <div className="flex flex-col items-center gap-4">
                  <Progress className="w-full" />
                  <p className="text-slate-500">Processing sources and applying classification rules...</p>
                </div>
              </div>
            </>
          )}

          {generateDialogPhase === 'result' && generateResult && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3 text-xl">
                  {generateResult.success ? (
                    <IconCircleCheck className="w-6 h-6 text-green-600" />
                  ) : (
                    <IconCircleX className="w-6 h-6 text-red-600" />
                  )}
                  {generateResult.success ? 'Generation Complete' : 'Generation Failed'}
                </DialogTitle>
              </DialogHeader>
              <div className="py-6">
                {generateResult.success ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-center">
                      <div>
                        <p className="text-3xl font-bold text-slate-900">{generateResult.generated}</p>
                        <p className="text-sm text-slate-500">Generated</p>
                      </div>
                      <div>
                        <p className="text-3xl font-bold text-slate-400">{generateResult.skipped}</p>
                        <p className="text-sm text-slate-500">Skipped</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-center text-slate-600">Failed to generate entries.</p>
                    {generateResult.error && (
                      <p className="text-sm text-red-600 text-center">{generateResult.error}</p>
                    )}
                  </div>
                )}
              </div>
              <div className="flex justify-end">
                <Button onClick={closeGenerateDialog}>
                  Done
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Push to Jira Dialog */}
      <Dialog open={pushDialogOpen} onOpenChange={(open) => {
        if (!open && !isPushing) {
          lastDialogCloseTime.current = Date.now();
          closePushDialog();
        }
      }}>
        <DialogContent className="sm:max-w-md">
          {pushDialogPhase === 'confirm' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3 text-xl">
                  <IconUpload className="w-6 h-6 text-blue-600" />
                  Push to Jira
                </DialogTitle>
                <DialogDescription className="text-base">
                  Review and confirm your time entries before pushing.
                </DialogDescription>
              </DialogHeader>
              <div className="py-6 overflow-hidden">
                <div className={`grid ${(skippedEntries.alreadyPushed + skippedEntries.noJira + skippedEntries.excluded) > 0 ? 'grid-cols-3' : 'grid-cols-2'} gap-4 text-center mb-4`}>
                  <div>
                    <p className="text-3xl font-bold text-slate-900">{entriesToPush.length}</p>
                    <p className="text-sm text-slate-500">Entries</p>
                  </div>
                  <div>
                    <p className="text-3xl font-bold text-slate-900">
                      {formatDuration(entriesToPush.reduce((sum, e) => sum + e.duration_minutes, 0))}
                    </p>
                    <p className="text-sm text-slate-500">Total Time</p>
                  </div>
                  {(skippedEntries.alreadyPushed + skippedEntries.noJira + skippedEntries.excluded) > 0 && (
                    <div>
                      <p className="text-3xl font-bold text-amber-600">
                        {skippedEntries.alreadyPushed + skippedEntries.noJira + skippedEntries.excluded}
                      </p>
                      <p className="text-sm text-slate-500">Skipped</p>
                    </div>
                  )}
                </div>
                {entriesToPush.length > 0 ? (
                  <div className="max-h-48 overflow-y-auto overflow-x-hidden rounded-xl">
                    <div className="space-y-2">
                      {entriesToPush.slice(0, 10).map((entry) => (
                        <div key={entry.id} className="flex items-center justify-between text-sm px-3 py-2 bg-slate-50 rounded-lg min-w-0">
                          <span className="truncate flex-1 min-w-0 mr-2">{entry.title}</span>
                          <Badge variant="outline" className="shrink-0">{entry.jira_issue}</Badge>
                        </div>
                      ))}
                      {entriesToPush.length > 10 && (
                        <p className="text-sm text-slate-500 text-center py-2">
                          +{entriesToPush.length - 10} more entries
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500 text-center py-4">
                    No entries available to push
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-3">
                {entriesToPush.length === 0 ? (
                  <Button onClick={closePushDialog}>
                    Close
                  </Button>
                ) : (
                  <>
                    <Button variant="outline" onClick={closePushDialog}>
                      Cancel
                    </Button>
                    <Button onClick={executePush} className="bg-slate-900 hover:bg-slate-800">
                      <IconUpload className="w-4 h-4 mr-2" />
                      Push {entriesToPush.length} Entries
                    </Button>
                  </>
                )}
              </div>
            </>
          )}

          {pushDialogPhase === 'pushing' && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3 text-xl">
                  <IconLoader2 className="w-6 h-6 text-blue-600 animate-spin" />
                  Pushing to Jira
                </DialogTitle>
              </DialogHeader>
              <div className="py-8">
                <div className="flex flex-col items-center gap-4">
                  <Progress className="w-full" />
                  <p className="text-slate-500">Pushing {entriesToPush.length} entries to Jira...</p>
                </div>
              </div>
            </>
          )}

          {pushDialogPhase === 'result' && pushResult && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3 text-xl">
                  {pushResult.success && pushResult.failed === 0 ? (
                    <IconCircleCheck className="w-6 h-6 text-green-600" />
                  ) : pushResult.success && pushResult.failed > 0 ? (
                    <IconAlertTriangle className="w-6 h-6 text-amber-500" />
                  ) : (
                    <IconCircleX className="w-6 h-6 text-red-600" />
                  )}
                  {pushResult.success && pushResult.failed === 0
                    ? 'Push Complete'
                    : pushResult.success && pushResult.failed > 0
                    ? 'Partial Success'
                    : 'Push Failed'}
                </DialogTitle>
              </DialogHeader>
              <div className="py-6">
                {pushResult.success ? (
                  <div className="space-y-4">
                    <p className="text-center text-slate-600">
                      Successfully pushed <span className="font-semibold">{pushResult.pushed}</span> {pushResult.pushed === 1 ? 'entry' : 'entries'} to Jira.
                      {pushResult.failed > 0 && (
                        <> <span className="font-semibold text-red-600">{pushResult.failed}</span> failed.</>
                      )}
                    </p>
                    {pushResult.failed > 0 && pushResult.error && (
                      <p className="text-sm text-red-600 text-center">{pushResult.error}</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-center text-slate-600">
                      Failed to push <span className="font-semibold">{pushResult.failed}</span> {pushResult.failed === 1 ? 'entry' : 'entries'}.
                    </p>
                    {pushResult.error && (
                      <p className="text-sm text-red-600 text-center">{pushResult.error}</p>
                    )}
                  </div>
                )}
              </div>
              <div className="flex justify-end">
                <Button onClick={closePushDialog}>
                  Done
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Source Details Dialog */}
      <Dialog open={!!viewingSource} onOpenChange={(open) => {
        if (!open) lastDialogCloseTime.current = Date.now();
        setViewingSource(null);
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-xl">
              {viewingSource?.type === 'meeting' ? (
                <span className="text-sm px-3 py-1 rounded-full bg-purple-100 text-purple-700 font-medium">Meeting</span>
              ) : (
                <span className="text-sm px-3 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">Email</span>
              )}
              {viewingSource?.type === 'meeting' ? 'Meeting Details' : 'Email Details'}
            </DialogTitle>
          </DialogHeader>
          {viewingSource && (
            <div className="grid gap-8 py-6 overflow-y-auto">
              <div className="grid gap-3">
                <Label className="text-muted-foreground text-sm uppercase tracking-wide">Subject</Label>
                <p className="font-medium text-lg">{viewingSource.subject}</p>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="grid gap-3">
                  <Label className="text-muted-foreground text-sm uppercase tracking-wide">Date</Label>
                  <p className="text-base">{formatDisplayDate(viewingSource.date.split('T')[0])}</p>
                </div>
                {viewingSource.duration_minutes && (
                  <div className="grid gap-3">
                    <Label className="text-muted-foreground text-sm uppercase tracking-wide">Duration</Label>
                    <p className="text-base">{formatDuration(viewingSource.duration_minutes)}</p>
                  </div>
                )}
              </div>

              {viewingSource.body && (
                <div className="grid gap-3">
                  <Label className="text-muted-foreground text-sm uppercase tracking-wide">
                    {viewingSource.type === 'meeting' ? 'Meeting Notes / Description' : 'Email Body'}
                  </Label>
                  <div className="min-h-[48px] p-4 rounded-xl bg-slate-100 max-h-64 overflow-y-auto">
                    <pre className="text-base whitespace-pre-wrap font-sans text-slate-700">
                      {viewingSource.body}
                    </pre>
                  </div>
                </div>
              )}

              <div className="text-sm text-muted-foreground pt-4 border-t">
                Imported: {new Date(viewingSource.imported_at).toLocaleString()}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Project Editor Dialog */}
      <Dialog open={!!editingProject} onOpenChange={(open) => {
        if (!open) lastDialogCloseTime.current = Date.now();
        setEditingProject(null);
      }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-xl">Edit Project</DialogTitle>
            <DialogDescription className="text-base">
              Manage project settings, keywords, and email patterns.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-8 py-6">
            <div className="grid gap-3">
              <Label htmlFor="project-name" className="text-base">Project Name</Label>
              <div className="flex gap-3">
                <Input
                  id="project-name"
                  value={editingProjectName}
                  onChange={(e) => setEditingProjectName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleUpdateProjectName()}
                  className="flex-1"
                />
                <Button onClick={handleUpdateProjectName}>
                  Save
                </Button>
              </div>
            </div>

            <div className="grid gap-3">
              <Label htmlFor="project-keyword" className="text-base">Keywords</Label>
              <div className="flex gap-3">
                <Input
                  id="project-keyword"
                  placeholder="Enter a keyword..."
                  value={newKeywordForProject}
                  onChange={(e) => setNewKeywordForProject(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddProjectKeyword()}
                  className="flex-1"
                />
                <Button onClick={handleAddProjectKeyword} variant="secondary">
                  Add
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 min-h-[52px] p-4 rounded-xl bg-slate-100">
                {editingProject?.keywords?.map((kw) => (
                  <span
                    key={kw}
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-100 text-blue-700 rounded-full text-sm font-medium"
                  >
                    {kw}
                    <button
                      onClick={() => handleRemoveProjectKeyword(kw)}
                      className="hover:text-red-600 transition-colors cursor-pointer"
                      aria-label={`Remove ${kw}`}
                    >
                      <span className="text-lg leading-none">&times;</span>
                    </button>
                  </span>
                ))}
                {(!editingProject?.keywords || editingProject.keywords.length === 0) && (
                  <span className="text-muted-foreground text-base">No keywords added</span>
                )}
              </div>
            </div>

            <div className="grid gap-3">
              <div className="space-y-2">
                <Label htmlFor="project-email-pattern" className="text-base">Email Patterns</Label>
                <p className="text-base text-muted-foreground">
                  Associate email addresses or domains (e.g., @ukg.com or john@example.com)
                </p>
              </div>
              <div className="flex gap-3">
                <Input
                  id="project-email-pattern"
                  placeholder="Enter email or domain..."
                  value={newEmailPatternForProject}
                  onChange={(e) => setNewEmailPatternForProject(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddProjectEmailPattern()}
                  className="flex-1"
                />
                <Button onClick={handleAddProjectEmailPattern} variant="secondary">
                  Add
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 min-h-[52px] p-4 rounded-xl bg-slate-100">
                {editingProject?.emailPatterns?.map((pattern) => (
                  <span
                    key={pattern}
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-purple-100 text-purple-700 rounded-full text-sm font-medium"
                  >
                    {pattern}
                    <button
                      onClick={() => handleRemoveProjectEmailPattern(pattern)}
                      className="hover:text-red-600 transition-colors cursor-pointer"
                      aria-label={`Remove ${pattern}`}
                    >
                      <span className="text-lg leading-none">&times;</span>
                    </button>
                  </span>
                ))}
                {(!editingProject?.emailPatterns || editingProject.emailPatterns.length === 0) && (
                  <span className="text-muted-foreground text-base">No email patterns added</span>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Project Dialog */}
      <Dialog open={isCreatingProject} onOpenChange={(open) => {
        if (!open) lastDialogCloseTime.current = Date.now();
        setIsCreatingProject(open);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl">Create Project</DialogTitle>
            <DialogDescription className="text-base">
              Enter a name for the new project.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-3">
              <Label htmlFor="new-project-name" className="text-base">Project Name</Label>
              <Input
                id="new-project-name"
                value={creatingProjectName}
                onChange={(e) => setCreatingProjectName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateProject()}
                placeholder="Enter project name..."
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreatingProject(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateProject} disabled={!creatingProjectName.trim()}>
              Create Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Task Type Dialog */}
      <Dialog open={isCreatingTaskType} onOpenChange={(open) => {
        if (!open) lastDialogCloseTime.current = Date.now();
        setIsCreatingTaskType(open);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl">Create Task Type</DialogTitle>
            <DialogDescription className="text-base">
              Enter a name for the new task type.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-3">
              <Label htmlFor="new-task-type-name" className="text-base">Task Type Name</Label>
              <Input
                id="new-task-type-name"
                value={creatingTaskTypeName}
                onChange={(e) => setCreatingTaskTypeName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateTaskType()}
                placeholder="Enter task type name..."
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreatingTaskType(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateTaskType} disabled={!creatingTaskTypeName.trim()}>
              Create Task Type
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task Type Editor Dialog */}
      <Dialog open={!!editingTaskType} onOpenChange={(open) => {
        if (!open) lastDialogCloseTime.current = Date.now();
        setEditingTaskType(null);
      }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-xl">Edit Task Type</DialogTitle>
            <DialogDescription className="text-base">
              Manage task type settings and keywords.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-8 py-6">
            <div className="grid gap-3">
              <Label htmlFor="task-type-name" className="text-base">Task Type Name</Label>
              <div className="flex gap-3">
                <Input
                  id="task-type-name"
                  value={editingTaskTypeName}
                  onChange={(e) => setEditingTaskTypeName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleUpdateTaskTypeName()}
                  className="flex-1"
                />
                <Button onClick={handleUpdateTaskTypeName}>
                  Save
                </Button>
              </div>
            </div>

            <div className="grid gap-3">
              <Label htmlFor="task-type-keyword" className="text-base">Keywords</Label>
              <div className="flex gap-3">
                <Input
                  id="task-type-keyword"
                  placeholder="Enter a keyword..."
                  value={newKeywordForTaskType}
                  onChange={(e) => setNewKeywordForTaskType(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddTaskTypeKeyword()}
                  className="flex-1"
                />
                <Button onClick={handleAddTaskTypeKeyword} variant="secondary">
                  Add
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 min-h-[52px] p-4 rounded-xl bg-slate-100">
                {editingTaskType?.keywords?.map((kw) => (
                  <span
                    key={kw}
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-100 text-green-700 rounded-full text-sm font-medium"
                  >
                    {kw}
                    <button
                      onClick={() => handleRemoveTaskTypeKeyword(kw)}
                      className="hover:text-red-600 transition-colors cursor-pointer"
                      aria-label={`Remove ${kw}`}
                    >
                      <span className="text-lg leading-none">&times;</span>
                    </button>
                  </span>
                ))}
                {(!editingTaskType?.keywords || editingTaskType.keywords.length === 0) && (
                  <span className="text-muted-foreground text-base">No keywords added</span>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Favorite Editor Dialog */}
      <Dialog open={!!editingFavorite} onOpenChange={(open) => {
        if (!open) lastDialogCloseTime.current = Date.now();
        setEditingFavorite(null);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl">Edit Favorite</DialogTitle>
            <DialogDescription className="text-base">
              Set a short name for quick identification. The Jira key and issue name cannot be changed.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-6 py-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground text-sm">Jira Issue</Label>
              <p className="font-medium text-base">{editingFavorite?.jira_key}</p>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground text-sm">Issue Name (from Jira)</Label>
              <p className="text-sm text-slate-600">{editingFavorite?.jira_name}</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="short-name" className="text-base">Short Name (editable)</Label>
              <Input
                id="short-name"
                placeholder="e.g., Sprint Planning"
                value={editingFavoriteShortName}
                onChange={(e) => setEditingFavoriteShortName(e.target.value)}
              />
              <p className="text-xs text-slate-500">
                This name will be displayed instead of the Jira key for easier identification.
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setEditingFavorite(null)}>
              Cancel
            </Button>
            <Button onClick={saveFavoriteShortName}>Save</Button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
