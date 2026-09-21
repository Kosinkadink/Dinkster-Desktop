import { describe, expect, it } from 'vitest'
import { deepLinkFromArgv, parseDeepLink } from '../src/deep-link.js'

describe('parseDeepLink', () => {
  it('parses a full link with project and backend', () => {
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1&project=p-alpha&backend=https%3A%2F%2Fhost%3A8443')).toEqual({
      projectId: 'p-alpha',
      workflowId: 'wf-1',
      backendUrl: 'https://host:8443',
    })
  })

  it('defaults the project and omits an absent backend', () => {
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1')).toEqual({
      projectId: 'default',
      workflowId: 'wf-1',
    })
  })

  it('rejects anything outside the open/workflow grammar', () => {
    expect(parseDeepLink('https://open/workflow?workflow=wf-1')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/other?workflow=wf-1')).toBeUndefined()
    expect(parseDeepLink('dinkster://close/workflow?workflow=wf-1')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow')).toBeUndefined()
    expect(parseDeepLink('not a url')).toBeUndefined()
  })

  it('rejects invalid identifiers as a whole', () => {
    expect(parseDeepLink('dinkster://open/workflow?workflow=')).toBeUndefined()
    expect(parseDeepLink(`dinkster://open/workflow?workflow=${'x'.repeat(513)}`)).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow?workflow=a%00b')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1&project=Not%20Valid')).toBeUndefined()
  })

  it('rejects fragments, unknown keys, and duplicate keys', () => {
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1#section')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1&extra=1')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1&workflow=wf-2')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1&project=p-a&project=p-b')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1&backend=https%3A%2F%2Fh&backend=https%3A%2F%2Fh')).toBeUndefined()
  })

  it('rejects credentials and non-http backends', () => {
    expect(parseDeepLink('dinkster://user:pass@open/workflow?workflow=wf-1')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1&backend=ftp%3A%2F%2Fhost')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1&backend=https%3A%2F%2Fuser%3Apass%40host')).toBeUndefined()
    expect(parseDeepLink('dinkster://open/workflow?workflow=wf-1&backend=not-a-url')).toBeUndefined()
  })

  it('rejects oversized input', () => {
    expect(parseDeepLink(`dinkster://open/workflow?workflow=wf-1&backend=${'a'.repeat(5000)}`)).toBeUndefined()
  })
})

describe('deepLinkFromArgv', () => {
  it('returns the first parseable dinkster:// argument', () => {
    const link = deepLinkFromArgv([
      'C:\\app\\Dinkster.exe',
      '--flag',
      'dinkster://open/other?workflow=skip',
      'dinkster://open/workflow?workflow=wf-2',
    ])
    expect(link).toEqual({ projectId: 'default', workflowId: 'wf-2' })
  })

  it('returns undefined when no argument is a valid link', () => {
    expect(deepLinkFromArgv(['C:\\app\\Dinkster.exe', 'dinkster://nope', 'file.txt'])).toBeUndefined()
  })
})
