const ts = require('typescript')
const { createHash } = require('node:crypto')
const { relative } = require('node:path')

module.exports = function compileWorkerTypeScript(source) {
  const member = relative(this.rootContext, this.resourcePath)
  const hash = value => createHash('sha256').update(value).digest('hex')
  this.emitFile(`source-receipts/${hash(member)}.json`, JSON.stringify({ path: member, sha256: hash(source) }))
  return ts.transpileModule(source, {
    fileName: this.resourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      sourceMap: false,
    },
  }).outputText
}
