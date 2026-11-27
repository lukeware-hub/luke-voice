// Prompt Master is the Lukeware Hub plugin that rewrites each prompt before Claude reads it
// (github.com/lukeware-hub/prompt-master). When it is installed, luke-voice keeps it on while a
// call runs. Another plugin may also be named prompt-master, so the plugin counts only when the
// marketplace it was installed from is the lukeware-hub/prompt-master repository on GitHub.
//
// Claude Code lists what is installed with `claude plugin list --json`: one row per install, its
// `id` being `<plugin>@<marketplace>`, with `enabled`, `scope` and, for a project or local
// install, `projectPath`. `claude plugin marketplace list --json` names where each marketplace
// comes from: `source` "github" with `repo` "owner/name", or "git" with a `url`. A plugin from the
// organization's library (scope "synced", marketplace "synced") names no repository, so it is not
// taken for Prompt Master.

export const PROMPT_MASTER = 'prompt-master'
export const PROMPT_MASTER_REPO = 'lukeware-hub/prompt-master'

// The two listings, in the order they are read.
export const PLUGIN_LISTINGS = [
  ['plugin', 'list', '--json'],
  ['plugin', 'marketplace', 'list', '--json'],
] as const

type Row = Record<string, unknown>

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((v): v is Row => typeof v === 'object' && v !== null) : [])

// A path as Windows and the other systems both write it: forward slashes, no trailing one, and
// case-folded, since Windows paths are not case-sensitive.
const samePath = (a: string, b: string) => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// Whether a marketplace row comes from github.com/lukeware-hub/prompt-master: as a GitHub source,
// or as a git URL (https or ssh, with or without .git).
export function isPromptMasterMarketplace(row: Row): boolean {
  const repo = typeof row.repo === 'string' ? row.repo.trim().toLowerCase() : ''
  if (row.source === 'github' && repo === PROMPT_MASTER_REPO) return true
  const url = typeof row.url === 'string' ? row.url.trim().toLowerCase() : ''
  const match = url.match(/^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:](.+?)(?:\.git)?\/?$/)
  return row.source === 'git' && match?.[1] === PROMPT_MASTER_REPO
}

// The id of the Lukeware Hub Prompt Master that applies to the folder `cwd`, or null when there is
// none: enabled, installed for the user (or by the organization's managed settings) or for that
// project, from the right marketplace.
export function findPromptMaster(plugins: unknown, marketplaces: unknown, cwd: string): string | null {
  const ours = new Set(
    rowsOf(marketplaces)
      .filter(isPromptMasterMarketplace)
      .map(row => row.name)
      .filter((name): name is string => typeof name === 'string'),
  )
  for (const row of rowsOf(plugins)) {
    if (typeof row.id !== 'string' || row.enabled !== true) continue
    const at = row.id.lastIndexOf('@')
    if (at < 1 || row.id.slice(0, at) !== PROMPT_MASTER || !ours.has(row.id.slice(at + 1))) continue
    if (row.scope === 'user' || row.scope === 'managed') return row.id
    if ((row.scope === 'project' || row.scope === 'local') && typeof row.projectPath === 'string' && samePath(row.projectPath, cwd)) return row.id
  }
  return null
}

// A listing's JSON, or null when it is not JSON (an old `claude`, an error printed instead).
export function parseListing(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}
