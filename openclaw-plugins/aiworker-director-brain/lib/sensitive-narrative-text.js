const LABEL = String.raw`(?:一次性\s*)?(?:口令|密码|验证码|校验码|动态码|PIN(?:\s*码)?|OTP)`
const LABEL_BOUNDARY = String.raw`(?<![A-Za-z0-9])`
const QUOTED_VALUE = String.raw`(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}')`
const ESCAPED_QUOTED_VALUE = String.raw`(?:\\["'][^\\\r\n]{4,}?\\["'])`
const HTML_QUOTED_VALUE = String.raw`(?:(?:&quot;|&#34;|&#x22;)[^\r\n]{4,}?(?:&quot;|&#34;|&#x22;)|(?:&apos;|&#39;|&#x27;)[^\r\n]{4,}?(?:&apos;|&#39;|&#x27;))`
const BARE_VALUE = String.raw`(?:[A-Za-z0-9._~+/=-]{4,})`
const VALUE = String.raw`(?:${QUOTED_VALUE}|${ESCAPED_QUOTED_VALUE}|${HTML_QUOTED_VALUE}|${BARE_VALUE})`
const EXPLICIT_SEPARATOR = String.raw`(?:为|是|[:：=]|&colon;|&#0*58;|&#x0*3a;)`

function sensitiveNarrativePatterns() {
  return [
    new RegExp(String.raw`${LABEL_BOUNDARY}${LABEL}\s*${EXPLICIT_SEPARATOR}\s*${VALUE}`, 'giu'),
    new RegExp(String.raw`${LABEL_BOUNDARY}${LABEL}\s+${VALUE}`, 'giu'),
    new RegExp(String.raw`${LABEL_BOUNDARY}${LABEL}${BARE_VALUE}`, 'giu'),
  ]
}

export function containsSensitiveNarrativeValue(value) {
  if (typeof value !== 'string') return false
  return sensitiveNarrativePatterns().some(pattern => pattern.test(value.normalize('NFKC')))
}

export function redactSensitiveNarrativeValues(value, replacement = '[已省略]') {
  if (typeof value !== 'string') return ''
  let output = value
  for (const pattern of sensitiveNarrativePatterns()) output = output.replace(pattern, replacement)
  return output
}
