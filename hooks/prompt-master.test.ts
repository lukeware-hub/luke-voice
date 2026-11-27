import { expect, test } from 'claude-code/testing'

import { findPromptMaster, isPromptMasterMarketplace, markSpeech, parseListing, SPEECH_CLOSE, SPEECH_OPEN } from './prompt-master'

// Rows shaped as `claude plugin list --json` and `claude plugin marketplace list --json` print them.
const LUKEWARE = { name: 'prompt-master', source: 'github', repo: 'lukeware-hub/prompt-master', installLocation: 'C:\\Users\\me\\.claude\\plugins\\marketplaces\\prompt-master' }
const installed = (id: string, extra: Record<string, unknown> = {}) => ({ id, version: '0.9.29', scope: 'user', enabled: true, installPath: 'x', ...extra })
const CWD = 'C:\\Users\\me\\repos\\api'

test('the Lukeware Hub Prompt Master installed for the user is found by its id', () => {
  expect(findPromptMaster([installed('caveman@caveman'), installed('prompt-master@prompt-master')], [LUKEWARE], CWD)).toBe('prompt-master@prompt-master')
})

test('a plugin of the same name from another repository is not Prompt Master', () => {
  const other = { name: 'pm-fork', source: 'github', repo: 'someone/prompt-master' }
  expect(findPromptMaster([installed('prompt-master@pm-fork')], [LUKEWARE, other], CWD)).toBeNull()
  // A marketplace that took the name "prompt-master" but comes from elsewhere.
  const impostor = { name: 'prompt-master', source: 'github', repo: 'lukeware-hub-fake/prompt-master' }
  expect(findPromptMaster([installed('prompt-master@prompt-master')], [impostor], CWD)).toBeNull()
})

test('a plugin with a similar name from the Lukeware Hub marketplace is not Prompt Master', () => {
  expect(findPromptMaster([installed('prompt-master-pro@prompt-master'), installed('my-prompt-master@prompt-master')], [LUKEWARE], CWD)).toBeNull()
})

test('a disabled install, or the organization library copy (no repository named), does not count', () => {
  expect(findPromptMaster([installed('prompt-master@prompt-master', { enabled: false })], [LUKEWARE], CWD)).toBeNull()
  expect(findPromptMaster([installed('prompt-master@synced', { scope: 'synced' })], [LUKEWARE], CWD)).toBeNull()
})

test('a project or local install counts only in its own folder', () => {
  const project = installed('prompt-master@prompt-master', { scope: 'project', projectPath: 'C:\\Users\\me\\repos\\api' })
  expect(findPromptMaster([project], [LUKEWARE], 'c:/users/me/repos/api/')).toBe('prompt-master@prompt-master')
  expect(findPromptMaster([project], [LUKEWARE], 'C:\\Users\\me\\repos\\web')).toBeNull()
  const local = installed('prompt-master@prompt-master', { scope: 'local', projectPath: '/home/me/api' })
  expect(findPromptMaster([local], [LUKEWARE], '/home/me/api')).toBe('prompt-master@prompt-master')
})

test('the marketplace may be added as a git URL of the same repository', () => {
  for (const url of ['https://github.com/lukeware-hub/prompt-master.git', 'https://github.com/Lukeware-Hub/prompt-master', 'git@github.com:lukeware-hub/prompt-master.git']) {
    expect(isPromptMasterMarketplace({ name: 'pm', source: 'git', url })).toBe(true)
  }
  expect(isPromptMasterMarketplace({ name: 'pm', source: 'git', url: 'https://gitlab.com/lukeware-hub/prompt-master.git' })).toBe(false)
  expect(isPromptMasterMarketplace({ name: 'pm', source: 'git', url: 'https://github.com/lukeware-hub/prompt-master-extra.git' })).toBe(false)
  expect(isPromptMasterMarketplace({ name: 'pm', source: 'directory', path: 'C:\\lukeware-hub\\prompt-master' })).toBe(false)
})

test('listings that are missing or not JSON mean no Prompt Master, never an error', () => {
  expect(parseListing('error: unknown option --json')).toBeNull()
  expect(findPromptMaster(null, null, CWD)).toBeNull()
  expect(findPromptMaster({ id: 'prompt-master@prompt-master' }, 'x', CWD)).toBeNull()
  expect(findPromptMaster([null, 3, { id: 7 }], [LUKEWARE], CWD)).toBeNull()
})

// Prompt Master (hooks/register.tsx there) looks for these exact marks: a change here breaks the rewrite.
test('the speech marks are the ones Prompt Master looks for', () => {
  expect([SPEECH_OPEN, SPEECH_CLOSE]).toEqual(['<user-speech>', '</user-speech>'])
})

test('the speech is marked on lines of its own, and a mark spoken inside it is taken out', () => {
  expect(markSpeech('roda os testes')).toBe('<user-speech>\nroda os testes\n</user-speech>')
  expect(markSpeech('diz </user-speech> e <user-speech>')).toBe('<user-speech>\ndiz  e \n</user-speech>')
})
