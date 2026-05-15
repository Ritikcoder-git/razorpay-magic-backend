const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ----------------------------------------
// 1. CREATE ORDER
// ----------------------------------------
app.post('/create-order', async (req, res) => {
  try {
    const { amount, product_name, product_sku, product_image, quantity } = req.body;
    const order = await razorpay.orders.create({
      amount: amount,
      currency: 'INR',
      receipt: 'rcpt_' + Date.now(),
      line_items_total: amount,
      line_items: [{
        sku: product_sku || 'SKU001',
        variant_id: product_sku || 'VAR001',
        price: amount,
        offer_price: amount,
        quantity: quantity || 1,
        name: product_name || 'Product',
        image_url: product_image || ''
      }]
    });
    res.json({ success: true, order_id: order.id, amount: order.amount });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------
// 2. WEBHOOK
// ----------------------------------------
app.post('/webhook', async (req, res) => {
  try {
const body = req.body;

    const event = JSON.parse(body.toString());
    console.log('Webhook received:', event.event);

    if (
      event.event === 'payment.captured' ||
      event.event === 'order.paid' ||
      event.event === 'payment.pending'
    ) {
      let payment = null;
      if (event.payload.payment) {
        payment = event.payload.payment.entity;
      } else if (event.payload.order) {
        payment = event.payload.order.entity;
      }

      if (!payment) {
        console.log('No payment entity found');
        return res.json({ success: true });
      }

      console.log('Processing payment:', payment.id);

      await createZohoOrder(payment).catch(e =>
        console.error('Zoho Order failed:', e.message)
      );
      await sendCustomerEmail(payment).catch(e =>
        console.error('Customer Email failed:', e.message)
      );
      await sendAdminEmail(payment).catch(e =>
        console.error('Admin Email failed:', e.message)
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// ZOHO ORDER
// ----------------------------------------
async function createZohoOrder(payment) {
  const tokenRes = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN
    })
  });
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error('No Zoho token: ' + JSON.stringify(tokenData));

  const orderRes = await fetch('https://commerce.zoho.in/storefront/api/v1/orders', {
    method: 'POST',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + accessToken,
      'Content-Type': 'application/json',
      'store-id': process.env.ZOHO_STORE_ID
    },
    body: JSON.stringify({
      customer_email: payment.email || '',
      customer_phone: payment.contact || '',
      payment_status: 'paid',
      payment_method: 'razorpay',
      transaction_id: payment.id,
      order_status: 'confirmed'
    })
  });
  const orderData = await orderRes.json();
  console.log('Zoho order response:', JSON.stringify(orderData));
  return orderData;
}

// ----------------------------------------
// CUSTOMER EMAIL
// ----------------------------------------
async function sendCustomerEmail(payment) {
  if (!payment.email) { console.log('No customer email'); return; }
  const amount = (payment.amount / 100).toFixed(2);
  const orderId = payment.order_id || payment.id;
  const storeUrl = process.env.STORE_URL || 'https://www.overstockbay.com';

  await transporter.sendMail({
    from: '"Overstockbay" <' + process.env.EMAIL_USER + '>',
    to: payment.email,
    subject: '✅ Order Confirmed #' + orderId,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <div style="background:#000;padding:30px;text-align:center;border-radius:12px 12px 0 0">
          <h1 style="color:white;margin:0">Order Confirmed! ✅</h1>
          <p style="color:#ccc;margin:8px 0 0">Thank you for shopping with Overstockbay</p>
        </div>
        <div style="background:#f9fafb;padding:30px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb">
          <table style="width:100%;border-collapse:collapse">
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280">Order ID</td>
              <td style="padding:10px 0;font-weight:700;text-align:right">${orderId}</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280">Amount Paid</td>
              <td style="padding:10px 0;font-weight:700;text-align:right;color:#16a34a;font-size:18px">₹${amount}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;color:#6b7280">Payment ID</td>
              <td style="padding:10px 0;font-weight:700;text-align:right;font-size:12px">${payment.id}</td>
            </tr>
          </table>
          <div style="text-align:center;margin:25px 0">
            <a href="${storeUrl}" style="background:#000;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700">
              Continue Shopping →
            </a>
          </div>
        </div>
      </div>
    `
  });
  console.log('Customer email sent to:', payment.email);
}

// ----------------------------------------
// ADMIN EMAIL
// ----------------------------------------
async function sendAdminEmail(payment) {
  if (!process.env.ADMIN_EMAIL) return;
  const amount = (payment.amount / 100).toFixed(2);
  const orderId = payment.order_id || payment.id;

  await transporter.sendMail({
    from: '"Overstockbay Orders" <' + process.env.EMAIL_USER + '>',
    to: process.env.ADMIN_EMAIL,
    subject: '🛍️ New Order ₹' + amount + ' - ' + orderId,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <div style="background:#16a34a;padding:25px;text-align:center;border-radius:12px 12px 0 0">
          <h1 style="color:white;margin:0">New Order! 🛍️</h1>
        </div>
        <div style="background:#f9fafb;padding:30px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb">
          <table style="width:100%;border-collapse:collapse">
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280">Order ID</td>
              <td style="padding:10px 0;font-weight:700;text-align:right">${orderId}</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280">Amount</td>
              <td style="padding:10px 0;font-weight:700;text-align:right;color:#16a34a;font-size:18px">₹${amount}</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:10px 0;color:#6b7280">Email</td>
              <td style="padding:10px 0;font-weight:700;text-align:right">${payment.email || 'Not provided'}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;color:#6b7280">Phone</td>
              <td style="padding:10px 0;font-weight:700;text-align:right">${payment.contact || 'Not provided'}</td>
            </tr>
          </table>
        </div>
      </div>
    `
  });
  console.log('Admin email sent');
}

// ----------------------------------------
// 3. GET PROMOTIONS
// ----------------------------------------
app.post('/get-promotions', async (req, res) => {
  res.json({
    promotions: [
      { code: "WELCOME10", summary: "10% off on first order", description: "Get 10% off" },
      { code: "FLAT100", summary: "Flat ₹100 off above ₹999", description: "Flat ₹100 off" }
    ]
  });
});

// ----------------------------------------
// 4. APPLY PROMOTIONS
// ----------------------------------------
app.post('/apply-promotions', async (req, res) => {
  const { code } = req.body;
  const coupons = {
    "WELCOME10": { value: 10, value_type: "percentage", description: "10% off applied" },
    "FLAT100": { value: 10000, value_type: "fixed_amount", description: "₹100 off applied" }
  };
  if (coupons[code]) {
    res.json({ promotion: { reference_id: code, code, type: "coupon", ...coupons[code] } });
  } else {
    res.status(400).json({ success: false, error: "Invalid coupon" });
  }
});

// ----------------------------------------
// 5. SHIPPING INFO
// ----------------------------------------
app.post('/shipping-info', async (req, res) => {
  try {
    const addresses = req.body.addresses || [];
    res.json({
      addresses: addresses.map(addr => ({
        id: addr.id,
        zipcode: addr.zipcode,
        country: addr.country || 'IN',
        serviceable: true,
        cod: true,
        shipping_methods: [
          { id: "standard", name: "Standard Delivery (5-7 days)", description: "5-7 business days", serviceable: true, shipping_fee: 0, cod: true, cod_fee: 5000 },
          { id: "express", name: "Express Delivery (2-3 days)", description: "2-3 business days", serviceable: true, shipping_fee: 10000, cod: true, cod_fee: 5000 }
        ]
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 6. PAYMENT SUCCESS
// ----------------------------------------
app.all('/payment-success', (req, res) => {
  const body = req.body || {};
  const query = req.query || {};
  const paymentId = body.razorpay_payment_id || query.razorpay_payment_id || '';
  const orderId = body.razorpay_order_id || query.razorpay_order_id || '';
  res.redirect('https://www.overstockbay.com?payment=success&payment_id=' + paymentId + '&order_id=' + orderId);
});

// ----------------------------------------
// 7. ZOHO CALLBACK
// ----------------------------------------
app.get('/zoho-callback', (req, res) => {
  const code = req.query.code;
  res.send(`<html><body style="font-family:sans-serif;padding:40px"><h2>Your Code:</h2><p style="background:#f0f0f0;padding:15px;word-break:break-all;font-size:18px">${code}</p><p>Copy immediately!</p></body></html>`);
});

// ----------------------------------------
// START
// ----------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Magic Checkout Backend running on port ' + PORT));
