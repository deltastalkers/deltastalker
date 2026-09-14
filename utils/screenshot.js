import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { randomUUID } from "node:crypto";
import puppeteer from 'puppeteer-extra';
import { mkdirSync } from "node:fs";
puppeteer.use(StealthPlugin());

export async function screenshot(url, { filename = `${randomUUID()}`, width = 1920, height = 1080, fullPage = false, element, cookies, evalme, progress = () => { } }) {
    mkdirSync("./screenshots/", { recursive: true })
    progress("launching...");
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] });
    if (cookies) {
        progress("setting cookies...");
        await browser.setCookie(...cookies);
    };
    try {
        progress("opening page...");
        const page = await browser.newPage();
        await page.setUserAgent({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' });
        progress("setting viewport...");
        await page.setViewport({ width, height, deviceScaleFactor: 2 });
        if (evalme) {
            progress("running eval...");
            await evalme(page);
        };
        progress(`going to URL (${url})...`);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (element) {
            progress("waiting for element to load...");
            const el = await page.waitForSelector(element);
            if (!fullPage) {
                progress("taking screenshot of element...");
                const path = `./screenshots/${filename}.png`;
                await el.screenshot({ path });
                progress(`screenshot saved! ${path}`);
                return path;
            };
        };
        progress("taking screenshot...");
        const path = `./screenshots/${filename}.png`;
        await page.screenshot({ path, fullPage });
        progress(`screenshot saved! ${path}`);
        return path;
    } finally {
        progress("closing browser...");
        await browser.close();
    };
};