/**
 * Shared credential-value scanner for server-side validation, historical seed
 * redaction, and Feishu write boundaries. Field-name policy remains with each
 * caller; this module only recognizes values that look like actual secrets.
 */

const SENSITIVE_VALUE_PATTERNS = [
  { type: 'aws_access_key', severity: 'critical', regex: /AKIA[0-9A-Z]{16}/g },
  {
    type: 'aws_secret_key',
    severity: 'critical',
    regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+=]{40}/g,
  },
  {
    type: 'github_token',
    severity: 'critical',
    regex: /\bgh[ps]_[A-Za-z0-9_]{20,255}\b/g,
  },
  {
    type: 'github_oauth_token',
    severity: 'critical',
    regex: /\bgho_[A-Za-z0-9_]{20,255}\b/g,
  },
  {
    type: 'github_user_token',
    severity: 'critical',
    regex: /\bghu_[A-Za-z0-9_]{20,255}\b/g,
  },
  {
    type: 'github_refresh_token',
    severity: 'critical',
    regex: /\bghr_[A-Za-z0-9_]{20,255}\b/g,
  },
  {
    type: 'github_pat',
    severity: 'critical',
    regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  },
  {
    type: 'bearer_token',
    severity: 'critical',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  },
  {
    type: 'slack_token',
    severity: 'critical',
    regex: /\bxox[A-Za-z]-[A-Za-z0-9-]{10,}\b/g,
  },
  { type: 'stripe_secret_key', severity: 'critical', regex: /\bsk_live_[A-Za-z0-9]{24,99}\b/g },
  { type: 'stripe_test_key', severity: 'warning', regex: /\bsk_test_[A-Za-z0-9]{24,99}\b/g },
  { type: 'openai_api_key', severity: 'critical', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  {
    type: 'credential_assignment',
    severity: 'critical',
    regex: /\b(?:authorization|api[-_ ]?key|apikey|api[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|app[-_ ]?secret|password|passwd|pwd|secret|token|key)\s*[:=]\s*(?:Bearer\s+)?["'`]?[^\s,，;；"'`]{8,}/giu,
  },
  {
    type: 'jwt',
    severity: 'warning',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_+/=-]{8,}\b/g,
  },
  { type: 'private_key', severity: 'critical', regex: /-----BEGIN\s(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  {
    type: 'db_connection_string',
    severity: 'critical',
    regex: /(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis):\/\/[^\s'"]{10,}/giu,
  },
  {
    type: 'slack_webhook',
    severity: 'critical',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}/g,
  },
  {
    type: 'discord_webhook',
    severity: 'critical',
    regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d{17,}\/[A-Za-z0-9_-]{60,}/g,
  },
  { type: 'anthropic_api_key', severity: 'critical', regex: /\bsk-ant-api[A-Za-z0-9_-]{20,}\b/g },
  { type: 'twilio_api_key', severity: 'critical', regex: /\bSK[0-9a-fA-F]{32}\b/g },
  {
    type: 'sendgrid_api_key',
    severity: 'critical',
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  },
  { type: 'mailgun_api_key', severity: 'critical', regex: /\bkey-[0-9a-zA-Z]{32}\b/g },
  {
    type: 'gcp_service_account',
    severity: 'critical',
    regex: /"type"\s*:\s*"service_account"[^}]*"private_key"/g,
  },
  {
    type: 'azure_storage',
    severity: 'critical',
    regex: /DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{20,}/g,
  },
  {
    type: 'ssh_private_key_content',
    severity: 'critical',
    regex: /-----BEGIN\s(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]{20,}?-----END\s(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
]

const RELEASE_CONTEXTUAL_PATTERN_TYPES = new Set(['credential_assignment'])

function textValue(value) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function scanPatterns(value, includePattern) {
  const text = textValue(value)
  const matches = []
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    if (!includePattern(pattern)) continue
    pattern.regex.lastIndex = 0
    let match
    while ((match = pattern.regex.exec(text)) !== null) {
      matches.push({
        type: pattern.type,
        severity: pattern.severity,
        value: match[0],
        position: match.index,
      })
    }
  }
  return matches
}

export function scanSensitiveValues(value) {
  return scanPatterns(value, () => true)
}

/**
 * Release artifacts are arbitrary source, generated code, dependencies, and
 * binary payloads. The broad assignment pattern is intentionally excluded
 * here because code such as `token: string` is not credential material.
 * Context-aware hard-coded assignment checks live in the release scanner.
 */
export function scanHighConfidenceSensitiveValues(value) {
  return scanPatterns(
    value,
    pattern => !RELEASE_CONTEXTUAL_PATTERN_TYPES.has(pattern.type),
  )
}

export function containsSensitiveValue(value) {
  return scanSensitiveValues(value).length > 0
}

export function redactSensitiveValues(value, replacement = '[credential]') {
  let result = textValue(value)
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    pattern.regex.lastIndex = 0
    result = result.replace(pattern.regex, replacement)
  }
  return result
}
