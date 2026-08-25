'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

export interface AllocRow {
  key: string;
  name: string;
  pct: number;
  locked: boolean;
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

interface Props {
  rows: AllocRow[];
  setRows: (updater: (prev: AllocRow[]) => AllocRow[]) => void;
  totalHours: number;
  meetingsHours: number;
  setTotalHours: (n: number) => void;
  unassigned: { id: number; key: string; name: string }[];
  onAddToActive: (key: string, name: string) => void;
  onRemoveFromActive: (key: string, name: string) => void;
  onDeleteUnassigned: (id: number, key: string) => void;
  onAddProject: () => void;
  dateLabel: string;
  manualMeetings?: { id: string; title: string; hours: number }[];
  onRemoveMeeting?: (id: string, hours: number) => void;
}

export function AllocationCard({
  rows, setRows, totalHours, meetingsHours, setTotalHours,
  unassigned, onAddToActive, onRemoveFromActive, onDeleteUnassigned, onAddProject,
  dateLabel, manualMeetings, onRemoveMeeting,
}: Props) {
  const workTime = Math.max(0, totalHours - meetingsHours);
  const anyLocked = rows.some((r) => r.locked);
  const dragRef = useRef<{ targetKey: string; trackEl: HTMLElement } | null>(null);

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
      let next = prev.filter((c) => c.key !== targetKey).map((c) => ({ ...c }));
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
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>{dateLabel}</div>
        <div className="total-input">
          <span style={{ fontSize: 13, color: 'var(--slate-500)' }}>Total</span>
          <input className="input" type="number" min={0} max={24} value={totalHours}
            onChange={(e) => setTotalHours(parseFloat(e.target.value) || 0)} />
          <span style={{ fontSize: 13, color: 'var(--slate-500)' }}>hours</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, padding: '8px 12px', background: 'var(--slate-100)', borderRadius: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--slate-500)', fontWeight: 600 }}>{fmtHrsMin(meetingsHours)} in meetings</span>
        <span style={{ fontSize: 12, color: 'var(--slate-400)' }}>from calendar</span>
      </div>

      {manualMeetings && manualMeetings.length > 0 && (
        <div style={{ marginBottom: 6, paddingLeft: 12 }}>
          {manualMeetings.map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 13, color: 'var(--slate-500)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--navy)', flexShrink: 0 }}></span>
              <span style={{ fontWeight: 500 }}>{m.title}</span>
              <span style={{ color: 'var(--slate-400)' }}>{fmtHrsMin(m.hours)}</span>
              {onRemoveMeeting && (
                <button className="btn btn-secondary btn-sm" style={{ padding: '0 5px', fontSize: 13, lineHeight: 1, marginLeft: 'auto' }}
                  onClick={() => onRemoveMeeting(m.id, m.hours)} title="Remove meeting">x</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 13, color: 'var(--slate-500)', padding: '6px 12px', marginBottom: 14 }}>
        <b style={{ color: 'var(--navy)' }}>{fmtHrsMin(workTime)}</b> to allocate across projects
      </div>

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
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span className="pct">{row.pct}%</span>
                  <span className="hrs">{fmtHrsMin(hrs)}</span>
                  <button className="alloc-lock" onClick={() => toggleLock(row.key)}
                    title={row.locked ? 'Unlock (allow redistribution)' : 'Lock this share'}
                    aria-label={row.locked ? 'Unlock' : 'Lock'}>
                    {row.locked ? <LockIcon /> : <UnlockIcon />}
                  </button>
                  <button className="btn btn-secondary btn-sm" style={{ padding: '2px 6px', fontSize: 13, lineHeight: 1 }}
                    onClick={() => removeRow(row.key)} title="Remove">x</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="alloc-section-label" style={{ marginTop: 16 }}>Unassigned</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {unassigned.map((p) => (
          <div key={p.key} className="proj-chip" onClick={() => addToActive(p.key, p.name)} style={{ cursor: 'pointer' }}>
            <span className="key">{p.key}</span> {p.name}
            <button
              className="btn btn-secondary btn-sm"
              style={{ padding: '0 4px', fontSize: 13, lineHeight: 1, marginLeft: 4 }}
              onClick={(e) => { e.stopPropagation(); onDeleteUnassigned(p.id, p.key); }}
              title={`Remove ${p.key} from your list`}
              aria-label={`Remove ${p.key}`}
            >x</button>
          </div>
        ))}
        <button className="btn btn-secondary btn-sm" onClick={onAddProject}>+ Add project or meeting</button>
      </div>

    </div>
  );
}
