import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { assertNode, checkLauncher, LauncherError, manifest } from '../src/launcher.js'

const execute = promisify(execFile)
const code = expected => error => error instanceof LauncherError && error.code === expected
const launcher = fileURLToPath(new URL('../src/launcher.js', import.meta.url))

test('Runtime: the Node 25 line is accepted alongside pinned 22.16+ and 24', () => {
  for (const node of ['22.16.0', '22.23.0', '24.0.0', '24.9.0', '25.0.0', '25.6.1', process.versions.node]) {
    assert.doesNotThrow(() => assertNode({ node }))
  }
})

test('Runtime: below-floor, unverified majors, prerelease and Bun stay rejected', () => {
  for (const node of ['22.15.9', '23.6.0', '26.0.0', '25.0.0-rc.1', 'v25.6.1', 'bad']) {
    assert.throws(() => assertNode({ node }), code('E_NODE'))
  }
  assert.throws(() => assertNode({ node: '25.6.1', bun: '1.4.0' }), code('E_NODE'))
})

test('Runtime: manifest and lockfile declare the identical engines range', async () => {
  const lock = JSON.parse(await readFile(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'))
  assert.equal(lock.packages[''].engines.node, manifest.engines.node)
  assert.match(manifest.engines.node, /\^22\.16\.0 \|\| \^24\.0\.0 \|\| \^25\.0\.0/)
})

test('Runtime: node:sqlite performs real in-memory reads and writes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE runtime_probe (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)')
    db.prepare('INSERT INTO runtime_probe (marker) VALUES (?)').run('sqlite-ok')
    const row = db.prepare('SELECT marker FROM runtime_probe WHERE id = ?').get(1)
    assert.equal(row.marker, 'sqlite-ok')
  } finally {
    db.close()
  }
})

test('Runtime: launcher precheck and upstream initialization pass in a real subprocess', async t => {
  const configHome = await mkdtemp(join(tmpdir(), 'zcode-runtime-config-'))
  const probe = join(configHome, 'precheck.mjs')
  await writeFile(probe, [
    "import { checkLauncher } from " + JSON.stringify(launcher) + ";",
    "const upstream = await checkLauncher();",
    "console.log(JSON.stringify({ ok: true, name: upstream.name, version: upstream.version, entry: upstream.entry.length > 0 }));",
  ].join('\n'))
  t.after(async () => { await rm(configHome, { recursive: true, force: true, maxRetries: 3 }) })
  const { stdout } = await execute(process.execPath, [probe], {
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    timeout: 30000,
  })
  const result = JSON.parse(stdout)
  assert.equal(result.ok, true)
  assert.equal(result.name, 'zcode-acp-server')
  assert.equal(result.version, manifest.dependencies['zcode-acp-server'])
  assert.equal(result.entry, true)
})
