const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
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
// 2. VERIFY PAYMENT + CREATE ZOHO ORDER
// ----------------------------------------
app.post('/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .toString('hex');

    if (expectedSignature === razorpay_signature) {

      // Fetch payment details from Razorpay
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      
      // Try to create order in Zoho (won't crash if it fails)
      try {
        await createZohoOrder(payment, razorpay_order_id);
      } catch (zohoError) {
        console.error('Zoho order creation failed:', zohoError.message);
      }

      res.json({
        success: true,
        message: 'Payment verified',
        payment_id: razorpay_payment_id,
        order_id: razorpay_order_id
      });

    } else {
      res.status(400).json({ success: false, message: 'Payment verification failed' });
    }

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------
// CREATE ORDER IN ZOHO COMMERCE
// ----------------------------------------
async function createZohoOrder(payment, razorpayOrderId) {
  // Get Zoho access token
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

  if (!accessToken) {
    throw new Error('Could not get Zoho access token: ' + JSON.stringify(tokenData));
  }

  // Create order in Zoho Commerce
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
      razorpay_order_id: razorpayOrderId,
      order_status: 'confirmed'
    })
  });

  const orderData = await orderRes.json();
  console.log('Zoho order created:', JSON.stringify(orderData));
  return orderData;
}

// ----------------------------------------
// 3. GET PROMOTIONS
// ----------------------------------------
app.post('/get-promotions', async (req, res) => {
  res.json({
    promotions: [
      {
        code: "WELCOME10",
        summary: "10% off on first order",
        description: "Get 10% off on your first order"
      },
      {
        code: "FLAT100",
        summary: "Flat ₹100 off on orders above ₹999",
        description: "Flat ₹100 off"
      }
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
    res.json({
      promotion: {
        reference_id: code,
        code: code,
        type: "coupon",
        value: coupons[code].value,
        value_type: coupons[code].value_type,
        description: coupons[code].description
      }
    });
  } else {
    res.status(400).json({ success: false, error: "Invalid coupon code" });
  }
});

// ----------------------------------------
// 5. SHIPPING INFO
// ----------------------------------------
app.post('/shipping-info', async (req, res) => {
  try {
    const addresses = req.body.addresses || [];

    const responseAddresses = addresses.map(addr => ({
      id: addr.id,
      zipcode: addr.zipcode,
      country: addr.country || 'IN',
      serviceable: true,
      cod: true,
      shipping_methods: [
        {
          id: "standard",
          name: "Standard Delivery (5-7 days)",
          description: "Delivery within 5-7 business days",
          serviceable: true,
          shipping_fee: 0,
          cod: true,
          cod_fee: 5000
        },
        {
          id: "express",
          name: "Express Delivery (2-3 days)",
          description: "Delivery within 2-3 business days",
          serviceable: true,
          shipping_fee: 10000,
          cod: true,
          cod_fee: 5000
        }
      ]
    }));

    res.json({ addresses: responseAddresses });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 6. PAYMENT SUCCESS — REDIRECT TO ZOHO STORE
// ----------------------------------------
app.all('/payment-success', (req, res) => {
  const paymentId = req.query.razorpay_payment_id || '';
  const orderId = req.query.razorpay_order_id || '';

  // Redirect customer to your Zoho store homepage
  res.redirect('https://www.overstockbay.com?payment_id=' + paymentId + '&order_id=' + orderId);
});

// ----------------------------------------
// 7. ZOHO OAUTH CALLBACK (needed to get refresh token)
// ----------------------------------------
app.get('/zoho-callback', (req, res) => {
  const code = req.query.code;
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:40px">
        <h2>Your Zoho Authorization Code:</h2>
        <p style="background:#f0f0f0;padding:15px;font-size:18px;word-break:break-all">${code}</p>
        <p>Copy this code and send it to complete setup.</p>
      </body>
    </html>
  `);
});

// ----------------------------------------
// START SERVER
// ----------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Magic Checkout Backend running on port ' + PORT);
});
