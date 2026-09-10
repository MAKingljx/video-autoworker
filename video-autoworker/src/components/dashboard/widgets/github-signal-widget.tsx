'use client'

import { StatRow, type DashboardData } from '../widget-primitives'

export function GithubSignalWidget({ data }: { data: DashboardData }) {
  const { githubStats, isGithubLoading } = data

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 className="text-sm font-semibold">GitHub 信号</h3>
        {githubStats?.user && <span className="text-2xs text-muted-foreground font-mono-tight">@{githubStats.user.login}</span>}
      </div>
      <div className="panel-body space-y-3">
        {githubStats ? (
          <>
            <StatRow label="活跃仓库" value={githubStats.repos.total} />
            <StatRow label="公开 / 私有" value={`${githubStats.repos.public} / ${githubStats.repos.private}`} />
            <StatRow label="未关闭 Issues" value={githubStats.repos.total_open_issues} />
            <StatRow label="Stars" value={githubStats.repos.total_stars} />
          </>
        ) : (
          <div className="text-center py-4">
            <p className="text-xs text-muted-foreground">{isGithubLoading ? '正在加载 GitHub 统计...' : '未配置 GitHub Token'}</p>
            {!isGithubLoading && <p className="text-2xs text-muted-foreground/60 mt-1">请在 .env.local 中设置 GITHUB_TOKEN</p>}
          </div>
        )}
      </div>
    </div>
  )
}
