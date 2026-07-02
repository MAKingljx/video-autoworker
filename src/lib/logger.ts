import pino from 'pino'

function hasPinoPretty(): boolean {
  try {
    require.resolve('pino-pretty')
    return true
  } catch {
    return false
  }
}

const usePretty = process.env.NODE_ENV !== 'production' && hasPinoPretty()

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  hooks: {
    logMethod(inputArgs, method) {
      if (process.env.MC_LOG_LOCALE !== 'en') {
        const args = [...inputArgs]
        const last = args[args.length - 1]
        if (typeof last === 'string') {
          args[args.length - 1] = localizeLogMessage(last)
        }
        return method.apply(this, args as any)
      }
      return method.apply(this, inputArgs as any)
    },
  },
  ...(usePretty && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
})

function localizeLogMessage(message: string): string {
  let text = message
  const replacements: Array<[RegExp, string]> = [
    [
      /AUTH_PASS is not set — admin account will be created via \/setup\. Set AUTH_PASS or AUTH_PASS_B64 to seed an admin from env \(useful for CI\/automation\)\./gi,
      '未设置 AUTH_PASS，管理员账号将通过 /setup 创建。可设置 AUTH_PASS 或 AUTH_PASS_B64 从环境变量预置管理员账号（适合 CI/自动化）。',
    ],
    [/Database migrations applied successfully/gi, '数据库迁移已成功应用'],
    [
      /Scheduler initialized - backup at ~3AM, cleanup at ~4AM, heartbeat every 5m, webhook\/claude\/skill\/local-agent\/gateway-agent sync every 60s/gi,
      '调度器已初始化：约 3 点备份，约 4 点清理，每 5 分钟心跳检查，每 60 秒同步 webhook / OpenClaw / 技能 / 本地智能体 / 网关智能体',
    ],
    [/Agent sync complete/gi, '智能体同步完成'],
    [/Agent auto-sync failed/gi, '智能体自动同步失败'],
    [/Local agent sync failed/gi, '本地智能体同步失败'],
    [/Skill sync failed/gi, '技能同步失败'],
    [/OpenClaw update failed/gi, 'OpenClaw 更新失败'],
    [/OpenClaw doctor fix failed/gi, 'OpenClaw 诊断修复失败'],
    [/Gateway unreachable/gi, '网关不可达'],
    [/Gateway .* timed out/gi, '网关请求超时'],
    [/Gateway .* failed/gi, '网关请求失败'],
    [/Failed to apply database migrations/gi, '数据库迁移应用失败'],
    [/Failed to initialize database/gi, '数据库初始化失败'],
    [/Failed to persist auto-generated values/gi, '自动生成值持久化失败'],
    [/Auto-generated AUTH_SECRET \(persisted to \.data\/\.auto-generated\)/gi, '已自动生成 AUTH_SECRET，并保存到 .data/.auto-generated'],
    [/Auto-generated API_KEY \(persisted to \.data\/\.auto-generated\)/gi, '已自动生成 API_KEY，并保存到 .data/.auto-generated'],
    [/Failed to load token usage from database/gi, '从数据库加载 Token 用量失败'],
    [/Tokens API error/gi, 'Token 接口错误'],
    [/Memory .* API error/gi, '记忆接口错误'],
    [/Status API error/gi, '状态接口错误'],
    [/Diagnostics API error/gi, '诊断接口错误'],
    [/Setup error/gi, '初始化设置错误'],
    [/Login error/gi, '登录错误'],
    [/Internal server error/gi, '服务器内部错误'],
  ]

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement)
  }
  return text
}
