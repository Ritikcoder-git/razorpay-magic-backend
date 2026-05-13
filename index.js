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
// 2. VERIFY PAYMENT
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
      res.json({ success: true, message: 'Payment verified', payment_id: razorpay_payment_id, order_id: razorpay_order_id });
    } else {
      res.status(400).json({ success: false, message: 'Payment verification failed' });
    }

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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
// 6. PAYMENT SUCCESS PAGE
// ----------------------------------------
app.get('/payment-success', (req, res) => {
  res.send(`
    <html>
      <head><title>Payment Successful</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px">
        <h1>✅ Payment Successful!</h1>
        <p>Thank you for your order.</p>
        <p>Payment ID: ${req.query.razorpay_payment_id || ''}</p>
        <a href="https://www.overstockbay.com">Continue Shopping</a>
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
