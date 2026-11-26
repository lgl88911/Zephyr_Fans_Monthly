#!/usr/bin/env node
/**
 * 把 GitHub Pulse 页面的 Overview 区域保存为一张 PNG 图片。
 *
 * 依赖：
 *   npm install playwright
 *   npx playwright install chromium
 *
 * 用法：
 *   node capture_zephyr_pulse_overview.mjs
 *   node capture_zephyr_pulse_overview.mjs --repo zephyrproject-rtos/zephyr --period monthly --out zephyr-overview.png
 *   node capture_zephyr_pulse_overview.mjs --url 'https://github.com/zephyrproject-rtos/zephyr/pulse?period=weekly' --scale 3
 *   node capture_zephyr_pulse_overview.mjs --debug
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);

function arg(name, fallback = null) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法：
  node capture_zephyr_pulse_overview.mjs [选项]

选项：
  --url <URL>        完整 Pulse 页面地址
  --repo <owner/repo> 仓库标识，默认 zephyrproject-rtos/zephyr
  --period <name>    weekly | monthly | quarterly，默认 monthly
  --out <path>       输出 PNG 路径，默认 zephyr-pulse-overview.png
  --scale <number>   像素倍率，默认 2
  --timeout <ms>     页面加载超时，默认 60000
  --debug            打印识别到的标题和裁剪区域
  -h, --help         显示帮助`);
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('未找到 playwright。请先执行：');
  console.error('  npm install playwright');
  console.error('  npx playwright install chromium');
  process.exit(1);
}

const repo = arg('--repo', 'zephyrproject-rtos/zephyr');
const period = arg('--period', 'monthly');
const validPeriods = ['weekly', 'monthly', 'quarterly'];
if (!validPeriods.includes(period)) {
  console.error(`--period 只支持 ${validPeriods.join(' / ')}，收到：${period}`);
  process.exit(1);
}

const url = arg(
  '--url',
  `https://github.com/${repo}/pulse?period=${period}`,
);
const outputPath = path.resolve(arg('--out', 'zephyr-pulse-overview.png'));
const scale = Number(arg('--scale', '2')) || 2;
const timeout = Number(arg('--timeout', '60000')) || 60000;
const debug = argv.includes('--debug');

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1400 },
    deviceScaleFactor: scale,
    locale: 'en-US',
  });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

  // Pulse 的数据由前端加载，等 Overview 和指标文字都出现后再截图。
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText || '';
      return (
        /\bOverview\b/i.test(text) &&
        /(merged pull requests|open issues|active issues|authors|commits)/i.test(text)
      );
    },
    null,
    { timeout },
  );
  await page.waitForTimeout(1200);

  await page.evaluate(() => window.scrollTo(0, 0));

  const region = await page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const headingSelector = [
      'h1',
      'h2',
      'h3',
      'h4',
      '[role="heading"]',
      '[data-testid*="heading" i]',
      '[class*="Heading" i]',
    ].join(',');

    const all = Array.from(document.querySelectorAll(headingSelector));
    const candidates = all
      .map((el) => {
        const box = el.getBoundingClientRect();
        return {
          el,
          text: normalize(el.textContent),
          top: box.top,
          left: box.left,
          right: box.right,
          width: box.width,
          height: box.height,
        };
      })
      .filter((item) => item.width > 20 && item.height > 8 && item.top >= 0);

    let overview = candidates.find((item) => lower(item.text) === 'overview');
    if (!overview) {
      overview = candidates.find((item) => lower(item.text).startsWith('overview'));
    }

    if (!overview) {
      return {
        error: '页面里没有找到 Overview 标题，可能是 GitHub 调整了页面结构。',
        headings: candidates.slice(0, 40).map((item) => item.text),
      };
    }

    const following = candidates
      .filter((item) => item.el !== overview.el && item.top > overview.top + 8)
      .sort((a, b) => a.top - b.top);

    const nextHeading =
      following.find((item) =>
        /^(authors|contributors|pull requests|issues|commits|activity|stargazers|forks|traffic)/i.test(
          lower(item.text),
        ),
      ) || following[0];

    const main = document.querySelector('main') || document.querySelector('article') || document.body;
    const mainBox = main.getBoundingClientRect();

    const top = Math.max(0, overview.top - 18);
    const bottomCandidate = nextHeading ? nextHeading.top - 18 : overview.top + 360;
    const bottom = Math.min(
      Math.max(bottomCandidate, overview.top + 120),
      Math.min(window.innerHeight, mainBox.bottom) - 8,
    );

    const left = Math.max(0, Math.min(mainBox.left, overview.left) + 4);
    const right = Math.min(
      window.innerWidth,
      Math.max(mainBox.right, overview.right) - 4,
    );

    return {
      clip: {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(Math.max(320, right - left)),
        height: Math.round(Math.max(120, bottom - top)),
      },
      overviewText: overview.text,
      nextHeadingText: nextHeading ? nextHeading.text : null,
      headings: candidates.slice(0, 40).map((item) => item.text),
    };
  });

  if (region.error) {
    console.error(region.error);
    console.error(`识别到的标题：${region.headings.join(' | ') || '（空）'}`);
    console.error('可加 --debug 查看完整列表，或先用浏览器确认页面是否登录受限。');
    process.exit(2);
  }

  if (debug) {
    console.error(`Overview 标题：${region.overviewText}`);
    console.error(`下一节标题：${region.nextHeadingText || '（未找到，使用固定高度）'}`);
    console.error(`裁剪区域：${JSON.stringify(region.clip)}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await page.screenshot({ path: outputPath, clip: region.clip });
  console.log(`已保存：${outputPath}`);
} finally {
  await browser.close();
}
