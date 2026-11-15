import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

import { artifactSigning } from '../electron-builder.signed.mjs'
import { createArtifactSigningHook } from './artifact-sign.mjs'

const executable = resolve(import.meta.dirname, '../resources/sandbox/wxc-exec.exe')
await access(executable)
await createArtifactSigningHook(artifactSigning)({ path: executable })
