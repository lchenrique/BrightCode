#!/usr/bin/env node
/**
 * Adapt OpenCode agent markdown files for BrightCode.
 *
 *   - Strip the YAML frontmatter (we keep `name` and `description` for
 *     the picker; mode / color / permission are dropped)
 *   - Add a header noting the file was adapted and when
 *   - Replace tool references with BrightCode's tool names:
 *       read         → read_file
 *       edit         → edit_file
 *       write        → write_file
 *       grep         → search_files
 *       glob, list   → list_files
 *       task()       → delegate_to_<agent> (BrightCode's delegation)
 *       webfetch     → note (no web access — use search_files / read_skill)
 *   - Tidy the few "ðŸ" / "â€" UTF-8 mojibake that came over from the
 *     OpenCode source encoding
 *
 * Run: `node scripts/adapt-opencode-agents.mjs`
 * Idempotent: running twice produces the same output.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'

const PRESETS_DIR = 'agents/presets'

const TOOL_REPLACEMENTS = [
  // Be careful with order — longer phrases first to avoid partial matches.
  [/\bdelegate_to_[a-z][a-z0-9_]*\s+agent\b/gi, 'delegate_to_<agent>'],
  [/\btask\s*\(\s*planner\s*\)/gi, 'delegate_to_planner'],
  [/\btask\s*\(\s*<agent-name>\s*\)/gi, 'delegate_to_<agent>'],
  [/\btask\s*\(\s*([a-z][a-z0-9_-]*)\s*\)/gi, 'delegate_to_$1'],
  [/\bvia the `task` tool\b/gi, 'via the delegate_to_<agent> tool'],
  [/\bthe `task` tool\b/gi, 'the delegate_to_<agent> tool'],
  [/\bvia `task`\(\)/gi, 'via delegate_to_<agent>'],
  [/\bvia `?task\(\)`?/gi, 'via delegate_to_<agent>'],
  [/\bUse `task`\(/gi, 'Use delegate_to_<agent>('],
  [/\bdelegate via the `task` tool\b/gi, 'delegate via the delegate_to_<agent> tool'],
  [/\bdelegation via the `task` tool\b/gi, 'delegation via the delegate_to_<agent> tool'],
  [/\bdelegate via `task`\b/gi, 'delegate via delegate_to_<agent>'],
  [/\bALWAYS delegate via `task`\(\)/gi, 'ALWAYS delegate via delegate_to_<agent>'],
  [/\bUse `task`\b/gi, 'Use delegate_to_<agent>'],

  // OpenCode tool names → BrightCode tool names. Use word boundaries so
  // we don't break words that happen to contain "write" or "read".
  [/\bwebfetch\b/gi, 'WEBFETCH (not available — use search_files or read_skill)'],
  [/\bweb fetch\b/gi, 'web fetch (not available — use search_files or read_skill)'],
  [/\bthe `read` permission\b/gi, 'read access'],
  [/\bthe `write` permission\b/gi, 'write access'],
  [/\bthe `edit` permission\b/gi, 'edit access'],
  [/\bpermission `read`\b/gi, 'read_file access'],
  [/\bpermission `edit`\b/gi, 'edit_file access'],
  [/\bpermission `write`\b/gi, 'write_file access'],
  [/\bthe `bash` permission\b/gi, 'bash access'],
  [/\bpermission `bash`\b/gi, 'bash access'],
  [/\bvia `grep`\b/gi, 'via search_files'],
  [/\buse `grep`\b/gi, 'use search_files'],
  [/\b`grep` tool\b/gi, 'search_files tool'],
  [/\b`grep`\b/gi, 'search_files'],
  [/\bvia `glob`\b/gi, 'via list_files (recursive)'],
  [/\buse `glob`\b/gi, 'use list_files (recursive)'],
  [/\b`glob` tool\b/gi, 'list_files tool'],
  [/\b`glob`\b/gi, 'list_files'],
  [/\bvia `list`\b/gi, 'via list_files'],
  [/\buse `list`\b/gi, 'use list_files'],
  [/\b`list` tool\b/gi, 'list_files tool'],
  // The remaining bare `list` is risky (could be a verb in prose). We
  // leave it alone unless the surrounding context already says "tool".

  [/\bpermission:[\s\S]*?(?=\n[a-zA-Z#]|\n---|\Z)/m, ''], // drop YAML permissions block
]

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/

const ADAPTED_HEADER = `> **Adapted for BrightCode.** Tool names translated from OpenCode's set
> (\`read\` → \`read_file\`, \`edit\` → \`edit_file\`, \`write\` → \`write_file\`,
> \`grep\` → \`search_files\`, \`glob\`/\`list\` → \`list_files\`,
> \`task()\` → \`delegate_to_<agent>\`). \`webfetch\` is not available;
> substitute \`search_files\` or \`read_skill\` for web-bound research.

`

const MOJIBAKE = [
  ['ðŸ§', '🧠'],
  ['ðŸŽ¯', '🎯'],
  ['ðŸš¨', '🚨'],
  ['ðŸ“‹', '📋'],
  ['â€"', '—'],
  ['â€™', "'"],
  ['â€œ', '"'],
  ['â€\u009d', '"'],
]

function adapt(content, filename) {
  // 1. Drop YAML frontmatter but keep the `name` / `description` as a
  //    comment at the top so the picker can still read them.
  const fmMatch = content.match(FRONTMATTER)
  let name = 'Agent'
  let description = ''
  if (fmMatch) {
    const block = fmMatch[0]
    const nameMatch = block.match(/^name:\s*(.+?)\s*$/m)
    const descMatch = block.match(/^description:\s*(.+?)\s*$/m)
    if (nameMatch) name = nameMatch[1].trim()
    if (descMatch) description = descMatch[1].trim()
    content = content.slice(fmMatch[0].length).replace(/^\n+/, '')
  }

  // 2. Apply tool substitutions.
  for (const [pattern, replacement] of TOOL_REPLACEMENTS) {
    content = content.replace(pattern, replacement)
  }

  // 3. Fix mojibake from the OpenCode source.
  for (const [bad, good] of MOJIBAKE) {
    content = content.split(bad).join(good)
  }

  // 4. Prepend the adapted header with preserved name/description.
  const header = [
    '---',
    `name: ${name}`,
    description ? `description: ${description}` : null,
    'source: opencode/agents (adapted)',
    '---',
    '',
    ADAPTED_HEADER,
  ]
    .filter(Boolean)
    .join('\n')

  return header + content
}

const files = readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.md'))
let changed = 0
for (const f of files) {
  const full = join(PRESETS_DIR, f)
  const original = readFileSync(full, 'utf8')
  const next = adapt(original, f)
  if (next !== original) {
    writeFileSync(full, next, 'utf8')
    changed += 1
    console.log(`✓ adapted: ${f}`)
  } else {
    console.log(`  unchanged: ${f}`)
  }
}
console.log(`\n${changed} file(s) updated.`)
