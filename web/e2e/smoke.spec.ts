/**
 * Privasys Harness — browser smoke tests.
 *
 * These catch the classes of failure that shipped undetected before:
 *   1. Reachability + the enclave static-unsealed exemption: the public URL
 *      must serve the UI shell (no `sealed-transport-required`, no hosts file).
 *   2. Branding: the global Auth SDK gate + Privasys chrome, NOT DeepSeek's
 *      "DSH Local Build" / whale mark.
 *   3. No boot crash / console-error storm before sign-in.
 *
 * Coverage gap (tracked): the SIGNED-IN runtime check — sign in, then assert
 * the app actually connects (no "connection lost" loop, workspaces load) —
 * needs sealed-session auth automation (the wallet attests the enclave;
 * methods:['wallet']). The FIDO2 OIDC helper in developer.privasys.org/e2e
 * yields a passkey JWT but not the sealed session, so that leg is stubbed
 * behind E2E_SEALED_STORAGE_STATE until we wire a headless sealed bootstrap.
 * The `connects` test runs only when that state is provided.
 */
import { test, expect } from '@playwright/test'

const URL = process.env.E2E_HARNESS_URL || 'https://attested-harness.apps-test.privasys.org'

test.describe('attested-harness public surface', () => {
  test('serves the UI shell unsealed (exemption)', async ({ page }) => {
    const resp = await page.goto(URL, { waitUntil: 'domcontentloaded' })
    expect(resp, 'no response').toBeTruthy()
    expect(resp!.status(), 'expected 200, not sealed-transport-required/404').toBe(200)
    // dsh boot manifest + our shell mounts must be present.
    await expect(page.locator('#root')).toHaveCount(1)
    await expect(page.locator('#privasys-shell')).toHaveCount(1)
    // Shell + SDK assets load through the exemption.
    for (const a of [
      '/privasys/privasys-shell.js',
      '/privasys/privasys-auth-client.iife.js',
      '/privasys/privasys-shell.css'
    ]) {
      const r = await page.request.get(URL.replace(/\/$/, '') + a)
      expect(r.status(), `${a} must serve unsealed`).toBe(200)
    }
  })

  test('renders the global Auth SDK gate, branded Privasys (not DeepSeek)', async ({ page }) => {
    await page.goto(URL, { waitUntil: 'networkidle' })
    // The SDK ceremony runs in an iframe hosted by the IdP origin.
    await expect(page.locator('iframe')).toBeVisible({ timeout: 20_000 })
    // Title must be the Privasys app name, never the dsh default.
    await expect(page).toHaveTitle(/Privasys Harness/i, { timeout: 20_000 })
    const title = await page.title()
    expect(title, 'dsh default title leaked').not.toMatch(/DSH Local Build/i)
    // The Privasys favicon + logo asset must be the served ones.
    const logo = await page.request.get(URL.replace(/\/$/, '') + '/privasys/privasys-logo.mini.svg')
    expect(logo.status()).toBe(200)
    expect(await logo.text(), 'logo is not the Privasys mark').toContain('#34E89E')
  })

  test('no console-error storm before sign-in', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(URL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(8_000)
    // A handful of benign errors is fine; the failure we regressed on was a
    // FLOOD (401/429 + "connection lost, retry #N"). Fail on that signature.
    const connLost = errors.filter((e) => /connection lost|Too Many Requests|events\.(mux|host).*401/i.test(e))
    expect(connLost.length, `connection-loss storm before sign-in:\n${connLost.slice(0, 5).join('\n')}`).toBeLessThan(3)
  })

  // Signed-in runtime check — the one that would have caught the concurrent
  // sealed-frame 401 storm end to end. Enabled only when a sealed storageState
  // is provided (see the coverage-gap note above).
  test('signed in: the agent runtime connects and stays connected', async ({ browser }) => {
    const state = process.env.E2E_SEALED_STORAGE_STATE
    test.skip(!state, 'needs a sealed-session storageState (headless wallet bootstrap not yet wired)')
    const ctx = await browser.newContext({ storageState: state })
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(URL, { waitUntil: 'networkidle' })
    // After auth, dsh boots into #root; a working runtime shows the composer
    // and NOT a persistent connection-lost state.
    await expect(page.getByText(/Choose (a )?workspace/i)).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(10_000)
    const storm = errors.filter((e) => /connection lost|Too Many Requests|401/i.test(e))
    expect(storm.length, `runtime failed to stay connected:\n${storm.slice(0, 8).join('\n')}`).toBeLessThan(3)
    await ctx.close()
  })
})
