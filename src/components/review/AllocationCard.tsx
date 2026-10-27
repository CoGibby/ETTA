'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';

export interface AllocRow {
  key: string;
  name: string;
  pct: number;
  locked: boolean;
  comment?: string;
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}
function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}
export function fmtHrsMin(h: number): string {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (hh === 0) return mm + 'm';
  if (mm === 0) return hh + 'h';
  return hh + 'h ' + mm + 'm';
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '...';
}

const LockIcon = () => (
  <svg width="11" height="12" viewBox="0 0 12 13" fill="none">
    <rect x="2" y="6" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M4 6V4a2 2 0 014 0v2" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);
const UnlockIcon = () => (
  <svg width="11" height="12" viewBox="0 0 12 13" fill="none">
    <rect x="2" y="6" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M4 6V4a2 2 0 014 0" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const CommentIcon = ({ hasComment }: { hasComment: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M2 3h12v8H6l-3 2.5V11H2V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    {hasComment && <circle cx="13" cy="3" r="3" fill="var(--danger)" stroke="#fff" strokeWidth="1" />}
  </svg>
);

interface Props {
  rows: AllocRow[];
  setRows: (updater: (prev: AllocRow[]) => AllocRow[]) => void;
  totalHours: number;
  meetingsHours: number;
  tempoHours?: number;
  historySuggestions?: { key: string; name: string; score: number }[];
  setTotalHours: (n: number) => void;
  unassigned: { id: number; key: string; name: string }[];
  onAddToActive: (key: string, name: string) => void;
  onRemoveFromActive: (key: string, name: string) => void;
  onDeleteUnassigned: (id: number, key: string) => void;
  onAddProject: () => void;
  selectedDateKey?: string;
  estimates?: Record<string, { remaining: number; hasEstimate: boolean; issueType: string; isOpen: boolean; statusName: string }>;
  onPushed?: () => void | Promise<void>;
}

export function AllocationCard({
  rows, setRows, totalHours, meetingsHours, tempoHours, setTotalHours,
  historySuggestions,
  unassigned, onAddToActive, onRemoveFromActive, onDeleteUnassigned, onAddProject,
  selectedDateKey, estimates,
  onPushed,
}: Props) {
  const workTime = Math.max(0, totalHours - meetingsHours - (tempoHours || 0));
  const suggestions = useMemo(() => historySuggestions || [], [historySuggestions]);
  const anyLocked = rows.some((r) => r.locked);
  const dragRef = useRef<{ targetKey: string; trackEl: HTMLElement } | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushMsg, setPushMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pushProgress, setPushProgress] = useState<{ current: number; total: number } | null>(null);
  const [commentKey, setCommentKey] = useState<string | null>(null);
  const [openWarnings, setOpenWarnings] = useState<Set<string>>(new Set());
  const [openClosed, setOpenClosed] = useState<Set<string>>(new Set());
  const warningKey = useCallback((key: string) => selectedDateKey ? selectedDateKey + ':' + key : key, [selectedDateKey]);

  useEffect(() => {
    setOpenWarnings(new Set());
    setOpenClosed(new Set());
  }, [selectedDateKey]);

  const setComment = useCallback((key: string, text: string) => {
    setRows((prev) => prev.map((r) => r.key === key ? { ...r, comment: text } : r));
  }, [setRows]);

  // Propose a day split from recent Jira activity: locked rows keep their exact
  // share, the rest is distributed across active rows and recent issues in
  // 15-minute increments (the jira-worklogs skill's rounding convention).
  const applyFill = useCallback(() => {
    const totalMinutes = Math.round(workTime * 60);
    const usable = Math.floor(totalMinutes / 15) * 15;
    if (usable <= 0) return;

    const lockedRows = rows.filter((r) => r.locked && r.key.trim());
    const lockedMinutes = lockedRows.reduce((s, r) => s + (r.pct / 100) * totalMinutes, 0);
    const remaining = Math.max(0, usable - Math.round(lockedMinutes));
    if (remaining < 15) return;

    const scoreByKey = new Map(suggestions.map((c) => [c.key.toUpperCase(), c.score]));
    const seen = new Set<string>();
    const existingUnlocked = rows.filter((r) => !r.locked && r.key.trim());
    existingUnlocked.forEach((r) => seen.add(r.key.toUpperCase()));

    type FillCandidate = { key: string; name: string; score: number; comment?: string };
    const candidates: FillCandidate[] = existingUnlocked.map((r) => ({
      key: r.key,
      name: r.name,
      score: scoreByKey.get(r.key.toUpperCase()) ?? 1,
      comment: r.comment,
    }));
    for (const suggestion of suggestions) {
      if (candidates.length >= 6) break;
      if (seen.has(suggestion.key.toUpperCase())) continue;
      seen.add(suggestion.key.toUpperCase());
      candidates.push({ key: suggestion.key, name: suggestion.name, score: suggestion.score });
    }
    if (candidates.length === 0) return;

    const sumScore = candidates.reduce((s, c) => s + c.score, 0);
    if (sumScore <= 0) return;
    const bases = candidates.map((c) => Math.floor((remaining * (c.score / sumScore)) / 15) * 15);
    const remainders = candidates.map((c, i) => remaining * (c.score / sumScore) - bases[i]);
    let leftover = remaining - bases.reduce((s, b) => s + b, 0);
    const order = candidates
      .map((_, i) => i)
      .sort((a, b) => remainders[b] - remainders[a] || candidates[b].score - candidates[a].score);
    let orderIndex = 0;
    while (leftover >= 15) {
      bases[order[orderIndex % order.length]] += 15;
      leftover -= 15;
      orderIndex += 1;
    }

    const filled = candidates
      .map((c, i) => ({ candidate: c, minutes: bases[i] }))
      .filter((item) => item.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .map((item) => ({
        key: item.candidate.key,
        name: item.candidate.name,
        pct: Math.round((item.minutes / totalMinutes) * 100 * 1000) / 1000,
        locked: false,
        comment: item.candidate.comment,
      }));
    if (filled.length === 0) return;

    setRows(() => [...lockedRows, ...filled]);
  }, [rows, workTime, suggestions, setRows]);

  const pushToJira = () => {
    if (rows.length === 0 || workTime <= 0) return;
    setShowConfirm(true);
  };

  const doPush = async () => {
    if (rows.length === 0 || workTime <= 0) return;
    setShowConfirm(false);
    setPushing(true);
    setPushMsg(null);
    setPushProgress({ current: 0, total: rows.filter(function(r) { return (r.pct / 100) * workTime > 0; }).length });
    try {
      const worklogs = rows.map((r) => ({
        issueKey: r.key,
        timeSpentMinutes: Math.round((r.pct / 100) * workTime * 60),
        startedDate: selectedDateKey || new Date().toISOString().split('T')[0],
        comment: r.comment || r.name,
      })).filter((w) => w.timeSpentMinutes > 0);

      if (worklogs.length === 0) {
        setPushMsg({ ok: false, text: 'No time to push.' });
        return;
      }

      const res = await fetch('/api/jira/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryIds: [], worklogs }),
      });
      const data = await res.json();

      // Tempo reconciliation (splits against time already logged in Tempo):
      const skippedCount = Array.isArray(data.skippedEntries) ? data.skippedEntries.length : (data.skipped || 0);
      const partialCount = Array.isArray(data.partial) ? data.partial.length : 0;

      if (data.success) {
        let text = `Pushed ${data.pushed} entr${data.pushed === 1 ? 'y' : 'ies'} to Jira.`;
        if (partialCount > 0 && data.pushed === 0) {
          text = `Pushed the remaining time not already allocated in Tempo.`;
        } else if (skippedCount > 0) {
          text += ` ${skippedCount} ${skippedCount === 1 ? 'entry' : 'entries'} already allocated in Tempo.`;
        }
        setPushMsg({ ok: true, text });
        await onPushed?.();
      } else {
        const invalidIssues = Object.entries(data.invalidIssues || {}) as [string, string][];
        const issueDetail = invalidIssues.length > 0
          ? ' ' + invalidIssues.map(([key, reason]) => `${key}: ${reason}`).join(' ')
          : '';

        // "All time already allocated" is the expected no-op outcome when the user
        // has already logged this time manually in Jira/Tempo.
        const allAllocated = Array.isArray(data.skippedEntries) && data.skippedEntries.length > 0
          && (data.error || '').toLowerCase().includes('already allocated');
        if (allAllocated) {
          setPushMsg({ ok: false, text: 'All time already allocated — nothing to push.' });
          await onPushed?.();
        } else {
          setPushMsg({ ok: false, text: (data.error || 'Push failed.') + issueDetail });
        }
      }
    } catch {
      setPushMsg({ ok: false, text: 'Network error.' });
    } finally {
      setPushing(false);
      setPushProgress(null);
      setTimeout(() => setPushMsg(null), 5000);
    }
  };

  // ---- Set a row to an absolute pct, redistributing the rest ----
  const setTargetPct = useCallback((targetKey: string, desiredPct: number) => {
    setRows((prev) => {
      const targetIdx = prev.findIndex((c) => c.key === targetKey);
      if (targetIdx < 0) return prev;
      const target = prev[targetIdx];
      if (target.locked) return prev;

      const lockedSum = prev.reduce((s, c) => (c.key !== targetKey && c.locked ? s + c.pct : s), 0);
      const unlockedKeys = prev.filter((c) => c.key !== targetKey && !c.locked).map((c) => c.key);

      let minTarget = 0;
      let maxTarget = 100 - lockedSum;
      if (unlockedKeys.length === 0) {
        minTarget = 100 - lockedSum;
        maxTarget = 100 - lockedSum;
      }
      let targetPct = Math.max(minTarget, Math.min(maxTarget, clampPct(desiredPct)));
      targetPct = roundHalf(targetPct);
      const delta = targetPct - target.pct;
      if (Math.abs(delta) < 0.01) return prev;

      const next = prev.map((c) => ({ ...c }));
      next[targetIdx] = { ...next[targetIdx], pct: targetPct };

      if (unlockedKeys.length > 0) {
        let remaining = delta;
        let eligible = unlockedKeys.map((k) => next.findIndex((c) => c.key === k)).filter((i) => i >= 0);
        let safety = 0;
        while (eligible.length > 0 && safety < 30) {
          safety++;
          const share = remaining / eligible.length;
          const newlyCapped: number[] = [];
          eligible.forEach((i) => {
            const cur = next[i].pct;
            const val = cur - share;
            if (val < 0) {
              next[i] = { ...next[i], pct: 0 };
              remaining += cur;
              newlyCapped.push(i);
            } else {
              next[i] = { ...next[i], pct: roundHalf(val) };
              remaining -= share;
            }
          });
          if (newlyCapped.length === 0) break;
          eligible = eligible.filter((i) => !newlyCapped.includes(i));
          remaining = roundHalf(remaining);
        }
        // Fix drift
        let sum = next[targetIdx].pct;
        next.forEach((c, i) => { if (i !== targetIdx) sum += c.pct; });
        const drift = roundHalf(100 - sum);
        if (Math.abs(drift) >= 0.1) {
          const fi = next.findIndex((c) => !c.locked && c.key !== targetKey);
          if (fi >= 0) next[fi] = { ...next[fi], pct: clampPct(next[fi].pct + drift) };
        }
      }
      return next;
    });
  }, [setRows]);

  // ---- Pointer drag ----
  const startWeight = useCallback((e: React.PointerEvent, targetKey: string) => {
    e.preventDefault();
    const trackEl = e.currentTarget.closest('.alloc-row')?.querySelector('.alloc-row-track') as HTMLElement;
    if (!trackEl) return;
    const row = rows.find((r) => r.key === targetKey);
    if (!row || row.locked) return;
    dragRef.current = { targetKey, trackEl };

    const moveHandler = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const r = dragRef.current.trackEl.getBoundingClientRect();
      let pct = ((ev.clientX - r.left) / r.width) * 100;
      pct = roundHalf(pct);
      setTargetPct(dragRef.current.targetKey, pct);
    };
    const upHandler = () => {
      document.removeEventListener('pointermove', moveHandler);
      document.removeEventListener('pointerup', upHandler);
      dragRef.current = null;
    };
    document.addEventListener('pointermove', moveHandler);
    document.addEventListener('pointerup', upHandler);
  }, [rows, setTargetPct]);

  // ---- Lock toggle with auto-lock-last ----
  const toggleLock = useCallback((targetKey: string) => {
    setRows((prev) => {
      const next = prev.map((c) => ({ ...c }));
      const idx = next.findIndex((c) => c.key === targetKey);
      if (idx < 0) return prev;
      next[idx] = { ...next[idx], locked: !next[idx].locked };
      if (next[idx].locked) {
        const unlocked = next.filter((c) => !c.locked);
        if (unlocked.length === 1) {
          const li = next.findIndex((c) => c.key === unlocked[0].key);
          if (li >= 0) next[li] = { ...next[li], locked: true };
        }
      }
      return next;
    });
  }, [setRows]);

  const unlockAll = useCallback(() => {
    setRows((prev) => prev.map((c) => ({ ...c, locked: false })));
  }, [setRows]);

  // ---- Remove row: rebalance remaining, then notify parent ----
  const removeRow = useCallback((targetKey: string) => {
    const row = rows.find((c) => c.key === targetKey);
    if (!row) return;
    setRows((prev) => {
      const next = prev.filter((c) => c.key !== targetKey).map((c) => ({ ...c }));
      const lockedSum = next.filter((c) => c.locked).reduce((s, c) => s + c.pct, 0);
      const unlocked = next.filter((c) => !c.locked);
      if (unlocked.length > 0) {
        const remaining = Math.max(0, 100 - lockedSum);
        const pct = roundHalf(remaining / unlocked.length);
        unlocked.forEach((c, i) => {
          c.pct = (i === unlocked.length - 1) ? roundHalf(remaining - pct * (unlocked.length - 1)) : pct;
        });
      } else if (next.length > 0) {
        const sum = next.reduce((s, c) => s + c.pct, 0);
        if (sum > 0) next.forEach((c) => { c.pct = roundHalf((c.pct / sum) * 100); });
        else { const e = roundHalf(100 / next.length); next.forEach((c, i) => { c.pct = i === next.length - 1 ? roundHalf(100 - e * (next.length - 1)) : e; }); }
      }
      return next;
    });
    onRemoveFromActive(row.key, row.name);
  }, [rows, setRows, onRemoveFromActive]);

  // ---- Add to active: rebalance to make room, then notify parent ----
  const addToActive = useCallback((key: string, name: string) => {
    setRows((prev) => {
      if (prev.some((c) => c.key === key)) return prev;
      const next = prev.map((c) => ({ ...c }));
      next.push({ key, name, pct: 0, locked: false });
      const lockedSum = next.filter((c) => c.locked).reduce((s, c) => s + c.pct, 0);
      const unlocked = next.filter((c) => !c.locked);
      const remaining = Math.max(0, 100 - lockedSum);
      const pct = roundHalf(remaining / unlocked.length);
      unlocked.forEach((c, i) => {
        c.pct = (i === unlocked.length - 1) ? roundHalf(remaining - pct * (unlocked.length - 1)) : pct;
      });
      return next;
    });
    onAddToActive(key, name);
  }, [setRows, onAddToActive]);

  return (
    <div className="alloc-hero">
      <div className="top-row">
        <div className="alloc-summary">
          {workTime < 0.01 && (tempoHours || 0) > 0 ? (
            <span className="value">All time already logged in Jira</span>
          ) : (
            <>
              <span className="value">{fmtHrsMin(workTime)}</span>
              <span className="label">to allocate</span>
            </>
          )}
          {(tempoHours || 0) > 0 && <span className="detail">{fmtHrsMin(tempoHours || 0)} in Tempo</span>}
          {meetingsHours > 0 && <span className="detail">{fmtHrsMin(meetingsHours)} meetings to review</span>}
        </div>
        <div className="total-input">
          <span className="text-muted">Total</span>
          <input className="input" type="number" min={0} max={12} value={totalHours}
            onChange={(e) => { const val = parseFloat(e.target.value) || 0; setTotalHours(Math.min(val, 12)); }} />
          <span className="text-muted">hours</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 0 10px', gap: 10 }}>
        {rows.length > 0 && workTime > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {pushMsg && <span style={{ fontSize: 12, color: pushMsg.ok ? 'var(--success-600)' : 'var(--danger-600)', fontWeight: 600 }}>{pushMsg.text}</span>}
            <button className="btn btn-navy btn-lg" onClick={pushToJira} disabled={pushing}
              style={{ textTransform: 'none', letterSpacing: 0, minWidth: 200, flexShrink: 0 }}>
              {pushing ? (pushProgress ? 'Logging ' + pushProgress.current + '/' + pushProgress.total + '...' : 'Logging...') : 'Log time in Jira'}
            </button>
          </div>
        )}
      </div>

      {workTime > 0 && suggestions.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '0 0 10px', flexWrap: 'wrap' }}>
          <span className="text-muted" style={{ fontSize: 13, minWidth: 0 }}>
            {rows.length === 0
              ? 'Not sure how to split your time? Start from your recent Jira activity.'
              : 'Rebalance this split to match your recent Jira activity.'}
          </span>
          <button className="btn btn-secondary btn-sm" style={{ textTransform: 'none', letterSpacing: 0, flexShrink: 0 }} onClick={applyFill}>
            {rows.length === 0 ? `Fill to ${fmtHrsMin(workTime)}` : 'Re-suggest split'}
          </button>
        </div>
      )}

      <div className="alloc-section-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Split your time
        {anyLocked && (
          <button className="btn btn-secondary btn-sm" onClick={unlockAll}
            style={{ textTransform: 'none', letterSpacing: 0 }}>Unlock all</button>
        )}
      </div>

      <div className={rows.length === 0 ? 'alloc-chips empty' : 'alloc-chips'}>
        {rows.map((row) => {
          const hrs = (row.pct / 100) * workTime;
          const upperKey = row.key.toUpperCase();
          const estData = estimates && upperKey in estimates ? estimates[upperKey] : undefined;
          const estHours = estData ? estData.remaining / 3600 : undefined;
          // Only warn if an original estimate was actually set AND we're over it
          const overEstimate = estData?.hasEstimate === true && estHours !== undefined && (estHours <= 0 ? hrs > 0 : hrs >= estHours);
          const overBy = estHours !== undefined ? Math.max(0, hrs - estHours) : 0;
          const isClosed = estData ? !estData.isOpen : false;
          const isMeeting = /meeting/i.test(row.name);
          const isGeneral = /^SVCOPS-/i.test(row.key);
          const showMeetingPrompt = (isMeeting || isGeneral) && !row.comment;
          const showCommentBox = commentKey === row.key;
          return (
            <div key={row.key} className={'alloc-row' + (row.locked ? ' locked' : '')}>
              <div className="alloc-row-track"
                onPointerDown={(e) => { if (!row.locked) startWeight(e, row.key); }}
                style={{ cursor: row.locked ? 'default' : 'pointer' }}>
                <div className="alloc-row-fill" style={{ width: row.pct + '%' }} />
                <div className="alloc-grip" style={{ left: row.pct + '%' }}
                  onPointerDown={(e) => { if (!row.locked) startWeight(e, row.key); }}>
                  <div className="alloc-grip-dots"><div></div><div></div><div></div></div>
                </div>
              </div>
              <div className="alloc-row-content">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                  <span className="key">{row.key}</span>
                  <span className="row-name">{row.name}</span>
                  {overEstimate && (
                    <button
                      onClick={(e) => { e.stopPropagation(); const key = warningKey(row.key); setOpenWarnings(prev => { const next = new Set(prev); if (next.has(key)) { next.delete(key); } else { next.add(key); } return next; }); }}
                      title="Click to see details"
                      className="warn-badge"
                    >!</button>
                  )}
                  {isClosed && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setOpenClosed(prev => { const next = new Set(prev); if (next.has(row.key)) { next.delete(row.key); } else { next.add(row.key); } return next; }); }}
                      title="Click to see details"
                      className="warn-badge"
                      style={{ marginLeft: 8 }}
                    >!</button>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span className="pct">{row.pct}%</span>
                  <span className="hrs">{fmtHrsMin(hrs)}</span>
                  <button className="alloc-lock" onClick={() => toggleLock(row.key)}
                    title={row.locked ? 'Unlock (allow redistribution)' : 'Lock this share'}
                    aria-label={row.locked ? 'Unlock' : 'Lock'}>
                    {row.locked ? <LockIcon /> : <UnlockIcon />}
                  </button>
                  <button className="alloc-lock" onClick={() => setCommentKey(showCommentBox ? null : row.key)}
                    title={row.comment ? 'Edit comment' : 'Add comment'}
                    aria-label="Comment"
                    style={{ position: 'relative' }}>
                    <CommentIcon hasComment={!!row.comment} />
                  </button>
                  <button className="btn btn-secondary btn-sm" style={{ padding: '2px 6px', fontSize: 13, lineHeight: 1 }}
                    onClick={() => removeRow(row.key)} title="Remove">x</button>
                </div>
              </div>
              {overEstimate && openWarnings.has(warningKey(row.key)) && (
                <div style={{ padding: '4px 12px 6px', fontSize: 13, color: 'var(--navy)', fontWeight: 600 }}>
                  {'You are exceeding the remaining estimated time. Consider adding a comment to explain.'}
                    <button onClick={() => { const key = warningKey(row.key); setOpenWarnings(prev => { const next = new Set(prev); next.delete(key); return next; }); setCommentKey(row.key); }}
                    style={{ background: 'none', border: 'none', color: 'var(--navy)', cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: 0, marginLeft: 4, textDecoration: 'underline' }}>
                    Add comment
                  </button>
                </div>
              )}
              {isClosed && openClosed.has(row.key) && (
                <div style={{ padding: '4px 12px 6px', fontSize: 13, color: 'var(--navy)', fontWeight: 600 }}>
                  {'This issue is closed. You can still log time, but consider verifying with your team.'}
                </div>
              )}
              {showMeetingPrompt && !showCommentBox && (
                <div style={{ padding: '2px 12px 6px' }}>
                  <button onClick={() => setCommentKey(row.key)}
                    style={{ background: 'none', border: 'none', color: 'var(--navy)', cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: 0, textDecoration: 'underline' }}>
                    {isMeeting ? 'Consider adding meeting notes' : 'Consider adding detail about this general work'}
                  </button>
                </div>
              )}
              {showCommentBox && (
                <div style={{ padding: '4px 12px 8px' }}>
                  <textarea
                    className="input"
                    placeholder="Add a comment (shown in Jira/Tempo)"
                    value={row.comment || ''}
                    onChange={(e) => setComment(row.key, e.target.value)}
                    rows={2}
                    style={{ width: '100%', fontSize: 13, resize: 'vertical', minHeight: 44 }}
                    autoFocus
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setCommentKey(null)}>Done</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="alloc-section-label" style={{ marginTop: 16 }}>Saved for later</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {unassigned.map((p) => {
          const short = truncateWords(p.name, 4);
          const isLong = p.name.split(/\s+/).length > 4;
          return (
            <div key={p.key} className="proj-chip" onClick={() => addToActive(p.key, p.name)} style={{ cursor: 'pointer' }} title={p.name}>
              <span className="key">{p.key}</span> {short}
              {isLong && <span className="text-muted" style={{ marginLeft: 2, cursor: 'pointer' }}></span>}
              <button
                className="btn btn-secondary btn-sm"
                style={{ padding: '0 4px', fontSize: 13, lineHeight: 1, marginLeft: 4 }}
                onClick={(e) => { e.stopPropagation(); onDeleteUnassigned(p.id, p.key); }}
                title={`Remove ${p.key} from your list`}
                aria-label={`Remove ${p.key}`}
              >x</button>
            </div>
          );
        })}
        <button className="btn btn-secondary btn-sm" onClick={onAddProject}>Find Jira issue</button>
      </div>

      {showConfirm && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) setShowConfirm(false); }}>
          <div className="modal" style={{ maxWidth: 380 }}>
            <h3>Log time in Jira?</h3>
            <p className="text-muted">
              This will log <b>{fmtHrsMin(workTime)}</b> across <b>{rows.filter(function(r) { return (r.pct / 100) * workTime > 0; }).length}</b> project{rows.filter(function(r) { return (r.pct / 100) * workTime > 0; }).length === 1 ? '' : 's'} in Jira.
            </p>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowConfirm(false)}>Cancel</button>
              <button className="btn btn-navy" onClick={doPush} disabled={pushing}>Log time</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
