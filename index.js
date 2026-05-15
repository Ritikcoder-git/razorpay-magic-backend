const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Supabase Setup
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function supabaseQuery(endpoint, method, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method: method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : undefined
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return response.json();
}

// ----------------------------------------
// 1. CREATE ORDER
// ----------------------------------------
app.post('/create-order', async (req, res) => {
  try {
    const { amount, product_name, product_sku, product_image, quantity, variant, size, color } = req.body;
    
    const order = await razorpay.orders.create({
      amount: amount,
      currency: 'INR',
      receipt: 'rcpt_' + Date.now(),
      notes: {
        product_name: product_name || 'Product',
        product_sku: product_sku || 'SKU001',
        product_image: product_image || '',
        quantity: quantity || 1,
        variant: variant || '',
        size: size || '',
        color: color || ''
      }
    });
    
    res.json({ success: true, order_id: order.id, amount: order.amount });
  } catch (error) {
    console.error('Create order error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------
// 2. WEBHOOK - Payment Received
// ----------------------------------------
app.post('/webhook', async (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());
    console.log('Webhook received:', event.event);

    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      const payment = event.payload.payment ? event.payload.payment.entity : event.payload.order.entity;
      
      console.log('Processing payment:', payment.id);
      
      // Extract product details from notes
      const notes = payment.notes || {};
      
      // Generate order ID
      const orderId = 'OSB' + Date.now();
      
      // Get customer address from Razorpay
      let customerAddress = {};
      try {
        const addressData = await razorpay.orders.fetch(payment.order_id);
        if (addressData.customer_details && addressData.customer_details.shipping_address) {
          customerAddress = addressData.customer_details.shipping_address;
        }
      } catch (e) {
        console.log('Could not fetch address:', e.message);
      }
      
      // Save order to Supabase
      const orderData = {
        order_id: orderId,
        razorpay_payment_id: payment.id,
        razorpay_order_id: payment.order_id,
        customer_name: customerAddress.name || payment.notes?.customer_name || '',
        customer_email: payment.email || '',
        customer_phone: payment.contact || '',
        customer_address: customerAddress.line1 || '',
        customer_city: customerAddress.city || '',
        customer_state: customerAddress.state || '',
        customer_pincode: customerAddress.zipcode || '',
        order_amount: payment.amount / 100,
        order_status: 'confirmed',
        payment_status: 'paid',
        payment_method: payment.method || 'online'
      };
      
      const savedOrder = await supabaseQuery('orders', 'POST', orderData);
      console.log('Order saved:', savedOrder);
      
      // Save order items
      const itemData = {
        order_id: orderId,
        product_name: notes.product_name || 'Product',
        product_sku: notes.product_sku || '',
        product_image: notes.product_image || '',
        product_variant: notes.variant || '',
        product_size: notes.size || '',
        product_color: notes.color || '',
        quantity: parseInt(notes.quantity) || 1,
        price: payment.amount / 100
      };
      
      const savedItem = await supabaseQuery('order_items', 'POST', itemData);
      console.log('Order item saved:', savedItem);
      
      // Send WhatsApp notification (Zoho SalesIQ)
      await sendWhatsAppNotification(orderData, itemData).catch(e => 
        console.error('WhatsApp failed:', e.message)
      );
      
      // Send email notifications
      await sendCustomerEmail(orderData, itemData).catch(e => 
        console.error('Customer email failed:', e.message)
      );
      
      await sendAdminEmail(orderData, itemData).catch(e => 
        console.error('Admin email failed:', e.message)
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 3. WHATSAPP NOTIFICATION (Zoho SalesIQ)
// ----------------------------------------
async function sendWhatsAppNotification(order, item) {
  // We'll configure this with Zoho SalesIQ API
  console.log('WhatsApp notification for order:', order.order_id);
  
  // Placeholder - will add Zoho SalesIQ integration
  // For now, log the message that would be sent
  const message = `
🛍️ *Order Confirmed!*

Order ID: ${order.order_id}
Product: ${item.product_name}
Amount: ₹${order.order_amount}

Thank you for shopping with Overstockbay!

Track your order: https://www.overstockbay.com/track-order
  `;
  console.log('WhatsApp message:', message);
}

// ----------------------------------------
// 4. CUSTOMER EMAIL (Brevo)
// ----------------------------------------
async function sendCustomerEmail(order, item) {
  if (!order.customer_email || order.customer_email === 'void@razorpay.com') {
    console.log('No valid customer email');
    return;
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Overstockbay', email: process.env.EMAIL_USER },
      to: [{ email: order.customer_email }],
      subject: '✅ Order Confirmed #' + order.order_id + ' - Overstockbay',
      htmlContent: `
        
          
            Order Confirmed! ✅
          
          
            Hi ${order.customer_name || 'Customer'}!
            Thank you for your order. Here are the details:
            
            
              
                
                  Order ID
                  ${order.order_id}
                
                
                  Product
                  ${item.product_name}
                
                
                  Quantity
                  ${item.quantity}
                
                
                  Amount Paid
                  ₹${order.order_amount}
                
              
            
            
            
              📦 Shipping Address:
              ${order.customer_address}, ${order.customer_city}, ${order.customer_state} - ${order.customer_pincode}
            
            
            
              
                Track Your Order →
              
            
            
            
              Questions? Reply to this email or WhatsApp us!
            
          
        
      `
    })
  });

  if (!response.ok) {
    throw new Error('Brevo API error: ' + await response.text());
  }
  console.log('Customer email sent to:', order.customer_email);
}

// ----------------------------------------
// 5. ADMIN EMAIL
// ----------------------------------------
async function sendAdminEmail(order, item) {
  if (!process.env.ADMIN_EMAIL) return;

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Overstockbay Orders', email: process.env.EMAIL_USER },
      to: [{ email: process.env.ADMIN_EMAIL }],
      subject: '🛍️ New Order ₹' + order.order_amount + ' - ' + order.order_id,
      htmlContent: `
        
          
            New Order Received! 🛍️
          
          
            
            
              Order Details
              
                
                  Order ID
                  ${order.order_id}
                
                
                  Product
                  ${item.product_name}
                
                
                  Quantity
                  ${item.quantity}
                
                
                  Amount
                  ₹${order.order_amount}
                
              
            
            
            
              Customer Details
              
                
                  Name
                  ${order.customer_name || 'Not provided'}
                
                
                  Phone
                  ${order.customer_phone}
                
                
                  Email
                  ${order.customer_email}
                
                
                  Address
                  ${order.customer_address}, ${order.customer_city}, ${order.customer_state} - ${order.customer_pincode}
                
              
            
            
          
        
      `
    })
  });

  if (!response.ok) {
    throw new Error('Brevo API error: ' + await response.text());
  }
  console.log('Admin email sent');
}

// ----------------------------------------
// 6. TRACK ORDER (Customer)
// ----------------------------------------
app.post('/track-order', async (req, res) => {
  try {
    const { phone, email } = req.body;
    
    let query = 'orders?select=*,order_items(*)';
    if (phone) {
      query += `&customer_phone=eq.${phone}`;
    } else if (email) {
      query += `&customer_email=eq.${email.toLowerCase()}`;
    } else {
      return res.status(400).json({ error: 'Phone or email required' });
    }
    
    query += '&order=created_at.desc';
    
    const orders = await supabaseQuery(query, 'GET');
    res.json({ success: true, orders: orders });
  } catch (error) {
    console.error('Track order error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 7. GET ORDER DETAILS
// ----------------------------------------
app.get('/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const orders = await supabaseQuery(`orders?order_id=eq.${orderId}&select=*,order_items(*)`, 'GET');
    
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    res.json({ success: true, order: orders[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 8. REQUEST RETURN
// ----------------------------------------
app.post('/request-return', async (req, res) => {
  try {
    const { order_id, phone, reason, description } = req.body;
    
    // Verify order belongs to this phone
    const orders = await supabaseQuery(`orders?order_id=eq.${order_id}&customer_phone=eq.${phone}`, 'GET');
    
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found or phone does not match' });
    }
    
    const order = orders[0];
    
    // Check if within 7 days
    const orderDate = new Date(order.created_at);
    const now = new Date();
    const daysDiff = Math.floor((now - orderDate) / (1000 * 60 * 60 * 24));
    
    if (daysDiff > 7) {
      return res.status(400).json({ error: 'Return window expired. Returns allowed within 7 days only.' });
    }
    
    // Check if already returned
    const existingReturns = await supabaseQuery(`returns?order_id=eq.${order_id}`, 'GET');
    if (existingReturns.length > 0) {
      return res.status(400).json({ error: 'Return already requested for this order' });
    }
    
    // Create return request
    const returnData = {
      order_id: order_id,
      return_reason: reason,
      return_description: description || '',
      return_status: 'requested',
      refund_amount: order.order_amount,
      refund_status: 'pending'
    };
    
    const savedReturn = await supabaseQuery('returns', 'POST', returnData);
    
    // Update order status
    await supabaseQuery(`orders?order_id=eq.${order_id}`, 'PATCH', { order_status: 'return_requested' });
    
    // Notify admin
    await sendAdminReturnAlert(order, reason).catch(e => console.error('Return alert failed:', e.message));
    
    res.json({ success: true, return: savedReturn });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 9. ADMIN - GET ALL ORDERS
// ----------------------------------------
app.get('/admin/orders', async (req, res) => {
  try {
    const { status, date_from, date_to } = req.query;
    
    let query = 'orders?select=*,order_items(*),returns(*)&order=created_at.desc';
    
    if (status) {
      query += `&order_status=eq.${status}`;
    }
    
    const orders = await supabaseQuery(query, 'GET');
    res.json({ success: true, orders: orders });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 10. ADMIN - UPDATE ORDER STATUS
// ----------------------------------------
app.post('/admin/update-order', async (req, res) => {
  try {
    const { order_id, status } = req.body;
    
    const updateData = { order_status: status, updated_at: new Date().toISOString() };
    
    if (status === 'shipped') {
      updateData.shipped_at = new Date().toISOString();
    } else if (status === 'delivered') {
      updateData.delivered_at = new Date().toISOString();
    }
    
    await supabaseQuery(`orders?order_id=eq.${order_id}`, 'PATCH', updateData);
    
    // Get order details for notification
    const orders = await supabaseQuery(`orders?order_id=eq.${order_id}`, 'GET');
    if (orders.length > 0) {
      await sendStatusUpdateWhatsApp(orders[0], status).catch(e => console.error('WhatsApp update failed:', e.message));
    }
    
    res.json({ success: true, message: 'Order updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 11. ADMIN - APPROVE/REJECT RETURN
// ----------------------------------------
app.post('/admin/process-return', async (req, res) => {
  try {
    const { order_id, action } = req.body; // action: 'approve' or 'reject'
    
    if (action === 'approve') {
      await supabaseQuery(`returns?order_id=eq.${order_id}`, 'PATCH', {
        return_status: 'approved',
        approved_at: new Date().toISOString()
      });
      await supabaseQuery(`orders?order_id=eq.${order_id}`, 'PATCH', { order_status: 'return_approved' });
    } else {
      await supabaseQuery(`returns?order_id=eq.${order_id}`, 'PATCH', { return_status: 'rejected' });
      await supabaseQuery(`orders?order_id=eq.${order_id}`, 'PATCH', { order_status: 'return_rejected' });
    }
    
    res.json({ success: true, message: `Return ${action}d` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 12. ADMIN - PROCESS REFUND
// ----------------------------------------
app.post('/admin/process-refund', async (req, res) => {
  try {
    const { order_id, payment_id } = req.body;
    
    // Get order details
    const orders = await supabaseQuery(`orders?order_id=eq.${order_id}`, 'GET');
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orders[0];
    
    // Process refund through Razorpay
    const refund = await razorpay.payments.refund(order.razorpay_payment_id, {
      amount: order.order_amount * 100,
      notes: { reason: 'Customer return request' }
    });
    
    // Update database
    await supabaseQuery(`returns?order_id=eq.${order_id}`, 'PATCH', {
      refund_status: 'completed',
      refunded_at: new Date().toISOString()
    });
    await supabaseQuery(`orders?order_id=eq.${order_id}`, 'PATCH', { order_status: 'refunded' });
    
    res.json({ success: true, refund: refund });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// HELPER: Send Status Update WhatsApp
// ----------------------------------------
async function sendStatusUpdateWhatsApp(order, status) {
  const messages = {
    'shipped': `📦 Your order ${order.order_id} has been shipped! Track: https://www.overstockbay.com/track-order`,
    'out_for_delivery': `🚚 Your order ${order.order_id} is out for delivery today!`,
    'delivered': `✅ Your order ${order.order_id} has been delivered. Thank you for shopping!`,
    'return_approved': `✅ Return approved for order ${order.order_id}. Refund will be processed soon.`,
    'return_rejected': `❌ Return request for order ${order.order_id} was not approved.`
  };
  
  console.log('WhatsApp status update:', messages[status] || `Order ${order.order_id} status: ${status}`);
}

// ----------------------------------------
// HELPER: Send Admin Return Alert
// ----------------------------------------
async function sendAdminReturnAlert(order, reason) {
  if (!process.env.ADMIN_EMAIL) return;
  
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Overstockbay Returns', email: process.env.EMAIL_USER },
      to: [{ email: process.env.ADMIN_EMAIL }],
      subject: '⚠️ Return Requested - ' + order.order_id,
      htmlContent: `
        
          Return Request Received
          Order ID: ${order.order_id}
          Customer: ${order.customer_name} (${order.customer_phone})
          Amount: ₹${order.order_amount}
          Reason: ${reason}
          Go to Admin Dashboard
        
      `
    })
  });
  console.log('Admin return alert sent');
}

// ----------------------------------------
// SHIPPING & PROMOTIONS (Keep existing)
// ----------------------------------------
app.post('/get-promotions', async (req, res) => {
  res.json({
    promotions: [
      { code: "WELCOME10", summary: "10% off on first order", description: "Get 10% off" },
      { code: "FLAT100", summary: "Flat ₹100 off above ₹999", description: "Flat ₹100 off" }
    ]
  });
});

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

app.all('/payment-success', (req, res) => {
  const body = req.body || {};
  const query = req.query || {};
  const paymentId = body.razorpay_payment_id || query.razorpay_payment_id || '';
  const orderId = body.razorpay_order_id || query.razorpay_order_id || '';
  res.redirect('https://www.overstockbay.com?payment=success&payment_id=' + paymentId + '&order_id=' + orderId);
});

// ----------------------------------------
// HEALTH CHECK
// ----------------------------------------
app.get('/', (req, res) => {
  res.send('Overstockbay Backend Running ✅');
});

// ----------------------------------------
// START SERVER
// ----------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
