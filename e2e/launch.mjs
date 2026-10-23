// Shared browser launch for the e2e scripts: the CI / container Chromium if present, else
// Playwright's bundled Chromium, else an installed Edge or Chrome (e.g. Windows machines where
// the bundled build won't start).

import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';

export async function launchBrowser() {
  const exe = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'].find((p) => existsSync(p));
  const attempts = [{ executablePath: exe }, { channel: 'msedge' }, { channel: 'chrome' }];
  let last;
  for (const opts of attempts) {
    try {
      return await chromium.launch(opts);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
