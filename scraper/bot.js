require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const axios = require('axios');
const db = require('./db');

const token = process.env.BOT_TOKEN;
const apiBaseUrl = process.env.API_BASE_URL;

// Memory Cache for Authorized Users
const authorizedUsersCache = new Set();

// Initialize DB and load cache
db.initDB().then(async () => {
    try {
        const res = await db.pool.query('SELECT chat_id FROM authorized_users');
        res.rows.forEach(r => authorizedUsersCache.add(r.chat_id));
        console.log(`Loaded ${authorizedUsersCache.size} authorized users from DB.`);
    } catch (err) {
        console.error('Failed to load authorized users cache:', err);
    }
});

const bot = new TelegramBot(token, { polling: true });

// Dummy Web Server for Render Hosting (Prevents Port Timeout Crash)
const express = require('express');
const app = express();
const port = process.env.PORT || 4000;
app.get('/', (req, res) => res.send('Bot is running!'));

app.get('/wakeup', async (req, res) => {
    try {
        await axios.get(`${apiBaseUrl}/task`).catch(() => {});
        res.send(`
            <h1 style="color: green; font-family: sans-serif; text-align: center; margin-top: 20%;">
                ✅ Systems Online!
            </h1>
            <p style="text-align: center; font-family: sans-serif;">
                Both the Bot Server and Scraper API have been awakened.<br/>
                You can now return to Telegram and use the bot!
            </p>
        `);
    } catch (err) {
        res.send('Bot is awake, but could not reach the API server.');
    }
});

app.listen(port, () => console.log(`Dummy server listening on port ${port}`));

const botUrl = process.env.BOT_BASE_URL;

// Keep Database Alive (Pings Supabase every hour)
setInterval(() => {
    db.pool.query('SELECT 1').catch(() => console.error("Keep-alive DB ping failed"));
}, 60 * 60 * 1000);

// Keep Render Awake (6 PM to 6 AM ICT)
setInterval(() => {
    const hour = (new Date().getUTCHours() + 7) % 24; // Convert UTC to UTC+7 (Cambodia/ICT)
    if (hour >= 18 || hour < 6) {
        // Send inbound traffic to both servers to prevent 15-min sleep
        if (botUrl) {
            axios.get(botUrl).catch(() => {});
            console.log("Self-pinging Bot Server to stay awake...");
        }
        axios.get(`${apiBaseUrl}/task`).catch(() => {});
        console.log("Pinging API Server to stay awake...");
    }
}, 14 * 60 * 1000); // Run every 14 minutes

console.log('====================================');
console.log('🤖 Multi-User Telegram Bot is running!');
console.log(`👥 Connected to DB cache.`);
console.log(`🔗 Connected to API: ${apiBaseUrl}`);
console.log('====================================');

// State Machine for Conversational Flow (Multi-User)
const userStates = {};

const getUserState = (chatId) => {
    if (!userStates[chatId]) {
        userStates[chatId] = { step: 'NONE', taskId: null, sessionCount: null, username: null };
    }
    return userStates[chatId];
};

const resetUserState = (chatId) => {
    userStates[chatId] = { step: 'NONE', taskId: null, sessionCount: null, username: null };
};

// Helper: Show Main Menu
const showMainMenu = (chatId, text = "🤖 *Welcome to ReportBot!* \nWhat would you like to do?") => {
    resetUserState(chatId);

    bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📋 View Active Tasks', callback_data: 'VIEW_TASKS' }],
                [{ text: '🔑 Login / Refresh Session', callback_data: 'LOGIN' }]
            ]
        }
    });
};


// 1. Text Message Handler
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text || '';

    // Handle Activation
    if (text.startsWith('/activate')) {
        if (authorizedUsersCache.has(chatId)) {
            return bot.sendMessage(chatId, "✅ You are already activated!");
        }

        const code = text.split(' ')[1];
        if (!code) return bot.sendMessage(chatId, "⚠️ Please provide a code. Example: `/activate 1234ABCD`", { parse_mode: 'Markdown' });

        try {
            // Check if secret exists
            const secretRes = await db.pool.query('SELECT code FROM secrets WHERE code = $1', [code]);
            if (secretRes.rows.length > 0) {
                // Burn the code
                await db.pool.query('DELETE FROM secrets WHERE code = $1', [code]);
                // Authorize user
                await db.pool.query('INSERT INTO authorized_users (chat_id) VALUES ($1) ON CONFLICT DO NOTHING', [chatId]);

                authorizedUsersCache.add(chatId);
                return showMainMenu(chatId, `🎉 **Activation Successful!**\nWelcome to ReportBot. Your device is now authorized.`);
            } else {
                return bot.sendMessage(chatId, "❌ Invalid or already used Secret Code.");
            }
        } catch (err) {
            console.error("Activation error:", err);
            return bot.sendMessage(chatId, "❌ Database error during activation.");
        }
    }

    // Security Check
    if (!authorizedUsersCache.has(chatId)) {
        return bot.sendMessage(chatId, "🛑 *Unauthorized.*\n\nPlease activate this bot by typing:\n`/activate <SECRET_CODE>`", { parse_mode: 'Markdown' });
    }

    // Handle standard commands first
    if (text === '/start' || text === '/help') {
        return showMainMenu(chatId);
    }
    
    // Handle Shortcut Report Command: /report taskId; description; sessions
    if (text.startsWith('/report ')) {
        const argsString = text.replace('/report ', '').trim();
        const parts = argsString.split(';');
        
        if (parts.length !== 3) {
            return bot.sendMessage(chatId, "⚠️ *Invalid format!*\n\nPlease use:\n`/report <TaskID>; <Description>; <Sessions>`\n\n_Example:_\n`/report 1; fix frontend and connect it to database; 5`", { parse_mode: 'Markdown' });
        }
        
        const taskId = parts[0].trim();
        const description = parts[1].trim();
        const sessionCount = parseInt(parts[2].trim());
        
        if (isNaN(sessionCount) || sessionCount <= 0) {
            return bot.sendMessage(chatId, "⚠️ Invalid session count! It must be a number greater than 0.");
        }
        
        bot.sendMessage(chatId, `⚡ *Shortcut Report Detected!*\n🔄 Submitting to Task ID ${taskId}...\n📝 Description: "${description}"\n⏳ Sessions: ${sessionCount}`, { parse_mode: 'Markdown' });
        
        try {
            const res = await axios.post(`${apiBaseUrl}/report`, { 
                taskId, 
                reportDescription: description, 
                reportSession: sessionCount,
                userId: chatId
            });
            
            if (res.data.success) {
                showMainMenu(chatId, `🎉 **Success!** Shortcut report submitted to Task ${taskId}.`);
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || err.message;
            if (errMsg.includes('Not logged in') || errMsg.includes('401')) {
                showMainMenu(chatId, `❌ Session expired! Please click Login first.`);
            } else {
                showMainMenu(chatId, `❌ Failed to add report: ${errMsg}`);
            }
        }
        return;
    }

    const state = getUserState(chatId);

    // Ignore if no state is pending
    if (state.step === 'NONE') {
        if (!text.startsWith('/')) {
            showMainMenu(chatId, "I didn't understand that. Please use the menu below:");
        }
        return;
    }

    // Handle: AWAITING_LOGIN_USERNAME
    if (state.step === 'AWAITING_LOGIN_USERNAME') {
        state.username = text;
        state.step = 'AWAITING_LOGIN_PASSWORD';
        return bot.sendMessage(chatId, "🔑 Great. Now reply with your *Password*:", { parse_mode: 'Markdown' });
    }

    // Handle: AWAITING_LOGIN_PASSWORD
    if (state.step === 'AWAITING_LOGIN_PASSWORD') {
        const email = state.username;
        const password = text;

        resetUserState(chatId);
        bot.sendMessage(chatId, '🔄 Sending login request... Please wait (~15 seconds).');

        try {
            const res = await axios.post(`${apiBaseUrl}/register`, { email, password, userId: chatId });
            if (res.data.success) {
                showMainMenu(chatId, '✅ Successfully logged in! You can now view your tasks.');
            } else {
                showMainMenu(chatId, `❌ Login failed: ${res.data.error}`);
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || err.message;
            if (errMsg.includes('Timeout')) {
                showMainMenu(chatId, `❌ Login Failed: Incorrect Username or Password.`);
            } else {
                showMainMenu(chatId, `❌ API Error: ${errMsg}`);
            }
        }
        return;
    }

    // Handle: AWAITING_SESSION_COUNT
    if (state.step === 'AWAITING_SESSION_COUNT') {
        const count = parseInt(text);
        if (isNaN(count) || count <= 0) {
            return bot.sendMessage(chatId, "⚠️ Please enter a valid number (e.g., 1, 2, 3).");
        }

        state.sessionCount = count;
        state.step = 'AWAITING_DESCRIPTION';
        return bot.sendMessage(chatId, `✅ Session count set to *${count}*.\n\nNow, please type the *Description* for this report:`, { parse_mode: 'Markdown' });
    }

    // Handle: AWAITING_DESCRIPTION
    if (state.step === 'AWAITING_DESCRIPTION') {
        const description = text;
        const taskId = state.taskId;
        const sessionCount = state.sessionCount;

        resetUserState(chatId);

        bot.sendMessage(chatId, `🔄 Submitting Report to Task ID ${taskId}...\nDescription: "${description}"`);

        try {
            const res = await axios.post(`${apiBaseUrl}/report`, {
                taskId,
                reportDescription: description,
                reportSession: sessionCount,
                userId: chatId
            });

            if (res.data.success) {
                showMainMenu(chatId, `🎉 **Success!** Report physically submitted to Task ${taskId}.`);
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || err.message;
            if (errMsg.includes('Not logged in') || errMsg.includes('401')) {
                showMainMenu(chatId, `❌ Session expired! Please login again.`);
            } else {
                showMainMenu(chatId, `❌ Failed to add report: ${errMsg}`);
            }
        }
        return;
    }
});


// 2. Button Click Handler
bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    bot.answerCallbackQuery(query.id);

    if (!authorizedUsersCache.has(chatId)) return;

    const data = query.data;
    const state = getUserState(chatId);

    // Handle: LOGIN button
    if (data === 'LOGIN') {
        state.step = 'AWAITING_LOGIN_USERNAME';
        return bot.sendMessage(chatId, '🔑 Please reply to this message with your *Username* (or email):\n\n_Example: Nuon Hokseng_', { parse_mode: 'Markdown' });
    }

    // Handle: VIEW_TASKS button
    if (data === 'VIEW_TASKS') {
        const loadingMsg = await bot.sendMessage(chatId, '🔄 Scraping your dashboard tasks...');

        try {
            const res = await axios.get(`${apiBaseUrl}/task?userId=${chatId}`);

            // Delete the "Scraping..." message to keep the chat clean
            bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });

            if (res.data.success) {
                const tasks = res.data.tasks;
                if (tasks.length === 0) {
                    return showMainMenu(chatId, '⚠️ You have no active tasks!');
                }

                for (const t of tasks) {
                    const taskMsg = `*ID ${t.id}*: ${t.name}\n⏳ ${t.actualHour} Hours | 🗓️ Due: ${t.deadline}`;
                    await bot.sendMessage(chatId, taskMsg, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: `📝 Add Report to Task ${t.id}`, callback_data: `ADD_REPORT_${t.id}` }]
                            ]
                        }
                    });
                }

                bot.sendMessage(chatId, "👆 Select a task above to add a report, or return to menu:", {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'MAIN_MENU' }]]
                    }
                });
            }
        } catch (err) {
            // Delete the "Scraping..." message if it failed
            bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });

            const errMsg = err.response?.data?.error || err.message;
            if (errMsg.includes('Not logged in') || errMsg.includes('401')) {
                showMainMenu(chatId, `❌ Session expired! Please click Login first.`);
            } else {
                showMainMenu(chatId, `❌ API Error: ${errMsg}`);
            }
        }
        return;
    }

    // Handle: ADD_REPORT_xxx button
    if (data.startsWith('ADD_REPORT_')) {
        const taskId = data.replace('ADD_REPORT_', '');
        state.step = 'AWAITING_SESSION_COUNT';
        state.taskId = taskId;

        return bot.sendMessage(chatId, `📝 *Starting Report for Task ${taskId}*\n\nHow many sessions did you do? (Reply with a number like 1, 2, 3)`, { parse_mode: 'Markdown' });
    }

    // Handle: MAIN_MENU button
    if (data === 'MAIN_MENU') {
        return showMainMenu(chatId);
    }
});
