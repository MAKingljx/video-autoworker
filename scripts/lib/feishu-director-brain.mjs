import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const API_ROOT = 'https://open.feishu.cn/open-apis'
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const DEFAULT_SCHEMA_PATH = resolve(MODULE_ROOT, 'ops/feishu-director-brain/schema.json')
export const DEFAULT_CATALOG_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Video AutoWorker',
  'director-brain',
  'test-catalog.json',
)
export const DEFAULT_CATALOG_ROOT = dirname(DEFAULT_CATALOG_PATH)

const TOKEN_EXPIRY_MARGIN_MS = 60_000
const FIELD_TYPES = new Set([1, 2, 3, 4, 5])
const DEFAULT_STARTER_FIELD_NAMES = new Set(['单选', '日期', '附件'])
const SECRET_FIELD_PATTERN = /(?:secret|token|password|密码|密钥|私钥)/iu
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:app_secret|client_secret)\s*[:=]\s*\S+/iu,
]

let cachedToken = null

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + '_must_be_object')
  }
  return value
}

function requireNonEmpty(value, label) {
  const text = String(value || '').trim()
  if (!text) throw new Error(label + '_required')
  return text
}

function stableUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(label + '_must_be_unique')
}

export function validateDirectorBrainSchema(raw) {
  const schema = requireObject(raw, 'schema')
  if (Number(schema.schemaVersion) !== 1) throw new Error('schema_version_unsupported')
  requireNonEmpty(schema.brainName, 'brain_name')
  requireNonEmpty(schema.projectId, 'project_id')
  requireNonEmpty(schema.environment, 'environment')
  requireNonEmpty(schema.keychainService, 'keychain_service')
  if (!Array.isArray(schema.tables) || schema.tables.length !== 10) {
    throw new Error('director_brain_requires_exactly_ten_tables')
  }

  const tableKeys = []
  const tableNames = []
  for (const tableValue of schema.tables) {
    const table = requireObject(tableValue, 'table')
    tableKeys.push(requireNonEmpty(table.key, 'table_key'))
    tableNames.push(requireNonEmpty(table.name, 'table_name'))
    const stableId = requireNonEmpty(table.stableId, 'stable_id')
    if (!Array.isArray(table.fields) || table.fields.length < 3 || table.fields.length > 100) {
      throw new Error('table_field_count_invalid:' + table.key)
    }
    const fieldNames = []
    let primaryCount = 0
    for (const fieldValue of table.fields) {
      const field = requireObject(fieldValue, 'field')
      const fieldName = requireNonEmpty(field.name, 'field_name')
      fieldNames.push(fieldName)
      if (!Number.isInteger(field.type) || !FIELD_TYPES.has(field.type)) {
        throw new Error('field_type_unsupported:' + table.key + ':' + fieldName)
      }
      if (field.primary === true) primaryCount += 1
      if ((Number(field.type) === 3 || Number(field.type) === 4)) {
        if (!Array.isArray(field.options) || field.options.length === 0) {
          throw new Error('select_options_required:' + table.key + ':' + fieldName)
        }
        stableUnique(field.options.map(String), 'select_options:' + table.key + ':' + fieldName)
      }
      if (SECRET_FIELD_PATTERN.test(fieldName)) {
        throw new Error('secret_field_forbidden:' + table.key + ':' + fieldName)
      }
    }
    stableUnique(fieldNames, 'field_names:' + table.key)
    if (primaryCount !== 1 || table.fields[0].primary !== true) {
      throw new Error('first_field_must_be_only_primary:' + table.key)
    }
    if (Number(table.fields[0].type) !== 1) {
      throw new Error('primary_field_must_be_text:' + table.key)
    }
    const stableIdField = table.fields.find(field => field.name === stableId)
    if (!stableIdField) {
      throw new Error('stable_id_field_missing:' + table.key)
    }
    if (Number(stableIdField.type) !== 1) {
      throw new Error('stable_id_field_must_be_text:' + table.key)
    }
  }
  stableUnique(tableKeys, 'table_keys')
  stableUnique(tableNames, 'table_names')
  return schema
}

export async function loadDirectorBrainSchema(pathname = DEFAULT_SCHEMA_PATH) {
  const raw = JSON.parse(await readFile(pathname, 'utf8'))
  return validateDirectorBrainSchema(raw)
}

function fieldPayload(field) {
  const payload = {
    field_name: field.name,
    type: Number(field.type),
  }
  if (field.type === 3 || field.type === 4) {
    payload.ui_type = field.type === 3 ? 'SingleSelect' : 'MultiSelect'
    payload.property = {
      options: field.options.map((name, index) => ({ name, color: index % 55 })),
    }
  } else if (field.type === 5) {
    payload.ui_type = 'DateTime'
    payload.property = { date_formatter: 'yyyy-MM-dd' }
  }
  return payload
}

function redactApiMessage(value) {
  return String(value || 'unknown_error')
    .replace(/(?:app_secret|client_secret|authorization)[^,}\n]*/giu, '[redacted]')
    .slice(0, 800)
}

async function requestJson(method, path, options = {}) {
  const url = new URL(API_ROOT + path)
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(options.accessToken ? { Authorization: 'Bearer ' + options.accessToken } : {}),
    },
    ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  })
  const raw = await response.text()
  let payload = null
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    throw new Error('feishu_response_invalid_json:' + response.status)
  }
  if (!response.ok) {
    throw new Error('feishu_http_error:' + response.status + ':' + redactApiMessage(payload?.msg || raw))
  }
  if (payload?.code !== 0) {
    throw new Error('feishu_api_error:' + String(payload?.code) + ':' + redactApiMessage(payload?.msg))
  }
  return payload
}

async function keychainSecret(appId, service) {
  const result = await execFileAsync('security', [
    'find-generic-password',
    '-a',
    appId,
    '-s',
    service,
    '-w',
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }).catch(error => {
    const stderr = String(error?.stderr || '')
    if (/could not be found|item not found|errSecItemNotFound|找不到/iu.test(stderr)) {
      throw new Error('director_brain_keychain_secret_missing')
    }
    throw new Error('director_brain_keychain_unavailable')
  })
  const secret = String(result.stdout || '').trim()
  if (!secret) throw new Error('director_brain_keychain_secret_missing')
  return secret
}

async function tenantAccessToken(appId, service) {
  const now = Date.now()
  if (cachedToken
    && cachedToken.appId === appId
    && cachedToken.service === service
    && cachedToken.expiresAt > now) {
    return cachedToken.value
  }
  const appSecret = await keychainSecret(appId, service)
  const response = await requestJson('POST', '/auth/v3/tenant_access_token/internal', {
    payload: { app_id: appId, app_secret: appSecret },
  })
  cachedToken = {
    appId,
    service,
    value: response.tenant_access_token,
    expiresAt: now + Math.max(1_000, Number(response.expire || 7200) * 1000 - TOKEN_EXPIRY_MARGIN_MS),
  }
  return cachedToken.value
}

export function validateDirectorBrainCatalogPath(pathname, catalogRoot = DEFAULT_CATALOG_ROOT) {
  if (!isAbsolute(pathname)) throw new Error('catalog_path_must_be_absolute')
  const root = resolve(catalogRoot)
  const target = resolve(pathname)
  if (dirname(target) !== root) throw new Error('catalog_path_outside_private_root')
  return target
}

async function pathStats(pathname) {
  try {
    return await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function ensureCatalogRoot(root, create) {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  const stats = await pathStats(root)
  if (!stats) return false
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('catalog_root_must_be_private_directory')
  }
  if (resolve(await realpath(root)) !== root) throw new Error('catalog_root_symlink_forbidden')
  if ((stats.mode & 0o077) !== 0) {
    if (!create) throw new Error('catalog_root_permissions_too_open')
    await chmod(root, 0o700)
  }
  return true
}

async function assertCatalogFileSafe(target) {
  const stats = await pathStats(target)
  if (!stats) return null
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('catalog_file_must_be_regular')
  if ((stats.mode & 0o077) !== 0) throw new Error('catalog_file_permissions_too_open')
  return stats
}

async function readCatalog(pathname) {
  const target = validateDirectorBrainCatalogPath(pathname)
  const root = dirname(target)
  if (!await ensureCatalogRoot(root, false)) return null
  if (!await assertCatalogFileSafe(target)) return null
  return requireObject(JSON.parse(await readFile(target, 'utf8')), 'catalog')
}

async function prepareCatalogRoot(pathname) {
  const target = validateDirectorBrainCatalogPath(pathname)
  await ensureCatalogRoot(dirname(target), true)
}

async function writeCatalog(pathname, catalog) {
  const target = validateDirectorBrainCatalogPath(pathname)
  const root = dirname(target)
  await ensureCatalogRoot(root, true)
  await assertCatalogFileSafe(target)
  const temporary = target + '.tmp-' + process.pid + '-' + randomUUID()
  let temporaryCreated = false
  try {
    await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    temporaryCreated = true
    await rename(temporary, target)
    temporaryCreated = false
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => {})
  }
  await chmod(target, 0o600)
}

export function validateDirectorBrainCatalog(raw, schema, options = {}) {
  const catalog = requireObject(raw, 'catalog')
  if (Number(catalog.schemaVersion) !== 1) throw new Error('catalog_schema_version_mismatch')
  if (requireNonEmpty(catalog.brainName, 'catalog_brain_name') !== schema.brainName) {
    throw new Error('catalog_brain_name_mismatch')
  }
  if (requireNonEmpty(catalog.projectId, 'catalog_project_id') !== schema.projectId) {
    throw new Error('catalog_project_id_mismatch')
  }
  if (requireNonEmpty(catalog.environment, 'catalog_environment') !== schema.environment) {
    throw new Error('catalog_environment_mismatch')
  }
  if (requireNonEmpty(catalog.keychainService, 'catalog_keychain_service') !== schema.keychainService) {
    throw new Error('catalog_keychain_service_mismatch')
  }
  requireNonEmpty(catalog.appId, 'catalog_app_id')
  requireNonEmpty(catalog.appToken, 'catalog_app_token')
  requireObject(catalog.tables, 'catalog_tables')
  const expectedByKey = new Map(schema.tables.map(table => [table.key, table]))
  const catalogKeys = Object.keys(catalog.tables)
  for (const key of catalogKeys) {
    if (!expectedByKey.has(key)) throw new Error('catalog_table_key_unexpected:' + key)
  }
  if (options.allowPartialTables !== true && catalogKeys.length !== schema.tables.length) {
    throw new Error('catalog_table_count_mismatch')
  }
  for (const [key, refValue] of Object.entries(catalog.tables)) {
    const ref = requireObject(refValue, 'catalog_table:' + key)
    if (requireNonEmpty(ref.name, 'catalog_table_name:' + key) !== expectedByKey.get(key).name) {
      throw new Error('catalog_table_name_mismatch:' + key)
    }
    requireNonEmpty(ref.tableId, 'catalog_table_id:' + key)
  }
  stableUnique(
    Object.values(catalog.tables).map(ref => ref.tableId),
    'catalog_table_ids',
  )
  return catalog
}

function runtimeContext(schema, catalog, appIdOverride, options = {}) {
  const validatedCatalog = catalog
    ? validateDirectorBrainCatalog(catalog, schema, options)
    : null
  const appId = requireNonEmpty(appIdOverride || validatedCatalog?.appId, 'app_id')
  if (validatedCatalog?.appId && validatedCatalog.appId !== appId) {
    throw new Error('catalog_app_id_mismatch')
  }
  return {
    schema,
    catalog: validatedCatalog,
    appId,
    service: schema.keychainService,
  }
}

async function listPaged(accessToken, path, itemKey = 'items', extraQuery = {}) {
  const items = []
  let pageToken = null
  do {
    const response = await requestJson('GET', path, {
      accessToken,
      query: {
        page_size: 100,
        ...extraQuery,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    })
    const data = response.data || {}
    items.push(...(Array.isArray(data[itemKey]) ? data[itemKey] : []))
    if (!data.has_more) break
    pageToken = data.page_token
    if (!pageToken) throw new Error('feishu_page_token_missing')
  } while (pageToken)
  return items
}

async function listTables(accessToken, appToken) {
  return listPaged(accessToken, '/bitable/v1/apps/' + appToken + '/tables')
}

async function listFields(accessToken, appToken, tableId) {
  return listPaged(
    accessToken,
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields',
  )
}

async function listRecords(accessToken, appToken, tableId, filter) {
  return listPaged(
    accessToken,
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records',
    'items',
    filter ? { filter } : {},
  )
}

async function createBitable(accessToken, name) {
  const response = await requestJson('POST', '/bitable/v1/apps', {
    accessToken,
    payload: { name, time_zone: 'Asia/Shanghai' },
  })
  return response.data.app
}

async function renameTable(accessToken, appToken, tableId, name) {
  await requestJson('PATCH', '/bitable/v1/apps/' + appToken + '/tables/' + tableId, {
    accessToken,
    payload: { name },
  })
}

async function createTable(accessToken, appToken, table) {
  const response = await requestJson('POST', '/bitable/v1/apps/' + appToken + '/tables', {
    accessToken,
    payload: {
      table: {
        name: table.name,
        default_view_name: '默认视图',
        fields: table.fields.map(fieldPayload),
      },
    },
  })
  return response.data.table_id
}

async function createField(accessToken, appToken, tableId, field) {
  await requestJson(
    'POST',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields',
    { accessToken, payload: fieldPayload(field) },
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 120))
}

async function updateField(accessToken, appToken, tableId, fieldId, payload) {
  await requestJson(
    'PUT',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields/' + fieldId,
    { accessToken, payload },
  )
}

async function deleteField(accessToken, appToken, tableId, fieldId) {
  await requestJson(
    'DELETE',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields/' + fieldId,
    { accessToken },
  )
}

async function ensureSelectOptions(accessToken, appToken, tableId, observed, expected) {
  const existing = Array.isArray(observed.property?.options) ? observed.property.options : []
  const existingNames = new Set(existing.map(option => option.name))
  const missing = expected.options.filter(name => !existingNames.has(name))
  if (!missing.length) return false
  await updateField(accessToken, appToken, tableId, observed.field_id, {
    field_name: observed.field_name,
    type: observed.type,
    property: {
      options: [
        ...existing,
        ...missing.map((name, index) => ({ name, color: (existing.length + index) % 55 })),
      ],
    },
  })
  return true
}

async function ensureTableFields(accessToken, appToken, tableId, table) {
  const observed = await listFields(accessToken, appToken, tableId)
  const byName = new Map(observed.map(field => [field.field_name, field]))
  const expectedPrimary = table.fields[0]
  const primaries = observed.filter(field => field.is_primary)
  if (primaries.length !== 1) throw new Error('director_brain_primary_count_invalid:' + table.key)
  let primary = primaries[0]
  const namedPrimary = byName.get(expectedPrimary.name)
  if (namedPrimary && !namedPrimary.is_primary) {
    throw new Error('director_brain_primary_field_unsafe:' + table.key)
  }
  if (!byName.has(expectedPrimary.name)) {
    if (Number(primary.type) !== Number(expectedPrimary.type)) {
      throw new Error('director_brain_primary_field_unsafe:' + table.key)
    }
    const renamePayload = {
      field_name: expectedPrimary.name,
      type: Number(primary.type),
      ...(primary.property ? { property: primary.property } : {}),
    }
    await updateField(accessToken, appToken, tableId, primary.field_id, renamePayload)
    primary = { ...primary, field_name: expectedPrimary.name }
    byName.set(expectedPrimary.name, primary)
  }
  if (primary.field_name !== expectedPrimary.name
    || Number(primary.type) !== Number(expectedPrimary.type)) {
    throw new Error('director_brain_primary_field_mismatch:' + table.key)
  }

  let created = 0
  let updated = 0
  for (const expected of table.fields) {
    const current = byName.get(expected.name)
    if (!current) {
      await createField(accessToken, appToken, tableId, expected)
      created += 1
      continue
    }
    if (Number(current.type) !== Number(expected.type)) {
      throw new Error('director_brain_field_type_mismatch:' + table.key + ':' + expected.name)
    }
    if ((expected.type === 3 || expected.type === 4)
      && await ensureSelectOptions(accessToken, appToken, tableId, current, expected)) {
      updated += 1
    }
  }
  return { created, updated }
}

function isBlankRecord(record) {
  const values = Object.values(record?.fields || {})
  return values.length === 0 || values.every(value => {
    if (value === null || value === undefined || value === '') return true
    if (Array.isArray(value)) return value.length === 0
    return false
  })
}

async function removeBlankStarterRecords(accessToken, appToken, tableId) {
  const records = await listRecords(accessToken, appToken, tableId)
  const blankRecords = records.filter(isBlankRecord)
  for (const record of blankRecords) {
    await deleteRecord(accessToken, appToken, tableId, record.record_id)
  }
  return blankRecords.length
}

async function removeUnusedStarterFields(accessToken, appToken, tableId) {
  const [fields, records] = await Promise.all([
    listFields(accessToken, appToken, tableId),
    listRecords(accessToken, appToken, tableId),
  ])
  const removable = fields.filter(field => !field.is_primary
    && DEFAULT_STARTER_FIELD_NAMES.has(field.field_name)
    && records.every(record => {
      const value = record.fields?.[field.field_name]
      return value === null || value === undefined || value === ''
        || (Array.isArray(value) && value.length === 0)
    }))
  for (const field of removable) {
    await deleteField(accessToken, appToken, tableId, field.field_id)
  }
  return removable.length
}

export function resolveBootstrapTableAssignments(schema, catalog, remoteTables) {
  if (!Array.isArray(remoteTables)) throw new Error('bootstrap_remote_tables_must_be_array')
  const remoteById = new Map()
  const remoteByName = new Map()
  for (const remoteValue of remoteTables) {
    const remote = requireObject(remoteValue, 'bootstrap_remote_table')
    const tableId = requireNonEmpty(remote.table_id, 'bootstrap_remote_table_id')
    const name = requireNonEmpty(remote.name, 'bootstrap_remote_table_name')
    if (remoteById.has(tableId)) throw new Error('bootstrap_remote_table_ids_must_be_unique')
    remoteById.set(tableId, remote)
    const named = remoteByName.get(name) || []
    named.push(remote)
    remoteByName.set(name, named)
  }

  const assignments = {}
  const assignedIds = new Set()
  for (let index = 0; index < schema.tables.length; index += 1) {
    const table = schema.tables[index]
    const catalogRef = catalog.tables?.[table.key]
    let remote = null
    if (catalogRef?.tableId) {
      remote = remoteById.get(catalogRef.tableId)
      if (!remote) throw new Error('catalog_table_missing:' + table.key)
      if (remote.name !== table.name) throw new Error('catalog_table_name_mismatch:' + table.key)
    } else {
      const named = remoteByName.get(table.name) || []
      if (named.length > 1) throw new Error('duplicate_remote_table_name:' + table.name)
      if (named.length === 1) remote = named[0]
    }
    if (!remote && index === 0 && catalog.defaultTableId) {
      remote = remoteById.get(catalog.defaultTableId) || null
    }
    if (!remote) continue
    if (assignedIds.has(remote.table_id)) {
      throw new Error('bootstrap_remote_table_assignment_conflict:' + table.key)
    }
    assignments[table.key] = remote.table_id
    assignedIds.add(remote.table_id)
  }

  const extra = remoteTables.filter(remote => !assignedIds.has(remote.table_id))
  if (extra.length) {
    throw new Error('bootstrap_unexpected_remote_table:' + extra.map(table => table.name).join(','))
  }
  return assignments
}

function recordFieldIsBlank(record, fieldName) {
  const value = record?.fields?.[fieldName]
  return value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0)
}

export function validateBootstrapTablePreflight(table, fields, records = []) {
  if (!Array.isArray(fields)) throw new Error('bootstrap_remote_fields_must_be_array:' + table.key)
  if (!Array.isArray(records)) throw new Error('bootstrap_remote_records_must_be_array:' + table.key)
  const byName = new Map()
  for (const field of fields) {
    const name = requireNonEmpty(field?.field_name, 'bootstrap_remote_field_name:' + table.key)
    if (byName.has(name)) throw new Error('director_brain_field_name_not_unique:' + table.key)
    byName.set(name, field)
  }

  const expectedPrimary = table.fields[0]
  const primaries = fields.filter(field => field.is_primary)
  if (primaries.length !== 1) throw new Error('director_brain_primary_count_invalid:' + table.key)
  const primary = primaries[0]
  const namedPrimary = byName.get(expectedPrimary.name)
  if (namedPrimary && !namedPrimary.is_primary) {
    throw new Error('director_brain_primary_field_unsafe:' + table.key)
  }
  if (!namedPrimary && Number(primary.type) !== Number(expectedPrimary.type)) {
    throw new Error('director_brain_primary_field_unsafe:' + table.key)
  }
  if (namedPrimary && Number(namedPrimary.type) !== Number(expectedPrimary.type)) {
    throw new Error('director_brain_primary_field_mismatch:' + table.key)
  }

  for (const expected of table.fields) {
    const current = byName.get(expected.name)
    if (!current) continue
    if (Number(current.type) !== Number(expected.type)) {
      throw new Error('director_brain_field_type_mismatch:' + table.key + ':' + expected.name)
    }
    if (expected.type === 3 || expected.type === 4) {
      const options = Array.isArray(current.property?.options) ? current.property.options : []
      const names = options.map(option => option.name)
      if (new Set(names).size !== names.length
        || names.some(name => !expected.options.includes(name))) {
        throw new Error('director_brain_select_options_conflict:' + table.key + ':' + expected.name)
      }
    }
  }

  const expectedNames = new Set(table.fields.map(field => field.name))
  for (const field of fields) {
    if (expectedNames.has(field.field_name)) continue
    if (!namedPrimary && field === primary) continue
    if (DEFAULT_STARTER_FIELD_NAMES.has(field.field_name)
      && records.every(record => recordFieldIsBlank(record, field.field_name))) {
      continue
    }
    throw new Error('director_brain_unexpected_field_conflict:' + table.key + ':' + field.field_name)
  }
  return true
}

async function preflightBootstrapRemoteState(accessToken, appToken, schema, catalog, remoteTables) {
  const assignments = resolveBootstrapTableAssignments(schema, catalog, remoteTables)
  for (const table of schema.tables) {
    const tableId = assignments[table.key]
    if (!tableId) continue
    const [fields, records] = await Promise.all([
      listFields(accessToken, appToken, tableId),
      listRecords(accessToken, appToken, tableId),
    ])
    validateBootstrapTablePreflight(table, fields, records)
  }
  return assignments
}

export async function bootstrapDirectorBrain(options = {}) {
  const schema = await loadDirectorBrainSchema(options.schemaPath)
  const catalogPath = validateDirectorBrainCatalogPath(options.catalogPath || DEFAULT_CATALOG_PATH)
  let catalog = await readCatalog(catalogPath)
  const context = runtimeContext(schema, catalog, options.appId, { allowPartialTables: true })
  if (!catalog?.appToken) await prepareCatalogRoot(catalogPath)
  const accessToken = await tenantAccessToken(context.appId, context.service)
  const createdTables = []
  const reconciled = {}

  if (!catalog?.appToken) {
    const app = await createBitable(accessToken, schema.brainName)
    catalog = {
      schemaVersion: 1,
      brainName: schema.brainName,
      projectId: schema.projectId,
      environment: schema.environment,
      keychainService: schema.keychainService,
      appId: context.appId,
      appToken: app.app_token,
      url: app.url,
      defaultTableId: app.default_table_id,
      tables: {},
    }
    await writeCatalog(catalogPath, catalog)
  }

  const existing = await listTables(accessToken, catalog.appToken)
  await preflightBootstrapRemoteState(
    accessToken,
    catalog.appToken,
    schema,
    catalog,
    existing,
  )
  const existingById = new Map(existing.map(table => [table.table_id, table]))
  const existingByName = new Map()
  for (const remoteTable of existing) {
    const matches = existingByName.get(remoteTable.name) || []
    matches.push(remoteTable)
    existingByName.set(remoteTable.name, matches)
  }
  for (const table of schema.tables) {
    if ((existingByName.get(table.name) || []).length > 1) {
      throw new Error('duplicate_remote_table_name:' + table.name)
    }
  }

  for (let index = 0; index < schema.tables.length; index += 1) {
    const table = schema.tables[index]
    let tableId = catalog.tables?.[table.key]?.tableId
    if (tableId && !existingById.has(tableId)) throw new Error('catalog_table_missing:' + table.key)
    if (tableId && existingById.get(tableId)?.name !== table.name) {
      throw new Error('catalog_table_name_mismatch:' + table.key)
    }
    if (!tableId && existingByName.has(table.name)) {
      tableId = existingByName.get(table.name)[0].table_id
    }
    if (!tableId && index === 0 && catalog.defaultTableId && existingById.has(catalog.defaultTableId)) {
      tableId = catalog.defaultTableId
      await renameTable(accessToken, catalog.appToken, tableId, table.name)
      createdTables.push(table.key)
    }
    if (!tableId) {
      tableId = await createTable(accessToken, catalog.appToken, table)
      createdTables.push(table.key)
    }
    catalog.tables = catalog.tables || {}
    catalog.tables[table.key] = { name: table.name, tableId }
    const fieldResult = await ensureTableFields(
      accessToken,
      catalog.appToken,
      tableId,
      table,
    )
    reconciled[table.key] = {
      ...fieldResult,
      blankStarterRecordsRemoved: await removeBlankStarterRecords(
        accessToken,
        catalog.appToken,
        tableId,
      ),
      starterFieldsRemoved: await removeUnusedStarterFields(
        accessToken,
        catalog.appToken,
        tableId,
      ),
    }
    await writeCatalog(catalogPath, catalog)
  }

  delete catalog.defaultTableId
  await writeCatalog(catalogPath, catalog)
  const contract = await checkDirectorBrain({ ...options, catalogPath })
  return {
    ok: true,
    brainName: schema.brainName,
    projectId: schema.projectId,
    environment: schema.environment,
    createdBitable: !context.catalog?.appToken,
    createdTables,
    reconciled,
    tableCount: schema.tables.length,
    contractVerified: contract.ok,
    catalogPath,
    url: catalog.url,
  }
}

function filterLiteral(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

export function exactRecordFilter(fieldName, value) {
  if (String(fieldName).includes(']')) throw new Error('invalid_filter_field')
  return 'CurrentValue.[' + fieldName + ']="' + filterLiteral(value) + '"'
}

function assertNoSecrets(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (SECRET_FIELD_PATTERN.test(name)) throw new Error('secret_field_forbidden:' + name)
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (SECRET_VALUE_PATTERNS.some(pattern => pattern.test(text))) {
      throw new Error('sensitive_value_forbidden:' + name)
    }
  }
}

function normalizeRecordFields(table, fields) {
  assertNoSecrets(fields)
  const types = new Map(table.fields.map(field => [field.name, field.type]))
  for (const name of Object.keys(fields)) {
    if (!types.has(name)) throw new Error('unknown_record_field:' + table.key + ':' + name)
  }
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => {
    if (value !== null && types.get(name) === 5 && typeof value === 'string') {
      const timestamp = Date.parse(value)
      if (!Number.isFinite(timestamp)) throw new Error('invalid_record_date:' + name)
      return [name, timestamp]
    }
    return [name, value]
  }))
}

async function createRecord(accessToken, appToken, tableId, fields) {
  const response = await requestJson(
    'POST',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records',
    { accessToken, payload: { fields } },
  )
  return response.data.record
}

async function updateRecord(accessToken, appToken, tableId, recordId, fields) {
  const response = await requestJson(
    'PUT',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/' + recordId,
    { accessToken, payload: { fields } },
  )
  return response.data.record
}

async function deleteRecord(accessToken, appToken, tableId, recordId) {
  await requestJson(
    'DELETE',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/' + recordId,
    { accessToken },
  )
}

function tableContext(schema, catalog, tableKey) {
  const table = schema.tables.find(item => item.key === tableKey)
  if (!table) throw new Error('unknown_table_key:' + tableKey)
  const ref = catalog.tables?.[tableKey]
  if (!ref?.tableId) throw new Error('table_not_bootstrapped:' + tableKey)
  return { table, tableId: ref.tableId }
}

async function connectedContext(options = {}) {
  const schema = await loadDirectorBrainSchema(options.schemaPath)
  const catalogPath = validateDirectorBrainCatalogPath(options.catalogPath || DEFAULT_CATALOG_PATH)
  const catalog = await readCatalog(catalogPath)
  if (!catalog?.appToken) throw new Error('director_brain_catalog_missing')
  const context = runtimeContext(schema, catalog, options.appId)
  const accessToken = await tenantAccessToken(context.appId, context.service)
  return { ...context, accessToken, catalogPath }
}

function recordFieldEquals(field, actual, expected) {
  if (Number(field.type) === 5) return Number(actual) === Number(expected)
  return JSON.stringify(actual) === JSON.stringify(expected)
}

async function createSeedRecordIfMissing(context, tableKey, fields) {
  const { table, tableId } = tableContext(context.schema, context.catalog, tableKey)
  const stableId = requireNonEmpty(fields[table.stableId], 'stable_record_id')
  const normalized = normalizeRecordFields(table, fields)
  const matches = await listRecords(
    context.accessToken,
    context.catalog.appToken,
    tableId,
    exactRecordFilter(table.stableId, stableId),
  )
  const exact = matches.filter(record => String(record.fields?.[table.stableId] || '').trim() === stableId)
  if (exact.length > 1) throw new Error('duplicate_stable_record_id:' + tableKey + ':' + stableId)
  if (exact.length === 1) {
    const fieldTypes = new Map(table.fields.map(field => [field.name, field]))
    const mismatched = Object.entries(normalized)
      .filter(([name, expected]) => !recordFieldEquals(
        fieldTypes.get(name),
        exact[0].fields?.[name],
        expected,
      ))
      .map(([name]) => name)
    if (mismatched.length) {
      throw new Error('seed_record_conflict:' + tableKey + ':' + stableId + ':' + mismatched.join(','))
    }
    return { action: 'unchanged', record: exact[0] }
  }
  const record = await createRecord(
    context.accessToken,
    context.catalog.appToken,
    tableId,
    normalized,
  )
  return { action: 'created', record }
}

export function initialDirectorBrainBlueprint(projectId = 'PROJ-VIDEO-AUTOWORKER') {
  const common = {
    '项目 ID': projectId,
    '环境': '测试',
    '状态': '生效',
    '版本': 'v0.1.0',
    '来源': '用户确认/2026-08-30',
    '更新时间': '2026-08-30T00:00:00+08:00',
  }
  return [
    {
      ...common,
      '标题': '导演脑项目定位',
      '规范 ID': 'DB-SPEC-CORE',
      '类型': '定位',
      '内容': '导演脑使用独立飞书测试账号、独立自建应用、独立多维表格和独立凭据服务，但仍属于 Video AutoWorker，不创建第二个项目。',
    },
    {
      ...common,
      '标题': '导演脑最终目标',
      '规范 ID': 'DB-GOAL-FINAL',
      '类型': '目标',
      '内容': '通过学习成片内容和导演判断案例建立技能与技法库，结合素材分析主动发现故事、撰写故事脚本，并在经过实机验证的剪辑软件接口支持下形成可执行剪辑方案。',
    },
    {
      ...common,
      '标题': '导演脑六层架构',
      '规范 ID': 'DB-ARCH-6L',
      '类型': '架构',
      '内容': '六层依次为素材感知、人物理解、故事发现、导演判断、叙事结构和导演意图；所有高层判断必须回链到素材证据与时间码。',
    },
    {
      ...common,
      '标题': '导演经验学习闭环',
      '规范 ID': 'DB-LOOP-CASE',
      '类型': '开发逻辑',
      '内容': '原始素材到导演判断，再记录判断原因、上下文、采用或拒绝、成片位置和最终效果，形成可复核案例并提炼技法；重点学习为什么这样判断。',
    },
    {
      ...common,
      '标题': '单链集成边界',
      '规范 ID': 'DB-INTEGRATION-SINGLE',
      '类型': '集成边界',
      '内容': '导演脑作为长期知识与决策子系统接入现有唯一视频任务链，不维护任务状态机、队列或影子派发链。',
    },
    {
      ...common,
      '标题': '导演脑数据边界',
      '规范 ID': 'DB-DATA-BOUNDARY',
      '类型': '数据边界',
      '内容': '飞书只保存导演意图、人物、故事、判断、叙事、案例、技法以及素材 ID、证据时间码和版本；原片、逐帧图片、完整原始转写、向量、运行日志和凭据留在受控本地系统。',
    },
    {
      ...common,
      '标题': '既有 ID 复用规则',
      '规范 ID': 'DB-ID-REUSE',
      '类型': '开发逻辑',
      '内容': '现有 taskId、batchId、materialId、sceneId 和 shotId 原样作为来源引用，不重新生成；只为人物、故事节点、关系、判断、意图、方案、案例和技法创建稳定领域 ID。',
    },
    {
      ...common,
      '标题': 'DaVinci 分阶段验收',
      '规范 ID': 'DB-DAVINCI-STAGED',
      '类型': '验收',
      '内容': '先生成可校验的 edit-plan，再以时间线副本验证 DaVinci 或其他剪辑软件的正式接口；复杂 AI 功能只有经过目标版本实机测试后才能声明可用。',
    },
  ]
}

export async function seedDirectorBrain(options = {}) {
  const context = await connectedContext(options)
  const records = initialDirectorBrainBlueprint(context.schema.projectId)
  const actions = []
  for (const fields of records) {
    const result = await createSeedRecordIfMissing(context, 'system_blueprint', fields)
    actions.push({
      stableId: fields['规范 ID'],
      action: result.action,
    })
  }
  return { ok: true, seeded: actions.length, actions }
}

export async function writeCheckDirectorBrain(options = {}) {
  const context = await connectedContext(options)
  const tableKey = options.tableKey || 'system_blueprint'
  const { table, tableId } = tableContext(context.schema, context.catalog, tableKey)
  const primaryName = table.fields[0].name
  const stableId = 'DB-WRITE-CHECK-' + randomUUID()
  const fields = normalizeRecordFields(table, {
    [primaryName]: 'API 临时写检查',
    [table.stableId]: stableId,
    ...(table.fields.some(field => field.name === '项目 ID')
      ? { '项目 ID': context.schema.projectId }
      : {}),
  })
  let record = null
  let created = false
  let updated = false
  let operationError = null
  try {
    record = await createRecord(
      context.accessToken,
      context.catalog.appToken,
      tableId,
      fields,
    )
    created = true
    await updateRecord(
      context.accessToken,
      context.catalog.appToken,
      tableId,
      record.record_id,
      { [primaryName]: 'API 临时写检查已更新' },
    )
    updated = true
  } catch (error) {
    operationError = error
  }
  if (record?.record_id) {
    try {
      await deleteRecord(
        context.accessToken,
        context.catalog.appToken,
        tableId,
        record.record_id,
      )
    } catch {
      // Fall through to stable-ID cleanup so a transient direct-delete failure cannot strand data.
    }
  }
  const cleanupDelays = [250, 750, 1_500]
  for (const delayMs of cleanupDelays) {
    try {
      const matches = await listRecords(
        context.accessToken,
        context.catalog.appToken,
        tableId,
        exactRecordFilter(table.stableId, stableId),
      )
      for (const match of matches) {
        try {
          await deleteRecord(
            context.accessToken,
            context.catalog.appToken,
            tableId,
            match.record_id,
          )
        } catch {
          // A later pass and the final residue check decide whether cleanup succeeded.
        }
      }
    } catch {
      // A later pass may succeed after a temporary API or consistency delay.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs))
  }
  const residue = await listRecords(
    context.accessToken,
    context.catalog.appToken,
    tableId,
    exactRecordFilter(table.stableId, stableId),
  )
  if (residue.length) throw new Error('director_brain_write_check_cleanup_failed')
  if (operationError) throw operationError
  if (!created || !updated) throw new Error('director_brain_write_check_incomplete')
  return { ok: true, table: tableKey, created, updated, deleted: true, residue: 0 }
}

export async function checkDirectorBrain(options = {}) {
  const context = await connectedContext(options)
  const remoteTables = await listTables(context.accessToken, context.catalog.appToken)
  if (remoteTables.length !== context.schema.tables.length) {
    throw new Error('director_brain_remote_table_count_mismatch')
  }
  const remoteById = new Map(remoteTables.map(table => [table.table_id, table]))
  const expectedRemoteIds = new Set(
    context.schema.tables.map(table => context.catalog.tables[table.key].tableId),
  )
  if (expectedRemoteIds.size !== context.schema.tables.length
    || remoteTables.some(table => !expectedRemoteIds.has(table.table_id))) {
    throw new Error('director_brain_remote_table_set_mismatch')
  }
  const remoteNameCounts = new Map()
  for (const remoteTable of remoteTables) {
    remoteNameCounts.set(remoteTable.name, (remoteNameCounts.get(remoteTable.name) || 0) + 1)
  }
  const result = {}
  for (const table of context.schema.tables) {
    const ref = context.catalog.tables?.[table.key]
    if (!ref?.tableId || !remoteById.has(ref.tableId)) {
      throw new Error('director_brain_table_missing:' + table.key)
    }
    if (ref.name !== table.name || remoteById.get(ref.tableId).name !== table.name) {
      throw new Error('director_brain_table_name_mismatch:' + table.key)
    }
    if (remoteNameCounts.get(table.name) !== 1) {
      throw new Error('director_brain_table_name_not_unique:' + table.key)
    }
    const fields = await listFields(
      context.accessToken,
      context.catalog.appToken,
      ref.tableId,
    )
    const observed = new Map(fields.map(field => [field.field_name, field]))
    if (observed.size !== fields.length) {
      throw new Error('director_brain_field_name_not_unique:' + table.key)
    }
    const missing = table.fields
      .filter(field => Number(observed.get(field.name)?.type) !== Number(field.type))
      .map(field => field.name)
    if (missing.length) throw new Error('director_brain_schema_mismatch:' + table.key + ':' + missing.join(','))
    const expectedNames = new Set(table.fields.map(field => field.name))
    const extra = fields
      .filter(field => !expectedNames.has(field.field_name))
      .map(field => field.field_name)
    if (extra.length) throw new Error('director_brain_unexpected_fields:' + table.key + ':' + extra.join(','))
    const primaries = fields.filter(field => field.is_primary)
    if (primaries.length !== 1
      || primaries[0].field_name !== table.fields[0].name
      || Number(primaries[0].type) !== Number(table.fields[0].type)) {
      throw new Error('director_brain_primary_field_mismatch:' + table.key)
    }
    for (const expected of table.fields.filter(field => field.type === 3 || field.type === 4)) {
      const options = observed.get(expected.name)?.property?.options || []
      const optionNames = new Set(options.map(option => option.name))
      const expectedOptions = new Set(expected.options)
      if (optionNames.size !== options.length
        || optionNames.size !== expectedOptions.size
        || expected.options.some(option => !optionNames.has(option))) {
        throw new Error('director_brain_select_options_mismatch:' + table.key + ':' + expected.name)
      }
    }
    result[table.key] = {
      name: table.name,
      expectedFields: table.fields.length,
      observedFields: fields.length,
    }
  }
  return {
    ok: true,
    brainName: context.schema.brainName,
    projectId: context.schema.projectId,
    environment: context.schema.environment,
    tableCount: context.schema.tables.length,
    tables: result,
    url: context.catalog.url,
  }
}

export async function verifyDirectorBrain(options = {}) {
  const context = await connectedContext(options)
  const check = await checkDirectorBrain(options)
  const blueprint = tableContext(context.schema, context.catalog, 'system_blueprint')
  const expected = initialDirectorBrainBlueprint(context.schema.projectId)
  const stableIds = new Set()
  for (const item of expected) {
    assertNoSecrets(item)
    const id = item['规范 ID']
    if (stableIds.has(id)) throw new Error('duplicate_seed_id:' + id)
    stableIds.add(id)
    const records = await listRecords(
      context.accessToken,
      context.catalog.appToken,
      blueprint.tableId,
      exactRecordFilter('规范 ID', id),
    )
    const exact = records.filter(record => record.fields?.['规范 ID'] === id)
    if (exact.length !== 1) throw new Error('seed_record_count_invalid:' + id)
    assertNoSecrets(exact[0].fields || {})
    const normalized = normalizeRecordFields(blueprint.table, item)
    const fieldTypes = new Map(blueprint.table.fields.map(field => [field.name, field]))
    const mismatched = Object.entries(normalized)
      .filter(([name, value]) => !recordFieldEquals(
        fieldTypes.get(name),
        exact[0].fields?.[name],
        value,
      ))
      .map(([name]) => name)
    if (mismatched.length) {
      throw new Error('seed_record_content_mismatch:' + id + ':' + mismatched.join(','))
    }
  }
  return {
    ...check,
    seedCount: expected.length,
    stableIdsVerified: expected.length,
    seedRemoteContentVerified: true,
    seedRemoteSecretPatternScanPassed: true,
  }
}

export function parseDirectorBrainArgs(argv) {
  const args = {
    command: argv[0] || '',
    schemaPath: DEFAULT_SCHEMA_PATH,
    catalogPath: DEFAULT_CATALOG_PATH,
    appId: null,
    tableKey: null,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--schema' || flag === '--catalog' || flag === '--app-id' || flag === '--table') {
      if (!value) throw new Error('missing_option_value:' + flag)
      if (flag === '--schema') args.schemaPath = resolve(value)
      if (flag === '--catalog') args.catalogPath = value
      if (flag === '--app-id') args.appId = value
      if (flag === '--table') args.tableKey = value
      index += 1
      continue
    }
    throw new Error('unknown_option:' + flag)
  }
  if (!['bootstrap', 'check', 'write-check', 'seed', 'verify', 'schema'].includes(args.command)) {
    throw new Error('command_must_be_bootstrap_check_write-check_seed_verify_or_schema')
  }
  return args
}

export async function runDirectorBrainCli(argv) {
  const args = parseDirectorBrainArgs(argv)
  if (args.command === 'schema') {
    const schema = await loadDirectorBrainSchema(args.schemaPath)
    return {
      ok: true,
      brainName: schema.brainName,
      projectId: schema.projectId,
      environment: schema.environment,
      tableCount: schema.tables.length,
      tables: schema.tables.map(table => ({
        key: table.key,
        name: table.name,
        stableId: table.stableId,
        fields: table.fields.length,
      })),
    }
  }
  if (args.command === 'bootstrap') return bootstrapDirectorBrain(args)
  if (args.command === 'check') return checkDirectorBrain(args)
  if (args.command === 'write-check') return writeCheckDirectorBrain(args)
  if (args.command === 'seed') return seedDirectorBrain(args)
  return verifyDirectorBrain(args)
}
