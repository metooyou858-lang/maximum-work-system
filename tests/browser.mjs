import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(process.argv[2] || join(root, 'package.json'));
const { chromium } = require('playwright');
const out = join(root, 'artifacts', 'qa');
mkdirSync(out, { recursive: true });
const staticServer = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (!['index.html', 'app.js', 'style.css', 'demo-store.js', 'demo-config.js'].includes(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(readFileSync(join(root, 'phone-demo', 'dist', file)));
});
const app = createApp({ database: ':memory:' });
let browser;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function waitText(page, text) { await page.getByText(text, { exact: true }).first().waitFor(); }
async function fit(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Горизонтальная прокрутка');
}
try {
  await listen(staticServer); await listen(app.server);
  browser = await chromium.launch({ headless: true });
  for (const [name, server] of [['phone', staticServer], ['server', app.server]]) {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: 'Прибыл', exact: true }).waitFor();
    await fit(page);
    await page.screenshot({ path: join(out, `${name}-01-arrival-390.png`), fullPage: true });
    await page.getByRole('button', { name: 'Руководитель', exact: true }).click();
    await waitText(page, 'Прибытие ещё не отмечено');
    await page.getByRole('button', { name: 'Сотрудник', exact: true }).click();
    for (const scenario of ['offsite', 'unavailable', 'denied', 'inaccurate']) {
      await page.locator('#scenario').selectOption(scenario);
      await page.getByRole('button', { name: 'Прибыл', exact: true }).click();
      await page.locator('#arrival-feedback .error').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Заполнить отчёт', exact: true }).count(), 0);
      await fit(page);
      if (scenario === 'offsite') await page.screenshot({ path: join(out, `${name}-02-offsite-390.png`), fullPage: true });
    }
    await page.locator('#scenario').selectOption('onsite');
    await page.getByRole('button', { name: 'Прибыл', exact: true }).click();
    await waitText(page, 'Прибытие зафиксировано');
    await page.getByRole('button', { name: 'Заполнить отчёт', exact: true }).click();
    await page.getByLabel('Вид работ', { exact: true }).selectOption('cutting');
    assert.equal(await page.getByLabel('Единица', { exact: true }).inputValue(), 'пог. м');
    await page.getByLabel('Объём работ', { exact: true }).fill('12.5');
    await page.getByLabel('Параметры выполненных работ', { exact: true }).fill('Учебная резка бетона, толщина 200 мм.');
    await page.getByLabel('Комментарий', { exact: false }).fill('Тестовый отчёт. <script>throw new Error("XSS")</script>');
    await page.reload();
    await page.getByRole('button', { name: 'Заполнить отчёт', exact: true }).click();
    assert.equal(await page.getByLabel('Объём работ', { exact: true }).inputValue(), '12.5');
    await page.screenshot({ path: join(out, `${name}-03-report-form-390.png`), fullPage: true });
    if (name === 'server') {
      await ctx.setOffline(true);
      await page.getByRole('button', { name: 'Сдать отчёт', exact: true }).click();
      await page.locator('#report-error .error').waitFor();
      assert.equal(await page.getByLabel('Объём работ', { exact: true }).inputValue(), '12.5');
      await ctx.setOffline(false);
      await page.getByRole('button', { name: 'Повторить отправку отчёта', exact: true }).click();
    } else await page.getByRole('button', { name: 'Сдать отчёт', exact: true }).click();
    await page.getByRole('heading', { name: 'Отчёт принят', exact: true }).waitFor();
    await page.screenshot({ path: join(out, `${name}-04-accepted-390.png`), fullPage: true });
    await page.getByRole('button', { name: 'Руководитель', exact: true }).click();
    await page.locator('[data-role="manager"][aria-pressed="true"]').waitFor();
    await page.getByRole('heading', { name: 'Принятый отчёт', exact: true }).waitFor();
    assert.ok((await page.locator('body').innerText()).includes('12.5 пог. м'));
    assert.ok((await page.locator('body').innerText()).includes('Время сдачи отчёта не является временем убытия'));
    const managerUrl = page.url();
    await page.reload();
    await page.getByRole('heading', { name: 'Принятый отчёт', exact: true }).waitFor();
    if (name === 'server') {
      const otherContext = await browser.newContext();
      const otherPage = await otherContext.newPage();
      await otherPage.goto(managerUrl);
      await otherPage.getByRole('heading', { name: 'Принятый отчёт', exact: true }).waitFor();
      await otherContext.close();
    }
    for (const width of [360, 430, 1280]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await fit(page);
      await page.screenshot({ path: join(out, `${name}-05-manager-${width}.png`), fullPage: true });
      await page.screenshot({ path: join(out, `${name}-06-viewport-${width}.png`) });
    }
    await page.getByRole('button', { name: 'Новый показ', exact: true }).click();
    await page.getByRole('button', { name: 'Прибыл', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Принятый отчёт', exact: true }).count(), 0);
    await page.goto(managerUrl);
    await page.getByRole('heading', { name: 'Принятый отчёт', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log(`PASS ${name}: прибытие, 4 отказа, черновик, отчёт, руководитель, перезагрузка, новый показ, 360/390/430/1280 px, XSS`);
  }
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => staticServer.close(resolve));
  await app.close();
}
