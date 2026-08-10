import { describe, expect, it } from 'vitest'

import { parseNaturalVideoRequest } from '../lib/natural-video-request.js'

describe('natural-language video request parser', () => {
  it.each([
    ['帮我分析一下这个视频 /tmp/demo.mp4', '/tmp/demo.mp4'],
    ['请帮我解析 `/Users/Shared/中文 素材/样片 (final).mov`', '/Users/Shared/中文 素材/样片 (final).mov'],
    ['能不能帮我分析 /tmp/demo.MKV', '/tmp/demo.MKV'],
    ['马上处理视频 "/tmp/不要执行/样片.mp4"', '/tmp/不要执行/样片.mp4'],
    ['请帮我解析 “/Users/Shared/中文 素材/样片 (final).mov”', '/Users/Shared/中文 素材/样片 (final).mov'],
    ['马上分析视频 ‘/tmp/demo.webm’', '/tmp/demo.webm'],
  ])('accepts one affirmative request: %s', (message, videoPath) => {
    expect(parseNaturalVideoRequest(message)).toEqual({ kind: 'match', videoPath })
  })

  it.each([
    ['帮我分析这个视频，但不要执行 /tmp/a.mp4', 'negative_intent'],
    ['先告诉我这个视频怎么分析 /tmp/a.mp4', 'explanation_only'],
    ['帮我分析一下这个视频', 'missing_absolute_path'],
    ['帮我分析 /tmp/a.mp4 和 /tmp/b.mp4', 'multiple_paths'],
    ['帮我分析 /tmp/a.mp4、/tmp/b.mp4', 'multiple_paths'],
    ['帮我分析 /tmp/a.mp4 和 b.mp4', 'multiple_paths'],
    ['帮我分析 /tmp/a.mp4 和 b.avi', 'multiple_paths'],
    ['帮我分析 “/tmp/a.mp4” 以及另一个 b.MOV）', 'multiple_paths'],
    ['帮我分析 “/tmp/a.mp4', 'invalid_message_shape'],
    ['帮我分析 /tmp/a.mp4/../b.mp4', 'multiple_paths'],
    ['帮我分析 /tmp/a/../b.mp4', 'noncanonical_path'],
    ['帮我分析 /tmp//b.mp4', 'noncanonical_path'],
    ['帮我分析这个视频 https://example.com/a.mp4', 'url_not_allowed'],
    ['帮我分析这个视频 ../a.mp4', 'relative_path_not_allowed'],
    ['帮我分析这个视频 /tmp/a.avi', 'unsupported_video_path'],
    ['比如用“帮我分析 /tmp/a.mp4”作为示例', 'example_only'],
    ['分析视频 /tmp/a.mp4', 'exact_command_reserved'],
    ['分析视频\t/tmp/a.mp4', 'exact_command_reserved'],
    ['这个视频能分析吗 /tmp/a.mp4', 'capability_question'],
    ['你可以分析这个视频吗 /tmp/a.mp4', 'capability_question'],
    ['是否可以分析这个视频 /tmp/a.mp4', 'capability_question'],
  ])('fails closed: %s', (message, reason) => {
    expect(parseNaturalVideoRequest(message)).toEqual({ kind: 'blocked', reason })
  })

  it.each(['avi', 'wmv', 'flv', 'mpeg', 'mpg', 'ts', '3gp', 'mp4', 'webm'])(
    'counts an extra bare .%s token as multi-video ambiguity',
    extension => {
      expect(parseNaturalVideoRequest(
        `帮我分析 /tmp/a.mp4 和 second.${extension}`,
      )).toEqual({ kind: 'blocked', reason: 'multiple_paths' })
    },
  )

  it.each([
    '今天的任务进展怎么样',
    '请分析这份数据',
    '/tmp/a.mp4',
    '请安排明天的视频会议',
  ])('leaves unrelated input unmatched: %s', (message) => {
    expect(parseNaturalVideoRequest(message)).toEqual({ kind: 'unmatched' })
  })

  it('rejects multiline and oversized video-shaped messages', () => {
    expect(parseNaturalVideoRequest('帮我分析视频\n/tmp/a.mp4')).toEqual({
      kind: 'blocked', reason: 'invalid_message_shape',
    })
    expect(parseNaturalVideoRequest(`帮我分析视频 /tmp/${'a'.repeat(4_100)}.mp4`)).toEqual({
      kind: 'blocked', reason: 'invalid_message_shape',
    })
  })

  it('does not hijack unrelated multiline or oversized agent prompts', () => {
    expect(parseNaturalVideoRequest('请整理下面的任务\n第一项：核对数据')).toEqual({
      kind: 'unmatched',
    })
    expect(parseNaturalVideoRequest(`请总结这份数据 ${'a'.repeat(4_100)}`)).toEqual({
      kind: 'unmatched',
    })
  })
})
