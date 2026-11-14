import { readFile } from 'node:fs/promises'

export default async function signedMacConfiguration() {
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]?.trim()) throw new Error(`Signed macOS packaging requires ${name}`)
  }
  const { build } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  const { identity: _unsignedIdentity, ...mac } = build.mac
  return {
    ...build,
    mac: {
      ...mac,
      type: 'distribution',
      forceCodeSigning: true,
      hardenedRuntime: true,
      notarize: true,
    },
  }
}
