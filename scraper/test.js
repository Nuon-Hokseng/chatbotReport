const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: 'state.json' });
  const page = await context.newPage();
  await page.goto('http://185.185.80.214/');
  await page.waitForSelector('table tbody tr');
  const rows = await page.$$eval('table tbody tr', trs => trs.map(tr => {
    const tds = tr.querySelectorAll('td');
    return { length: tds.length, html: tr.innerHTML };
  }));
  console.log(JSON.stringify(rows[0], null, 2));
  await browser.close();
})();
