/** Renders a .mmd file to SVG/PNG via headless Chromium, and fails loudly on syntax errors. */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const input = process.argv[2];
const graph = readFileSync(input, 'utf-8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2400, height: 1500 }, deviceScaleFactor: 2 });
await page.setContent('<div id="out"></div>', { waitUntil: 'domcontentloaded' });
await page.addScriptTag({ path: resolve('node_modules/mermaid/dist/mermaid.min.js') });

const result = await page.evaluate(async (definition) => {
  // @ts-ignore
  mermaid.initialize({ startOnLoad: false, theme: 'base', flowchart: { curve: 'basis', htmlLabels: true } });
  try {
    // @ts-ignore
    await mermaid.parse(definition);
    // @ts-ignore
    const { svg } = await mermaid.render('graph', definition);
    document.getElementById('out').innerHTML = svg;
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}, graph);

if (!result.ok) {
  console.error('MERMAID SYNTAX ERROR:\n' + result.error);
  await browser.close();
  process.exit(1);
}

const svg = await page.locator('#out svg').first();
const box = await svg.boundingBox();
writeFileSync(input.replace(/\.mmd$/, '.svg'), await page.locator('#out').innerHTML(), 'utf-8');
await svg.screenshot({ path: input.replace(/\.mmd$/, '.png') });
console.log(`RENDER OK  ${Math.round(box.width)}x${Math.round(box.height)}`);
await browser.close();
