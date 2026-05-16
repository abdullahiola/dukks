// DUKEH Importation Bot — Configuration
// Update prices, dates, and admin number here.

require('dotenv').config();

const ADMIN_NUMBER = '2349037746949@c.us';

// Telegram Bot — reads from .env file
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in your .env file
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const PAYMENT_DETAILS = `🏦 *Payment Details*

Bank: *Paystack-titan*
Account Name: *ADEBISI BAMGBOLA ZAINAB*
Account Number: *9864161842*

After payment, send receipt of payment here and we will confirm your registration.`;

// Group classes
const GROUP_CLASSES = [
  {
    id: 'china',
    name: 'China Importation Masterclass',
    price: '₦35,000',
    description: 'Learn how to import any product directly from China.',
    learn: [
      'How to find verified suppliers',
      'How to avoid supplier scams',
      'Payment & shipping process',
      'Profit calculation before ordering',
    ],
  },
  {
    id: 'hair',
    name: 'Luxury Hair Importation Class',
    price: '₦45,000',
    description: 'Learn how to import high quality hairs directly from Vietnam and China.',
    learn: [
      'How to find verified suppliers',
      'How to avoid supplier scams',
      'Payment & shipping process',
      'Profit calculation before ordering',
    ],
  },
  {
    id: 'gadget',
    name: 'Gadget Importation Class',
    price: '₦40,000',
    description: 'Learn how to import any gadgets such as iPhones, Samsungs, iPads, tablets and computers directly from China.',
    learn: [
      'How to verify phones and identify good and bad phones',
      'How to avoid supplier scams',
      'Payment & shipping process',
      'Profit calculation before ordering',
    ],
  },
  {
    id: 'shein',
    name: 'SHEIN Bale Importation Class',
    price: '₦20,000',
    description: 'Learn how to import SHEIN bale directly from China.',
    learn: [
      'How to buy from suppliers',
      'How to avoid supplier scams',
      'Payment & shipping process',
      'Access to suppliers contacts',
      'Profit calculation before ordering',
    ],
  },
  {
    id: 'tshirt',
    name: 'T-Shirt Importation Class',
    price: '₦20,000',
    description: 'Learn how to import T-shirts directly from China.',
    learn: [
      'How to know types of Gram and Fabric of T-shirts',
      'How to avoid supplier scams',
      'Payment & shipping process',
      'Profit calculation before ordering',
    ],
  },
  {
    id: 'blend',
    name: 'Blend Importation Class',
    price: '₦35,000',
    description: 'Learn how to import BLEND HAIRS directly from China.',
    learn: [
      'How to identify types of hair blends',
      'How to avoid supplier scams',
      'Payment & shipping process',
      'Profit calculation before ordering',
    ],
  },
];

// Personal class prices
const PERSONAL_CLASSES = [
  { name: 'China Personal Class', price: '₦100,000' },
  { name: 'Hair Personal Class', price: '₦120,000' },
  { name: 'Luxury Hair Importation Class', price: '₦150,000' },
  { name: 'Gadget Importation Class', price: '₦80,000' },
  { name: 'SHEIN Bale Importation Class', price: '₦50,000' },
  { name: 'T-Shirt Importation Class', price: '₦50,000' },
  { name: 'Blend Importation Class', price: '₦70,000' },
];

module.exports = { ADMIN_NUMBER, PAYMENT_DETAILS, GROUP_CLASSES, PERSONAL_CLASSES, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID };
