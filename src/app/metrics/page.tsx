'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { CalendarJiraMapping, getMappedJiraIssue, getTempoCoverageForEntries, TempoCoverage, TempoWorklog } from '@/lib/tempo-match';
import { buildTempoByDay } from '@/lib/stats';

interface ApiEntry {
  id: number;
  source_type: 'email' | 'meeting' | 'manual';
  title: string;
  date: string;
  duration_minutes: number;
  context_minutes: number;
  jira_issue: string | null;
  jira_name: string | null;
  status: 'pending' | 'pushed' | 'excluded';
  jira_worklog_id?: string | null;
}

function toIso(d: Date) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function mondayOf(offset: number): Date {
  const d = new Date(); const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff + offset * 7); d.setHours(0, 0, 0, 0); return d;
}
const mins = (e: ApiEntry) => e.duration_minutes + (e.context_minutes || 0);
const toH = (m: number) => Math.round((m / 60) * 10) / 10;

interface IssueRow { key: string; name: string; hours: number; status: 'pushed' | 'hascode' | 'need' | 'block'; }

function dayKey(dateIso: string): string {
  const d = new Date(dateIso.substring(0, 10) + 'T00:00:00');
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

export default function MetricsPage() {
  const [entries, setEntries] = useState<ApiEntry[]>([]);
  const [coverage, setCoverage] = useState<Record<number, TempoCoverage>>({});
  const [mappings, setMappings] = useState<CalendarJiraMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    const mon = mondayOf(weekOffset);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    try {
      const [res, tempoRes, mappingsRes] = await Promise.all([
        fetch(`/api/entries?startDate=${toIso(mon)}&endDate=${toIso(sun)}`),
        fetch('/api/jira/tempo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dateFrom: toIso(mon), dateTo: toIso(sun) }),
        }),
        fetch('/api/calendar-mappings'),
      ]);
      const data = await res.json();
      const weekEntries: ApiEntry[] = data.entries || [];

      let calendarMappings: CalendarJiraMapping[] = [];
      try {
        const mappingsData = await mappingsRes.json();
        calendarMappings = mappingsData.mappings || [];
      } catch { calendarMappings = []; }
      setMappings(calendarMappings);

      let tempoByDay: Record<string, TempoWorklog[]> = {};
      try {
        const tempoData = await tempoRes.json();
        if (tempoData.success && Array.isArray(tempoData.entries)) {
          tempoByDay = buildTempoByDay(
            tempoData.entries.map((t: { issueKey: string; minutes: number; comment?: string; date: string }) => ({
              issueKey: t.issueKey || '', minutes: t.minutes || 0, comment: t.comment || '', date: t.date || '',
            }))
          );
        }
      } catch { /* preview ignore tempo */ }

      const byDay: Record<string, ApiEntry[]> = {};
      for (const entry of weekEntries) {
        if (entry.status === 'excluded') continue;
        const k = dayKey(entry.date);
        (byDay[k] = byDay[k] || []).push(entry);
      }
      const coverageByDay: Record<string, Record<number, TempoCoverage>> = {};
      for (const [k, de] of Object.entries(byDay)) {
        coverageByDay[k] = getTempoCoverageForEntries(de, tempoByDay[k] || [], calendarMappings);
      }
      const coverageMap: Record<number, TempoCoverage> = {};
      for (const entry of weekEntries) {
        if (entry.status === 'excluded') continue;
        coverageMap[entry.id] = coverageByDay[dayKey(entry.date)]?.[entry.id] || 'none';
      }
      setEntries(weekEntries);
      setCoverage(coverageMap);
    } catch { setEntries([]); setCoverage({}); }
    finally { setLoading(false); }
  }, [weekOffset]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const coverageOf = (e: ApiEntry): TempoCoverage => (e.status === 'pushed' ? 'full' : coverage[e.id] || 'none');
  const hasAssignable = (e: ApiEntry): boolean =>
    Boolean(e.jira_issue || getMappedJiraIssue(e, mappings));
  const isPushed = (e: ApiEntry): boolean =>
    e.status !== 'excluded' && (e.status === 'pushed' || (e.status === 'pending' && coverageOf(e) !== 'none'));

  const totalCaptured = toH(entries.filter((e) => e.status !== 'excluded').reduce((s, e) => s + mins(e), 0));
  const pushedH = toH(entries.filter((e) => isPushed(e)).reduce((s, e) => s + mins(e), 0));
  const reviewH = toH(entries.filter((e) => e.status !== 'excluded' && e.status === 'pending' && coverageOf(e) === 'none' && !hasAssignable(e)).reduce((s, e) => s + mins(e), 0));
  const pushedIssues = new Set(entries.filter((e) => isPushed(e) && (e.jira_issue || getMappedJiraIssue(e, mappings)?.jiraIssue)).map((e) => e.jira_issue || getMappedJiraIssue(e, mappings)?.jiraIssue)).size;

  // Hours by issue
  const issueMap = new Map<string, { name: string; mins: number; status: 'pushed' | 'hascode' | 'need' | 'block' }>();
  entries.forEach((e) => {
    if (e.status === 'excluded') return;
    const key = e.jira_issue || getMappedJiraIssue(e, mappings)?.jiraIssue || '';
    if (!key) return;
    const cur = issueMap.get(key) || { name: e.jira_name || key, mins: 0, status: 'need' as const };
    cur.mins += mins(e);
    if (isPushed(e)) cur.status = 'pushed';
    else if (cur.status !== 'pushed') cur.status = 'hascode';
    issueMap.set(key, cur);
  });
  const issues: IssueRow[] = Array.from(issueMap.entries())
    .map(([key, v]) => ({ key, name: v.name, hours: toH(v.mins), status: v.status }))
    .sort((a, b) => b.hours - a.hours);
  const maxIssueH = Math.max(1, ...issues.map((i) => i.hours));

  // Sources
  const calMins = entries.filter((e) => e.source_type === 'meeting').reduce((s, e) => s + mins(e), 0);
  const emailMins = entries.filter((e) => e.source_type === 'email').reduce((s, e) => s + mins(e), 0);
  const manualMins = entries.filter((e) => e.source_type === 'manual').reduce((s, e) => s + mins(e), 0);
  const calCount = entries.filter((e) => e.source_type === 'meeting').length;
  const emailCount = entries.filter((e) => e.source_type === 'email').length;

  const statusMeta: Record<IssueRow['status'], { color: string; bg: string; border: string; label: string }> = {
    pushed: { color: 'var(--success-600)', bg: 'var(--success-50)', border: '#bfe5cd', label: 'pushed' },
    hascode: { color: 'var(--blue-600)', bg: 'var(--blue-50)', border: 'var(--blue-200)', label: 'has code' },
    need: { color: 'var(--gold-600)', bg: 'var(--gold-50)', border: '#eed9a0', label: 'needs code' },
    block: { color: 'var(--danger-600)', bg: 'var(--danger-50)', border: '#f2c2bf', label: 'blocked' },
  };

  if (loading) {
    return <div className="metrics-page"><p style={{ color: 'var(--slate-400)', fontSize: 14 }}>Loading metrics…</p></div>;
  }

  return (
    <div className="metrics-page">
      <h2 style={{ fontSize: 28, fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>Metrics</h2>
      <p style={{ color: 'var(--slate-500)', fontSize: 14.5, marginBottom: 10 }}>Where your time went.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={'btn btn-sm ' + (weekOffset === 0 ? 'btn-navy' : 'btn-secondary')} onClick={() => setWeekOffset(0)}>This week</button>
        <button className={'btn btn-sm ' + (weekOffset === -1 ? 'btn-navy' : 'btn-secondary')} onClick={() => setWeekOffset(-1)}>Last week</button>
      </div>

      {/* Summary boxes */}
      <div className="metrics-summary">
        <div className="card" style={{ padding: 24, background: 'var(--slate-100)' }}>
          <div style={{ color: 'var(--navy)', fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>Total captured</div>
          <div style={{ fontSize: 34, fontWeight: 700, color: 'var(--navy)', margin: '8px 0' }}>{totalCaptured}h</div>
          <div style={{ color: 'var(--slate-400)', fontSize: 14 }}>{entries.filter((e) => e.status !== 'excluded').length} {entries.filter((e) => e.status !== 'excluded').length === 1 ? 'entry' : 'entries'}</div>
        </div>
        <div className="card" style={{ padding: 24, background: 'var(--success-50)' }}>
          <div style={{ color: 'var(--navy)', fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>Pushed to Jira</div>
          <div style={{ fontSize: 34, fontWeight: 700, color: 'var(--navy)', margin: '8px 0' }}>{pushedH}h</div>
          <div style={{ color: 'var(--slate-400)', fontSize: 14 }}>{pushedIssues} {pushedIssues === 1 ? 'issue' : 'issues'}</div>
        </div>
        <div className="card" style={{ padding: 24, background: 'var(--gold-50)' }}>
          <div style={{ color: 'var(--navy)', fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>Needs review</div>
          <div style={{ fontSize: 34, fontWeight: 700, color: 'var(--navy)', margin: '8px 0' }}>{reviewH}h</div>
          <div style={{ fontSize: 14, marginTop: 2 }}>
            <Link href="/" className="help-link" style={{ fontWeight: 600, color: "var(--navy)", borderBottomColor: "var(--slate-300)" }}>Review now →</Link>
          </div>
        </div>
      </div>

      {/* Hours by issue */}
      <div className="metrics-columns">
        {issues.length > 0 && (
          <div className="card">
            <h3 style={{ fontWeight: 700, color: 'var(--navy)' }}>Hours by issue</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {issues.map((iss) => {
                const m = statusMeta[iss.status];
                return (
                  <div key={iss.key}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 14, marginBottom: 6 }}>
                      <span className="issue-key">{iss.key}</span>
                      <span style={{ color: 'var(--navy)', fontWeight: 600 }}>
                        <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: m.color, marginRight: 6, verticalAlign: 'middle' }}></span>
                        {iss.hours}h · {m.label}
                      </span>
                    </div>
                    <div className="bar" style={{ width: (iss.hours / maxIssueH * 100) + '%', background: m.bg, border: '1px solid ' + m.border }} />
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 14, color: 'var(--slate-400)', marginTop: 16 }}>
              Blocked and needs-code hours need attention — <Link href="/" className="help-link" style={{ color: 'var(--navy)', borderBottomColor: 'var(--slate-300)' }}>Review now</Link>
            </div>
          </div>
        )}

        {/* Where your time came from */}
        <div className="card" style={issues.length === 0 ? { gridColumn: '1 / -1' } : undefined}>
          <h3 style={{ fontWeight: 700, color: 'var(--navy)' }}>Where your time came from</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[
              { pill: 'sp-gray', label: 'Calendar', h: toH(calMins), count: calCount, barColor: 'var(--slate-200)', barBorder: 'var(--slate-300)' },
              { pill: 'sp-gray', label: 'Email', h: toH(emailMins), count: emailCount, barColor: 'var(--slate-200)', barBorder: 'var(--slate-300)' },
              { pill: 'sp-gray', label: 'Manual', h: toH(manualMins), count: entries.filter((e) => e.source_type === 'manual').length, barColor: 'var(--slate-200)', barBorder: 'var(--slate-300)' },
            ].map((s, i) => {
              const maxH = Math.max(0.1, toH(calMins), toH(emailMins), toH(manualMins));
              return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className={'status-pill ' + s.pill}>{s.label}</span>
                <span style={{ fontSize: 14, color: 'var(--navy)', minWidth: 120 }}>{s.h}h{s.count > 0 ? ' - ' + s.count + ' ' + (s.count === 1 ? 'entry' : 'entries') : ''}</span>
                {s.h > 0 && <div className="bar" style={{ background: s.barColor, border: '1px solid ' + s.barBorder, width: Math.max(8, (s.h / maxH) * 100) + '%', maxWidth: '70%' }} />}
              </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
