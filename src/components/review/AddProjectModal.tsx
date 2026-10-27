'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface SearchResult {
  key: string;
  summary: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded: (key: string, name: string) => void;
  existingKeys: string[];
}

export function AddProjectModal({ open, onClose, onAdded, existingKeys }: Props) {
  const [input, setInput] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [validating, setValidating] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const existingSet = new Set(existingKeys.map((k) => k.toUpperCase()));

  useEffect(() => {
    if (open) {
      setInput('');
      setResults([]);
      setError('');
      setHighlightIdx(-1);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Debounced search as the user types
  const handleInput = useCallback((value: string) => {
    setInput(value);
    setError('');
    setHighlightIdx(-1);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (trimmed.length < 1) {
      setResults([]);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/jira/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: trimmed }),
        });

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          setResults([]);
          return;
        }

        const data = await res.json();
        if (data.success) {
          setResults(data.issues || []);
        } else {
          setResults([]);
        }
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, []);

  // Validate and add a specific issue key
  const addIssue = async (key: string) => {
    const k = key.trim().toUpperCase();
    if (!k) return;
    if (existingSet.has(k)) { setError('This issue is already added.'); return; }

    setValidating(true);
    setError('');
    try {
      const res = await fetch('/api/jira/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jira_key: k }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        setError('Could not reach Jira. Check your connection in Settings.');
        setValidating(false);
        return;
      }

      const data = await res.json();
      if (!data.valid) {
        setError(data.error || 'Issue not found in Jira.');
        setValidating(false);
        return;
      }

      await fetch('/api/favorites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jira_key: k, jira_name: data.jira_name || k }),
      }).catch(() => {});

      onAdded(k, data.jira_name || k);
      onClose();
    } catch {
      setError('Could not reach Jira.');
    } finally {
      setValidating(false);
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }

    if (results.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, results.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && highlightIdx >= 0 && highlightIdx < results.length) {
        e.preventDefault();
        addIssue(results[highlightIdx].key);
        return;
      }
    }

    // Plain Enter with no selection — try exact key match from results, or validate as-is
    if (e.key === 'Enter' && results.length === 0) {
      e.preventDefault();
      addIssue(input);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', marginBottom: 16 }}>Find a Jira issue</h3>
          <p style={{ fontSize: 13.5, color: 'var(--slate-500)', marginBottom: 14 }}>
            Type an issue key or summary and pick from the results.
          </p>

          {/* Search input with dropdown */}
        <div style={{ position: 'relative' }}>
          <input
            ref={inputRef}
            className="input"
            value={input}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type an issue key or search..."
            autoComplete="off"
            spellCheck={false}
            style={{ marginBottom: 4 }}
          />

          {/* Autocomplete dropdown */}
          {input.trim().length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0,
              background: '#fff', border: '1px solid var(--slate-200)',
              borderRadius: '0 0 10px 10px', boxShadow: 'var(--shadow-lg)',
              maxHeight: 280, overflowY: 'auto', zIndex: 10,
            }}>
              {searching && (
                <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--slate-400)' }}>Searching Jira...</div>
              )}

              {!searching && results.length === 0 && (
                <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--slate-400)' }}>
                  No matches found. Try a different search, or press Enter to validate a full issue key.
                </div>
              )}

              {!searching && results.map((r, i) => {
                const alreadyAdded = existingSet.has(r.key.toUpperCase());
                return (
                  <div
                    key={r.key}
                    onClick={() => { if (!alreadyAdded) addIssue(r.key); }}
                    style={{
                      padding: '10px 14px', cursor: alreadyAdded ? 'default' : 'pointer',
                      background: i === highlightIdx ? 'var(--blue-50)' : '#fff',
                      borderBottom: '1px solid var(--slate-100)',
                      opacity: alreadyAdded ? 0.5 : 1,
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}
                    onMouseEnter={() => setHighlightIdx(i)}
                  >
                    <span className="issue-key">{r.key}</span>
                    <span style={{ fontSize: 13, color: 'var(--slate-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.summary}
                    </span>
                    {alreadyAdded && <span style={{ fontSize: 12, color: 'var(--slate-400)', marginLeft: 'auto' }}>Added</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {error && <div style={{ fontSize: 13, color: 'var(--danger-600)', marginBottom: 8, marginTop: 8 }}>{error}</div>}

        <div className="actions" style={{ marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-navy"
            disabled={validating || !input.trim()}
            onClick={() => {
              if (highlightIdx >= 0 && highlightIdx < results.length) {
                addIssue(results[highlightIdx].key);
              } else {
                addIssue(input);
              }
            }}
          >
            {validating ? 'Adding...' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
