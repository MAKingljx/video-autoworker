import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveBaseSchemaPath, runMigrations } from '@/lib/migrations'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'video-autoworker-schema-path-'))
  roots.push(root)
  return root
}

describe('migration schema path', () => {
  it('uses the source schema in a development checkout', async () => {
    const root = await createRoot()
    const sourceSchema = join(root, 'src', 'lib', 'schema.sql')
    await mkdir(join(root, 'src', 'lib'), { recursive: true })
    await writeFile(sourceSchema, 'CREATE TABLE source_test (id INTEGER);\n')

    expect(resolveBaseSchemaPath(root)).toBe(sourceSchema)
  })

  it('uses the copied runtime schema in a standalone release', async () => {
    const root = await createRoot()
    const runtimeSchema = join(root, 'runtime', 'schema.sql')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(runtimeSchema, 'CREATE TABLE runtime_test (id INTEGER);\n')

    expect(resolveBaseSchemaPath(root)).toBe(runtimeSchema)
  })

  it('falls back to a non-empty runtime schema when the source file is empty', async () => {
    const root = await createRoot()
    const sourceSchema = join(root, 'src', 'lib', 'schema.sql')
    const runtimeSchema = join(root, 'runtime', 'schema.sql')
    await mkdir(join(root, 'src', 'lib'), { recursive: true })
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(sourceSchema, '')
    await writeFile(runtimeSchema, 'CREATE TABLE runtime_test (id INTEGER);\n')

    expect(resolveBaseSchemaPath(root)).toBe(runtimeSchema)
  })

  it('fails closed when every schema candidate is empty', async () => {
    const root = await createRoot()
    await mkdir(join(root, 'src', 'lib'), { recursive: true })
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'src', 'lib', 'schema.sql'), '')
    await writeFile(join(root, 'runtime', 'schema.sql'), '')

    expect(() => resolveBaseSchemaPath(root)).toThrow('mission_control_schema_missing')
  })

  it('fails closed when neither schema asset exists', async () => {
    const root = await createRoot()

    expect(() => resolveBaseSchemaPath(root)).toThrow('mission_control_schema_missing')
  })

  it('fails closed when every schema candidate contains only whitespace', async () => {
    const root = await createRoot()
    await mkdir(join(root, 'src', 'lib'), { recursive: true })
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'src', 'lib', 'schema.sql'), ' \n\t')
    await writeFile(join(root, 'runtime', 'schema.sql'), '\n  \n')

    expect(() => resolveBaseSchemaPath(root)).toThrow('mission_control_schema_missing')
  })

  it('rejects a symlinked schema instead of falling back to another candidate', async () => {
    const root = await createRoot()
    const externalSchema = join(root, 'external-schema.sql')
    await mkdir(join(root, 'src', 'lib'), { recursive: true })
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(externalSchema, 'CREATE TABLE tasks (id INTEGER);\n')
    await symlink(externalSchema, join(root, 'src', 'lib', 'schema.sql'))
    await writeFile(join(root, 'runtime', 'schema.sql'), 'CREATE TABLE fallback (id INTEGER);\n')

    expect(() => resolveBaseSchemaPath(root)).toThrow('mission_control_schema_unsafe_type')
  })

  it('rejects a non-regular schema instead of falling back to another candidate', async () => {
    const root = await createRoot()
    await mkdir(join(root, 'src', 'lib', 'schema.sql'), { recursive: true })
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'runtime', 'schema.sql'), 'CREATE TABLE fallback (id INTEGER);\n')

    expect(() => resolveBaseSchemaPath(root)).toThrow('mission_control_schema_unsafe_type')
  })

  it.each([
    {
      name: 'invalid SQL',
      schema: 'CREATE TABLE tasks (id INTEGER); CREATE TABLE broken (',
      error: /syntax error|incomplete input/u,
    },
    {
      name: 'a missing required table',
      schema: 'CREATE TABLE tasks (id INTEGER, title TEXT, status TEXT);',
      error: 'mission_control_schema_required_table_missing:agents',
    },
    {
      name: 'missing required columns',
      schema: [
        'CREATE TABLE tasks (id INTEGER, title TEXT, status TEXT);',
        'CREATE TABLE agents (id INTEGER, name TEXT);',
      ].join('\n'),
      error: 'mission_control_schema_required_columns_missing:agents:status',
    },
  ])('does not record 001_init for $name', async ({ schema, error }) => {
    const root = await createRoot()
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'runtime', 'schema.sql'), schema)
    const db = new Database(':memory:')
    try {
      expect(() => runMigrations(db, root)).toThrow(error)
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '001_init'")
          .get(),
      ).toEqual({ count: 0 })
      expect(
        db.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'agents')",
        ).get(),
      ).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('can retry 001_init after a rejected schema without retaining partial state', async () => {
    const root = await createRoot()
    const runtimeSchema = join(root, 'runtime', 'schema.sql')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(runtimeSchema, 'CREATE TABLE tasks (id INTEGER); CREATE TABLE broken (')
    const db = new Database(':memory:')
    try {
      expect(() => runMigrations(db, root)).toThrow()
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '001_init'")
          .get(),
      ).toEqual({ count: 0 })

      await writeFile(
        runtimeSchema,
        await readFile(join(process.cwd(), 'src', 'lib', 'schema.sql'), 'utf8'),
      )
      expect(() => runMigrations(db, root)).not.toThrow()
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '001_init'")
          .get(),
      ).toEqual({ count: 1 })
      expect(
        db.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'agents')",
        ).get(),
      ).toEqual({ count: 2 })
    } finally {
      db.close()
    }
  })
})
