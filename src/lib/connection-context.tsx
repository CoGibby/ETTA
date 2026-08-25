'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode, useMemo } from 'react';

interface ConnectionState {
  connected: boolean;
  connecting: boolean;
  email: string | null;
  jiraUrl: string | null;
  checking: boolean;
  refresh: () => Promise<void>;
  setConnecting: (v: boolean) => void;
}

const ConnectionContext = createContext<ConnectionState | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [jiraUrl, setJiraUrl] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      const s = data.settings || {};
      const hasCreds = !!(s.jira_url && s.jira_pat);
      setConnected(hasCreds);
      setJiraUrl(hasCreds ? s.jira_url : null);
      setEmail(hasCreds ? (s.jira_email || 'connected user') : null);
    } catch {
      setConnected(false);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(() => ({
    connected, connecting, email, jiraUrl, checking, refresh, setConnecting,
  }), [connected, connecting, email, jiraUrl, checking, refresh]);

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection() {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within a ConnectionProvider');
  return ctx;
}
