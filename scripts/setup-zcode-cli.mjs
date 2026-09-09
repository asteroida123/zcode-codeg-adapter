#!/usr/bin/env node
/** One-time, opt-in local setup. Not imported by either ACP launcher or probe.
 * Only the selected desktop provider and a model.main string enter CLI config.
 * Never read credentials.json, print config values, or contact a provider.
 */
import { constants } from 'node:fs'
import { open, lstat, mkdir, writeFile, link, rename, unlink, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createInterface } from 'node:readline/promises'

export class SetupError extends Error {
  constructor(code) { super(code); this.name = 'SetupError'; this.code = code }
}
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const validId = x => typeof x === 'string' && x.length > 0 && x.length <= 160 &&
  x.trim() === x && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(x) &&
  !['__proto__', 'prototype', 'constructor'].includes(x)
const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const fail = code => { throw new SetupError(code) }

async function directory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e })
  let s
  try { s = await lstat(path) } catch (e) { if (e.code === 'ENOENT') return false; throw e }
  if (s.isSymbolicLink() || !s.isDirectory()) fail('E_UNSAFE_PATH')
  return true
}
async function jsonFile(path) {
  let h
  try {
    const s = await lstat(path)
    if (s.isSymbolicLink() || !s.isFile()) fail('E_UNSAFE_PATH')
    h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const f = await h.stat()
    if (!f.isFile() || f.size > 1024 * 1024) fail('E_CONFIG_FORMAT')
    const raw = await h.readFile()
    if (raw.length > 1024 * 1024) fail('E_CONFIG_FORMAT')
    let data
    try { data = JSON.parse(raw.toString('utf8')) } catch { fail('E_CONFIG_FORMAT') }
    if (!record(data)) fail('E_CONFIG_FORMAT')
    return { raw, data, ino: f.ino, dev: f.dev }
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  } finally { await h?.close() }
}

export function choicesFrom(desktop) {
  if (!record(desktop) || !record(desktop.provider)) fail('E_NO_DESKTOP_PROVIDER')
  const choices = []
  for (const [providerId, provider] of Object.entries(desktop.provider)) {
    if (!record(provider) || provider.enabled !== true) continue
    if (!validId(providerId) || providerId.includes('/') || !validId(provider.kind) ||
        !record(provider.options) || !record(provider.models)) continue
    for (const modelId of Object.keys(provider.models)) {
      if (validId(modelId)) choices.push({ providerId, modelId })
      if (choices.length > 256) fail('E_CONFIG_FORMAT')
    }
  }
  if (!choices.length) fail('E_NO_DESKTOP_PROVIDER')
  return choices
}

export async function inspectSetup(home = homedir()) {
  const canonicalHome = await realpath(home)
  const base = join(canonicalHome, '.zcode')
  const within = relative(repoRoot, base)
  if (within === '' || (!within.startsWith('..') && !isAbsolute(within))) fail('E_UNSAFE_PATH')
  if (!await directory(base) || !await directory(join(base, 'v2'))) fail('E_NO_DESKTOP_PROVIDER')
  const sourcePath = join(base, 'v2', 'config.json')
  const source = await jsonFile(sourcePath)
  if (!source) fail('E_NO_DESKTOP_PROVIDER')
  const cliDir = join(base, 'cli')
  const targetPath = join(cliDir, 'config.json')
  const target = await directory(cliDir) ? await jsonFile(targetPath) : null
  return { base, cliDir, sourcePath, targetPath, source, target, choices: choicesFrom(source.data) }
}

export function buildConfig(snapshot, choiceIndex) {
  if (!Number.isSafeInteger(choiceIndex) || !snapshot.choices[choiceIndex]) fail('E_SELECTION')
  const cli = snapshot.target?.data ?? {}
  if ((cli.model !== undefined && !record(cli.model)) ||
      (cli.provider !== undefined && !record(cli.provider))) fail('E_CONFIG_FORMAT')
  // An existing explicit selection needs diagnosis, not an automatic replacement.
  if (typeof cli.model?.main === 'string' && cli.model.main.trim()) fail('E_EXISTING_MODEL')
  const { providerId, modelId } = snapshot.choices[choiceIndex]
  const provider = structuredClone(snapshot.source.data.provider[providerId])
  if (Object.hasOwn(cli.provider ?? {}, providerId) && !isDeepStrictEqual(cli.provider[providerId], provider)) {
    fail('E_PROVIDER_CONFLICT')
  }
  return { ...structuredClone(cli),
    provider: { ...structuredClone(cli.provider ?? {}), [providerId]: provider },
    model: { ...structuredClone(cli.model ?? {}), main: `${providerId}/${modelId}` },
  }
}

async function assertUnchanged(snapshot) {
  await directory(snapshot.base)
  await directory(join(snapshot.base, 'v2'))
  await directory(snapshot.cliDir)
  for (const [path, before] of [[snapshot.sourcePath, snapshot.source], [snapshot.targetPath, snapshot.target]]) {
    const now = await jsonFile(path)
    if (Boolean(now) !== Boolean(before) || (now &&
      (now.ino !== before.ino || now.dev !== before.dev || !now.raw.equals(before.raw)))) fail('E_CHANGED')
  }
}

export async function applySetup(snapshot, choiceIndex, { confirmed = false } = {}) {
  if (confirmed !== true) fail('E_CONFIRM')
  const data = buildConfig(snapshot, choiceIndex)
  await directory(snapshot.cliDir, true)
  const lockPath = join(snapshot.cliDir, '.codeg-setup.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) }
  catch (e) { if (e.code === 'EEXIST') fail('E_LOCKED'); throw e }
  const suffix = randomBytes(8).toString('hex')
  const temporary = join(snapshot.cliDir, `.codeg-setup-${suffix}.tmp`)
  let backupName = null
  try {
    await assertUnchanged(snapshot)
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    if (snapshot.target) {
      backupName = `config.json.before-codeg-${suffix}.bak`
      await writeFile(join(snapshot.cliDir, backupName), snapshot.target.raw, { flag: 'wx', mode: 0o600 })
    }
    await assertUnchanged(snapshot)
    // Own setup processes share a lock; ZCode does not. Quit ZCode before setup.
    // The pre-replace checks are not atomic CAS against third-party writers.
    if (snapshot.target) await rename(temporary, snapshot.targetPath)
    else await link(temporary, snapshot.targetPath) // Atomic create-only, no clobber.
    return { status: 'written', backedUp: backupName !== null, backupName,
      authenticationVerified: false, sessionVerified: false }
  } finally {
    try { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e }) }
    finally {
      try { await lock.close() } finally { await unlink(lockPath) }
    }
  }
}

const explanations = {
  E_ARGS: '仅支持无参数（只读检查）、--apply（本机确认后写入）或 --help。',
  E_TTY: '--apply 必须在交互式终端运行；不支持管道自动确认。',
  E_NO_DESKTOP_PROVIDER: '没有找到可选的已启用桌面 provider/model；未改动配置，不要提供密钥文件。',
  E_UNSAFE_PATH: '配置路径含符号链接、非普通文件或落入仓库；已拒绝操作。',
  E_CONFIG_FORMAT: '现有配置格式不受本工具支持；保留原样。',
  E_EXISTING_MODEL: 'CLI 已有非空 model.main；不能假定它无效并覆盖，请继续诊断原配置。',
  E_PROVIDER_CONFLICT: 'CLI 已有同 ID 但不同内容的 provider；保留原样，拒绝覆盖。',
  E_SELECTION: '模型编号无效；未写入。',
  E_CONFIRM: '未明确确认；未写入。',
  E_CHANGED: '配置在检查后发生变化；停止写入，请关闭 ZCode 后重新检查。',
  E_LOCKED: '另一次配置操作的锁已存在；未覆盖配置或锁。',
  E_SETUP_IO: '本机配置操作失败；未输出文件内容或原始异常。请检查文件权限。',
}
export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length && !['--apply', '--help'].includes(args[0]))) fail('E_ARGS')
  if (args[0] === '--help') {
    console.log('node scripts/setup-zcode-cli.mjs [--apply]\n无参数只读检查；--apply 在本机选择模型并输入 APPLY 后才写入。\n读取桌面 v2/config.json，复制一个选中的 provider（可能含 API key）到 cli/config.json。\n不读取 credentials.json；不联网、不运行 ZCode、不修改桌面配置。写入前请关闭 ZCode。')
    return
  }
  const apply = args[0] === '--apply'
  if (apply && (!process.stdin.isTTY || !process.stdout.isTTY)) fail('E_TTY')
  if (apply) console.log('一次性本机配置：读取桌面 provider（可能含 API key），确认后复制到 CLI。\n不会读取 credentials.json、打印密钥、联网或运行模型。请先退出 ZCode App 和其他 ZCode CLI。')
  const snapshot = await inspectSetup()
  if (!apply) {
    console.log(JSON.stringify({ status: 'inspected', writes: false,
      cliConfigExists: snapshot.target !== null,
      cliModelReferencePresent: typeof snapshot.target?.data.model?.main === 'string' && Boolean(snapshot.target.data.model.main.trim()),
      selectableModels: snapshot.choices.length,
      authenticationVerified: false, sessionVerified: false }, null, 2))
    return
  }
  console.log('选择你要用于 CLI 的模型（不会默认选择列表第一项）：')
  snapshot.choices.forEach((choice, i) => console.log(`${i + 1}. ${JSON.stringify(choice.providerId)} / ${JSON.stringify(choice.modelId)}`))
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question('模型编号：')).trim()
    if (!/^[1-9]\d{0,2}$/.test(answer)) fail('E_SELECTION')
    const index = Number(answer) - 1
    buildConfig(snapshot, index) // Reject conflicts before asking for write consent.
    console.log(snapshot.target ? '将保留其他 CLI 字段，先备份原文件，再写入选定 provider 和 model.main。' : '将新建 ~/.zcode/cli/config.json（文件权限 0600）。')
    if ((await rl.question('确认已关闭 ZCode，且同意本机配置复制，请输入 APPLY；其他输入取消：')).trim() !== 'APPLY') fail('E_CONFIRM')
    const result = await applySetup(snapshot, index, { confirmed: true })
    console.log('CLI 配置已写入；尚未验证认证、模型调用或会话。')
    if (result.backupName) console.log(`原文件备份：~/.zcode/cli/${result.backupName}（可能含密钥，请勿上传）`)
  } finally { rl.close() }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    const code = error instanceof SetupError && Object.hasOwn(explanations, error.code) ? error.code : 'E_SETUP_IO'
    console.error(`${code}: ${explanations[code]}`)
    process.exitCode = 1
  })
}
