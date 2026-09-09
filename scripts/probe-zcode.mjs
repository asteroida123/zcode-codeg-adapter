#!/usr/bin/env node
import { parseArgs, runProbe, saveReport } from '../spikes/backend-contract/probe.mjs'
import { diagnostic } from '../spikes/backend-contract/errors.mjs'
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const HELP = `ZCode backend contract probe (not the ACP agent)
Default: --mock --scenario all; no ZCode, credentials or network required.

--live --zcode /absolute/path/zcode.cjs [--scenario inspect]
--live --zcode /absolute/path/zcode.cjs --scenario session
--live --zcode /absolute/path/zcode.cjs --allow-model --scenario smoke|cancel|resume
--live --zcode /absolute/path/zcode.cjs --allow-model --allow-file-test --scenario deny
--local-error                  Live session only: save the FIRST remote error's text
                               to a private temporary file, not to stdout. May contain
                               secrets; inspect locally, never upload or paste the file.
--out /path/to/new-report.json   Save summary exclusively; never overwrite.

Live model tests use account quota and create native session records. Every permission
request is denied; native tools may run without asking. Temporary cwd is NOT a sandbox.
Use an isolated OS account/container for stronger isolation. No credentials are copied.
Exit: 0 pass (only the selected checks), 1 failed, 2 invalid/unsafe options, 3 inconclusive.
`
try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) process.stdout.write(HELP)
  else {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once('SIGINT', cancel)
    process.once('SIGTERM', cancel)
    try {
      let localErrorPath
      if (options.localError) process.stderr.write('本机诊断已显式开启：错误说明可能含敏感信息，只保存在临时文件，不要上传或完整粘贴。\n')
      const report = await runProbe(options, { signal: controller.signal,
        onLocalErrorFile: path => { localErrorPath = path },
      })
      if (localErrorPath) {
        process.stderr.write(`本机错误文件（排查后请删除）：${JSON.stringify(localErrorPath)}\n`)
        if (process.platform === 'darwin') process.stderr.write(`仅在本机文本编辑器查看：open -t ${shellQuote(localErrorPath)}\n`)
      }
      if (options.out) await saveReport(options.out, report)
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      process.exitCode = report.status === 'pass' ? 0 : report.status === 'inconclusive' ? 3 : 1
    } finally {
      process.removeListener('SIGINT', cancel)
      process.removeListener('SIGTERM', cancel)
    }
  }
} catch (error) {
  process.stderr.write(JSON.stringify(diagnostic(error)) + '\n')
  process.exitCode = 2
}
