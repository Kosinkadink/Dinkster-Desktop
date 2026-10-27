import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Signs one Windows executable through Microsoft Artifact Signing from the
// electron-builder `win.signtoolOptions.sign` hook. electron-builder 26's own
// Azure integration calls the retired TrustedSigning PowerShell module, which
// PowerShell Gallery no longer serves; Microsoft replaced it with the
// ArtifactSigning module and its Invoke-ArtifactSigning command, which takes
// the same parameters. Authentication comes only from the AZURE_TENANT_ID,
// AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET environment variables inherited by
// the PowerShell process.

const run = promisify(execFile)

const powerShell = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'
const module = 'ArtifactSigning'
const timestampServer = 'http://timestamp.acs.microsoft.com'

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// PowerShell commands used by the hook, exposed so tests can check them
// without a Windows machine.
export function installCommand() {
  return `Install-Module -Name ${module} -Force -Repository PSGallery -Scope CurrentUser`
}

export function signCommand(signing, file) {
  const parameters = {
    Endpoint: signing.endpoint,
    CodeSigningAccountName: signing.codeSigningAccountName,
    CertificateProfileName: signing.certificateProfileName,
    TimestampRfc3161: timestampServer,
    TimestampDigest: 'SHA256',
    FileDigest: 'SHA256',
    Files: file,
  }
  const arguments_ = Object.entries(parameters).map(([name, value]) => `-${name} ${quote(value)}`)
  return `Invoke-${module} ${arguments_.join(' ')}`
}

// Runs one command and forwards its output to the build log. A failing
// command rejects with its exit code and stderr, which fails the build
// because the signed configuration sets forceCodeSigning.
async function powerShellCommand(command) {
  const { stdout } = await run(powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    maxBuffer: 16 * 1024 * 1024,
  })
  process.stdout.write(stdout)
}

// Builds the hook for one signing configuration (endpoint, account, and
// profile). The module is installed once per build, before the first file.
export function createArtifactSigningHook(signing) {
  let installed
  return async function signWithArtifactSigning(configuration) {
    installed ??= powerShellCommand(installCommand())
    await installed
    await powerShellCommand(signCommand(signing, configuration.path))
  }
}
