/**
 * Clean leading email reply/forward prefixes from a subject line so the visible
 * title reads naturally (e.g. "RE: RE: [External] Weekly sync" -> "Weekly sync").
 */
export function cleanEmailTitle(title: string): string {
  if (!title) return title;
  let out = title.trim();
  // Reply/forward tokens (matched verbatim, then normalized to lower for comparison).
  const tokens = ['re', 'fw', 'fwd', 'aw', 'sv', 'vs', 'rv'];
  for (let i = 0; i < 5; i++) {
    const trimmed = out.trim();
    if (!trimmed) break;
    // Match "<token>:" with optional surrounding spaces, or bracketed tag like [External]
    const tokenMatch = /^([a-zA-Z]+):[\s:]*/.exec(trimmed);
    if (tokenMatch) {
      const t = tokenMatch[1].toLowerCase();
      if (tokens.includes(t)) {
        out = trimmed.slice(tokenMatch[0].length);
        continue;
      }
      break;
    }
    const bracketMatch = /^\[[^\]\[]{1,30}\]:?\s*/.exec(trimmed);
    if (bracketMatch) {
      out = trimmed.slice(bracketMatch[0].length);
      continue;
    }
    break;
  }
  const final = out.replace(/^[\s:>|+\-]+/, '').trim();
  return final.length > 0 ? final : title.trim();
}