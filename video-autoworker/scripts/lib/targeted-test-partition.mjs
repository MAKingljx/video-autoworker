import { isAbsolute, relative, resolve } from 'node:path'

/** A related-file selection must preserve the existing heavy-suite boundary. */
export function partitionTargetedTests(files, productRoot, heavyTests) {
  const root = resolve(productRoot)
  const heavy = new Set(heavyTests)
  const names = [...new Set(files.map(file => {
    const absolute = resolve(root, file)
    const name = relative(root, absolute).split('\\').join('/')
    if (!name || name.startsWith('../') || isAbsolute(name)) throw new Error('targeted_test_outside_product')
    return name
  }))].sort()
  if (!names.length) throw new Error('targeted_test_selection_empty')
  const regularFiles = names.filter(name => !heavy.has(name))
  const heavyFiles = names.filter(name => heavy.has(name))
  const base = ['run', '--maxWorkers=1', '--no-file-parallelism']
  return { regularFiles, heavyFiles, invocations: [
    ...(regularFiles.length ? [[...base, ...regularFiles]] : []),
    ...heavyFiles.map(name => [...base, '--testTimeout=30000', '--hookTimeout=30000', name]),
  ] }
}
