// DUKEH AI Module — Claude-powered natural conversation
const { PAYMENT_DETAILS, GROUP_CLASSES, PERSONAL_CLASSES } = require('./config');

const conversations = new Map();
const MAX_HISTORY = 30;
const CONVERSATION_TIMEOUT = 60 * 60 * 1000; // 1 hour

function buildSystemPrompt() {
  let classInfo = '';
  GROUP_CLASSES.forEach((c, i) => {
    classInfo += `${i + 1}. ${c.name} — ${c.price}\n   ${c.description}\n   Topics: ${c.learn.join(', ')}\n\n`;
  });

  let personalInfo = '';
  PERSONAL_CLASSES.forEach((c, i) => {
    personalInfo += `${i + 1}. ${c.name} — ${c.price}\n`;
  });

  return `You are Dukeh — you run DUKEH Importation's WhatsApp. You're NOT a bot, you're a real person chatting. You're chill, helpful, and you know your stuff about importing from China.

## How you talk
- Talk like a REAL person texting on WhatsApp. Keep it SHORT. 1-2 sentences is perfect. Never write paragraphs.
- Sound human, not corporate. Say "hey!" not "Hello, welcome to our services."
- Say "sure thing 😊" not "Certainly! I'd be happy to assist you with that."
- Say "yeah we got that" not "Yes, we offer that service."
- Use emojis like a normal person — sparingly, not every sentence.
- NEVER use numbered lists, bullet points, or menu-style formatting. Just chat.
- NEVER say things like "I'd be happy to help" or "Thank you for your interest" — that's robot talk.
- Don't repeat what the customer just said back to them. Just answer.
- Be warm but brief. Like texting a friend who sells stuff.

## What you know
You work for DUKEH Importation — a business that teaches people how to import products from China and also offers procurement services.

### Group Classes
${classInfo}

### Personal Classes (1-on-1 training, only 10 spots per month)
${personalInfo}

### Payment Details
${PAYMENT_DETAILS}

### Services
- Training classes (group and personal) to teach importation
- Procurement & personal shopping — we source, negotiate, inspect, and ship products for customers

## How to handle things
- When someone's interested in a class, chat with them about it naturally. Ask what they want to learn, recommend the right class.
- When they want to register: casually collect their full name, WhatsApp number, and which class. Then use the create_registration tool. Don't make it feel like filling out a form — make it feel like a conversation.
- After registration, share the payment details naturally and ask them to send a photo of their receipt.
- For procurement requests, ask what they want to import, how many, and where they're located. Then use forward_to_admin to pass it along.
- If someone sends a photo, it's probably a payment receipt. Thank them warmly and let them know the team will review it.
- If someone asks about something unrelated, gently steer back to importation.
- Never make up prices or classes. Only share what's listed above.
- Create a sense of urgency naturally — "spots are filling up fast this month!" feels better than "Limited availability."`;
}

const tools = [
  {
    name: 'create_registration',
    description: 'Create a registration after collecting customer name, phone, and chosen class.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Full name' },
        phone_number: { type: 'string', description: 'WhatsApp phone number' },
        class_name: { type: 'string', description: 'Exact class name' },
        class_type: { type: 'string', enum: ['group', 'personal'] },
        price: { type: 'string', description: 'Class price' },
      },
      required: ['customer_name', 'phone_number', 'class_name', 'class_type', 'price'],
    },
  },
  {
    name: 'forward_to_admin',
    description: 'Forward a request to admin/support. Use for procurement, support, or escalation.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'e.g. "procurement request", "support question"' },
        details: { type: 'string', description: 'Summary of the request' },
      },
      required: ['reason', 'details'],
    },
  },
];

function getConversation(chatId) {
  let conv = conversations.get(chatId);
  if (!conv || Date.now() - conv.lastActive > CONVERSATION_TIMEOUT) {
    conv = { messages: [], lastActive: Date.now() };
    conversations.set(chatId, conv);
  }
  conv.lastActive = Date.now();
  return conv;
}

function clearConversation(chatId) {
  conversations.delete(chatId);
}

async function callClaude(messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  return response.json();
}

async function generateResponse(chatId, userMessage, isMedia) {
  const conv = getConversation(chatId);

  const content = isMedia
    ? `[Customer sent a photo/image]${userMessage ? ' ' + userMessage : ''}`
    : userMessage;

  conv.messages.push({ role: 'user', content });

  if (conv.messages.length > MAX_HISTORY) {
    conv.messages = conv.messages.slice(-MAX_HISTORY);
  }

  const result = await callClaude(conv.messages);

  let text = '';
  const actions = [];

  for (const block of result.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') actions.push({ tool: block.name, input: block.input, id: block.id });
  }

  conv.messages.push({ role: 'assistant', content: result.content });

  return { text, actions, stopReason: result.stop_reason };
}

async function continueAfterActions(chatId, toolResults) {
  const conv = getConversation(chatId);

  conv.messages.push({ role: 'user', content: toolResults });

  const result = await callClaude(conv.messages);

  let text = '';
  const actions = [];

  for (const block of result.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') actions.push({ tool: block.name, input: block.input, id: block.id });
  }

  conv.messages.push({ role: 'assistant', content: result.content });

  return { text, actions, stopReason: result.stop_reason };
}

module.exports = { generateResponse, continueAfterActions, clearConversation };
