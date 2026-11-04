import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

// `image-studio` shipped before the plugin was reusable. Keep its scope hash
// byte-for-byte stable so previously accepted jobs remain discoverable.
export const LEGACY_IMAGE_PROFILE = 'image-studio'
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/u

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function trustedIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

function trustedStateDirectory(value) {
  return typeof value === 'string' && isAbsolute(value) && normalize(value) === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

export function legacyImageBinding() {
  return Object.freeze({ profile: LEGACY_IMAGE_PROFILE, targetAgentId: LEGACY_IMAGE_PROFILE })
}

// The target comes only from a profile-owned plugin configuration. A new
// profile must opt in explicitly; only the existing image-studio installation
// receives the compatibility default.
export function resolveImagePluginBinding(env, pluginConfig) {
  const profile = env?.OPENCLAW_PROFILE
  const stateDir = env?.OPENCLAW_STATE_DIR
  if (!trustedIdentifier(profile) || !trustedStateDirectory(stateDir) || !plainObject(pluginConfig)) {
    throw new Error('image_notification_profile_binding_invalid')
  }
  const configured = pluginConfig.targetAgentId
  const targetAgentId = configured === undefined && profile === LEGACY_IMAGE_PROFILE
    ? LEGACY_IMAGE_PROFILE : configured
  if (!trustedIdentifier(targetAgentId)) throw new Error('image_notification_profile_binding_invalid')
  return Object.freeze({ profile, targetAgentId, stateDir })
}

export function imageSessionScope(context, binding = legacyImageBinding()) {
  const agentId = binding?.targetAgentId
  const profile = binding?.profile
  const sessionKey = context?.sessionKey
  if (!trustedIdentifier(profile) || !trustedIdentifier(agentId) || context?.agentId !== agentId
    || typeof sessionKey !== 'string' || sessionKey.length === 0 || sessionKey.length > 4096
    || sessionKey !== sessionKey.trim() || !sessionKey.startsWith(`agent:${agentId}:`)
    || /[\r\n\t\u0000-\u001f\u007f]/u.test(sessionKey)) return null
  const identity = profile === LEGACY_IMAGE_PROFILE && agentId === LEGACY_IMAGE_PROFILE
    ? `${LEGACY_IMAGE_PROFILE}\0${sessionKey}`
    : `${profile}\0${agentId}\0${sessionKey}`
  return createHash('sha256').update(identity).digest('hex')
}
