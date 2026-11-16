import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

export const mxcCommit = 'c66201839d63cae2239db5e92f1f1d6076cf5181'

export async function writeMxcBuild(executable, destination) {
  const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex')
  await writeFile(destination, `${JSON.stringify({
    format: 'dinkster.mxc/1',
    commit: mxcCommit,
    telemetryComponent: '',
    sha256,
  }, null, 2)}\n`)
}
