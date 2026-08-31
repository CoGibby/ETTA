'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode, useMemo } from 'react';

interface ConnectionState {
  connected: boolean;
  connecting: boolean;
  email: string | null;
  jiraUrl: string | null;
  outlookConnected: boolean;
  checking: boolean;
  refresh: () => Promise<void>;
  refreshOutlook: () => Promise<void>;
  setConnecting: (v: boolean) => void;
}

const ConnectionContext = createContext<ConnectionState | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [jiraUrl, setJiraUrl] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [outlookConnected, setOutlookConnected] = useState(false);

  const refreshOutlook = useCallback(async () => {
    try {
      const res = await fetch('/api/outlook/status');
      const data = await res.json();
      setOutlookConnected(!!data.connected);
    } catch {
      setOutlookConnected(false);
    }
  }, []);

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
    await refreshOutlook();
  }, [refreshOutlook]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll Outlook status every 30 seconds so disconnect/connect is reflected everywhere
  useEffect(() => {
    const interval = setInterval(refreshOutlook, 30000);
    return () => clearInterval(interval);
  }, [refreshOutlook]);

  const value = useMemo(() => ({
    connected, connecting, email, jiraUrl, outlookConnected, checking, refresh, refreshOutlook, setConnecting,
  }), [connected, connecting, email, jiraUrl, outlookConnected, checking, refresh, refreshOutlook]);

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
