/**
 * Reference PhonePe payment-initiation + booking-tracking server for ZIPO.
 *
 * WHY THIS EXISTS
 * PhonePe has no client-side "checkout.js" like Razorpay. Starting a payment
 * means calling PhonePe's Pay API from a server, signed with your Merchant
 * ID + Salt Key (both secrets — never put them in the website's HTML/JS).
 * That call returns a redirect URL; you send the customer's browser there to
 * actually pay, and PhonePe later calls your server back (webhook) to
 * confirm the result.
 *
 * This version also keeps a simple, persistent log of every booking
 * (plan, amount, status, timestamp) in a local JSON file, and exposes an
 * admin-only endpoint to read that log — protected by verifying the
 * caller's Google ID token server-side, not just a front-end check.
 *
 * This is a minimal, deployable starting point, not a finished production
 * service. For real scale, swap the JSON file for a real database
 * (Postgres, MongoDB, etc.) — the storage functions below are isolated so
 * that swap is straightforward later.
 *
 * SETUP
 * 1. npm install express axios google-auth-library
 * 2. Get MERCHANT_ID / SALT_KEY / SALT_INDEX from the PhonePe Business
 *    dashboard once your merchant account is approved.
 * 3. Get GOOGLE_CLIENT_ID from the same Google Cloud Console project used
 *    on the website (the one already wired into index.html).
 * 4. Set ADMIN_EMAIL to the Google account allowed to view bookings.
 * 5. Run with environment variables set, e.g.:
 *      MERCHANT_ID=... SALT_KEY=... SALT_INDEX=1 \
 *      GOOGLE_CLIENT_ID=... ADMIN_EMAIL=zipocarwash@gmail.com \
 *      node phonepe-server.js
 * 6. Deploy on any Node host (Render, Railway, a small VPS, etc.) — it
 *    cannot live inside a static site.
 * 7. Point PHONEPE_INITIATE_ENDPOINT and BOOKINGS_ENDPOINT in the website's
 *    <script> at wherever you deploy this.
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');

const app = express();
app.use(express.json());

// CORS — allow your live site to call this backend from the browser.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://zipocarwash.in');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const MERCHANT_ID = process.env.MERCHANT_ID || 'YOUR_MERCHANT_ID';
const SALT_KEY = process.env.SALT_KEY || 'YOUR_SALT_KEY';
const SALT_INDEX = process.env.SALT_INDEX || '1';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '735987737182-blf0le6gk5607iji3ukifs0858esdtdc.apps.googleusercontent.com';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'zipocarwash@gmail.com').toLowerCase();

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// PhonePe UAT (sandbox/testing) host. Switch to the production host PhonePe
// gives you once your merchant account is live.
const PHONEPE_HOST = 'https://api-preprod.phonepe.com/apis/pg-sandbox';

// ---------------------------------------------------------------------
// Simple JSON-file booking store. Fine for a small business getting
// started; swap for a real database later without changing the API shape.
// ---------------------------------------------------------------------
const DB_FILE = path.join(__dirname, 'bookings.json');

function loadBookings() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveBookings(bookings) {
  fs.writeFileSync(DB_FILE, JSON.stringify(bookings, null, 2));
}

function addBooking(booking) {
  const bookings = loadBookings();
  bookings.push(booking);
  saveBookings(bookings);
}

function updateBookingStatus(merchantTransactionId, status, extra = {}) {
  const bookings = loadBookings();
  const idx = bookings.findIndex(b => b.merchantTransactionId === merchantTransactionId);
  if (idx !== -1) {
    bookings[idx] = { ...bookings[idx], status, ...extra, updatedAt: new Date().toISOString() };
    saveBookings(bookings);
  }
}

// ---------------------------------------------------------------------
// Start a PhonePe payment, and record the booking as "pending".
// ---------------------------------------------------------------------
app.post('/api/phonepe/initiate', async (req, res) => {
  try {
    const { planName, amount, merchantTransactionId, customerName, customerPhone } = req.body;

    const payload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: merchantTransactionId,
      merchantUserId: 'GUEST_' + Date.now(),
      amount: amount, // paise
      redirectUrl: 'https://zipocarwash.in/booking-status',
      redirectMode: 'REDIRECT',
      callbackUrl: 'https://your-api.example.com/api/phonepe/callback', // set to this server's real deployed URL
      mobileNumber: customerPhone || '9999999999',
      paymentInstrument: { type: 'PAY_PAGE' }
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const endpointPath = '/pg/v1/pay';
    const checksum = crypto
      .createHash('sha256')
      .update(base64Payload + endpointPath + SALT_KEY)
      .digest('hex') + '###' + SALT_INDEX;

    const response = await axios.post(
      PHONEPE_HOST + endpointPath,
      { request: base64Payload },
      { headers: { 'Content-Type': 'application/json', 'X-VERIFY': checksum } }
    );

    const redirectUrl = response.data?.data?.instrumentResponse?.redirectInfo?.url;
    if (!redirectUrl) throw new Error('PhonePe did not return a redirect URL');

    // Record the booking as pending — this is what the admin dashboard reads.
    addBooking({
      merchantTransactionId,
      planName,
      amount, // paise
      customerName: customerName || '',
      customerPhone: customerPhone || '',
      status: 'pending',
      createdAt: new Date().toISOString()
    });

    res.json({ redirectUrl });
  } catch (err) {
    console.error('PhonePe initiate failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start PhonePe payment' });
  }
});

// PhonePe calls this after the payment completes — this is the only place
// you should ever mark a booking as actually paid.
app.post('/api/phonepe/callback', (req, res) => {
  // TODO: verify the callback's X-VERIFY header against SALT_KEY before
  // trusting this payload, per PhonePe's callback verification docs.
  const merchantTransactionId = req.body?.data?.merchantTransactionId;
  const state = req.body?.data?.state; // e.g. "COMPLETED", "FAILED"
  if (merchantTransactionId) {
    updateBookingStatus(merchantTransactionId, state === 'COMPLETED' ? 'paid' : 'failed');
  }
  console.log('PhonePe callback received:', req.body);
  res.sendStatus(200);
});

// ---------------------------------------------------------------------
// Admin-only: list all bookings. Requires a valid Google ID token for
// ADMIN_EMAIL, verified against Google's servers — not just a front-end
// check, so this can't be bypassed from the browser.
// ---------------------------------------------------------------------
app.get('/api/admin/bookings', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    if (!idToken) return res.status(401).json({ error: 'Missing token' });

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();

    if (!payload.email || payload.email.toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const bookings = loadBookings().sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    res.json({ bookings });
  } catch (err) {
    console.error('Admin bookings check failed:', err.message);
    res.status(401).json({ error: 'Invalid token' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('ZIPO backend listening on port ' + PORT));
