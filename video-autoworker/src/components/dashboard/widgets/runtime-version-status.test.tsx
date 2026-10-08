import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RuntimeVersionStatus } from './runtime-version-status'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('current production version', () => {
  it('uses the running receipt and removes a previous success after a failed refresh', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({
      currentState: 'ready', sourceCommit: '1234567890abcdef', verifiedAt: '2026-10-08T12:00:00Z',
    }) }).mockResolvedValueOnce({ ok: false })
    vi.stubGlobal('fetch', fetcher)
    render(<RuntimeVersionStatus />)
    expect(await screen.findByText('12345678')).toBeInTheDocument()
    expect(screen.getByText('已核对')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重新核对' }))
    expect(await screen.findByText('暂时无法核对')).toBeInTheDocument()
    expect(screen.queryByText('12345678')).toBeNull()
  })

  it('does not describe a drifted release as verified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ currentState: 'drift' }) }))
    render(<RuntimeVersionStatus />)
    expect(await screen.findByText('运行信息有变化')).toBeInTheDocument()
    expect(screen.queryByText('已核对')).toBeNull()
  })
})
