import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createArtifactSigningHook } from './scripts/artifact-sign.mjs'

// Windows release configuration that signs through the Artifact Signing
// account. The unsigned configuration in package.json stays the default so
// local and validation builds need no Azure credentials. Everything here is
// public: the account, profile, endpoint, and certificate subject already
// appear on every signed binary. Authentication comes only from the
// AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET environment
// variables of the build, which must never be written to this repository.
//
// Signing goes through the custom signtool hook in scripts/artifact-sign.mjs
// rather than electron-builder's azureSignOptions, whose PowerShell module no
// longer exists on PowerShell Gallery.

// Common name of the Public Trust certificate issued by the profile below.
export const currentPublisher = 'Jedrzej Kosinski'

// Publishers whose signatures installed applications accept on an update.
// The current publisher must stay listed while installs signed by it exist;
// the company name is listed ahead of time so those installs also accept a
// later company-signed release.
export const acceptedUpdatePublishers = [currentPublisher, 'Dinkster Inc']

export const artifactSigning = {
  endpoint: 'https://wus2.codesigning.azure.net',
  codeSigningAccountName: 'dinkster',
  certificateProfileName: 'dinkster-desktop',
}

// Artifact Signing produces one SHA-256 signature per file, so the hook runs
// once per file instead of electron-builder's default SHA-1 plus SHA-256 pair.
export const signtoolOptions = {
  sign: createArtifactSigningHook(artifactSigning),
  signingHashAlgorithms: ['sha256'],
  publisherName: currentPublisher,
}

export default async function signedConfiguration() {
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, 'package.json'), 'utf8'),
  )
  const { build } = manifest
  return {
    ...build,
    publish: build.publish.map((feed, index) =>
      index === 0 ? { ...feed, publisherName: acceptedUpdatePublishers } : feed,
    ),
    win: {
      ...build.win,
      forceCodeSigning: true,
      signtoolOptions,
    },
  }
}
