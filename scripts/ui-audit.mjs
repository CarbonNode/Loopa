/**
 * UI audit: screenshots plus automated overlap detection at real viewports.
 *
 * The manual eyeball pass misses collisions that only appear at one width or
 * with one content length, so this drives a real browser at several sizes and
 * asserts the things that actually break: horizontal overflow, overlapping
 * interactive controls, clipped text, and elements pushed off-screen.
 *
 * Usage: node scripts/ui-audit.mjs [baseUrl] [outDir]
 */
// playwright-core is CommonJS, so it has no named ESM exports.
import playwright from '/tmp/node_modules/playwright-core/index.js';
import { mkdir } from 'node:fs/promises';

const { chromium } = playwright;

const BASE = process.argv[2] ?? 'http://127.0.0.1:8099';
const OUT = process.argv[3] ?? '/tmp/loopa-shots';

const CREDENTIALS = {
  username: process.env.LOOPA_AUDIT_USER ?? 'admin',
  password: process.env.LOOPA_AUDIT_PASSWORD ?? 'wkomstu95@',
};

// A short, stable, Creative Commons video: the studio needs a real YouTube id
// to resolve, and a link that could be deleted would make the audit flaky.
const STUDIO_TEST_URL = process.env.LOOPA_AUDIT_VIDEO ?? 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

const VIEWPORTS = [
  { name: 'mobile-360', width: 360, height: 780 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'desktop-1920', width: 1920, height: 1080 },
];

/**
 * Runs in the page. Reports layout defects rather than screenshots, because
 * a 2px collision is invisible to the eye but breaks a tap target.
 */
const AUDIT = () => {
  const problems = [];
  const rect = (element) => element.getBoundingClientRect();
  /**
   * Visibility has to consider ancestors, not just the element.
   *
   * A card's action buttons are opacity:1 themselves but sit in a container
   * that is opacity:0 until hover — checking only the element reports
   * controls the user cannot currently see.
   */
  const visible = (element) => {
    let node = element;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      node = node.parentElement;
    }
    const box = rect(element);
    return box.width > 0 && box.height > 0;
  };

  // 1. Horizontal overflow — the single most common responsive bug, and it
  //    makes the whole page slide sideways on a phone.
  const docWidth = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > docWidth + 1) {
    problems.push({
      kind: 'horizontal-overflow',
      detail: `page scrollWidth ${document.documentElement.scrollWidth} > viewport ${docWidth}`,
    });

    for (const element of document.querySelectorAll('body *')) {
      if (!visible(element)) continue;
      const box = rect(element);
      if (box.right > docWidth + 1 && box.width <= docWidth) {
        problems.push({
          kind: 'element-overflows-right',
          detail: `${element.className || element.tagName} right=${Math.round(box.right)}`,
        });
        if (problems.length > 12) break;
      }
    }
  }

  // 2. Overlapping interactive controls. Two buttons sharing pixels means one
  //    of them cannot be clicked.
  //
  //    Only *within the same stacking layer* — a modal is supposed to cover
  //    the grid behind it, and counting that as a collision buries the real
  //    findings in noise. The nearest fixed-position ancestor identifies the
  //    layer an element belongs to.
  const layerOf = (element) => {
    let node = element;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.position === 'fixed' || style.position === 'sticky') return node;
      node = node.parentElement;
    }
    return document.body;
  };

  const controls = [...document.querySelectorAll('button, a[href], input, select, textarea')].filter(visible);
  const layers = new Map(controls.map((element) => [element, layerOf(element)]));

  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const a = controls[i];
      const b = controls[j];
      // Nesting is a containment relationship, not a collision.
      if (a.contains(b) || b.contains(a)) continue;
      // Different layers: the overlap is deliberate stacking.
      if (layers.get(a) !== layers.get(b)) continue;

      const ra = rect(a);
      const rb = rect(b);
      const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (overlapX <= 2 || overlapY <= 2) continue;

      const overlapArea = overlapX * overlapY;
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (overlapArea / smaller < 0.3) continue;

      // Overlap alone is not a defect — a card's favourite button is meant to
      // float over the card, and a search field's clear button over the
      // field. What matters is whether each control still has somewhere the
      // user can actually hit it. Ask the browser: if hit-testing a control's
      // own centre returns that control, it is reachable.
      //
      // elementFromPoint is viewport-relative, so this is only meaningful for
      // elements currently on screen. Clamping an off-screen centre into the
      // viewport would hit-test a completely different element and report a
      // collision that does not exist.
      const onScreen = (box) =>
        box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth;

      if (!onScreen(ra) || !onScreen(rb)) continue;

      const reachable = (element, box) => {
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!hit) return false;
        if (element === hit || element.contains(hit) || hit.contains(element)) return true;
        // Covered by a different stacking layer — an open modal, drawer or
        // toast deliberately makes the page behind it unreachable. That is
        // the overlay working, not a collision between these two controls.
        return layerOf(hit) !== layers.get(element);
      };

      if (reachable(a, ra) && reachable(b, rb)) continue;

      problems.push({
        kind: 'controls-overlap',
        detail: `${a.className || a.tagName} ∩ ${b.className || b.tagName} (${Math.round(overlapX)}×${Math.round(overlapY)}px) — one is unreachable`,
      });
      if (problems.length > 20) return problems;
    }
  }

  // 3. Text clipped by its container without an ellipsis to signal it.
  for (const element of document.querySelectorAll('h1, h2, h3, p, span, .chip__label, .sidebar__label')) {
    if (!visible(element)) continue;
    // .visually-hidden is a deliberate 1px clip for screen-reader-only text.
    if (element.closest('.visually-hidden')) continue;
    const style = getComputedStyle(element);
    if (style.overflow === 'visible') continue;
    if (style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none') continue;
    if (element.scrollWidth > element.clientWidth + 2) {
      problems.push({
        kind: 'text-clipped',
        detail: `${element.className || element.tagName}: "${(element.textContent ?? '').slice(0, 40)}"`,
      });
    }
  }

  // 4. Anything pushed off the left edge is simply unreachable.
  for (const element of document.querySelectorAll('button, a[href], input')) {
    if (!visible(element)) continue;
    const box = rect(element);
    if (box.right < 0 || box.left > docWidth) {
      problems.push({ kind: 'offscreen-control', detail: `${element.className || element.tagName}` });
    }
  }

  // 5. Tap targets below the 24px minimum are hard to hit on a phone.
  if (window.innerWidth <= 640) {
    for (const element of document.querySelectorAll('button, a[href]')) {
      if (!visible(element)) continue;
      const box = rect(element);
      if (box.height < 24 || box.width < 24) {
        problems.push({
          kind: 'tap-target-small',
          detail: `${element.className || element.tagName} ${Math.round(box.width)}×${Math.round(box.height)}`,
        });
      }
    }
  }

  return problems;
};

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const findings = [];
  let shotCount = 0;

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      // Emulate touch on phone-sized viewports. Without it the browser still
      // reports pointer:fine, so every `@media (pointer: coarse)` rule — which
      // is where the enlarged tap targets live — is skipped, and the audit
      // measures sizes the real device would never see.
      hasTouch: viewport.width <= 640,
      isMobile: viewport.width <= 640,
      // Autoplay would otherwise leave hover previews mid-frame and make
      // screenshots non-deterministic.
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();

    const consoleErrors = [];
    /**
     * Only our own frames count.
     *
     * The clip studio embeds the YouTube player, and a third-party iframe
     * logs its own errors into this page's console — cookie warnings, its own
     * failed requests. Reporting those as findings would bury a genuine bug
     * from our code in noise we cannot fix anyway.
     */
    const isOurs = (url) => !url || url.startsWith(BASE) || url.startsWith('blob:') || url.startsWith('data:');
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (!isOurs(message.location()?.url ?? '')) return;
      consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    const record = async (label) => {
      // Let transitions settle before measuring or shooting.
      await page.waitForTimeout(450);
      const problems = await page.evaluate(AUDIT);
      for (const problem of problems) findings.push({ viewport: viewport.name, view: label, ...problem });
      await page.screenshot({ path: `${OUT}/${viewport.name}--${label}.png`, fullPage: false });
      shotCount += 1;
    };

    // ── Sign in ──────────────────────────────────────────────────────────
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await record('01-login');

    await page.fill('#auth-username', CREDENTIALS.username);
    await page.fill('#auth-password', CREDENTIALS.password);
    await page.click('button[type="submit"]');
    // .pending-card counts too: with a download in flight and nothing else in
    // the library, the grid renders placeholders and neither of the other two
    // ever appears, so waiting on them alone hangs the whole run.
    await page.waitForSelector('.clip-card, .empty-state, .pending-card', { timeout: 20_000 });
    await record('02-library');

    // ── Clip context menu ────────────────────────────────────────────────
    // Anchored to the cursor and rendered above everything, so it is exactly
    // the shape of thing that collides with the card actions underneath it.
    const menuCard = await page.$('.clip-card__surface');
    if (menuCard) {
      await menuCard.click({ button: 'right' });
      await page.waitForSelector('.context-menu', { timeout: 8000 });
      await record('03-context-menu');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // ── Category context menu + inline rename ────────────────────────────
    // Below 900px the sidebar is a drawer, so it has to be opened to reach a
    // category at all.
    const drawer = viewport.width <= 900;
    if (drawer) {
      await page.click('.topbar__menu-toggle');
      await page.waitForTimeout(400);
    }

    const categoryRow = await page.$('.sidebar__item--category');
    if (categoryRow) {
      await categoryRow.click({ button: 'right' });
      await page.waitForSelector('.context-menu', { timeout: 8000 });
      await record('04-category-menu');

      // The row turns into its own editor; it must not shift the list.
      await page.click('.context-menu__item:has-text("Rename")');
      await page.waitForSelector('.sidebar__rename', { timeout: 8000 });
      await record('05-category-rename');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    if (drawer) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      if (await page.$('.sidebar--open')) {
        await page.click('.topbar__menu-toggle');
        await page.waitForTimeout(400);
      }
    }

    // ── Sidebar (a drawer below 900px) ───────────────────────────────────
    if (viewport.width <= 900) {
      await page.click('.topbar__menu-toggle');
      await page.waitForTimeout(400);
      await record('06-sidebar-drawer');

      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      // The drawer covers the page; if it is still open every later click
      // silently targets it instead of the intended control.
      const stillOpen = await page.$('.sidebar--open');
      if (stillOpen) {
        await page.click('.topbar__menu-toggle');
        await page.waitForTimeout(400);
      }
      await page.waitForSelector('.sidebar--open', { state: 'detached', timeout: 5000 });
    }

    // ── Search with results ──────────────────────────────────────────────
    await page.fill('.topbar__search-input', 'dog');
    await page.waitForTimeout(700);
    await record('07-search');

    // ── Search with no results (empty state) ─────────────────────────────
    await page.fill('.topbar__search-input', 'zzzznothingmatches');
    await page.waitForTimeout(700);
    await record('08-search-empty');
    await page.fill('.topbar__search-input', '');
    await page.waitForTimeout(600);

    // ── Lightbox ─────────────────────────────────────────────────────────
    const card = await page.$('.clip-card__surface');
    if (card) {
      await card.click();
      await page.waitForSelector('.lightbox__panel', { timeout: 10_000 });
      await page.waitForTimeout(800);
      await record('09-lightbox');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    // ── Import dialog ────────────────────────────────────────────────────
    await page.click('.btn--primary:has-text("Add link"), .topbar__actions .btn--primary');
    await page.waitForSelector('.import-dialog', { timeout: 10_000 });
    await page.fill(
      '#import-urls',
      'https://www.instagram.com/reel/CxAmpleReel/\nhttps://www.tiktok.com/@someone/video/7300000000000000000',
    );
    await page.waitForTimeout(900);
    await record('10-import');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // ── Settings ─────────────────────────────────────────────────────────
    await page.click('.topbar__avatar');
    await page.waitForTimeout(250);
    await page.click('text=Settings');
    await page.waitForSelector('.settings', { timeout: 10_000 });
    await record('11-settings-account');

    await page.click('.settings__tab:has-text("Ingest")');
    await page.waitForTimeout(500);
    await record('12-settings-ingest');

    const peopleTab = await page.$('.settings__tab:has-text("People")');
    if (peopleTab) {
      await peopleTab.click();
      await page.waitForTimeout(500);
      await record('13-settings-people');
    }

    const libraryTab = await page.$('.settings__tab:has-text("Library")');
    if (libraryTab) {
      await libraryTab.click();
      await page.waitForTimeout(500);
      await record('14-settings-library');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ── Clip studio ──────────────────────────────────────────────────────
    // Navigated by URL rather than by clicking the sidebar, so this also
    // exercises the SPA fallback: /studio has to survive a hard load.
    await page.goto(`${BASE}/studio`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.studio__empty', { timeout: 20_000 });
    await record('15-studio-empty');

    await page.fill('#studio-url', STUDIO_TEST_URL);
    await page.click('.studio__paste button[type="submit"]');
    // The timeline only appears once a duration is known — from the server
    // resolve, or from the player. Either way it is a network round trip, and
    // a machine with no route to YouTube should still produce a screenshot of
    // whatever state it reached rather than failing the whole run.
    await page
      .waitForSelector('.timeline__track', { timeout: 60_000 })
      .catch(() => console.warn('  (studio timeline did not appear — offline?)'));

    // The player supplies a duration in well under a second, but the title,
    // chapters and heatmap come from a yt-dlp call that takes a couple more.
    // Without waiting for that, this screenshots the skeleton state and the
    // populated panel never gets audited at all.
    await page
      .waitForFunction(
        () => {
          const title = document.querySelector('.studio__meta-title');
          return Boolean(title?.textContent) && title.textContent.trim() !== 'Loading…';
        },
        { timeout: 45_000 },
      )
      .catch(() => console.warn('  (studio metadata did not resolve — offline?)'));
    await page.waitForTimeout(700);
    await record('16-studio-loaded');

    // Zoomed in: the overview strip and the ruler only render past this point,
    // and the handles land near each other, which is where they collide.
    const fitButton = await page.$('.timeline__zoom button:has-text("Fit")');
    if (fitButton) {
      await fitButton.click();
      await page.waitForTimeout(400);
      await record('17-studio-zoomed');
    }

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await record('18-studio-light');
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    // .pending-card counts too: with a download in flight and nothing else in
    // the library, the grid renders placeholders and neither of the other two
    // ever appears, so waiting on them alone hangs the whole run.
    await page.waitForSelector('.clip-card, .empty-state, .pending-card', { timeout: 20_000 });

    // ── Selection bar (bottom-centre; must clear toasts and upload tray) ──
    const cards = await page.$$('.clip-card__action--select');
    for (const selectButton of cards.slice(0, 3)) {
      await selectButton.click();
      await page.waitForTimeout(120);
    }
    await record('19-selection');

    // ── Light theme ──────────────────────────────────────────────────────
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.waitForTimeout(400);
    await record('20-light-theme');

    for (const error of consoleErrors) {
      findings.push({ viewport: viewport.name, view: 'console', kind: 'console-error', detail: error.slice(0, 200) });
    }

    await context.close();
  }

  await browser.close();

  // ── Report ───────────────────────────────────────────────────────────────
  console.log(`\n${shotCount} screenshots written to ${OUT}\n`);

  if (findings.length === 0) {
    console.log('No layout problems detected.');
    return;
  }

  // Group so one systemic issue does not read as fifty separate ones.
  const grouped = new Map();
  for (const finding of findings) {
    const key = `${finding.kind}::${finding.detail}`;
    if (!grouped.has(key)) grouped.set(key, { ...finding, where: [] });
    grouped.get(key).where.push(`${finding.viewport}/${finding.view}`);
  }

  console.log(`${grouped.size} distinct problem(s):\n`);
  for (const problem of grouped.values()) {
    console.log(`  [${problem.kind}] ${problem.detail}`);
    console.log(`      seen at: ${problem.where.slice(0, 6).join(', ')}${problem.where.length > 6 ? ` (+${problem.where.length - 6})` : ''}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
