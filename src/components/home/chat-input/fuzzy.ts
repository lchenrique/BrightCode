/**
 * Tiny fuzzy matcher used by the slash-command and @-mention menus.
 *
 * Scoring is intentionally simple so the matcher is cheap to run on every
 * keystroke against the full command/agent/file list:
 *
 *   100  exact (case-insensitive) match
 *   80   query is a prefix of the candidate
 *   60   candidate contains the query as a substring
 *   40 + sequence bonus   query chars appear in order, possibly with gaps
 *    0   no match
 *
 * The sequence matcher is what gives the fzf/cmd-t feel: typing
 * "aptp" matches "AgentPresetPicker" because every char shows up in
 * order, even though no contiguous substring exists. Candidates are
 * returned sorted by score descending so the menu shows the best match
 * at the top.
 */

export interface FuzzyMatch<T> {
  item: T
  score: number
  /** Indices in the candidate that the query matched, for highlight. */
  matchedIndices: number[]
}

function indicesOf(query: string, candidate: string): number[] {
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  const out: number[] = []
  let qIdx = 0
  for (let i = 0; i < c.length && qIdx < q.length; i++) {
    if (c[i] === q[qIdx]) {
      out.push(i)
      qIdx += 1
    }
  }
  return qIdx === q.length ? out : []
}

export function fuzzyScore(query: string, candidate: string): { score: number; matched: number[] } {
  const q = query.trim()
  if (!q) return { score: 1, matched: [] }
  const lower = candidate.toLowerCase()
  const ql = q.toLowerCase()
  if (lower === ql) return { score: 100, matched: candidate.split('').map((_, i) => i) }
  if (lower.startsWith(ql)) {
    return {
      score: 80 + (ql.length / candidate.length) * 10,
      matched: Array.from({ length: ql.length }, (_, i) => i),
    }
  }
  const at = lower.indexOf(ql)
  if (at >= 0) {
    return {
      score: 60 + (ql.length / candidate.length) * 10,
      matched: Array.from({ length: ql.length }, (_, i) => at + i),
    }
  }
  const seq = indicesOf(q, candidate)
  if (seq.length === q.length) {
    // Bonus for consecutive matches and word starts.
    let bonus = 0
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === seq[i - 1] + 1) bonus += 4
      const ch = candidate[seq[i] - 1]
      if (ch === '/' || ch === '.' || ch === '-' || ch === '_' || ch === ' ') bonus += 6
    }
    return { score: 40 + bonus, matched: seq }
  }
  return { score: 0, matched: [] }
}

export function fuzzyFilter<T>(query: string, items: T[], getCandidate: (item: T) => string): FuzzyMatch<T>[] {
  const out: FuzzyMatch<T>[] = []
  for (const item of items) {
    const candidate = getCandidate(item)
    const { score, matched } = fuzzyScore(query, candidate)
    if (score > 0) out.push({ item, score, matchedIndices: matched })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/**
 * Render a candidate string with the matched chars wrapped in <mark>.
 * Use for inline highlighting in menu rows.
 */
export function highlightCandidate(
  candidate: string,
  matched: number[],
): Array<{ text: string; highlight: boolean }> {
  if (matched.length === 0) return [{ text: candidate, highlight: false }]
  const set = new Set(matched)
  const out: Array<{ text: string; highlight: boolean }> = []
  let buf = ''
  let bufHighlight = false
  for (let i = 0; i < candidate.length; i++) {
    const h = set.has(i)
    if (i === 0) {
      buf = candidate[i]!
      bufHighlight = h
      continue
    }
    if (h === bufHighlight) {
      buf += candidate[i]
    } else {
      out.push({ text: buf, highlight: bufHighlight })
      buf = candidate[i]!
      bufHighlight = h
    }
  }
  if (buf) out.push({ text: buf, highlight: bufHighlight })
  return out
}
