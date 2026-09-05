import { expect, test, type Page } from '@playwright/test'

const TEST_USER = process.env.AUTH_USER || 'testadmin'
const TEST_PASS = process.env.AUTH_PASS || 'testpass1234!'

function sessionFixture(index: number, longKey = false) {
  const key = longKey
    ? `gateway-overflow-probe-${'x'.repeat(240)}`
    : `overview-session-${index}`
  return {
    id: `overview-session-${index}`,
    key,
    agent: `agent-${index}`,
    kind: 'openclaw',
    age: `${index + 1}m`,
    model: 'qwen/test-model',
    tokens: `${(index + 1) * 100}`,
    flags: [],
    active: index < 3,
    lastActivity: Date.now() - index * 60_000,
  }
}

async function login(page: Page) {
  const testId = test.info().testId
  let ipHash = 0
  for (const character of testId) ipHash = ((ipHash * 31) + character.charCodeAt(0)) >>> 0
  const response = await page.request.post('/api/auth/login', {
    data: { username: TEST_USER, password: TEST_PASS },
    headers: { 'x-real-ip': `10.88.${((ipHash >>> 8) % 254) + 1}.${(ipHash % 254) + 1}` },
  })
  expect(response.status()).toBe(200)
}

type DashboardMode = 'local' | 'gateway'

async function installDashboardRoutes(
  page: Page,
  sessionCount: () => number,
  mode: DashboardMode = 'local',
) {
  await page.route('**/api/status?action=capabilities', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        gateway: mode === 'gateway',
        openclawHome: true,
        claudeHome: true,
        interfaceMode: 'essential',
        processUser: 'testadmin',
      }),
    })
  })

  await page.route('**/api/status?action=dashboard', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        memory: { total: 100, used: 42 },
        disk: { usage: '38%' },
        uptime: 3_600_000,
        db: {
          tasks: { total: 0, byStatus: {} },
          agents: { total: 0, byStatus: {} },
          audit: { day: 0, week: 0, loginFailures: 0 },
          activities: { day: 0 },
          notifications: { unread: 0 },
          pipelines: { active: 0, recentDay: 0 },
          backup: null,
          dbSizeBytes: 0,
          webhookCount: 0,
        },
      }),
    })
  })

  await page.route('**/api/sessions', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        sessions: Array.from(
          { length: sessionCount() },
          (_, index) => sessionFixture(index, mode === 'gateway' && index === 0),
        ),
      }),
    })
  })

  await page.route('**/api/github?action=stats', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not configured' }),
    })
  })
}

const LOCAL_FIXED_WIDGETS = [
  'runtime-health',
  'session-workbench',
  'event-stream',
  'task-flow',
  'github-signal',
]

const GATEWAY_FIXED_WIDGETS = [
  'gateway-health',
  'session-workbench',
  'event-stream',
  'task-flow',
  'security-audit',
  'maintenance',
]

async function fixedPanelBoxes(page: Page, widgets = LOCAL_FIXED_WIDGETS) {
  return Promise.all(widgets.map(async (id) => {
    const box = await page.locator(`[data-dashboard-widget="${id}"] > .panel`).boundingBox()
    expect(box, `${id} should render a visible panel`).not.toBeNull()
    return box!
  }))
}

test.describe('dashboard overview card frames', () => {
  test('keeps the primary cards equal and stable as live content changes', async ({ page }) => {
    let sessions = 0
    await installDashboardRoutes(page, () => sessions)
    await login(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/')

    await expect(page.locator('[data-dashboard-widget="session-workbench"]')).toContainText('暂无活跃会话')
    const emptyBoxes = await fixedPanelBoxes(page)

    for (const box of emptyBoxes) {
      expect(box.height).toBeCloseTo(320, 0)
    }
    for (const box of emptyBoxes.slice(0, 3)) {
      expect(Math.abs(box.y - emptyBoxes[0].y)).toBeLessThanOrEqual(1)
    }

    sessions = 10
    await page.reload()
    await expect(page.locator('[data-dashboard-widget="session-workbench"]')).toContainText('overview-session-9')
    const populatedBoxes = await fixedPanelBoxes(page)
    const sessionScroll = await page
      .locator('[data-dashboard-widget="session-workbench"] .dashboard-widget-scroll')
      .evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }))

    populatedBoxes.forEach((box, index) => {
      expect(Math.abs(box.height - emptyBoxes[index].height)).toBeLessThanOrEqual(1)
      expect(Math.abs(box.height - populatedBoxes[0].height)).toBeLessThanOrEqual(1)
    })
    expect(sessionScroll.scrollHeight).toBeGreaterThan(sessionScroll.clientHeight)
    expect(sessionScroll.overflowY).toBe('auto')
  })

  test('keeps fixed cards inside the overview at narrow widths', async ({ page }) => {
    await installDashboardRoutes(page, () => 10)
    await login(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')

    const main = page.locator('#main-content')
    await expect(main).toBeVisible()
    const overflow = await main.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)

    const mainBox = await main.boundingBox()
    expect(mainBox).not.toBeNull()

    const panels = page.locator('[data-dashboard-widget-frame="fixed"] > .panel')
    await expect(panels.first()).toBeVisible()
    expect(await panels.count()).toBe(LOCAL_FIXED_WIDGETS.length)
    for (let index = 0; index < await panels.count(); index += 1) {
      const box = await panels.nth(index).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(mainBox!.x - 1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 1)
      expect(box!.height).toBeCloseTo(320, 0)
    }
  })

  test('uses the available content width while keeping every responsive row filled', async ({ page }) => {
    await installDashboardRoutes(page, () => 4)
    await login(page)
    await page.setViewportSize({ width: 900, height: 1000 })
    await page.goto('/')

    const rows = page.locator('[data-dashboard-widget-row]')
    await expect(rows.first()).toBeVisible()

    for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
      const row = rows.nth(rowIndex)
      const rowBox = await row.boundingBox()
      expect(rowBox).not.toBeNull()

      const cards = row.locator(':scope > [data-dashboard-widget]')
      const cardCount = await cards.count()
      for (let cardIndex = 0; cardIndex < await cards.count(); cardIndex += 1) {
        const cardBox = await cards.nth(cardIndex).boundingBox()
        expect(cardBox).not.toBeNull()
        expect(cardBox!.height).toBeCloseTo(320, 0)

        const isLastOddCard = cardCount % 2 === 1 && cardIndex === cardCount - 1
        if (cardCount === 1 || isLastOddCard) {
          expect(Math.abs(cardBox!.x - rowBox!.x)).toBeLessThanOrEqual(1)
          expect(Math.abs(cardBox!.width - rowBox!.width)).toBeLessThanOrEqual(1)
          continue
        }

        const expectedWidth = (rowBox!.width - 16) / 2
        const expectedX = rowBox!.x + (cardIndex % 2) * (expectedWidth + 16)
        expect(Math.abs(cardBox!.x - expectedX)).toBeLessThanOrEqual(1)
        expect(Math.abs(cardBox!.width - expectedWidth)).toBeLessThanOrEqual(1)
      }
    }
  })

  test('keeps gateway cards inside the overview at narrow widths', async ({ page }) => {
    await installDashboardRoutes(page, () => 10, 'gateway')
    await login(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')

    const main = page.locator('#main-content')
    await expect(main).toBeVisible()
    const overflow = await main.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)

    const mainBox = await main.boundingBox()
    expect(mainBox).not.toBeNull()

    const panels = page.locator('[data-dashboard-widget-frame="fixed"] > .panel')
    await expect(panels.first()).toBeVisible()
    await expect(page.locator('[data-dashboard-widget="session-workbench"]')).toContainText('gateway-overflow-probe')
    expect(await panels.count()).toBe(GATEWAY_FIXED_WIDGETS.length)
    for (let index = 0; index < await panels.count(); index += 1) {
      const box = await panels.nth(index).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(mainBox!.x - 1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 1)
      expect(box!.height).toBeCloseTo(320, 0)
    }
  })

  test('keeps gateway-only cards on the same fixed frame contract', async ({ page }) => {
    await installDashboardRoutes(page, () => 4, 'gateway')
    await login(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/')

    await expect(page.locator('[data-dashboard-widget="gateway-health"] > .panel')).toBeVisible()
    const boxes = await fixedPanelBoxes(page, GATEWAY_FIXED_WIDGETS)

    for (const box of boxes) {
      expect(box.height).toBeCloseTo(320, 0)
    }
    for (const box of boxes.slice(0, 3)) {
      expect(Math.abs(box.y - boxes[0].y)).toBeLessThanOrEqual(1)
    }

    const maintenanceFill = await page
      .locator('[data-dashboard-widget="maintenance"]')
      .evaluate((element) => {
        const card = element.getBoundingClientRect()
        const row = element.parentElement!.getBoundingClientRect()
        return {
          leftGap: card.left - row.left,
          rightGap: row.right - card.right,
        }
      })
    expect(Math.abs(maintenanceFill.leftGap)).toBeLessThanOrEqual(1)
    expect(Math.abs(maintenanceFill.rightGap)).toBeLessThanOrEqual(1)
  })
})
