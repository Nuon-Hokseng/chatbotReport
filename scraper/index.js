const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const statePath = path.join(__dirname, 'state.json');

app.use(express.json());

// --- Core Browser Helpers ---

async function launchBrowserContext(requireAuth = true) {
    const browser = await chromium.launch({ 
        headless: true, // Production mode
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    });

    let contextOptions = {};
    if (requireAuth && fs.existsSync(statePath)) {
        contextOptions.storageState = statePath;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // Prevent basic bot detection
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    return { browser, context, page };
}

async function performLogin(page, context, email, password) {
    console.log("Navigating to login...");
    await page.goto("http://185.185.80.214/login", { waitUntil: 'domcontentloaded' });
    
    // Check if we are miraculously already logged in (cookies valid)
    try {
        await page.waitForSelector('table tbody tr', { timeout: 3000 });
        console.log("Already logged in (valid cookies)");
        return true;
    } catch (e) {
        console.log("Not logged in, proceeding with credentials...");
    }

    // Username
    try {
        const userField = page.getByRole('textbox', { name: /username/i }).first();
        await userField.focus();
        await userField.pressSequentially(email);
        await userField.blur();
    } catch (e) {
        const userField = page.locator('input[type="text"]').nth(0);
        await userField.focus();
        await userField.pressSequentially(email);
        await userField.blur();
    }

    // Password
    try {
        const passField = page.locator('input[type="password"]').first();
        await passField.focus();
        await passField.pressSequentially(password);
        await passField.press('Enter');
    } catch (e) {
        throw new Error("Failed to find password field.");
    }

    // Fallback Login Click
    try {
        const loginBtn = page.locator('button.white--text.primary');
        await loginBtn.click({ force: true });
    } catch (e) {
        await page.evaluate(() => {
            const btn = document.querySelector('button.white--text.primary');
            if (btn) btn.click();
        });
    }

    console.log("Waiting for dashboard redirect...");
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    
    console.log("Saving new cookies...");
    await context.storageState({ path: statePath });
    return true;
}

async function scrapeTasks(page) {
    return await page.$$eval('table tbody tr', rows => {
        return rows.map(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 6) {
                const links = cells[6].querySelectorAll('a');
                return {
                    id: cells[0].innerText.trim(),
                    name: cells[1].innerText.trim(),
                    actualHour: cells[2].innerText.trim(),
                    startDate: cells[3].innerText.trim(),
                    deadline: cells[4].innerText.trim(),
                    viewUrl: links.length > 0 ? links[0].getAttribute('href') : null,
                    editUrl: links.length > 1 ? links[1].getAttribute('href') : null
                };
            }
            return null;
        }).filter(task => task !== null);
    });
}


// --- API Endpoints ---


// 1. REGISTER (Executes Login)
app.post('/api/v1/register', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ success: false, error: "Email and password are required" });
    }

    let browserInstance;
    try {
        // Launch WITHOUT requiring existing auth
        const { browser, context, page } = await launchBrowserContext(false);
        browserInstance = browser;
        
        await performLogin(page, context, email, password);
        
        res.json({ success: true, message: "Successfully logged in and saved session for future use" });
    } catch (error) {
        console.error("Register error:", error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browserInstance) await browserInstance.close();
    }
});


// 2. LIST TASKS
app.get('/api/v1/task', async (req, res) => {
    if (!fs.existsSync(statePath)) {
        return res.status(401).json({ success: false, error: "Not logged in. Please call /api/v1/register first." });
    }

    let browserInstance;
    try {
        const { browser, context, page } = await launchBrowserContext(true);
        browserInstance = browser;
        
        await page.goto("http://185.185.80.214/", { waitUntil: 'domcontentloaded' });
        
        // Wait for tasks table
        await page.waitForSelector('table tbody tr', { timeout: 10000 });
        const tasks = await scrapeTasks(page);
        
        res.json({ success: true, count: tasks.length, tasks: tasks });
    } catch (error) {
        console.error("Task list error:", error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browserInstance) await browserInstance.close();
    }
});


// 3. ADD REPORT
app.post('/api/v1/report', async (req, res) => {
    const { taskId, reportDescription, reportSession } = req.body || {};
    if (!taskId || !reportDescription || !reportSession) {
        return res.status(400).json({ success: false, error: "taskId, reportDescription, and reportSession are required" });
    }

    if (!fs.existsSync(statePath)) {
        return res.status(401).json({ success: false, error: "Not logged in. Please call /api/v1/register first." });
    }

    let browserInstance;
    try {
        const { browser, context, page } = await launchBrowserContext(true);
        browserInstance = browser;
        
        console.log(`Starting report flow for Task ID: ${taskId}`);
        
        // Step 1: Scrape to find the hidden editUrl for this Task ID
        await page.goto("http://185.185.80.214/", { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('table tbody tr', { timeout: 10000 });
        const tasks = await scrapeTasks(page);
        
        const taskToEdit = tasks.find(t => t.id === String(taskId));
        if (!taskToEdit || !taskToEdit.editUrl) {
            throw new Error(`Could not find Task ID ${taskId} on the dashboard!`);
        }

        // Step 2: Navigate to Edit Screen
        console.log(`Navigating to edit URL: ${taskToEdit.editUrl}`);
        await page.locator(`a[href="${taskToEdit.editUrl}"]`).click();
        
        const addReportBtn = page.locator('button').filter({ hasText: /Add Report/i }).first();
        await addReportBtn.waitFor({ state: 'visible', timeout: 15000 });
        
        // Step 3: Hydration Delay before clicking "Add Report"
        console.log('Waiting 3 seconds for Vue task data hydration...');
        await page.waitForTimeout(3000); 
        await addReportBtn.click();
        
        // Step 4: Hydration Delay inside Modal
        console.log('Waiting for modal and semester hydration...');
        await page.waitForSelector('.v-dialog');
        await page.waitForTimeout(2000);
        
        // Step 5: Fill and Save Modal
        console.log('Filling report...');
        await page.getByPlaceholder('Report Description').fill(reportDescription);
        await page.getByPlaceholder('Number of Session').fill(String(reportSession));
        
        await page.locator('.v-dialog').getByRole('button', { name: 'save', exact: true }).click();
        
        // Wait for modal to disappear
        await page.waitForSelector('.v-dialog', { state: 'hidden', timeout: 5000 }).catch(() => {});
        
        // Step 6: Final Main Save
        console.log('Clicking Main Save...');
        const navigationPromise = page.waitForNavigation({ timeout: 5000 }).catch(() => {});
        
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const mainSaveBtn = buttons.find(b => 
                b.textContent && 
                b.textContent.trim().toLowerCase() === 'save' && 
                b.offsetParent !== null && 
                !b.closest('.v-dialog')
            );
            if (mainSaveBtn) {
                setTimeout(() => mainSaveBtn.click(), 0);
            }
        });
        
        await navigationPromise;
        
        res.json({ success: true, message: `Successfully added report to Task ${taskId}` });
    } catch (error) {
        console.error("Add report error:", error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browserInstance) await browserInstance.close();
    }
});


app.listen(port, () => {
    console.log(`Telegram Bot Backend API listening at http://localhost:${port}`);
    console.log(`Endpoints available:`);
    console.log(` - POST /api/v1/register`);
    console.log(` - GET  /api/v1/task`);
    console.log(` - POST /api/v1/report`);
});
