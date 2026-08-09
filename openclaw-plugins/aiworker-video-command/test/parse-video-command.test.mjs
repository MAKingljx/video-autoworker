import { describe, expect, it } from 'vitest'

import { parseVideoCommand } from '../lib/parse-video-command.js'

describe('parseVideoCommand', () => {
  it('accepts the whole absolute-path remainder, including unquoted spaces', () => {
    expect(parseVideoCommand('分析视频 /Users/Shared/中文 目录/样片 (终版).MOV')).toEqual({
      kind: 'match',
      videoPath: '/Users/Shared/中文 目录/样片 (终版).MOV',
    })
    expect(parseVideoCommand('分析视频 "/Users/Shared/中文 目录/样片 (终版).mkv"')).toEqual({
      kind: 'match',
      videoPath: '/Users/Shared/中文 目录/样片 (终版).mkv',
    })
    expect(parseVideoCommand('分析视频 /tmp/demo.mp4 补充.mp4')).toEqual({
      kind: 'match',
      videoPath: '/tmp/demo.mp4 补充.mp4',
    })
  })

  it('rejects command-shaped but unsafe or unsupported inputs', () => {
    const rejected = [
      '分析视频 relative/demo.mp4',
      '分析视频 ~/demo.mp4',
      '分析视频 /tmp/demo.txt',
      '分析视频 /tmp/demo.mp4\n现在开始',
      '分析视频 "/tmp/demo.mp4',
      '分析视频 /tmp/不要开始.mp4',
      '分析视频 /tmp/不要执行.mp4',
      '分析视频 /tmp/不要提交.mp4',
      '分析视频  /tmp/demo.mp4',
    ]
    for (const input of rejected) expect(parseVideoCommand(input)).toEqual({ kind: 'invalid' })
  })

  it('leaves unrelated and negative-prefix text to normal agent routing', () => {
    expect(parseVideoCommand('请总结这个视频')).toEqual({ kind: 'unmatched' })
    expect(parseVideoCommand('不要分析视频 /tmp/demo.mp4')).toEqual({ kind: 'unmatched' })
  })
})
