import { describe, expect, it } from 'vitest'
import { resolveN8nEditorTarget } from '@/lib/n8n-editor-url'

describe('resolveN8nEditorTarget', () => {
  it('allows a loopback editor from a loopback Mission Control page', () => {
    const target = resolveN8nEditorTarget(
      'http://127.0.0.1:5678',
      'http://127.0.0.1:3017/automation',
    )

    expect(target).toEqual({
      href: 'http://127.0.0.1:5678/',
      canOpen: true,
      canEmbed: true,
      openReason: null,
      embedReason: null,
    })
  })

  it('rejects a loopback editor when the page is being viewed remotely', () => {
    const target = resolveN8nEditorTarget(
      'http://127.0.0.1:5678',
      'https://control.example.com/automation',
    )

    expect(target.href).toBe('http://127.0.0.1:5678/')
    expect(target.canOpen).toBe(false)
    expect(target.canEmbed).toBe(false)
    expect(target.openReason).toContain('当前设备')
  })

  it('opens but does not embed across different loopback hostnames', () => {
    const target = resolveN8nEditorTarget(
      'http://127.0.0.1:5678',
      'http://localhost:3017/automation',
    )

    expect(target.canOpen).toBe(true)
    expect(target.canEmbed).toBe(false)
    expect(target.embedReason).toContain('相同的回环主机名')
  })

  it('allows an external editor but blocks HTTP iframe mixed content', () => {
    const target = resolveN8nEditorTarget(
      'http://192.168.1.20:5678',
      'https://control.example.com/automation',
    )

    expect(target.canOpen).toBe(true)
    expect(target.canEmbed).toBe(false)
    expect(target.embedReason).toContain('HTTPS')
  })

  it('preserves a configured base path and removes query and fragment data', () => {
    const target = resolveN8nEditorTarget(
      'https://control.example.com/n8n?token=ignored#section',
      'https://control.example.com/automation',
    )

    expect(target.href).toBe('https://control.example.com/n8n/')
    expect(target.canEmbed).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'file:///tmp/n8n',
    'http://user:secret@127.0.0.1:5678',
    'not a url',
  ])('rejects unsafe editor URL %s', (baseUrl) => {
    const target = resolveN8nEditorTarget(baseUrl, 'http://127.0.0.1:3017/automation')

    expect(target.href).toBeNull()
    expect(target.canOpen).toBe(false)
    expect(target.canEmbed).toBe(false)
  })
})
