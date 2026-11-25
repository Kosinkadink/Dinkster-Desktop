import { expect } from '@playwright/test'

/** Reach installation management through the same native command as the user. */
export async function installationManager(app) {
  // Desktop sets its menu only after its first window has loaded, which a
  // busy Windows runner can take well over five seconds to do.
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ Menu }) =>
            !!Menu.getApplicationMenu()?.getMenuItemById(
              'desktop-installations',
            ),
        ),
      { timeout: 60_000 },
    )
    .toBe(true)
  const existing = app
    .windows()
    .find((page) =>
      new URL(page.url()).pathname.endsWith('/desktop-environments.html'),
    )
  const opened = existing
    ? Promise.resolve(existing)
    : app.waitForEvent('window')
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const item = menu?.getMenuItemById('desktop-installations')
    if (!item) throw new Error('Installations menu is unavailable')
    item.click(undefined, undefined, undefined)
  })
  const page = await opened
  await expect(
    page.getByRole('heading', { name: 'Environments', exact: true }),
  ).toBeVisible()
  return page
}
