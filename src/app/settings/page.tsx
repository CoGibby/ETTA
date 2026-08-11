'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { IconCheck, IconX, IconLoader2, IconDownload, IconStar, IconTrash } from '@tabler/icons-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import Link from 'next/link';

interface OutlookStatus {
  backend: 'com' | 'graph';
  configured: boolean;
  connected: boolean;
  account: string | null;
  message: string;
}

interface Settings {
  jira_url?: string;
  jira_pat?: string;
  outlook_backend?: string;
  azure_client_id?: string;
  azure_tenant_id?: string;
  placeholder_jira_issue?: string;
  include_tentative_meetings?: string;
  email_short_minutes?: string;
  email_medium_minutes?: string;
  email_long_minutes?: string;
  email_short_threshold?: string;
  email_medium_threshold?: string;
  context_before_minutes?: string;
  context_after_minutes?: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [recalcResult, setRecalcResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const [outlookBackend, setOutlookBackend] = useState('auto');
  const [azureClientId, setAzureClientId] = useState('');
  const [azureTenantId, setAzureTenantId] = useState('common');
  const [outlookStatus, setOutlookStatus] = useState<OutlookStatus | null>(null);
  const [isLoadingOutlook, setIsLoadingOutlook] = useState(false);
  const [isConnectingOutlook, setIsConnectingOutlook] = useState(false);
  const [isCompletingOutlook, setIsCompletingOutlook] = useState(false);
  const [outlookAuthMessage, setOutlookAuthMessage] = useState<string | null>(null);
  const [showOutlookAuthDialog, setShowOutlookAuthDialog] = useState(false);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);

  // Form state
  const [jiraUrl, setJiraUrl] = useState('');
  const [jiraPat, setJiraPat] = useState('');
  const [placeholderJiraIssue, setPlaceholderJiraIssue] = useState('PPMO-537');
  const [includeTentative, setIncludeTentative] = useState(false);
  const [emailShortMinutes, setEmailShortMinutes] = useState('10');
  const [emailMediumMinutes, setEmailMediumMinutes] = useState('20');
  const [emailLongMinutes, setEmailLongMinutes] = useState('30');
  const [emailShortThreshold, setEmailShortThreshold] = useState('600');
  const [emailMediumThreshold, setEmailMediumThreshold] = useState('1200');
  const [contextBefore, setContextBefore] = useState('10');
  const [contextAfter, setContextAfter] = useState('10');

  const refreshOutlookStatus = useCallback(async () => {
    setIsLoadingOutlook(true);
    try {
      const res = await fetch('/api/outlook/status');
      const data = await res.json();
      setOutlookStatus(data);
    } catch (error) {
      console.error('Failed to load Outlook status:', error);
    } finally {
      setIsLoadingOutlook(false);
    }
  }, []);

  // Load settings
  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        setSettings(data.settings || {});
        setJiraUrl(data.settings?.jira_url || '');
        setJiraPat(data.settings?.jira_pat || '');
        setPlaceholderJiraIssue(data.settings?.placeholder_jira_issue || 'PPMO-537');
        setIncludeTentative(data.settings?.include_tentative_meetings === 'true');
        setOutlookBackend(data.settings?.outlook_backend || 'auto');
        setAzureClientId(data.settings?.azure_client_id || '');
        setAzureTenantId(data.settings?.azure_tenant_id || 'common');
        setEmailShortMinutes(data.settings?.email_short_minutes || '10');
        setEmailMediumMinutes(data.settings?.email_medium_minutes || '20');
        setEmailLongMinutes(data.settings?.email_long_minutes || '30');
        setEmailShortThreshold(data.settings?.email_short_threshold || '600');
        setEmailMediumThreshold(data.settings?.email_medium_threshold || '1200');
        setContextBefore(data.settings?.context_before_minutes || '10');
        setContextAfter(data.settings?.context_after_minutes || '10');
      } catch (error) {
        console.error('Failed to load settings:', error);
      } finally {
        setIsLoading(false);
      }
    }
    loadSettings();
    refreshOutlookStatus();
  }, [refreshOutlookStatus]);

  // Save settings
  const saveSettings = useCallback(async () => {
    setIsSaving(true);
    setSaveMessage(null);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jira_url: jiraUrl,
          jira_pat: jiraPat,
          outlook_backend: outlookBackend,
          azure_client_id: azureClientId,
          azure_tenant_id: azureTenantId,
          placeholder_jira_issue: placeholderJiraIssue,
          include_tentative_meetings: includeTentative ? 'true' : 'false',
          email_short_minutes: emailShortMinutes,
          email_medium_minutes: emailMediumMinutes,
          email_long_minutes: emailLongMinutes,
          email_short_threshold: emailShortThreshold,
          email_medium_threshold: emailMediumThreshold,
          context_before_minutes: contextBefore,
          context_after_minutes: contextAfter,
        }),
      });
      setSaveMessage('Settings saved successfully');
      setTimeout(() => setSaveMessage(null), 3000);
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSaveMessage('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  }, [
    jiraUrl,
    jiraPat,
    placeholderJiraIssue,
    includeTentative,
    outlookBackend,
    azureClientId,
    azureTenantId,
    emailShortMinutes,
    emailMediumMinutes,
    emailLongMinutes,
    emailShortThreshold,
    emailMediumThreshold,
    contextBefore,
    contextAfter,
  ]);

  const startOutlookConnect = useCallback(async () => {
    setIsConnectingOutlook(true);
    setOutlookAuthMessage(null);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outlook_backend: outlookBackend,
          azure_client_id: azureClientId,
          azure_tenant_id: azureTenantId,
        }),
      });

      const res = await fetch('/api/outlook/auth/start', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        setOutlookAuthMessage(data.error || 'Failed to start sign-in');
        return;
      }
      setDeviceCode(data.user_code || null);
      setVerificationUri(data.verification_uri || null);
      setOutlookAuthMessage(data.message || null);
      setShowOutlookAuthDialog(true);
    } catch {
      setOutlookAuthMessage('Failed to start Microsoft sign-in');
    } finally {
      setIsConnectingOutlook(false);
    }
  }, [outlookBackend, azureClientId, azureTenantId]);

  const completeOutlookConnect = useCallback(async () => {
    setIsCompletingOutlook(true);
    setOutlookAuthMessage(null);
    try {
      const res = await fetch('/api/outlook/auth/complete', { method: 'POST' });
      const data = await res.json();
      if (data.pending) {
        setOutlookAuthMessage(data.message || 'Still waiting — finish sign-in in your browser.');
        return;
      }
      if (!data.success) {
        setOutlookAuthMessage(data.error || 'Sign-in failed');
        return;
      }
      setShowOutlookAuthDialog(false);
      setDeviceCode(null);
      setVerificationUri(null);
      setOutlookAuthMessage(data.message || 'Connected.');
      await refreshOutlookStatus();
    } catch {
      setOutlookAuthMessage('Sign-in failed');
    } finally {
      setIsCompletingOutlook(false);
    }
  }, [refreshOutlookStatus]);

  const disconnectOutlook = useCallback(async () => {
    setIsConnectingOutlook(true);
    try {
      await fetch('/api/outlook/auth/logout', { method: 'POST' });
      setOutlookAuthMessage('Signed out.');
      await refreshOutlookStatus();
    } catch {
      setOutlookAuthMessage('Failed to sign out');
    } finally {
      setIsConnectingOutlook(false);
    }
  }, [refreshOutlookStatus]);

  // Test Jira connection
  const testConnection = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/jira/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: jiraUrl,
          pat: jiraPat,
        }),
      });
      const data = await res.json();
      setTestResult({
        success: data.success,
        message: data.success ? data.message : (data.error || data.message),
      });
    } catch (error) {
      setTestResult({
        success: false,
        message: 'Failed to test connection',
      });
    } finally {
      setIsTesting(false);
    }
  }, [jiraUrl, jiraPat]);

  // Export JSON
  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const res = await fetch('/api/export');
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'keyword-rules.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export:', error);
    } finally {
      setIsExporting(false);
    }
  }, []);

  // Recalculate email durations
  const recalculateDurations = useCallback(async () => {
    setIsRecalculating(true);
    setRecalcResult(null);
    try {
      const res = await fetch('/api/entries/recalculate-durations', {
        method: 'POST',
      });
      const data = await res.json();
      setRecalcResult({
        success: data.success,
        message: data.success
          ? `Updated ${data.updated} entries, ${data.skipped} unchanged`
          : (data.error || 'Recalculation failed'),
      });
    } catch (error) {
      setRecalcResult({
        success: false,
        message: 'Failed to recalculate durations',
      });
    } finally {
      setIsRecalculating(false);
    }
  }, []);

  // Reset all entries
  const handleReset = useCallback(async () => {
    setIsResetting(true);
    try {
      await fetch('/api/reset-entries', { method: 'DELETE' });
      setShowResetConfirm(false);
    } finally {
      setIsResetting(false);
    }
  }, []);

  // Sync Favorites from Jira
  const syncFavorites = useCallback(async () => {
    setIsSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/favorites/sync', {
        method: 'POST',
      });
      const data = await res.json();
      setSyncResult({
        success: data.success,
        message: data.success
          ? `Synced ${data.inserted} new, ${data.updated} updated favorites (${data.total} total)`
          : (data.error || 'Sync failed'),
      });
    } catch (error) {
      setSyncResult({
        success: false,
        message: 'Failed to sync favorites',
      });
    } finally {
      setIsSyncing(false);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="container mx-auto p-8 lg:p-12 max-w-7xl flex items-center justify-center min-h-[50vh]">
        <IconLoader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-8 lg:p-12 max-w-7xl">
      {/* Header */}
      <div className="flex justify-between items-center mb-10">
        <h1 className="text-3xl font-bold">Settings</h1>
        <div className="flex items-center gap-3">
          {saveMessage && (
            <span className="text-base text-green-600">{saveMessage}</span>
          )}
          <Button onClick={saveSettings} disabled={isSaving}>
            {isSaving && <IconLoader2 className="h-5 w-5 mr-2 animate-spin" />}
            Save Settings
          </Button>
          <Link href="/">
            <Button variant="secondary">Back to Timekeeper</Button>
          </Link>
        </div>
      </div>

      <div className="space-y-8">
        {/* Jira Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Jira Connection</CardTitle>
            <p className="text-base text-slate-500 mt-2">
              Configure your Jira credentials to push time entries
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-3">
              <Label htmlFor="jira-url" className="text-base">Jira Instance URL</Label>
              <Input
                id="jira-url"
                placeholder="https://its-pro.ucsd.edu"
                value={jiraUrl}
                onChange={(e) => setJiraUrl(e.target.value)}
              />
              <p className="text-base text-slate-500">
                Your Jira instance URL
              </p>
            </div>

            <div className="grid gap-3">
              <Label htmlFor="jira-pat" className="text-base">Personal Access Token (PAT)</Label>
              <Input
                id="jira-pat"
                type="password"
                placeholder="••••••••••••••••"
                value={jiraPat}
                onChange={(e) => setJiraPat(e.target.value)}
              />
              <p className="text-base text-slate-500">
                Generate in Jira: Profile &rarr; Personal Access Tokens
              </p>
            </div>

            <div className="flex items-center gap-4 pt-2">
              <Button
                variant="secondary"
                onClick={testConnection}
                disabled={isTesting || !jiraUrl || !jiraPat}
              >
                {isTesting && <IconLoader2 className="h-5 w-5 mr-2 animate-spin" />}
                Test Connection
              </Button>

              {testResult && (
                <div className={`flex items-center gap-2 text-base ${testResult.success ? 'text-green-600' : 'text-red-600'}`}>
                  {testResult.success ? (
                    <IconCheck className="h-5 w-5" />
                  ) : (
                    <IconX className="h-5 w-5" />
                  )}
                  {testResult.message}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Outlook / Microsoft Graph */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Outlook Connection</CardTitle>
            <p className="text-base text-slate-500 mt-2">
              Import sent mail and calendar via Microsoft Graph (macOS and Windows) or desktop
              Outlook COM (Windows only).
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-3">
              <Label className="text-base">Connection method</Label>
              <Select value={outlookBackend} onValueChange={setOutlookBackend}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (COM on Windows, Graph elsewhere)</SelectItem>
                  <SelectItem value="graph">Microsoft Graph API</SelectItem>
                  <SelectItem value="com">Windows desktop Outlook (COM)</SelectItem>
                </SelectContent>
              </Select>
              {outlookStatus && (
                <p className="text-base text-slate-500">
                  Active backend: <span className="font-medium">{outlookStatus.backend}</span>
                  {outlookStatus.connected && outlookStatus.account
                    ? ` — signed in as ${outlookStatus.account}`
                    : outlookStatus.message
                      ? ` — ${outlookStatus.message}`
                      : ''}
                </p>
              )}
            </div>

            {(outlookBackend === 'graph' || outlookBackend === 'auto') && (
              <>
                <div className="grid gap-3">
                  <Label htmlFor="azure-client-id" className="text-base">
                    Azure Application (client) ID
                  </Label>
                  <Input
                    id="azure-client-id"
                    placeholder="00000000-0000-0000-0000-000000000000"
                    value={azureClientId}
                    onChange={(e) => setAzureClientId(e.target.value)}
                  />
                  <p className="text-base text-slate-500">
                    Register an app in Azure Portal with delegated permissions Mail.Read and
                    Calendars.Read. Enable public client flows for device-code sign-in.
                  </p>
                </div>

                <div className="grid gap-3">
                  <Label htmlFor="azure-tenant-id" className="text-base">
                    Tenant ID
                  </Label>
                  <Input
                    id="azure-tenant-id"
                    placeholder="common"
                    value={azureTenantId}
                    onChange={(e) => setAzureTenantId(e.target.value)}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-2">
                  <Button
                    variant="secondary"
                    onClick={startOutlookConnect}
                    disabled={isConnectingOutlook || !azureClientId}
                  >
                    {isConnectingOutlook && (
                      <IconLoader2 className="h-5 w-5 mr-2 animate-spin" />
                    )}
                    Connect Outlook
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={disconnectOutlook}
                    disabled={isConnectingOutlook || !outlookStatus?.connected}
                  >
                    Disconnect
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={refreshOutlookStatus}
                    disabled={isLoadingOutlook}
                  >
                    {isLoadingOutlook && (
                      <IconLoader2 className="h-5 w-5 mr-2 animate-spin" />
                    )}
                    Refresh status
                  </Button>
                </div>
              </>
            )}

            {outlookBackend === 'com' && (
              <p className="text-base text-slate-500">
                Uses installed Outlook on Windows. No Azure sign-in required. Save settings and
                import from the Keywords tab.
              </p>
            )}

            {outlookAuthMessage && (
              <p className="text-base text-slate-600">{outlookAuthMessage}</p>
            )}
          </CardContent>
        </Card>

        {/* Jira Favorites */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Jira Favorites</CardTitle>
            <p className="text-base text-slate-500 mt-2">
              Sync your favorite Jira issues from Tempo for quick time entry assignment
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <Button
                variant="secondary"
                onClick={syncFavorites}
                disabled={isSyncing || !jiraUrl || !jiraPat}
              >
                {isSyncing ? (
                  <IconLoader2 className="h-5 w-5 mr-2 animate-spin" />
                ) : (
                  <IconStar className="h-5 w-5 mr-2" />
                )}
                Load Favorites from Jira
              </Button>

              {syncResult && (
                <div className={`flex items-center gap-2 text-base ${syncResult.success ? 'text-green-600' : 'text-red-600'}`}>
                  {syncResult.success ? (
                    <IconCheck className="h-5 w-5" />
                  ) : (
                    <IconX className="h-5 w-5" />
                  )}
                  {syncResult.message}
                </div>
              )}
            </div>
            <p className="text-base text-slate-500">
              Requires Jira connection above. Favorites are fetched from Tempo and can be used
              as drop targets in the Review tab to quickly assign Jira issues to entries.
            </p>
          </CardContent>
        </Card>

        {/* Placeholder Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Placeholder Activity</CardTitle>
            <p className="text-base text-slate-500 mt-2">
              Entries without a Jira code are assigned to this issue so time can be re-assigned later
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-3">
              <Label htmlFor="placeholder-jira" className="text-base">Placeholder Jira Issue Key</Label>
              <Input
                id="placeholder-jira"
                placeholder="PPMO-537"
                value={placeholderJiraIssue}
                onChange={(e) => setPlaceholderJiraIssue(e.target.value)}
              />
              <p className="text-base text-slate-500">
                Emails and meetings with no matching keyword or route will be logged against this issue. Leave blank to disable (uncoded entries will have no Jira assignment).
              </p>
            </div>
            <div className="flex items-center justify-between pt-2 border-t">
              <div>
                <Label htmlFor="include-tentative" className="text-base">Include tentative meetings</Label>
                <p className="text-sm text-slate-500 mt-1">
                  Off by default. When on, meetings you marked Tentative are also imported. Declined meetings are always excluded.
                </p>
              </div>
              <button
                id="include-tentative"
                type="button"
                role="switch"
                aria-checked={includeTentative}
                onClick={() => setIncludeTentative(!includeTentative)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${includeTentative ? 'bg-blue-600' : 'bg-slate-200'}`}
              >
                <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${includeTentative ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Email Duration Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Email Duration</CardTitle>
            <p className="text-base text-slate-500 mt-2">
              Time logged for emails based on character count
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-3 gap-6">
              <div className="grid gap-3">
                <Label htmlFor="email-short" className="text-base">Short</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="email-short"
                    type="number"
                    min="5"
                    max="60"
                    step="5"
                    value={emailShortMinutes}
                    onChange={(e) => setEmailShortMinutes(e.target.value)}
                  />
                  <span className="text-base text-slate-500">min</span>
                </div>
                <p className="text-base text-slate-400">&lt; {emailShortThreshold} chars</p>
              </div>
              <div className="grid gap-3">
                <Label htmlFor="email-medium" className="text-base">Medium</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="email-medium"
                    type="number"
                    min="5"
                    max="60"
                    step="5"
                    value={emailMediumMinutes}
                    onChange={(e) => setEmailMediumMinutes(e.target.value)}
                  />
                  <span className="text-base text-slate-500">min</span>
                </div>
                <p className="text-base text-slate-400">{emailShortThreshold}-{emailMediumThreshold} chars</p>
              </div>
              <div className="grid gap-3">
                <Label htmlFor="email-long" className="text-base">Long</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="email-long"
                    type="number"
                    min="5"
                    max="60"
                    step="5"
                    value={emailLongMinutes}
                    onChange={(e) => setEmailLongMinutes(e.target.value)}
                  />
                  <span className="text-base text-slate-500">min</span>
                </div>
                <p className="text-base text-slate-400">&gt; {emailMediumThreshold} chars</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div className="grid gap-3">
                <Label htmlFor="short-threshold" className="text-base">Short/Medium Threshold</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="short-threshold"
                    type="number"
                    min="100"
                    max="2000"
                    step="100"
                    value={emailShortThreshold}
                    onChange={(e) => setEmailShortThreshold(e.target.value)}
                  />
                  <span className="text-base text-slate-500">chars</span>
                </div>
              </div>
              <div className="grid gap-3">
                <Label htmlFor="medium-threshold" className="text-base">Medium/Long Threshold</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="medium-threshold"
                    type="number"
                    min="200"
                    max="5000"
                    step="100"
                    value={emailMediumThreshold}
                    onChange={(e) => setEmailMediumThreshold(e.target.value)}
                  />
                  <span className="text-base text-slate-500">chars</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4 pt-4 border-t">
              <Button
                variant="secondary"
                onClick={recalculateDurations}
                disabled={isRecalculating}
              >
                {isRecalculating && <IconLoader2 className="h-5 w-5 mr-2 animate-spin" />}
                Recalculate Email Durations
              </Button>
              {recalcResult && (
                <div className={`flex items-center gap-2 text-base ${recalcResult.success ? 'text-green-600' : 'text-red-600'}`}>
                  {recalcResult.success ? (
                    <IconCheck className="h-5 w-5" />
                  ) : (
                    <IconX className="h-5 w-5" />
                  )}
                  {recalcResult.message}
                </div>
              )}
              <p className="text-base text-slate-500">
                Update existing entries with new duration settings
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Meeting Context Time */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Meeting Context Time</CardTitle>
            <p className="text-base text-slate-500 mt-2">
              Buffer time added before/after meetings to account for context switching. Set to 0 to disable.
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div className="grid gap-3">
                <Label htmlFor="context-before" className="text-base">Before Meeting</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="context-before"
                    type="number"
                    min="0"
                    max="30"
                    step="5"
                    value={contextBefore}
                    onChange={(e) => setContextBefore(e.target.value)}
                  />
                  <span className="text-base text-slate-500">min</span>
                </div>
              </div>
              <div className="grid gap-3">
                <Label htmlFor="context-after" className="text-base">After Meeting</Label>
                <div className="flex items-center gap-3">
                  <Input
                    id="context-after"
                    type="number"
                    min="0"
                    max="30"
                    step="5"
                    value={contextAfter}
                    onChange={(e) => setContextAfter(e.target.value)}
                  />
                  <span className="text-base text-slate-500">min</span>
                </div>
              </div>
            </div>
            <p className="text-base text-slate-500">
              Time entries will show duration as &quot;Xm + Ym&quot; when context time is added
            </p>
          </CardContent>
        </Card>

        {/* Export */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Export Configuration</CardTitle>
            <p className="text-base text-slate-500 mt-2">
              Download your projects, task types, and keyword rules as JSON
            </p>
          </CardHeader>
          <CardContent>
            <Button variant="secondary" onClick={handleExport} disabled={isExporting}>
              {isExporting ? (
                <IconLoader2 className="h-5 w-5 mr-2 animate-spin" />
              ) : (
                <IconDownload className="h-5 w-5 mr-2" />
              )}
              Export JSON
            </Button>
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-xl text-red-600">Danger Zone</CardTitle>
            <p className="text-base text-slate-500 mt-2">
              Destructive actions that cannot be undone
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-4 border border-red-200 rounded-lg">
              <div>
                <p className="font-medium text-base">Reset All Entries</p>
                <p className="text-sm text-slate-500">Delete all time entries, imported sources, and unassigned keywords.</p>
              </div>
              <Button
                variant="destructive"
                onClick={() => setShowResetConfirm(true)}
              >
                <IconTrash className="h-5 w-5 mr-2" />
                Reset Entries
              </Button>
            </div>
          </CardContent>
        </Card>

      </div>

      {/* Microsoft sign-in (device code) */}
      <Dialog open={showOutlookAuthDialog} onOpenChange={setShowOutlookAuthDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-xl">Sign in to Microsoft 365</DialogTitle>
            <DialogDescription className="text-base pt-2 space-y-3">
              {verificationUri && (
                <p>
                  Open{' '}
                  <a
                    href={verificationUri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 underline"
                  >
                    {verificationUri}
                  </a>{' '}
                  and enter the code below.
                </p>
              )}
              {deviceCode && (
                <p className="font-mono text-2xl font-bold tracking-widest text-slate-800">
                  {deviceCode}
                </p>
              )}
              {outlookAuthMessage && <p>{outlookAuthMessage}</p>}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-3 pt-4">
            <Button variant="secondary" onClick={() => setShowOutlookAuthDialog(false)}>
              Cancel
            </Button>
            <Button onClick={completeOutlookConnect} disabled={isCompletingOutlook}>
              {isCompletingOutlook && <IconLoader2 className="h-5 w-5 mr-2 animate-spin" />}
              I&apos;ve signed in
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reset Confirmation Dialog */}
      <Dialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-xl">Reset All Entries?</DialogTitle>
            <DialogDescription className="text-base pt-2">
              This will permanently delete all time entries, imported sources (emails and meetings), and unassigned keywords. Project and task-type configuration will be preserved. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-3 pt-4">
            <Button variant="secondary" onClick={() => setShowResetConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReset} disabled={isResetting}>
              {isResetting && <IconLoader2 className="h-5 w-5 mr-2 animate-spin" />}
              Reset All Entries
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
