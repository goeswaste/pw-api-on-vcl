import { chromium } from "playwright-core";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.headers.authorization !== `Bearer ${process.env.API_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let browser;

  try {
    browser = await chromium.connectOverCDP(process.env.BROWSER_WS_URL);
    const page = await browser.newPage();
    await page.goto("https://duck.ai", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    return res.status(200).json({ title: await page.title() });
  } catch (error) {
    console.error("Browser task failed:", error.message);
    return res.status(500).json({ error: "Browser task failed" });
  } finally {
    await browser?.close();
  }
}
