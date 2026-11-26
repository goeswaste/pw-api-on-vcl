//const playwright = require('playwright-core');
import { chromium } from 'playwright-core';

export default async function handler(req, res) {
    const { url } = req.query;
    const authHeader = req.headers['x-proxy-secret'];

    if (authHeader !== process.env.API_SECRET) {
        return res.status(403).send('Unauthorized');
    }

    if (!url) return res.status(400).send('URL is required');

    let browser;
    try {
        // Connect to the remote browser via CDP
        //browser = await playwright.chromium.connectOverCDP(process.env.BROWSER_WS_URL);
		browser = await chromium.connectOverCDP(process.env.BROWSER_WS_URL);
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // Go to URL and wait until network is idle (handles SSR and initial JS)
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        // Scroll to bottom to trigger lazy-loading elements
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 100;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        // Final wait for any late-loading assets
        await page.waitForTimeout(1000);
        const content = await page.content();
        
        await browser.close();
        res.status(200).send(content);
    } catch (e) {
        if (browser) await browser.close();
        res.status(500).send(`Proxy Error: ${e.message}`);
    }
}
