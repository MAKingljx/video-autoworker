#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyStandaloneBuildRuntime } from './build-standalone.mjs'

const productRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const sha256 = value => createHash('sha256').update(value).digest('hex')

/** Build a separate artifact from the actual worker import/dependency closure. */
export async function buildSchedulerWorker(outputPath) {
  const runtime = { ...verifyStandaloneBuildRuntime(), platform: process.platform, arch: process.arch }
  const output = resolve(outputPath)
  mkdirSync(output, { recursive: false, mode: 0o700 })
  const staging = join(productRoot, '.next', `scheduler-worker-build-${randomUUID()}`)
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    const { webpack } = require('next/dist/compiled/webpack/webpack')
    const externalScripts = new Set()
    const compiler = webpack({
      mode: 'production', target: 'node22', context: productRoot,
      entry: { 'worker-runtime': './src/workers/scheduler-worker.ts', 'database-runtime': './src/workers/prepare-database.ts' },
      output: { path: staging, filename: '[name].cjs', chunkFilename: '[id].cjs', library: { type: 'commonjs2' } },
      resolve: { extensions: ['.ts', '.tsx', '.mjs', '.js', '.json'], alias: { '@': join(productRoot, 'src') } },
      module: { rules: [{ test: /\.tsx?$/u, exclude: /node_modules/u,
        use: [{ loader: join(productRoot, 'scripts/lib/scheduler-worker-typescript-loader.cjs') }] }] },
      externalsPresets: { node: true },
      externals: [({ request, context }, callback) => {
        // Keep reusable ESM CLI modules at their real artifact-relative paths;
        // bundling import.meta.url would bake the build host's path into them.
        if (request?.startsWith('.') && request.endsWith('.mjs')) {
          const source = resolve(context, request)
          if (!source.startsWith(`${productRoot}/scripts/`)
            && !source.startsWith(`${productRoot}/openclaw-skills/`)) {
            return callback(new Error('scheduler_worker_esm_path_invalid'))
          }
          externalScripts.add(source)
          callback(null, `commonjs ./${relative(productRoot, source)}`)
        } else if (request && !request.startsWith('.') && !request.startsWith('@/') && !isAbsolute(request)) {
          callback(null, `commonjs ${request}`)
        } else callback()
      }],
      optimization: { minimize: false, moduleIds: 'deterministic', chunkIds: 'deterministic' },
      devtool: false,
    })
    const stats = await new Promise((resolveStats, reject) => compiler.run((error, value) => {
      if (error || value?.hasErrors()) reject(error || new Error(value.toString({ all: false, errors: true })))
      else resolveStats(value)
    }))
    await new Promise((done, reject) => compiler.close(error => error ? reject(error) : done()))
    writeFileSync(join(staging, 'worker.cjs'),
      "require('./worker-runtime.cjs').startSchedulerWorker().catch(error => { process.stderr.write(error.message + '\\n'); process.exitCode = 1 })\n")
    writeFileSync(join(staging, 'prepare-database.cjs'),
      "if (process.argv[2] !== '--prepare-existing' || !process.env.MISSION_CONTROL_DB_PATH) throw new Error('database_prepare_requires_explicit_existing_target'); process.stdout.write(JSON.stringify(require('./database-runtime.cjs').prepareExistingDatabase(process.env.MISSION_CONTROL_DB_PATH)) + '\\n')\n")
    const sourceMembers = [...stats.compilation.fileDependencies]
      .filter(pathname => pathname.startsWith(`${productRoot}/`)
        && !pathname.includes('/node_modules/') && !pathname.startsWith(`${staging}/`))
      .filter(pathname => lstatSync(pathname).isFile())
      .map(pathname => relative(productRoot, pathname))
    const cliRoots = ['scripts/feishu-director-brain.mjs']
    const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft')
    const entries = [...readdirSync(staging).filter(name => name.endsWith('.cjs')).map(name => join(staging, name)),
      ...cliRoots.map(name => join(productRoot, name)), ...externalScripts]
    const trace = await nodeFileTrace(entries, { base: productRoot, processCwd: productRoot,
      mixedModules: true })
    const sourceReceiptPrefix = `${relative(productRoot, staging)}/source-receipts/`
    const files = new Set([...trace.fileList].filter(member => !member.startsWith(sourceReceiptPrefix)))
    for (const member of ['ops/feishu-director-brain/schema.json', 'src/lib/schema.sql',
      'scripts/database-backup.py']) files.add(member)
    const copiedSources = new Map()
    for (const member of [...files].sort((left, right) => left.split('/').length - right.split('/').length
      || left.localeCompare(right))) {
      const source = resolve(productRoot, member)
      if (!source.startsWith(`${productRoot}/`)) throw new Error('scheduler_worker_dependency_outside_product')
      const targetMember = source.startsWith(`${staging}/`) ? relative(staging, source) : member
      if (/(^|\/)(?:\.PhoenixBrain|\.env(?:\.|$)|memory|private|output|rollback)(\/|$)/u.test(targetMember)) {
        throw new Error(`scheduler_worker_private_member:${targetMember}`)
      }
      const target = resolve(output, targetMember)
      mkdirSync(dirname(target), { recursive: true })
      const sourceInfo = lstatSync(source)
      if (sourceInfo.isDirectory()) { mkdirSync(target, { recursive: true }); continue }
      if (sourceInfo.isSymbolicLink()) {
        symlinkSync(readlinkSync(source), target)
      } else {
        copyFileSync(source, target)
        chmodSync(target, sourceInfo.mode & 0o777)
      }
      if (!member.startsWith('node_modules/') && !source.startsWith(`${staging}/`)) {
        sourceMembers.push(member)
        copiedSources.set(member, sha256(readFileSync(target)))
      }
    }
    for (const member of ['package.json', 'pnpm-lock.yaml', '.nvmrc', 'scripts/build-scheduler-worker.mjs',
      'scripts/lib/scheduler-worker-typescript-loader.cjs', 'scripts/start-scheduler-worker.mjs',
      'ops/scheduler-worker/launch-agent.plist.template']) sourceMembers.push(member)
    const sources = [...new Set(sourceMembers)].sort().map(member => ({
      path: member, sha256: sha256(readFileSync(join(productRoot, member))),
    }))
    const sourceHashes = new Map(sources.map(source => [source.path, source.sha256]))
    for (const receipt of readdirSync(join(staging, 'source-receipts'))) {
      const observed = JSON.parse(readFileSync(join(staging, 'source-receipts', receipt), 'utf8'))
      if (sourceHashes.get(observed.path) !== observed.sha256) throw new Error('scheduler_worker_source_changed_during_build')
    }
    for (const [member, hash] of copiedSources) {
      if (sourceHashes.get(member) !== hash) throw new Error('scheduler_worker_source_changed_during_copy')
    }
    const members = []
    const walk = (root, prefix = '') => {
      for (const name of readdirSync(root).sort()) {
        const member = prefix ? `${prefix}/${name}` : name
        const pathname = join(root, name)
        const info = lstatSync(pathname)
        if (info.isSymbolicLink()) {
          const real = realpathSync(pathname)
          if (!real.startsWith(`${output}/`)) throw new Error(`scheduler_worker_external_symlink:${member}`)
          members.push({ path: member, type: 'symlink', target: readlinkSync(pathname), mode: info.mode & 0o777 })
        } else if (info.isDirectory()) walk(pathname, member)
        else if (info.isFile()) members.push({ path: member, type: 'file', size: info.size,
          sha256: sha256(readFileSync(pathname)), mode: info.mode & 0o777 })
        else throw new Error('scheduler_worker_member_invalid')
      }
    }
    walk(output)
    const contentSha256 = sha256(JSON.stringify({ runtime, sources, members }))
    const manifest = { schema: 'video-autoworker-scheduler-artifact/v1', contentSha256,
      runtime, sources, members, externalRuntimeContracts: ['director-evidence-transformer', 'OpenClaw', 'model-route-registry'] }
    writeFileSync(join(output, 'worker-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
    return { output, contentSha256, files: members.length, sourceFiles: sources.length, runtime,
      warnings: stats.toJson({ all: false, warnings: true }).warnings?.map(item => item.message) || [] }
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--output')
  if (index < 0 || !process.argv[index + 1]) throw new Error('scheduler_worker_output_required')
  buildSchedulerWorker(process.argv[index + 1]).then(value => process.stdout.write(`${JSON.stringify(value)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
