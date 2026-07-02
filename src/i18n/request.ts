import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import { locales, defaultLocale, type Locale } from './config'

export default getRequestConfig(async () => {
  let locale: Locale = readLockedLocale() || defaultLocale

  if (!readLockedLocale()) {
    // 1. Check NEXT_LOCALE cookie
    const cookieStore = await cookies()
    const cookieLocale = cookieStore.get('NEXT_LOCALE')?.value as Locale | undefined
    if (cookieLocale && locales.includes(cookieLocale)) {
      locale = cookieLocale
    } else {
      // 2. Fall back to Accept-Language header
      const headerStore = await headers()
      const acceptLang = headerStore.get('accept-language') || ''
      const preferred = acceptLang
        .split(',')
        .map((part) => part.split(';')[0].trim().substring(0, 2).toLowerCase())
        .find((code) => locales.includes(code as Locale))
      if (preferred) {
        locale = preferred as Locale
      }
    }
  }

  const englishMessages = (await import('../../messages/en.json')).default
  const localeMessages = locale === 'en'
    ? englishMessages
    : (await import(`../../messages/${locale}.json`)).default

  return {
    locale,
    messages: mergeMessages(englishMessages, localeMessages),
  }
})

function readLockedLocale(): Locale | null {
  const raw = String(process.env.MC_LOCK_LOCALE || process.env.NEXT_PUBLIC_MC_LOCK_LOCALE || 'zh')
    .trim()
    .toLowerCase()
  if (!raw || raw === 'auto') return null
  return locales.includes(raw as Locale) ? raw as Locale : defaultLocale
}

function mergeMessages(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const baseValue = output[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue)
    ) {
      output[key] = mergeMessages(baseValue as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      output[key] = value
    }
  }
  return output
}
