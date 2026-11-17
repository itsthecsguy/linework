// Runs once before the suite. Most tests draw, so they need a browser: without
// one, say that once and say what to do, rather than failing test by test.
import fs from 'node:fs';
import path from 'node:path';

const newest = (dir: string): number =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((t, e) => Math.max(t, e.isDirectory() ? newest(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).mtimeMs), 0);

export default async function setup() {
  const unit = process.env.LINEWORK_SKIP_E2E === '1' || process.env.npm_lifecycle_event === 'test:unit';
  if (unit) {
    console.warn('\nlinework: running only the tests that need no browser. The drawing tests are skipped.\n');
    return;
  }
  // test/daemon.test.ts runs the compiled CLI, so it tests whatever dist/ holds.
  const cli = fs.statSync('dist/cli.js', { throwIfNoEntry: false });
  if (!cli) console.warn('\nlinework: dist/ is missing, so the background-process tests are skipped. Run "npm run verify" (or "npm run build" first) to include them.\n');
  else if (cli.mtimeMs < newest('src')) console.warn('\nlinework: dist/ is older than src/, so the background-process tests run the old build. Run "npm run verify" (or "npm run build" first).\n');

  const { DrawioBrowser } = await import('../src/render/browser.js');
  try {
    await (await DrawioBrowser.launch()).close();
  } catch (e) {
    throw new Error(
      `The drawing tests need a Chromium-based browser, and linework couldn't start one.\n\n${(e as Error).message}\n\n` +
        'Then run the tests again. To run only the tests that need no browser: npm run test:unit',
    );
  }
}
