import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
const files = ['test/backend-contract.test.js', 'test/probe.test.js', 'test/fake-zcode.cjs']
for (const dir of ['spikes/backend-contract', 'scripts']) {
  for (const name of readdirSync(join(root, dir))) if (name.endsWith('.mjs')) files.push(`${dir}/${name}`)
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(1)
}
console.log(`Syntax checked ${files.length} backend-probe files`)
