#!/usr/bin/env node
/** Explicit isolated preview. Never imports production databases or calls models. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'

const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const split = arg.indexOf('=')
  return [arg.slice(0, split), arg.slice(split + 1)]
}))
const stateDirectory = args['--state-dir']
const sampleVideo = args['--sample-video']
const port = Number(args['--port'] || 3137)
if (!stateDirectory || !sampleVideo || !path.isAbsolute(stateDirectory) || !path.isAbsolute(sampleVideo)
  || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: node scripts/preview-material-graph.mjs --state-dir=<new absolute directory> --sample-video=<synthetic mp4> [--port=3137]')
}
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Use the project Node 22 runtime')
if (!fs.statSync(sampleVideo).isFile()) throw new Error('Synthetic sample video is required')
// Exclusive new state prevents overwriting a previous preview or a real workspace.
fs.mkdirSync(stateDirectory, { mode: 0o700 })
const workspace = path.join(stateDirectory, 'workspace')
const data = path.join(stateDirectory, 'data')
const openclaw = path.join(stateDirectory, 'openclaw')
for (const folder of [workspace, data, openclaw]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(openclaw, 'openclaw.json'), '{}\n', { mode: 0o600 })
const assetNames = { 雪山: ['雪岭远眺', '雪山营地', '高原清晨', '山脊日出', '云层之上', '雪线旅人'], 沙漠: ['沙海独行', '驼队经过', '沙漠落日', '沙粒纹理', '绿洲停留', '沙丘背影'], 海岸: ['海边独坐', '潮汐涌来', '港口清晨', '出海之前', '海岸回望', '远航'], 森林: ['林间雾气', '雨林穿行', '溪流旁', '营火交谈', '树冠之间', '落叶水滴'] }
const fixtureSummary = []
for (const [projectIndex, projectName] of ['本地验收示例 · 旅行素材', '本地验收示例 · 补充素材'].entries()) {
  const base = path.join(workspace, 'bot-learning', projectName)
  fs.mkdirSync(path.join(base, 'raw-data'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(base, 'pipeline'), { mode: 0o700 })
  const indexPath = path.join(base, 'pipeline', 'material_index.sqlite')
  const db = new Database(indexPath)
  db.exec(`CREATE TABLE scene_segments(id INTEGER PRIMARY KEY,label TEXT,start REAL,end REAL,keyframes_json TEXT,transcript TEXT,material_tags_json TEXT);
    CREATE TABLE visual_labels(scene_id INTEGER,status TEXT,result_json TEXT,raw_response TEXT);
    CREATE TABLE frames(id INTEGER PRIMARY KEY); CREATE TABLE audio_segments(id INTEGER PRIMARY KEY); CREATE TABLE shot_segments(id INTEGER PRIMARY KEY);`)
  const sceneStatement = db.prepare('INSERT INTO scene_segments VALUES(?,?,?,?,?,?,?)')
  const visualStatement = db.prepare('INSERT INTO visual_labels VALUES(?,?,?,?)')
  let index = 0, count = 0
  for (const [scene, names] of Object.entries(assetNames)) for (const [i, name] of names.entries()) {
    if (projectIndex === 1 && i > 1) continue
    count++
    const filename = `示例-${name}.mp4`
    fs.copyFileSync(sampleVideo, path.join(base, 'raw-data', filename))
    for (let part = 0; part < 2; part++) {
      index++
      sceneStatement.run(index, `${name} · 位置${part + 1}`, .5 + part * 2, 1.5 + part * 2, '[]', '', '[]')
      visualStatement.run(index, 'done', JSON.stringify({
        source_video: filename,
        scene_tags: i === 0 && part === 1 ? [scene, '公路'] : [scene],
        emotion: [i % 3 === 0 ? '孤独' : i % 3 === 1 ? '震撼' : '温暖'],
        visual_summary: `本地合成验收数据：${name}。场景/情绪标签为测试标注，视频为合成测试图样。`,
      }), '')
    }
  }
  if (projectIndex === 0) {
    fs.copyFileSync(sampleVideo, path.join(base, 'raw-data', '示例-尚未识别.mp4')); count++
  }
  db.close(); fs.chmodSync(indexPath, 0o600)
  fixtureSummary.push({ name: projectName, videos: count, scenes: index })
}
const emptyRoot = path.join(workspace, 'bot-learning', '本地验收示例 · 空素材集')
fs.mkdirSync(path.join(emptyRoot, 'raw-data'), { recursive: true, mode: 0o700 })
const env = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
  MISSION_CONTROL_TEST_MODE: '1', AIWORKER_DISABLE_SCHEDULER: '1',
  MISSION_CONTROL_DATA_DIR: data, MISSION_CONTROL_DB_PATH: path.join(data, 'mission-control.db'),
  MISSION_CONTROL_TOKENS_PATH: path.join(data, 'tokens.json'),
  OPENCLAW_STATE_DIR: openclaw, OPENCLAW_CONFIG_PATH: path.join(openclaw, 'openclaw.json'),
  OPENCLAW_WORKSPACE_DIR: workspace, MC_CLAUDE_HOME: path.join(stateDirectory, 'claude'),
  OPENCLAW_BIN: path.join(product, 'scripts/e2e-openclaw/bin/openclaw'),
  CLAWDBOT_BIN: path.join(product, 'scripts/e2e-openclaw/bin/clawdbot'),
  OPENCLAW_GATEWAY_HOST: '127.0.0.1', OPENCLAW_GATEWAY_PORT: '39997',
  MC_DESKTOP_MODE: '1', MC_OPENCLAW_PROFILES_NO_AUTH: '1',
  MC_OPENCLAW_PROFILE_TARGET: 'local', MC_MATERIALS_WORKSPACE_ROOT: workspace,
  MC_MATERIALS_REMOTE_PYTHON: '/usr/bin/python3', MC_DISABLE_RATE_LIMIT: '1',
  AUTH_USER: 'local-preview', AUTH_PASS: randomBytes(24).toString('base64url'),
  GNAP_ENABLED: 'false', GNAP_AUTO_SYNC: 'false',
}
for (const key of ['MC_SKILLS_USER_AGENTS_DIR', 'MC_SKILLS_USER_CODEX_DIR', 'MC_SKILLS_PROJECT_AGENTS_DIR', 'MC_SKILLS_PROJECT_CODEX_DIR', 'MC_SKILLS_OPENCLAW_DIR']) {
  env[key] = path.join(stateDirectory, 'skills', key.toLowerCase())
}
const logFile = path.join(stateDirectory, 'preview.log')
const log = fs.openSync(logFile, 'wx', 0o600)
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: product, env, stdio: ['ignore', log, log],
})
const receipt = {
  currentState: 'starting', pid: child.pid, supervisorPid: process.pid,
  url: `http://127.0.0.1:${port}/materials?view=graph`, stateDirectory, workspace, logFile,
  dataKind: 'synthetic-local-acceptance', fixtureSummary,
  schedulerDisabled: true, materialsTarget: 'local', node: process.version,
}
const receiptFile = path.join(stateDirectory, 'preview-receipt.json')
fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 })
process.stdout.write(JSON.stringify(receipt) + '\n')
child.on('error', error => { process.stderr.write(String(error)); process.exitCode = 1 })
child.on('exit', code => {
  receipt.currentState = 'stopped'; receipt.exitCode = code
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 })
  fs.closeSync(log); process.exit(code || 0)
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill('SIGTERM') })
