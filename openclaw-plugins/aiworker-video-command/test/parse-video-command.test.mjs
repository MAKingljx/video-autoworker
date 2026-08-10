import { describe, expect, it } from 'vitest'

import { parseVideoCommand } from '../lib/parse-video-command.js'

describe('parseVideoCommand', () => {
  it('accepts canonical paths and requires matching quotes around spaces', () => {
    expect(parseVideoCommand('分析视频 "/Users/Shared/中文 目录/样片 (终版).mkv"')).toEqual({
      kind: 'match',
      videoPath: '/Users/Shared/中文 目录/样片 (终版).mkv',
    })
    expect(parseVideoCommand('分析视频 “/Users/Shared/中文 目录/样片 (终版).MOV”')).toEqual({
      kind: 'match',
      videoPath: '/Users/Shared/中文 目录/样片 (终版).MOV',
    })
    expect(parseVideoCommand('分析视频 /tmp/不要执行.mp4')).toEqual({
      kind: 'match',
      videoPath: '/tmp/不要执行.mp4',
    })
  })

  it('rejects command-shaped but unsafe or unsupported inputs', () => {
    const rejected = [
      '分析视频',
      '分析视频\t/tmp/demo.mp4',
      '分析视频\v/tmp/demo.mp4',
      '分析视频\f/tmp/demo.mp4',
      '分析视频\u00a0/tmp/demo.mp4',
      '分析视频\u3000/tmp/demo.mp4',
      '分析视频 relative/demo.mp4',
      '分析视频 ~/demo.mp4',
      '分析视频 /tmp/demo.txt',
      '分析视频 /Users/Shared/中文 目录/样片 (终版).MOV',
      '分析视频 /tmp/demo.mp4 补充.mp4',
      '分析视频 /tmp/demo.mp4\n现在开始',
      '分析视频 "/tmp/demo\tname.mp4"',
      '分析视频 "/tmp/demo\u001bname.mp4"',
      '分析视频 "/tmp/demo.mp4',
      '分析视频 /tmp/a.mp4 /tmp/b.mp4',
      '分析视频 /tmp/a/../b.mp4',
      '分析视频 /tmp//demo.mp4',
      '分析视频 //tmp/demo.mp4',
      '分析视频  /tmp/demo.mp4',
    ]
    for (const input of rejected) expect(parseVideoCommand(input)).toEqual({ kind: 'invalid' })
  })

  it('leaves unrelated and negative-prefix text to the unified request router', () => {
    expect(parseVideoCommand('请总结这个视频')).toEqual({ kind: 'unmatched' })
    expect(parseVideoCommand('不要分析视频 /tmp/demo.mp4')).toEqual({ kind: 'unmatched' })
    expect(parseVideoCommand('分析视频号的运营数据')).toEqual({ kind: 'unmatched' })
    expect(parseVideoCommand('分析视频会议安排')).toEqual({ kind: 'unmatched' })
    expect(parseVideoCommand('分析视频编码原理')).toEqual({ kind: 'unmatched' })
    expect(parseVideoCommand('分析视频abc')).toEqual({ kind: 'unmatched' })
    expect(parseVideoCommand('分析视频/tmp/demo.mp4')).toEqual({ kind: 'unmatched' })
  })
})
