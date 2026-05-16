const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { ADMIN_NUMBER, PAYMENT_DETAILS, GROUP_CLASSES, PERSONAL_CLASSES, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('./config');
const ai = require('./ai');

// --- Telegram Bot (for QR delivery + remote commands) ---
let tgBot = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  const TelegramBot = require('node-telegram-bot-api');
  tgBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('📱 Telegram bot enabled (QR + commands).');

  // Only respond to the admin's Telegram chat
  tgBot.onText(/\/resetqr/, async (msg) => {
    if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
    try {
      await tgBot.sendMessage(TELEGRAM_CHAT_ID, '🔄 Disconnecting WhatsApp... A new QR code will be sent shortly.');
      qrSentToTelegram = false;
      try { await client.logout(); } catch (e) { await client.destroy(); }
      setTimeout(() => client.initialize(), 3000);
    } catch (e) {
      tgBot.sendMessage(TELEGRAM_CHAT_ID, `❌ Error: ${e.message}`).catch(() => {});
    }
  });

  tgBot.onText(/\/status/, async (msg) => {
    if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
    const state = await client.getState().catch(() => 'UNKNOWN');
    tgBot.sendMessage(TELEGRAM_CHAT_ID,
      `📊 *Bot Status*\n\nWhatsApp: *${state}*\nBot: *${botActive ? 'ON' : 'OFF'}*\nAI Mode: *${aiModeActive ? 'ON' : 'OFF'}*\nContact Filter: *${contactFilterActive ? 'ON' : 'OFF'}*`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });

} else {
  console.log('⚠️  Telegram disabled. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable.');
}

// --- Group links (persisted to file) ---
const LINKS_FILE = path.join(__dirname, 'group-links.json');

function loadGroupLinks() {
  try {
    if (fs.existsSync(LINKS_FILE)) {
      return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load group links:', e.message);
  }
  return {};
}

function saveGroupLinks() {
  try {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(groupLinks, null, 2));
  } catch (e) {
    console.error('Failed to save group links:', e.message);
  }
}

const groupLinks = loadGroupLinks(); // { className: url }

// Build a combined list of all class names for link management
const ALL_CLASSES = GROUP_CLASSES.map(c => c.name);

// --- Session state per user (in-memory) ---
const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 min

// --- Bot settings (persisted to file) ---
const SETTINGS_FILE = path.join(__dirname, 'bot-settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load settings:', e.message);
  }
  return { botActive: true, contactFilterActive: false, aiModeActive: false };
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ botActive, contactFilterActive, aiModeActive }, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e.message);
  }
}

const loadedSettings = loadSettings();
let botActive = loadedSettings.botActive;
let contactFilterActive = loadedSettings.contactFilterActive;
let aiModeActive = loadedSettings.aiModeActive;

// --- Authenticated admins (persisted to file) ---
const ADMINS_FILE = path.join(__dirname, 'authenticated-admins.json');

function loadAdmins() {
  try {
    if (fs.existsSync(ADMINS_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8')));
    }
  } catch (e) {
    console.error('Failed to load admins:', e.message);
  }
  return new Set();
}

function saveAdmins() {
  try {
    fs.writeFileSync(ADMINS_FILE, JSON.stringify([...authenticatedAdmins]));
  } catch (e) {
    console.error('Failed to save admins:', e.message);
  }
}

const authenticatedAdmins = loadAdmins();

// --- Pending registrations (persisted to file) ---
const REGS_FILE = path.join(__dirname, 'pending-registrations.json');

function loadRegistrations() {
  try {
    if (fs.existsSync(REGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGS_FILE, 'utf8'));
      return new Map(Object.entries(data));
    }
  } catch (e) {
    console.error('Failed to load registrations:', e.message);
  }
  return new Map();
}

function saveRegistrations() {
  try {
    const obj = Object.fromEntries(pendingRegistrations);
    fs.writeFileSync(REGS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Failed to save registrations:', e.message);
  }
}

const pendingRegistrations = loadRegistrations();
let adminState = null; // null or { action: 'awaitGroupLink', regId: '...' }

function generateRegId() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit random ID
}

function getSession(chatId) {
  let s = sessions.get(chatId);
  if (!s || Date.now() - s.lastActive > SESSION_TIMEOUT) {
    s = { step: 'welcome', subStep: 0, data: {}, lastActive: Date.now() };
    sessions.set(chatId, s);
  }
  s.lastActive = Date.now();
  return s;
}

function resetSession(chatId) {
  sessions.set(chatId, { step: 'welcome', subStep: 0, data: {}, lastActive: Date.now() });
}

// --- WhatsApp Client ---
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

let qrSentToTelegram = false;

client.on('qr', async (qr) => {
  console.log('Scan this QR code to login:');
  qrcode.generate(qr, { small: true });

  // Send QR to Telegram only once per connection attempt
  if (tgBot && !qrSentToTelegram) {
    qrSentToTelegram = true;
    try {
      const qrBuffer = await QRCode.toBuffer(qr, { width: 512, margin: 2 });
      await tgBot.sendPhoto(TELEGRAM_CHAT_ID, qrBuffer, {
        caption: '📱 *DUKEH Bot — Scan this QR code in WhatsApp*\n\nOpen WhatsApp → Settings → Linked Devices → Link a Device',
        parse_mode: 'Markdown'
      });
      console.log('✅ QR code sent to Telegram.');
    } catch (e) {
      qrSentToTelegram = false; // allow retry if send failed
      console.error('❌ Failed to send QR to Telegram:', e.message);
    }
  }

});

client.on('ready', () => {
  qrSentToTelegram = false;
  console.log('✅ DUKEH Bot is ready!');
});
client.on('auth_failure', (msg) => console.error('❌ Auth failed:', msg));
client.on('disconnected', (reason) => {
  qrSentToTelegram = false; // reset so reconnect sends a fresh QR
  console.log('Disconnected:', reason);
  if (tgBot) {
    tgBot.sendMessage(TELEGRAM_CHAT_ID, `⚠️ *DUKEH Bot disconnected*\nReason: ${reason}\n\nThe bot will attempt to reconnect. A new QR code will be sent if needed.`, { parse_mode: 'Markdown' }).catch(() => {});
  }
});

// --- Main Message Handler ---
client.on('message_create', async (msg) => {
  if (msg.from.includes('@g.us') || msg.from === 'status@broadcast') return;

  const chatId = msg.from;
  const body = msg.body.trim();

  // Self-messages: only process ! commands, skip bot flow
  if (msg.fromMe && !body.startsWith('!')) return;

  // Admin commands — anyone who knows them can use them
  if (body.startsWith('!')) {
    // Handle !admin login
    if (body.toLowerCase().startsWith('!admin ')) {
      const passcode = body.slice(7).trim();
      const correctPasscode = process.env.ADMIN_PASSCODE || 'dukeh2025';
      if (passcode === correctPasscode) {
        authenticatedAdmins.add(chatId);
        saveAdmins();
        return msg.reply('\u2705 *Admin access granted.* You can now use all admin commands.\n\nType *!commands* to see available commands.');
      }
      return msg.reply('\u274c Incorrect passcode.');
    }

    // All other ! commands require authentication
    if (!authenticatedAdmins.has(chatId)) {
      return; // Silently ignore — don't reveal that commands exist
    }
    // If admin is in the middle of a verify flow (waiting for group link)
    if (adminState && adminState.action === 'awaitGroupLink') {
      const reg = pendingRegistrations.get(adminState.regId);
      if (body.toLowerCase() === 'cancel') {
        adminState = null;
        return msg.reply('❌ Verification cancelled.');
      }
      if (reg) {
        try {
          await client.sendMessage(reg.chatId,
            `🎉 *Your registration has been confirmed!*\n\n` +
            `Class: *${reg.className}*\n` +
            `Name: *${reg.name}*\n\n` +
            `Here is your group link:\n${body}\n\n` +
            `Welcome to *DUKEH Importation*! 🙏`
          );
          await msg.reply(`✅ Confirmation sent to *${reg.name}* (${reg.phone}) with the group link.`);
        } catch (e) {
          console.error('Failed to send confirmation:', e.message);
          await msg.reply(`❌ Failed to send message to customer. They may have a new chat ID.`);
        }
        pendingRegistrations.delete(adminState.regId);
        saveRegistrations();
      }
      adminState = null;
      return;
    }

    if (body.toLowerCase() === '!bot off') {
      botActive = false;
      saveSettings();
      return msg.reply('🔴 Bot is now *OFF*. Customers will not receive replies.');
    }
    if (body.toLowerCase() === '!bot on') {
      botActive = true;
      saveSettings();
      return msg.reply('🟢 Bot is now *ON*. Customers will receive replies.');
    }
    if (body.toLowerCase() === '!bot status') {
      return msg.reply(botActive ? '🟢 Bot is currently *ON*.' : '🔴 Bot is currently *OFF*.');
    }
    if (body.toLowerCase() === '!contact on') {
      contactFilterActive = true;
      saveSettings();
      return msg.reply('🟢 Contact filter *ON*. Bot will only reply to *unsaved* contacts.');
    }
    if (body.toLowerCase() === '!contact off') {
      contactFilterActive = false;
      saveSettings();
      return msg.reply('🔴 Contact filter *OFF*. Bot will reply to *everyone*.');
    }
    if (body.toLowerCase() === '!contact status') {
      return msg.reply(contactFilterActive ? '🟢 Contact filter is *ON* (unsaved only).' : '🔴 Contact filter is *OFF* (everyone).');
    }
    if (body.toLowerCase().startsWith('!verify')) {
      let regId = body.split(' ')[1];
      // If no ID provided, try to extract from quoted message
      if (!regId && msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          const match = (quoted.body || '').match(/#(\d{6})/);
          if (match) regId = match[1];
        } catch (e) {}
      }
      if (!regId) {
        return msg.reply('Usage: *!verify <registration ID>*\n\nYou can also *reply* to a registration/receipt message with *!verify*');
      }
      const reg = pendingRegistrations.get(regId);
      if (!reg) {
        return msg.reply(`❌ Registration *#${regId}* not found. It may have already been verified or expired.`);
      }
      console.log(`[VERIFY] Reg #${regId} — chatId: ${reg.chatId}, class: ${reg.className}`);
      // Auto-use stored group link if available
      const storedLink = groupLinks[reg.className];
      if (storedLink) {
        try {
          await client.sendMessage(reg.chatId,
            `🎉 *Your registration has been confirmed!*\n\n` +
            `Class: *${reg.className}*\n` +
            `Name: *${reg.name}*\n\n` +
            `Here is your group link:\n${storedLink}\n\n` +
            `Welcome to *DUKEH Importation*! 🙏`
          );
          await msg.reply(`✅ Confirmation sent to *${reg.name}* (${reg.phone}) with the stored group link.`);
        } catch (e) {
          console.error('Failed to send confirmation:', e.message);
          await msg.reply(`❌ Failed to send message to customer.`);
        }
        pendingRegistrations.delete(regId);
        saveRegistrations();
        return;
      }
      // No stored link — ask admin to paste one
      adminState = { action: 'awaitGroupLink', regId };
      return msg.reply(
        `📋 *Verifying Registration #${regId}*\n\n` +
        `Name: ${reg.name}\n` +
        `Class: ${reg.className}\n` +
        `WhatsApp: ${reg.phone}\n\n` +
        `⚠️ No group link stored for *${reg.className}*.\n` +
        `Please send the *group link* for this customer.\n` +
        `_Type *cancel* to cancel._`
      );
    }
    if (body.toLowerCase() === '!links') {
      let text = `🔗 *Group Links*\n\n`;
      ALL_CLASSES.forEach((name, i) => {
        const link = groupLinks[name];
        text += `*${i + 1}.* ${name}\n${link ? `   ✅ ${link}` : '   ❌ No link set'}\n\n`;
      });
      text += `_Use *!link <number> <url>* to set a link._\n`;
      text += `_Use *!link remove <number>* to remove a link._`;
      return msg.reply(text);
    }
    if (body.toLowerCase().startsWith('!link remove')) {
      const num = parseInt(body.split(' ')[2]);
      if (!num || num < 1 || num > ALL_CLASSES.length) {
        return msg.reply(`Please specify a class number (1-${ALL_CLASSES.length}). Use *!links* to see the list.`);
      }
      const className = ALL_CLASSES[num - 1];
      delete groupLinks[className];
      saveGroupLinks();
      return msg.reply(`✅ Group link removed for *${className}*.`);
    }
    if (body.toLowerCase().startsWith('!link ')) {
      const parts = body.split(' ');
      const num = parseInt(parts[1]);
      const url = parts.slice(2).join(' ');
      if (!num || num < 1 || num > ALL_CLASSES.length || !url) {
        return msg.reply(`Usage: *!link <number> <url>*\n\nExample: *!link 1 https://chat.whatsapp.com/abc123*\n\nUse *!links* to see class numbers.`);
      }
      const className = ALL_CLASSES[num - 1];
      groupLinks[className] = url;
      saveGroupLinks();
      return msg.reply(`✅ Group link updated for *${className}*:\n${url}`);
    }
    if (body.toLowerCase() === '!pending') {
      if (pendingRegistrations.size === 0) {
        return msg.reply('📋 No pending registrations.');
      }
      let text = `📋 *Pending Registrations (${pendingRegistrations.size})*\n\n`;
      for (const [id, reg] of pendingRegistrations) {
        text += `*#${id}* — ${reg.name} | ${reg.className} | ${reg.phone}\n`;
      }
      text += `\n_Use *!verify <ID>* to confirm a registration._`;
      return msg.reply(text);
    }
    if (body.toLowerCase() === '!ai on') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return msg.reply('❌ Cannot enable AI mode. Set *ANTHROPIC_API_KEY* in your .env file first.');
      }
      aiModeActive = true;
      saveSettings();
      return msg.reply('🧠 AI mode is now *ON*. Claude will handle all customer messages.');
    }
    if (body.toLowerCase() === '!ai off') {
      aiModeActive = false;
      saveSettings();
      return msg.reply('🔴 AI mode is now *OFF*. Template flow restored.');
    }
    if (body.toLowerCase() === '!ai status') {
      return msg.reply(aiModeActive ? '🧠 AI mode is *ON*.' : '🔴 AI mode is *OFF*.');
    }
    if (body.toLowerCase() === '!commands') {
      return msg.reply(
        `🛠️ *Admin Commands*\n\n` +
        `*!bot on/off/status* — Toggle bot\n` +
        `*!contact on/off/status* — Toggle contact filter\n` +
        `*!ai on/off/status* — Toggle AI mode (Claude)\n` +
        `*!verify <ID>* — Verify a registration\n` +
        `*!pending* — View pending registrations\n` +
        `*!links* — View all group links\n` +
        `*!link <#> <url>* — Set/update a group link\n` +
        `*!link remove <#>* — Remove a group link\n` +
        `*!disconnect* — Disconnect WhatsApp & rescan QR\n` +
        `*!commands* — Show this list`
      );
    }
    if (body.toLowerCase() === '!disconnect') {
      await msg.reply('⚠️ *Disconnecting WhatsApp...*\nThe bot will log out and a new QR code will be generated.\n\nCheck your terminal or Telegram for the new QR code.');
      try {
        await client.logout();
      } catch (e) {
        console.error('Logout error:', e.message);
        // Force destroy and reinitialize
        await client.destroy();
      }
      console.log('🔄 Admin triggered disconnect. Reinitializing...');
      if (tgBot) {
        tgBot.sendMessage(TELEGRAM_CHAT_ID, '🔄 *Admin triggered disconnect.* A new QR code will be sent shortly.', { parse_mode: 'Markdown' }).catch(() => {});
      }
      setTimeout(() => {
        client.initialize();
      }, 3000);
      return;
    }
    return; // Unknown ! command, ignore
  }

  // If bot is off, ignore all customer messages
  if (!botActive) return;

  // If contact filter is on, skip saved contacts
  if (contactFilterActive) {
    const contact = await msg.getContact();
    if (contact.isMyContact) return;
  }

  // --- Enquiry filter: only respond to new conversations that look like enquiries ---
  const existingSession = sessions.get(chatId);
  const hasActiveSession = existingSession && Date.now() - existingSession.lastActive < SESSION_TIMEOUT;

  if (!hasActiveSession) {
    const lower = body.toLowerCase();
    const isEnquiry = /^(hi|hey|hello|helo|good\s*(morning|afternoon|evening|day)|how|what|please|pls|i\s*(want|need|am|like)|interested|import|class|register|sign\s*up|learn|price|cost|how\s*much|procurement|buy|sell|product|menu|start|info|help)/i.test(lower)
      || msg.hasMedia  // photos (likely receipts)
      || lower.length > 15;  // longer messages are usually genuine enquiries

    if (!isEnquiry) return; // Ignore short random messages like "ok", "👍", "k"
  }

  // --- AI Mode: route all customer messages through Claude ---
  if (aiModeActive) {
    return handleAIMessage(msg, chatId, body);
  }

  // Global reset commands
  if (['hi', 'hello', 'hey', 'menu', 'start', '0'].includes(body.toLowerCase())) {
    resetSession(chatId);
    return sendWelcome(msg);
  }

  const session = getSession(chatId);

  switch (session.step) {
    case 'welcome':       return handleWelcome(msg, session, body);
    case 'smartBot':      return handleSmartBot(msg, session, body);
    case 'groupClasses':  return handleGroupClasses(msg, session, body);
    case 'classInfo':     return handleClassInfo(msg, session, body);
    case 'classPriceMenu':return handleClassPriceMenu(msg, session, body);
    case 'personalClass': return handlePersonalClass(msg, session, body);
    case 'personalBooking': return handlePersonalBooking(msg, session, body);
    case 'procurement':   return handleProcurement(msg, session, body);
    case 'support':       return handleSupport(msg, session, body);
    case 'registration':  return handleRegistration(msg, session, body);
    case 'awaitReceipt':  return handleAwaitReceipt(msg, session, body);
    default:
      resetSession(chatId);
      return sendWelcome(msg);
  }
});

// ===== STEP 1: Welcome =====
async function sendWelcome(msg) {
  await msg.reply(
    `👋 Hello!\n` +
    `Welcome to *DUKEH Importation*, your personal assistant for importing products directly from China.\n\n` +
    `We help individuals and business owners source, import, and sell products safely and profitably.\n\n` +
    `How can we assist you today?\n\n` +
    `1️⃣ Personal Importation Class (1-on-1 Training)\n` +
    `2️⃣ Group Importation Classes\n` +
    `3️⃣ Procurement & Personal Shopping\n` +
    `4️⃣ Speak with Support\n` +
    `5️⃣ Help me choose the right class (Smart Bot)\n\n` +
    `_💡 New here? Most beginners start with the China Importation Masterclass._\n` +
    `_➡️ Reply *2* to view Group Classes_`
  );
}

async function handleWelcome(msg, session, body) {
  switch (body) {
    case '1':
      session.step = 'personalClass';
      return sendPersonalClassInfo(msg);
    case '2':
      session.step = 'groupClasses';
      return sendGroupCatalog(msg);
    case '3':
      session.step = 'procurement';
      session.subStep = 0;
      return sendProcurementInfo(msg);
    case '4':
      session.step = 'support';
      return sendSupportEntry(msg);
    case '5':
      session.step = 'smartBot';
      session.subStep = 1;
      session.data.answers = [];
      return sendSmartQ1(msg);
    default:
      return sendWelcome(msg);
  }
}

// ===== STEP 2: Smart Bot =====
async function sendSmartQ1(msg) {
  await msg.reply(
    `🤖 *Help Me Choose — Question 1 of 3*\n\n` +
    `What is your main goal?\n\n` +
    `1️⃣ Start a business\n` +
    `2️⃣ Personal shopping / self-use\n` +
    `3️⃣ Resell fashion items\n` +
    `4️⃣ Resell beauty / hair products`
  );
}

async function handleSmartBot(msg, session, body) {
  const num = parseInt(body);

  if (session.subStep === 1) {
    if (num < 1 || num > 4) return msg.reply('Please reply with a number (1-4).');
    session.data.answers.push(num);
    session.subStep = 2;
    return msg.reply(
      `🤖 *Question 2 of 3*\n\n` +
      `How familiar are you with importing?\n\n` +
      `1️⃣ Beginner – I've never imported before\n` +
      `2️⃣ Intermediate – I've tried importing a few times\n` +
      `3️⃣ Advanced – I import regularly`
    );
  }

  if (session.subStep === 2) {
    if (num < 1 || num > 3) return msg.reply('Please reply with a number (1-3).');
    session.data.answers.push(num);
    session.subStep = 3;
    return msg.reply(
      `🤖 *Question 3 of 3*\n\n` +
      `What type of training suits you best?\n\n` +
      `1️⃣ Group Class (learn with others)\n` +
      `2️⃣ Personal Class (1-on-1 guidance)\n` +
      `3️⃣ Procurement & Personal Shopping`
    );
  }

  if (session.subStep === 3) {
    if (num < 1 || num > 3) return msg.reply('Please reply with a number (1-3).');
    session.data.answers.push(num);
    return sendSmartRecommendation(msg, session);
  }
}

async function sendSmartRecommendation(msg, session) {
  const [purpose, experience, trainingType] = session.data.answers;

  // Route to procurement
  if (trainingType === 3) {
    session.step = 'procurement';
    session.subStep = 0;
    await msg.reply(`🤖 *Based on your answers, we recommend:*\n\n💼 *Procurement & Personal Shopping*\nWe'll help you source and import products directly!`);
    return sendProcurementInfo(msg);
  }

  // Pick recommended class based on purpose
  let classIndex = 0; // default: China Masterclass
  if (purpose === 3) classIndex = 4; // fashion → T-Shirt
  if (purpose === 4) classIndex = 1; // hair/beauty → Hair class

  if (trainingType === 2) {
    // Personal class
    session.step = 'personalClass';
    return sendPersonalClassInfo(msg);
  }

  // Group class recommendation
  const rec = GROUP_CLASSES[classIndex];
  session.step = 'classInfo';
  session.data.selectedClass = classIndex;
  await msg.reply(
    `🤖 *Based on your answers, we recommend:*\n\n` +
    `📘 *${rec.name}*\n${rec.description}\n\n` +
    `1️⃣ See class price\n` +
    `2️⃣ How to register\n` +
    `3️⃣ Back to class catalog`
  );
}

// ===== STEP 3: Group Class Catalog =====
async function sendGroupCatalog(msg) {
  let text = `📚 *DUKEH Importation Group Classes*\n\nExplore our available group trainings below:\n\n`;
  GROUP_CLASSES.forEach((c, i) => {
    text += `${i + 1}️⃣ ${c.name}\n`;
  });
  text += `\n7️⃣ Back to Main Menu`;
  await msg.reply(text);
}

async function handleGroupClasses(msg, session, body) {
  if (body === '7') {
    resetSession(msg.from);
    return sendWelcome(msg);
  }
  const num = parseInt(body);
  if (num >= 1 && num <= GROUP_CLASSES.length) {
    session.step = 'classInfo';
    session.data.selectedClass = num - 1;
    return sendClassInfo(msg, num - 1);
  }
  return msg.reply(`Please reply with a number (1-${GROUP_CLASSES.length}) or *7* for main menu.`);
}

// ===== STEP 4: Class Info =====
async function sendClassInfo(msg, index) {
  const c = GROUP_CLASSES[index];
  let text = `📘 *${c.name}*\n\n${c.description}\n\n*You will learn:*\n`;
  c.learn.forEach((item) => { text += `• ${item}\n`; });
  text += `\n1️⃣ See class price\n2️⃣ How to register\n3️⃣ Back to class catalog\n4️⃣ 🎧 Speak with Support`;

  // Nudge
  text += `\n\n_💡 Tip: Most beginners start with this class. Spots fill up quickly!_`;
  await msg.reply(text);
}

async function handleClassInfo(msg, session, body) {
  const c = GROUP_CLASSES[session.data.selectedClass];
  switch (body) {
    case '1':
      session.step = 'classPriceMenu';
      return msg.reply(
        `💰 *${c.name}*\n\nPrice: *${c.price}*\n\n` +
        `_Don't wait too long! Most students secure their spot immediately._\n\n` +
        `1️⃣ Register now\n2️⃣ Back to class catalog\n3️⃣ Back to main menu\n4️⃣ 🎧 Speak with Support`
      );
    case '2':
      session.step = 'registration';
      session.subStep = 1;
      session.data.regType = 'group';
      session.data.regClass = c.name;
      session.data.regPrice = c.price;
      return msg.reply(`📝 *Registration for ${c.name}*\n\nPlease enter your *full name*:`);
    case '3':
      session.step = 'groupClasses';
      return sendGroupCatalog(msg);
    case '4':
      session.step = 'support';
      return sendSupportEntry(msg);
    default:
      return msg.reply('Please reply with 1, 2, 3, or 4.');
  }
}

// ===== Class Price Menu =====
async function handleClassPriceMenu(msg, session, body) {
  const c = GROUP_CLASSES[session.data.selectedClass];
  switch (body) {
    case '1':
      session.step = 'registration';
      session.subStep = 1;
      session.data.regType = 'group';
      session.data.regClass = c.name;
      session.data.regPrice = c.price;
      return msg.reply(`📝 *Registration for ${c.name}*\n\nPlease enter your *full name*:`);
    case '2':
      session.step = 'groupClasses';
      return sendGroupCatalog(msg);
    case '3':
      resetSession(msg.from);
      return sendWelcome(msg);
    case '4':
      session.step = 'support';
      return sendSupportEntry(msg);
    default:
      return msg.reply('Please reply with 1, 2, 3, or 4.');
  }
}

// ===== STEP 5: Personal Class =====
async function sendPersonalClassInfo(msg) {
  await msg.reply(
    `👤 *Personal Importation Class (1-on-1)*\n\n` +
    `This is a private session designed to give you direct guidance for your product or business.\n\n` +
    `*You will learn:*\n` +
    `• Step-by-step importation process\n` +
    `• Supplier sourcing help\n` +
    `• Payment & shipping guidance\n` +
    `• How to calculate profit & scale\n\n` +
    `⚡ _Only 10 personal bookings per month._\n\n` +
    `1️⃣ Book personal class\n` +
    `2️⃣ Back to main menu\n` +
    `3️⃣ 🎧 Speak with Support`
  );
}

async function handlePersonalClass(msg, session, body) {
  switch (body) {
    case '1':
      session.step = 'personalBooking';
      return sendPersonalPrices(msg);
    case '2':
      resetSession(msg.from);
      return sendWelcome(msg);
    case '3':
      session.step = 'support';
      return sendSupportEntry(msg);
    default:
      return msg.reply('Please reply with 1, 2, or 3.');
  }
}

async function sendPersonalPrices(msg) {
  let text = `💰 *Personal Class Prices*\n\n`;
  PERSONAL_CLASSES.forEach((c, i) => {
    text += `${i + 1}️⃣ ${c.name} — *${c.price}*\n`;
  });
  text += `\n8️⃣ Back to main menu\n\n_Reply with a number to register for that class._`;
  await msg.reply(text);
}

async function handlePersonalBooking(msg, session, body) {
  if (body === '8') {
    resetSession(msg.from);
    return sendWelcome(msg);
  }
  const num = parseInt(body);
  if (num >= 1 && num <= PERSONAL_CLASSES.length) {
    const pc = PERSONAL_CLASSES[num - 1];
    session.step = 'registration';
    session.subStep = 1;
    session.data.regType = 'personal';
    session.data.regClass = pc.name;
    session.data.regPrice = pc.price;
    return msg.reply(`📝 *Registration for ${pc.name}* (${pc.price})\n\nPlease enter your *full name*:`);
  }
  return msg.reply(`Please reply with a number (1-${PERSONAL_CLASSES.length}) or *8* for main menu.`);
}

// ===== STEP 6: Procurement =====
async function sendProcurementInfo(msg) {
  await msg.reply(
    `💼 *Procurement & Personal Shopping*\n\n` +
    `We help you:\n` +
    `• Source verified suppliers\n` +
    `• Negotiate best prices\n` +
    `• Inspect product quality\n` +
    `• Handle payment & shipping\n\n` +
    `Please send:\n` +
    `📌 Product picture or links (well arranged)\n` +
    `📌 Quantity needed\n` +
    `📌 Your location\n\n` +
    `_Send your details below. Type *done* when finished, or *menu* to go back._`
  );
}

async function handleProcurement(msg, session, body) {
  if (body.toLowerCase() === 'done') {
    try {
      await client.sendMessage(ADMIN_NUMBER,
        `📦 *New Procurement Request*\n\nFrom: ${msg.from}\n\nDetails:\n${session.data.procurementDetails || '(see forwarded messages)'}`
      );
    } catch (e) {
      console.error('Failed to notify admin:', e.message);
    }
    await msg.reply(
      `✅ Thank you! Your procurement request has been received.\n\n` +
      `A team member will review your details and get back to you shortly.\n\n` +
      `Type *menu* to return to the main menu.`
    );
    resetSession(msg.from);
    return;
  }

  // Accumulate details
  if (!session.data.procurementDetails) session.data.procurementDetails = '';
  session.data.procurementDetails += body + '\n';

  // Forward media to admin
  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      await client.sendMessage(ADMIN_NUMBER, media, { caption: `📦 Procurement media from ${msg.from}` });
    } catch (e) {
      console.error('Failed to forward media:', e.message);
    }
  }

  await msg.reply(`✅ Noted! Send more details or type *done* when finished.`);
}

// ===== STEP 7: Support =====
async function sendSupportEntry(msg) {
  await msg.reply(
    `🎧 *You are speaking with the DUKEH Importation Assistant.*\n\n` +
    `A team member will respond shortly.\n` +
    `Please type your question below.\n\n` +
    `_Type *menu* to return to the main menu._`
  );
  // Notify admin that someone wants to speak with support
  try {
    await client.sendMessage(ADMIN_NUMBER,
      `🔔 *New Support Request*\n\nA customer (${msg.from}) wants to speak with support. Their next message will be forwarded to you.`
    );
  } catch (e) {
    console.error('Failed to notify admin of support request:', e.message);
  }
}

async function handleSupport(msg, session, body) {
  try {
    await client.sendMessage(ADMIN_NUMBER,
      `🎧 *Support Message*\n\nFrom: ${msg.from}\n\nMessage: ${body}`
    );
    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      await client.sendMessage(ADMIN_NUMBER, media, { caption: `🎧 Support media from ${msg.from}` });
    }
  } catch (e) {
    console.error('Failed to forward to admin:', e.message);
  }
  await msg.reply(`✅ Your message has been sent to our support team. We'll get back to you shortly.\n\n_Type *menu* to return to the main menu._`);
}

// ===== Registration Flow =====
async function handleRegistration(msg, session, body) {
  if (session.subStep === 1) {
    session.data.regName = body;
    session.subStep = 2;
    return msg.reply(`Thanks, *${body}*! Now please enter your *WhatsApp number*:`);
  }

  if (session.subStep === 2) {
    session.data.regPhone = body;
    session.subStep = 3;
    return msg.reply(
      `📋 *Please confirm your registration:*\n\n` +
      `Class: *${session.data.regClass}*\n` +
      `Type: *${session.data.regType === 'personal' ? 'Personal (1-on-1)' : 'Group'}*\n` +
      `Price: *${session.data.regPrice}*\n` +
      `Name: *${session.data.regName}*\n` +
      `WhatsApp: *${session.data.regPhone}*\n\n` +
      `1️⃣ Confirm registration\n` +
      `2️⃣ Cancel`
    );
  }

  if (session.subStep === 3) {
    if (body === '1') {
      // Generate random registration ID and store pending registration
      const regId = generateRegId();
      pendingRegistrations.set(regId, {
        chatId: msg.from,
        name: session.data.regName,
        phone: session.data.regPhone,
        className: session.data.regClass,
        type: session.data.regType,
        price: session.data.regPrice,
      });
      saveRegistrations();

      try {
        await client.sendMessage(ADMIN_NUMBER,
          `🆕 *New Registration #${regId}*\n\n` +
          `Class: ${session.data.regClass}\n` +
          `Type: ${session.data.regType}\n` +
          `Price: ${session.data.regPrice}\n` +
          `Name: ${session.data.regName}\n` +
          `WhatsApp: ${session.data.regPhone}\n\n` +
          `_Use *!verify ${regId}* to confirm this registration._`
        );
      } catch (e) {
        console.error('Failed to notify admin:', e.message);
      }
      await msg.reply(
        `✅ *Registration Successful!*\n\n` +
        `Your registration ID is *#${regId}*\n` +
        `You have been registered for *${session.data.regClass}*.\n\n` +
        PAYMENT_DETAILS + `\n\n` +
        `📸 Please send your *receipt of payment* below.\n` +
        `_Type *menu* to skip and return to the main menu._`
      );
      session.step = 'awaitReceipt';
      session.data.regId = regId;
      return;
    }
    if (body === '2') {
      await msg.reply('Registration cancelled. Type *menu* to return.');
      resetSession(msg.from);
      return;
    }
    return msg.reply('Please reply with *1* to confirm or *2* to cancel.');
  }
}

// ===== Receipt of Payment =====
async function handleAwaitReceipt(msg, session, body) {
  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      await client.sendMessage(ADMIN_NUMBER, media, {
        caption: `🧾 *Receipt of Payment — Registration #${session.data.regId}*\n\nName: ${session.data.regName}\nClass: ${session.data.regClass}\nType: ${session.data.regType}\nPrice: ${session.data.regPrice}\nWhatsApp: ${session.data.regPhone}\n\n_Reply to this message with *!verify* to confirm._`
      });
    } catch (e) {
      console.error('Failed to forward receipt:', e.message);
    }
    await msg.reply(
      `✅ *Receipt received!*\n\n` +
      `We will confirm your registration shortly.\n` +
      `Thank you for choosing *DUKEH Importation*! 🙏\n\n` +
      `Type *menu* to return to the main menu.`
    );
    resetSession(msg.from);
    return;
  }

  // They sent text instead of an image
  await msg.reply(`📸 Please send a *photo or screenshot* of your receipt.\n\n_Type *menu* to skip and return to the main menu._`);
}

// --- AI Message Handler ---
async function handleAIMessage(msg, chatId, body) {
  try {
    // Forward media to admin immediately
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        await client.sendMessage(ADMIN_NUMBER, media, {
          caption: `📨 *Media from customer* (AI Mode)\n\nFrom: ${chatId}${body ? '\nCaption: ' + body : ''}`,
        });
      } catch (e) {
        console.error('Failed to forward media:', e.message);
      }
    }

    let response = await ai.generateResponse(chatId, body, msg.hasMedia);

    // Tool-use loop: execute actions and get final response
    let loops = 0;
    while (response.stopReason === 'tool_use' && response.actions.length > 0 && loops < 5) {
      const toolResults = [];
      for (const action of response.actions) {
        const result = await executeAIAction(action, msg, chatId);
        toolResults.push({ type: 'tool_result', tool_use_id: action.id, content: result });
      }
      response = await ai.continueAfterActions(chatId, toolResults);
      loops++;
    }

    if (response.text) {
      await msg.reply(response.text);
    }
  } catch (err) {
    console.error('AI error:', err.message);
    await msg.reply(
      `I'm having trouble right now. Please try again in a moment.\n\n_If this persists, the admin has been notified._`
    );
  }
}

async function executeAIAction(action, msg, chatId) {
  switch (action.tool) {
    case 'create_registration': {
      const { customer_name, phone_number, class_name, class_type, price } = action.input;
      const regId = generateRegId();
      pendingRegistrations.set(regId, {
        chatId,
        name: customer_name,
        phone: phone_number,
        className: class_name,
        type: class_type,
        price,
      });
      saveRegistrations();
      await client.sendMessage(
        ADMIN_NUMBER,
        `🆕 *New Registration #${regId}* (AI Mode)\n\n` +
          `Class: ${class_name}\nType: ${class_type}\nPrice: ${price}\n` +
          `Name: ${customer_name}\nWhatsApp: ${phone_number}\n\n` +
          `_Use *!verify ${regId}* to confirm._`
      );
      return `Registration created. ID: #${regId}. Admin has been notified. Now share the payment details with the customer.`;
    }
    case 'forward_to_admin': {
      const { reason, details } = action.input;
      await client.sendMessage(
        ADMIN_NUMBER,
        `📨 *${reason}* (AI Mode)\n\nFrom: ${chatId}\n\n${details}`
      );
      return 'Forwarded to admin successfully.';
    }
    default:
      return 'Unknown action.';
  }
}

// --- Clean up stale Chromium lock files (prevents Docker restart errors) ---
function cleanChromiumLocks() {
  const authDir = path.join(__dirname, '.wwebjs_auth');
  if (!fs.existsSync(authDir)) return;
  const walk = (dir) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'SingletonLock' || entry.name === 'SingletonCookie' || entry.name === 'SingletonSocket') {
          fs.unlinkSync(full);
          console.log(`🧹 Removed stale lock: ${entry.name}`);
        }
      }
    } catch (e) {}
  };
  walk(authDir);
}

// --- Graceful shutdown ---
async function shutdown(signal) {
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);
  try { await client.destroy(); } catch (e) {}
  if (tgBot) { try { tgBot.stopPolling(); } catch (e) {} }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---
console.log('🚀 Starting DUKEH Importation Bot...');
cleanChromiumLocks();
client.initialize();
