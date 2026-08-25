'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

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

export default function MetricsPage() {
  const [entries, setEntries] = useState<ApiEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    const mon = mondayOf(0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    try {
      const res = await fetch(`/api/entries?startDate=${toIso(mon)}&endDate=${toIso(sun)}`);
      const data = await res.json();
      setEntries(data.entries || []);
    } catch { setEntries([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const totalCaptured = toH(entries.reduce((s, e) => s + mins(e), 0));
  const pushedH = toH(entries.filter((e) => e.status === 'pushed').reduce((s, e) => s + mins(e), 0));
  const reviewH = toH(entries.filter((e) => e.status === 'pending').reduce((s, e) => s + mins(e), 0));
  const pushedIssues = new Set(entries.filter((e) => e.status === 'pushed' && e.jira_issue).map((e) => e.jira_issue)).size;

  // Hours by issue
  const issueMap = new Map<string, { name: string; mins: number; status: 'pushed' | 'hascode' | 'need' | 'block' }>();
  entries.forEach((e) => {
    if (!e.jira_issue) return;
    const cur = issueMap.get(e.jira_issue) || { name: e.jira_name || e.jira_issue, mins: 0, status: 'need' as const };
    cur.mins += mins(e);
    if (e.status === 'pushed') cur.status = 'pushed';
    else if (e.jira_issue && cur.status !== 'pushed') cur.status = e.status === 'excluded' ? 'block' : 'hascode';
    issueMap.set(e.jira_issue, cur);
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
    return <div style={{ maxWidth: 760, margin: '0 auto' }}><p style={{ color: 'var(--slate-400)', fontSize: 13 }}>Loading metrics…</p></div>;
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>Metrics</h2>
      <p style={{ color: 'var(--slate-500)', fontSize: 13, marginBottom: 18 }}>Where your time went this week.</p>

      {/* Summary boxes */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 18 }}>
        <div className="card" style={{ padding: 18, background: 'var(--slate-100)' }}>
          <div style={{ color: 'var(--navy)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>Total captured</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', margin: '4px 0' }}>{totalCaptured}h</div>
          <div style={{ color: 'var(--slate-400)', fontSize: 13 }}>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</div>
        </div>
        <div className="card" style={{ padding: 18, background: 'var(--success-50)' }}>
          <div style={{ color: 'var(--success-600)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>Pushed to Jira</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--success-600)', margin: '4px 0' }}>{pushedH}h</div>
          <div style={{ color: 'var(--slate-400)', fontSize: 13 }}>{pushedIssues} {pushedIssues === 1 ? 'issue' : 'issues'}</div>
        </div>
        <div className="card" style={{ padding: 18, background: 'var(--gold-50)' }}>
          <div style={{ color: 'var(--gold-600)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>Needs review</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--gold-600)', margin: '4px 0' }}>{reviewH}h</div>
          <div style={{ fontSize: 13, marginTop: 2 }}>
            <Link href="/" className="help-link" style={{ fontWeight: 600 }}>Review now →</Link>
          </div>
        </div>
      </div>

      {/* Hours by issue */}
      {issues.length > 0 && (
        <div className="card" style={{ padding: 18, marginBottom: 14 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', marginBottom: 12 }}>Hours by issue</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {issues.map((iss) => {
              const m = statusMeta[iss.status];
              return (
                <div key={iss.key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, marginBottom: 4 }}>
                    <span className="issue-key">{iss.key}</span>
                    <span style={{ color: m.color, fontWeight: 600 }}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: m.color, marginRight: 5, verticalAlign: 'middle' }}></span>
                      {iss.hours}h · {m.label}
                    </span>
                  </div>
                  <div className="bar" style={{ width: (iss.hours / maxIssueH * 100) + '%', background: m.bg, border: '1px solid ' + m.border }} />
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 13, color: 'var(--slate-400)', marginTop: 12 }}>
            Blocked and needs-code hours need attention — <Link href="/" className="help-link">Review now</Link>
          </div>
        </div>
      )}

      {/* Where your time came from */}
      <div className="card" style={{ padding: 18 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', marginBottom: 12 }}>Where your time came from</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            { pill: 'sp-navy', label: 'Calendar', h: toH(calMins), count: calCount, barColor: 'var(--blue-50)', barBorder: 'var(--blue-200)' },
            { pill: 'sp-gold', label: 'Email', h: toH(emailMins), count: emailCount, barColor: 'var(--gold-50)', barBorder: '#eed9a0' },
            { pill: 'sp-gray', label: 'Manual', h: toH(manualMins), count: entries.filter((e) => e.source_type === 'manual').length, barColor: 'var(--slate-200)', barBorder: 'var(--slate-200)' },
          ].map((s, i) => {
            const maxH = Math.max(0.1, toH(calMins), toH(emailMins), toH(manualMins));
            return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className={'status-pill ' + s.pill}>{s.label}</span>
              <span style={{ fontSize: 13, color: 'var(--slate-500)', minWidth: 80 }}>{s.h}h{s.count > 0 ? ' - ' + s.count + ' ' + (s.count === 1 ? 'entry' : 'entries') : ''}</span>
              {s.h > 0 && <div className="bar" style={{ background: s.barColor, border: '1px solid ' + s.barBorder, width: Math.max(8, (s.h / maxH) * 180) + 'px', height: 8 }} />}
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
