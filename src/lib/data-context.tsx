'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode, useMemo } from 'react';

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

interface Favorite {
  id: number;
  jira_key: string;
  jira_name: string;
  short_name: string | null;
}

interface DataContextValue {
  // Data
  projects: Project[];
  taskTypes: TaskType[];
  favorites: Favorite[];

  // Loading states
  isLoading: boolean;

  // Refresh functions
  refreshProjects: () => Promise<void>;
  refreshTaskTypes: () => Promise<void>;
  refreshFavorites: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

// ============== PROVIDER ==============

export function DataProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [taskTypes, setTaskTypes] = useState<TaskType[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (error) {
      console.error('Failed to load projects:', error);
    }
  }, []);

  const refreshTaskTypes = useCallback(async () => {
    try {
      const res = await fetch('/api/task-types');
      const data = await res.json();
      setTaskTypes(data.taskTypes || []);
    } catch (error) {
      console.error('Failed to load task types:', error);
    }
  }, []);

  const refreshFavorites = useCallback(async () => {
    try {
      const res = await fetch('/api/favorites');
      const data = await res.json();
      setFavorites(data.favorites || []);
    } catch (error) {
      console.error('Failed to load favorites:', error);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setIsLoading(true);
    try {
      // Fetch all data in parallel
      await Promise.all([
        refreshProjects(),
        refreshTaskTypes(),
        refreshFavorites(),
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [refreshProjects, refreshTaskTypes, refreshFavorites]);

  // Validate favorites against Jira on load — remove ineligible (epics/milestones) or deleted issues
  const validateExistingFavorites = useCallback(async (favList: Favorite[]) => {
    if (favList.length === 0) return;
    try {
      const res = await fetch('/api/jira/validate-favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: favList.map((f) => f.jira_key) }),
      });
      const data = await res.json();
      if (data.success && data.ineligible && data.ineligible.length > 0) {
        const ineligibleKeys = new Set(data.ineligible.map((i: { key: string; reason: string }) => i.key.toUpperCase()));
        // Delete ineligible favorites from the database
        for (const fav of favList) {
          if (ineligibleKeys.has(fav.jira_key.toUpperCase())) {
            await fetch(`/api/favorites/${fav.id}`, { method: 'DELETE' }).catch(() => {});
          }
        }
        // Refresh the favorites list to reflect the removals
        await refreshFavorites();
      }
    } catch {
      // Non-fatal — favorites just won't be validated this cycle
    }
  }, [refreshFavorites]);

  // Load data on mount, then validate favorites
  useEffect(() => {
    (async () => {
      await refreshAll();
      // After initial load, validate favorites if we have any
      // refreshAll populates favorites state, so we read from the API again
      try {
        const favRes = await fetch('/api/favorites');
        const favData = await favRes.json();
        if (favData.favorites && favData.favorites.length > 0) {
          await validateExistingFavorites(favData.favorites);
        }
      } catch { /* ignore */ }
    })();
  }, [refreshAll, validateExistingFavorites]);

  const value = useMemo(() => ({
    projects,
    taskTypes,
    favorites,
    isLoading,
    refreshProjects,
    refreshTaskTypes,
    refreshFavorites,
    refreshAll,
  }), [projects, taskTypes, favorites, isLoading, refreshProjects, refreshTaskTypes, refreshFavorites, refreshAll]);

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
}

// ============== HOOK ==============

export function useSharedData() {
  const context = useContext(DataContext);
  if (!context) {
    throw new Error('useSharedData must be used within a DataProvider');
  }
  return context;
}
