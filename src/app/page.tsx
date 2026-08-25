'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AllocationCard, AllocRow, fmtHrsMin } from '@/components/review/AllocationCard';
import { CalendarSection } from '@/components/review/CalendarSection';
import { AddProjectModal } from '@/components/review/AddProjectModal';
import { useSharedData } from '@/lib/data-context';

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

export default function ReviewPage() {
  const { favorites, refreshFavorites } = useSharedData();
  const [rows, setRows] = useState<AllocRow[]>([]);
  const [totalHours, setTotalHours] = useState(8);
  const [meetingsHours, setMeetingsHours] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [weekStats, setWeekStats] = useState({ captured: 0, meetings: 0, pushed: 0, review: 0, autoCoded: 0, total: 0 });
  const [hasData, setHasData] = useState(false);
  const autoPopulated = useRef(false);

  const activeKeys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const unassigned = useMemo(
    () => favorites.filter((f) => !activeKeys.has(f.jira_key)).map((f) => ({ id: f.id, key: f.jira_key, name: f.short_name || f.jira_name })),
    [favorites, activeKeys]
  );

  const fetchStats = useCallback(async () => {
    setLoading(true);
    const mon = mondayOf(0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const today = toIso(new Date());
    try {
      const [weekRes, todayRes] = await Promise.all([
        fetch(`/api/entries?startDate=${toIso(mon)}&endDate=${toIso(sun)}`),
        fetch(`/api/entries?date=${today}`),
      ]);
      const weekData = await weekRes.json();
      const todayData = await todayRes.json();
      const weekEntries: ApiEntry[] = weekData.entries || [];
      const todayEntries: ApiEntry[] = todayData.entries || [];
      const weekHasData = weekEntries.length > 0;
      setHasData(weekHasData);

      setWeekStats({
        captured: toH(weekEntries.reduce((s, e) => s + mins(e), 0)),
        meetings: toH(weekEntries.filter((e) => e.source_type === 'meeting').reduce((s, e) => s + mins(e), 0)),
        pushed: toH(weekEntries.filter((e) => e.status === 'pushed').reduce((s, e) => s + mins(e), 0)),
        review: toH(weekEntries.filter((e) => e.status === 'pending').reduce((s, e) => s + mins(e), 0)),
        autoCoded: weekEntries.filter((e) => e.jira_issue).length,
        total: weekEntries.length,
      });

      // Auto-fill meetings hours from today's calendar
      const todayMeetings = todayEntries.filter((e) => e.source_type === 'meeting').reduce((s, e) => s + mins(e), 0);
      setMeetingsHours(toH(todayMeetings));

      // Auto-populate allocation bars from today's entries (only once)
      if (!autoPopulated.current && todayEntries.length > 0) {
        autoPopulated.current = true;
        const issueMap = new Map<string, { name: string; mins: number }>();
        todayEntries.forEach((e) => {
          if (!e.jira_issue) return;
          const cur = issueMap.get(e.jira_issue) || { name: e.jira_name || e.jira_issue, mins: 0 };
          cur.mins += mins(e);
          issueMap.set(e.jira_issue, cur);
        });
        if (issueMap.size > 0) {
          const totalIssueMins = Array.from(issueMap.values()).reduce((s, v) => s + v.mins, 0);
          const newRows: AllocRow[] = Array.from(issueMap.entries()).map(([key, v]) => ({
            key,
            name: v.name,
            pct: totalIssueMins > 0 ? Math.round((v.mins / totalIssueMins) * 100 * 2) / 2 : 0,
            locked: false,
          }));
          setRows(newRows);
        }
      }
    } catch {
      setHasData(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Pre-populate favorites as allocation rows if user has favorites but no rows yet
  useEffect(() => {
    if (!autoPopulated.current && !loading && rows.length === 0 && favorites.length > 0 && !hasData) {
      autoPopulated.current = true;
      const top = favorites.slice(0, 3);
      const even = Math.round(100 / top.length * 2) / 2;
      setRows(top.map((f, i) => ({
        key: f.jira_key,
        name: f.short_name || f.jira_name,
        pct: i === top.length - 1 ? Math.round((100 - even * (top.length - 1)) * 2) / 2 : even,
        locked: false,
      })));
    }
  }, [favorites, rows.length, loading, hasData]);

  const onAddToActive = useCallback((key: string, name: string) => {}, []);
  const onRemoveFromActive = useCallback((key: string, name: string) => {}, []);

  const onDeleteUnassigned = useCallback(async (id: number, key: string) => {
    try {
      await fetch(`/api/favorites/${id}`, { method: 'DELETE' });
      await refreshFavorites();
    } catch {
      // ignore
    }
  }, [refreshFavorites]);

  const onAddedProject = useCallback((key: string, name: string) => {
    refreshFavorites();
  }, [refreshFavorites]);

  const todayLabel = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }, []);

  if (loading) {
    return (
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>Review</h2>
        <p style={{ color: 'var(--slate-400)', fontSize: 13, marginBottom: 14 }}>Loading your week...</p>
        <div style={{ background: 'var(--slate-100)', borderRadius: 12, padding: 40, textAlign: 'center' }}>
          <div style={{ color: 'var(--slate-400)', fontSize: 14 }}>Gathering entries from your calendar and Jira...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>Review</h2>
      <p style={{ color: 'var(--slate-500)', fontSize: 13, marginBottom: 14 }}>
        ETTA auto-gathers from Outlook and Jira. Review your day below, then push to Jira.
      </p>

      {!hasData && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: 'var(--blue-50)', border: '1px solid var(--blue-200)', borderRadius: 12, padding: 16, marginBottom: 18 }}>
          <div style={{ flexShrink: 0, marginTop: 1, color: 'var(--blue-600)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--slate-500)' }}>
            <b style={{ color: 'var(--navy)' }}>No calendar data yet.</b> Connect Outlook in Settings to fill your weekly calendar automatically. You can still add projects and allocate time below.
          </div>
        </div>
      )}

      {hasData && weekStats.total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--blue-50)', border: '1px solid var(--blue-200)', borderRadius: 10, padding: '10px 14px', marginBottom: 18 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--blue-600)' }}></span>
          <span style={{ fontSize: 13.5, color: 'var(--slate-500)' }}>
            ETTA auto-coded <b>{weekStats.autoCoded} of {weekStats.total}</b> entries this week from your rules.
          </span>
        </div>
      )}

      <AllocationCard
        rows={rows}
        setRows={setRows}
        totalHours={totalHours}
        meetingsHours={meetingsHours}
        setTotalHours={setTotalHours}
        setMeetingsHours={setMeetingsHours}
        unassigned={unassigned}
        onAddToActive={onAddToActive}
        onRemoveFromActive={onRemoveFromActive}
        onDeleteUnassigned={onDeleteUnassigned}
        onAddProject={() => setAddOpen(true)}
        dateLabel={todayLabel}
      />

      {/* Summary strip */}
      <div style={{ marginTop: 20, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>Captured from calendar &amp; email</h3>
          <span style={{ fontSize: 13, color: 'var(--slate-400)' }}>Auto-gathered by ETTA</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, background: 'var(--slate-100)', borderRadius: 8, padding: '8px 14px' }}>
          {[
            { label: 'Auto-gathered', val: weekStats.captured + 'h', color: 'var(--blue-600)' },
            { label: 'Meetings', val: weekStats.meetings + 'h', color: 'var(--navy)' },
            { label: 'Pushed', val: weekStats.pushed + 'h', color: 'var(--success-600)' },
            { label: 'To review', val: weekStats.review + 'h', color: 'var(--gold-600)' },
          ].map((s, i) => (
            <div key={i} style={{ textAlign: 'center', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {i > 0 && <div style={{ width: 1, height: 24, background: 'var(--slate-200)', marginRight: 14 }}></div>}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em', color: s.color }}>{s.label}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: s.color, marginLeft: 4 }}>{s.val}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <CalendarSection />

      <AddProjectModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={onAddedProject}
        existingKeys={favorites.map((f) => f.jira_key)}
      />
    </div>
  );
}