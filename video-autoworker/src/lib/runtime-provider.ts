import { OpenClawRuntimeProvider } from './runtime/providers/openclaw'
import { createRuntimeProviderRegistry } from './runtime/registry'
import type { RuntimeProvider } from './runtime/contracts'

export type * from './runtime/contracts'
export { OpenClawRuntimeProvider } from './runtime/providers/openclaw'
export { createRuntimeProviderRegistry } from './runtime/registry'

// Composition root: a platform is selected here, outside application services.
// Production retains its current single runtime until another adapter passes
// the deployment and identity migration contract.
const providers = createRuntimeProviderRegistry({
  openclaw: () => new OpenClawRuntimeProvider(),
}, 'openclaw')
let testProvider: RuntimeProvider | null = null

export function getRuntimeProvider(): RuntimeProvider {
  return testProvider ?? providers.get()
}

export function __setRuntimeProviderForTests(provider: RuntimeProvider | null) {
  testProvider = provider
}
