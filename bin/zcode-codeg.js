#!/usr/bin/env node
import {
  LauncherError, checkLauncher, manifest, parseArgs, startServer, upstreamVersion,
} from '../src/launcher.js'

try {
  switch (parseArgs(process.argv.slice(2))) {
    case 'version':
      process.stdout.write(`${manifest.version}\n`)
      break
    case 'help':
      process.stdout.write(
        'Usage: zcode-codeg [server | doctor | --version | --help]\n' +
        '\nNo arguments: ACP over stdio, without a TUI or remote listener.\n' +
        'doctor: JSON checks for the launcher only; no login or model call.\n' +
        `Pinned upstream: zcode-acp-server@${upstreamVersion}\n` +
        'ZCODE_BIN / ZCODE_NODE / ZCODE_MODEL / ZCODE_BASE_URL are passed through.\n' +
        'Remote access and hub boot routing are disabled for this profile.\n'
      )
      break
    case 'doctor': {
      const upstream = await checkLauncher()
      process.stdout.write(JSON.stringify({
        ok: true,
        scope: 'launcher-only',
        adapterVersion: manifest.version,
        nodeVersion: process.versions.node,
        upstream: `${upstream.name}@${upstream.version}`,
        checks: ['node', 'node:sqlite', 'remote-config', 'upstream-manifest', 'upstream-entry-resolution'],
        zcodeInstallation: 'not-checked',
        authentication: 'not-checked',
        acpHandshake: 'not-checked',
      }) + '\n')
      break
    }
    case 'server':
      await startServer()
      break
  }
} catch (error) {
  const known = error instanceof LauncherError
  process.stderr.write(`[zcode-codeg] ${known ? error.code : 'E_STARTUP'}: ${known ? error.message : 'Startup failed. Run doctor and check the installation.'}\n`)
  process.exitCode = known && error.code === 'E_ARGS' ? 2 : 1
}
