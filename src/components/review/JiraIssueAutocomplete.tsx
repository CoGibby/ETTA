'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export interface JiraSearchResult {
  key: string;
  summary: string;
  updated?: string;
  timeestimate?: number;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSelect: (issue: JiraSearchResult) => void;
  onSubmitNoMatch?: (value: string) => void;
  onBlur?: (value: string) => void;
  onEscape?: () => void;
  placeholder?: string;
  helperText?: string;
  inputStyle?: CSSProperties;
  disabledKeys?: string[];
  usePortal?: boolean;
}

const EMPTY_DISABLED_KEYS: string[] = [];

export function JiraIssueAutocomplete({
  value,
  onChange,
  onSelect,
  onSubmitNoMatch,
  onBlur,
  onEscape,
  placeholder = 'Search Jira issues',
  helperText,
  inputStyle,
  disabledKeys = EMPTY_DISABLED_KEYS,
  usePortal = false,
}: Props) {
  const [results, setResults] = useState<JiraSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [portalStyle, setPortalStyle] = useState<CSSProperties>();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disabledSet = useMemo(
    () => new Set(disabledKeys.map((key) => key.toUpperCase())),
    [disabledKeys]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    };
  }, []);

  const search = useCallback((query: string) => {
    const requestId = ++requestRef.current;
    setSearching(true);

    (async () => {
      try {
        const response = await fetch('/api/jira/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json') || requestId !== requestRef.current) {
          setResults([]);
          setHasSearched(true);
          return;
        }

        const data = await response.json();
        setResults(data.success ? data.issues || [] : []);
        setHasSearched(true);
      } catch {
        if (requestId === requestRef.current) {
          setResults([]);
          setHasSearched(true);
        }
      } finally {
        if (requestId === requestRef.current) setSearching(false);
      }
    })();
  }, []);

  const handleChange = useCallback((nextValue: string) => {
    onChange(nextValue);
    setHighlightIndex(-1);
    setHasSearched(false);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = nextValue.trim();
    if (trimmed.length === 0) {
      requestRef.current++;
      setResults([]);
      setSearching(false);
      setHasSearched(false);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(() => search(trimmed), 250);
  }, [onChange, search]);

  const selectIssue = useCallback((issue: JiraSearchResult) => {
    if (disabledSet.has(issue.key.toUpperCase())) return;
    setResults([]);
    setHighlightIndex(-1);
    requestRef.current++;
    setSearching(false);
    setHasSearched(false);
    onSelect(issue);
  }, [disabledSet, onSelect]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setHighlightIndex((current) => (current + 1) % results.length);
      return;
    }

    if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setHighlightIndex((current) => current <= 0 ? results.length - 1 : current - 1);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const issue = results[highlightIndex];
      if (issue) {
        selectIssue(issue);
      } else {
        onSubmitNoMatch?.(value.trim());
      }
      return;
    }

    if (event.key === 'Escape') {
      setResults([]);
      setHighlightIndex(-1);
      setHasSearched(false);
      setSearching(false);
      requestRef.current++;
      onEscape?.();
    }
  }, [highlightIndex, onEscape, onSubmitNoMatch, results, selectIssue, value]);

  const handleBlur = useCallback(() => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    blurTimeoutRef.current = setTimeout(() => {
      setFocused(false);
      onBlur?.(value.trim());
    }, 150);
  }, [onBlur, value]);

  const showDropdown = focused && value.trim().length > 0 && (searching || hasSearched);

  const updatePortalPosition = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;

    const inputRect = input.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 0;
    const viewportHeight = window.innerHeight || 0;
    const width = Math.min(480, Math.max(280, viewportWidth - 24));
    const left = Math.min(
      Math.max(12, inputRect.left),
      Math.max(12, viewportWidth - width - 12)
    );
    const spaceBelow = viewportHeight - inputRect.bottom - 18;
    const spaceAbove = inputRect.top - 18;
    const preferredHeight = 340;
    const placeBelow = spaceBelow >= Math.min(preferredHeight, 220) || spaceBelow >= spaceAbove;
    const availableHeight = placeBelow ? spaceBelow : spaceAbove;
    const maxHeight = Math.max(180, Math.min(preferredHeight, availableHeight));
    const top = placeBelow
      ? inputRect.bottom + 6
      : Math.max(12, inputRect.top - maxHeight - 6);

    setPortalStyle({
      position: 'fixed',
      top,
      left,
      width,
      maxHeight,
    });
  }, []);

  useEffect(() => {
    if (!usePortal || !showDropdown) return;

    updatePortalPosition();
    window.addEventListener('resize', updatePortalPosition);
    window.addEventListener('scroll', updatePortalPosition, true);
    return () => {
      window.removeEventListener('resize', updatePortalPosition);
      window.removeEventListener('scroll', updatePortalPosition, true);
    };
  }, [showDropdown, updatePortalPosition, usePortal, searching, results.length]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        className="input"
        style={inputStyle}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onFocus={() => {
          if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
          if (usePortal) updatePortalPosition();
          setFocused(true);
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls={listboxId}
        aria-autocomplete="list"
      />

      {helperText && (
        <div className="text-muted" style={{ marginTop: 4, fontSize: 12.5 }}>
          {helperText}
        </div>
      )}

      {(() => {
        if (!showDropdown) return null;

        const dropdown = (
          <div
            id={listboxId}
            style={{
              ...(usePortal ? portalStyle : {
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
              }),
              background: '#fff',
              border: '1px solid var(--slate-200)',
              borderRadius: 10,
              boxShadow: 'var(--shadow-lg)',
              maxHeight: usePortal ? portalStyle?.maxHeight : 260,
              overflowY: 'auto',
              zIndex: 100,
            }}
          >
          {searching && (
            <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--slate-400)' }}>
              Searching Jira...
            </div>
          )}

          {!searching && results.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--slate-400)' }}>
              No eligible matches. Press Enter to check a full issue key.
            </div>
          )}

          {!searching && results.map((issue, index) => {
            const disabled = disabledSet.has(issue.key.toUpperCase());
            return (
              <button
                key={issue.key}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectIssue(issue)}
                onMouseEnter={() => setHighlightIndex(index)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '11px 14px',
                  cursor: disabled ? 'default' : 'pointer',
                  background: index === highlightIndex ? 'var(--blue-50)' : '#fff',
                  borderBottom: '1px solid var(--slate-100)',
                  opacity: disabled ? 0.55 : 1,
                }}
              >
                <span className="issue-key">{issue.key}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13.5, color: 'var(--slate-500)' }}>
                  {issue.summary}
                </span>
                {disabled && <span style={{ fontSize: 12, color: 'var(--slate-400)' }}>Added</span>}
              </button>
            );
          })}
          </div>
        );

        return usePortal ? createPortal(dropdown, document.body) : dropdown;
      })()}
    </div>
  );
}
