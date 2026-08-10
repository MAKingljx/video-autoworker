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
    ['帮我分析一下这个视频 /tmp/demo.mp4，不要等待', '/tmp/demo.mp4'],
    ['帮我分析一下这个视频 /tmp/demo.mp4，不要一直盯着', '/tmp/demo.mp4'],
    ['帮我分析一下这个视频 /tmp/demo.mp4，不要回投', '/tmp/demo.mp4'],
    ['帮我分析一下这个视频 /tmp/demo.mp4，不用回复结果', '/tmp/demo.mp4'],
    ['帮我分析一下这个视频 /tmp/demo.mp4，先提交再说', '/tmp/demo.mp4'],
    ['不要等待，帮我分析一下这个视频 /tmp/demo.mp4', '/tmp/demo.mp4'],
    ['不要一直盯着，帮我分析一下这个视频 /tmp/demo.mp4', '/tmp/demo.mp4'],
    ['不要回投，帮我分析一下这个视频 /tmp/demo.mp4', '/tmp/demo.mp4'],
    ['不用回复结果，帮我分析一下这个视频 /tmp/demo.mp4', '/tmp/demo.mp4'],
    ['只分析一下这个视频 /tmp/a.mp4', '/tmp/a.mp4'],
    ['仅分析这个视频 /tmp/a.mp4', '/tmp/a.mp4'],
    ['请只分析这个视频 /tmp/a.mp4', '/tmp/a.mp4'],
    ['帮我仅分析这个视频 /tmp/a.mp4', '/tmp/a.mp4'],
    ['只分析这个视频的音频和画面 /tmp/a.mp4', '/tmp/a.mp4'],
  ])('accepts one affirmative request: %s', (message, videoPath) => {
    expect(parseNaturalVideoRequest(message)).toEqual({ kind: 'match', videoPath })
  })

  it.each([
    ['帮我分析一下这个视频', 'missing_absolute_path'],
    ['帮我分析 /tmp/a.mp4 和 /tmp/b.mp4', 'multiple_paths'],
    ['帮我分析 /tmp/a.mp4、/tmp/b.mp4', 'multiple_paths'],
    ['帮我分析 /tmp/a.mp4 和 b.mp4', 'multiple_paths'],
    ['帮我分析 /tmp/a.mp4 和 b.avi', 'multiple_paths'],
    ['帮我分析 “/tmp/a.mp4” 以及另一个 b.MOV）', 'multiple_paths'],
    ['帮我分析 “/tmp/a.mp4', 'invalid_message_shape'],
    ['帮我分析 /tmp/a.mp4/../b.mp4', 'relative_path_not_allowed'],
    ['帮我分析 /tmp/a/../b.mp4', 'relative_path_not_allowed'],
    ['帮我分析 /tmp//b.mp4', 'noncanonical_path'],
    ['帮我分析这个视频 https://example.com/a.mp4', 'url_not_allowed'],
    ['帮我分析这个视频 ../a.mp4', 'relative_path_not_allowed'],
    ['帮我分析这个视频：../a.mp4', 'relative_path_not_allowed'],
    ['帮我分析这个视频路径是../a.mp4', 'relative_path_not_allowed'],
    ['帮我分析这个视频路径是~/a.mp4', 'relative_path_not_allowed'],
    ['帮我分析这个视频路径是abc/tmp/a.mp4', 'missing_absolute_path'],
    ['帮我分析这个视频 C:/tmp/a.mp4', 'missing_absolute_path'],
    ['帮我分析这个视频 x/a.mp4', 'missing_absolute_path'],
    ['帮我分析这个视频 /tmp/a.avi', 'unsupported_video_path'],
    ['帮我分析这个视频 /Users/Shared/中文 素材/样片.mp4', 'unquoted_space_path'],
    ['只分析画面 /tmp/a.mp4', 'partial_analysis_unsupported'],
    ['仅分析音频 /tmp/a.mp4', 'partial_analysis_unsupported'],
    ['请只分析这个视频的视觉 /tmp/a.mp4', 'partial_analysis_unsupported'],
    ['帮我仅识别该视频的语音 /tmp/a.mp4', 'partial_analysis_unsupported'],
    ['只分析这个视频的字幕 /tmp/a.mp4', 'partial_analysis_unsupported'],
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
    '分析视频号的运营数据',
    '请分析视频号的运营数据',
    '帮我分析视频号的运营数据',
    '分析视频会议安排',
    '请分析视频会议安排',
    '帮我分析视频会议安排',
    '分析视频编码原理',
    '请分析视频编码原理',
    '帮我分析视频编码原理',
  ])('leaves unrelated input unmatched: %s', (message) => {
    expect(parseNaturalVideoRequest(message)).toEqual({ kind: 'unmatched' })
  })

  it.each([
    ['帮我分析这个视频，但不要执行 /tmp/a.mp4', 'negative_intent'],
    ['请勿分析这个视频 /tmp/a.mp4', 'negative_intent'],
    ['禁止分析这个视频 /tmp/a.mp4', 'negative_intent'],
    ['我不想分析这个视频 /tmp/a.mp4', 'negative_intent'],
    ['不需要分析这个视频 /tmp/a.mp4', 'negative_intent'],
    ['不要提交这个视频 /tmp/a.mp4', 'negative_intent'],
    ['先别分析这个视频 /tmp/a.mp4', 'negative_intent'],
    ['先告诉我这个视频怎么分析 /tmp/a.mp4', 'explanation_only'],
    ['比如用“帮我分析 /tmp/a.mp4”作为示例', 'example_only'],
    ['分析视频 /tmp/a.mp4', 'exact_command_reserved'],
    ['分析视频\t/tmp/a.mp4', 'exact_command_reserved'],
    ['这个视频能分析吗 /tmp/a.mp4', 'capability_question'],
    ['你可以分析这个视频吗 /tmp/a.mp4', 'capability_question'],
    ['是否可以分析这个视频 /tmp/a.mp4', 'capability_question'],
    ['如果确认后再分析这个视频 /tmp/a.mp4', 'conditional_intent'],
    ['等我确认后分析这个视频 /tmp/a.mp4', 'conditional_intent'],
    ['确认后再分析这个视频 /tmp/a.mp4', 'conditional_intent'],
    ['先给我方案再分析这个视频 /tmp/a.mp4', 'conditional_intent'],
    ['刚才我说帮我分析这个视频 /tmp/a.mp4', 'historical_reference'],
    ['之前请你分析这个视频 /tmp/a.mp4', 'historical_reference'],
  ])('classifies non-execution video conversation for managed hook replies: %s', (message, reason) => {
    expect(parseNaturalVideoRequest(message)).toEqual({ kind: 'pass', reason })
  })

  it('rejects multiline and oversized video-shaped messages', () => {
    expect(parseNaturalVideoRequest('帮我分析视频\n/tmp/a.mp4')).toEqual({
      kind: 'blocked', reason: 'invalid_message_shape',
    })
    expect(parseNaturalVideoRequest(`帮我分析视频 /tmp/${'a'.repeat(4_100)}.mp4`)).toEqual({
      kind: 'blocked', reason: 'invalid_message_shape',
    })
    expect(parseNaturalVideoRequest('帮我分析视频 "/tmp/a\tname.mp4"')).toEqual({
      kind: 'blocked', reason: 'invalid_message_shape',
    })
    expect(parseNaturalVideoRequest('帮我分析视频 "/tmp/a\u001bname.mp4"')).toEqual({
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
    expect(parseNaturalVideoRequest('先告诉我怎么分析视频\n/tmp/a.mp4')).toEqual({
      kind: 'pass', reason: 'explanation_only',
    })
  })
})
