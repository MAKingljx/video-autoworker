import type { RuntimeProvider } from './contracts'

export type RuntimeProviderFactory = () => RuntimeProvider

/** Build a fixed provider catalog for one application composition. */
export function createRuntimeProviderRegistry(
  factories: Readonly<Record<string, RuntimeProviderFactory>>,
  defaultProviderId: string,
) {
  const catalog = new Map(Object.entries(factories))
  const instances = new Map<string, RuntimeProvider>()
  if (!catalog.has(defaultProviderId)) {
    throw new Error(`Runtime provider is not registered: ${defaultProviderId}`)
  }

  return {
    ids: Object.freeze([...catalog.keys()]),
    get(id = defaultProviderId): RuntimeProvider {
      const cached = instances.get(id)
      if (cached) return cached
      const factory = catalog.get(id)
      if (!factory) throw new Error(`Runtime provider is not registered: ${id}`)
      const provider = factory()
      if (provider.id !== id) throw new Error(`Runtime provider identity mismatch: ${id}`)
      // Cache only a successfully constructed, correctly bound provider. An
      // unavailable selected platform never falls back to a different one.
      instances.set(id, provider)
      return provider
    },
  }
}
