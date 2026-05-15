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
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + endpoint, {
    method: method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
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
      
      const notes = payment.notes || {};
      const orderId = 'OSB' + Date.now();
      
      let customerAddress = {};
      try {
        const addressData = await razorpay.orders.fetch(payment.order_id);
        if (addressData.customer_details && addressData.customer_details.shipping_address) {
          customerAddress = addressData.customer_details.shipping_address;
        }
      } catch (e) {
        console.log('Could not fetch address:', e.message);
      }
      
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
      
      await sendWhatsAppNotification(orderData, itemData).catch(e => console.error('WhatsApp failed:', e.message));
      await sendCustomerEmail(orderData, itemData).catch(e => console.error('Customer email failed:', e.message));
      await sendAdminEmail(orderData, itemData).catch(e => console.error('Admin email failed:', e.message));
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 3. WHATSAPP NOTIFICATION
// ----------------------------------------
async function sendWhatsAppNotification(order, item) {
  console.log('WhatsApp notification for order:', order.order_id);
  console.log('Product:', item.product_name, 'Amount:', order.order_amount);
}

// ----------------------------------------
// 4. CUSTOMER EMAIL (Brevo)
// ----------------------------------------
async function sendCustomerEmail(order, item) {
  if (!order.customer_email || order.customer_email === 'void@razorpay.com') {
    console.log('No valid customer email');
    return;
  }

  const emailHtml = 'Order Confirmed!Hi ' + (order.customer_name || 'Customer') + '!Thank you for your order.Order ID' + order.order_id + 'Product' + item.product_name + 'Quantity' + item.quantity + 'AmountRs.' + order.order_amount + 'Shipping Address:' + (order.customer_address || '') + ', ' + (order.customer_city || '') + ', ' + (order.customer_state || '') + ' - ' + (order.customer_pincode || '') + 'Track Your Order';

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Overstockbay', email: process.env.EMAIL_USER },
      to: [{ email: order.customer_email }],
      subject: 'Order Confirmed #' + order.order_id + ' - Overstockbay',
      htmlContent: emailHtml
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

  const emailHtml = 'New Order Received!Order ID' + order.order_id + 'Product' + item.product_name + 'AmountRs.' + order.order_amount + 'Customer' + (order.customer_name || 'N/A') + 'Phone' + order.customer_phone + 'Address' + (order.customer_address || '') + ', ' + (order.customer_city || '') + '';

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Overstockbay Orders', email: process.env.EMAIL_USER },
      to: [{ email: process.env.ADMIN_EMAIL }],
      subject: 'New Order Rs.' + order.order_amount + ' - ' + order.order_id,
      htmlContent: emailHtml
    })
  });

  if (!response.ok) {
    throw new Error('Brevo API error: ' + await response.text());
  }
  console.log('Admin email sent');
}

// ----------------------------------------
// 6. TRACK ORDER
// ----------------------------------------
app.post('/track-order', async (req, res) => {
  try {
    const { phone, email } = req.body;
    
    let query = 'orders?select=*,order_items(*)';
    if (phone) {
      query += '&customer_phone=eq.' + phone;
    } else if (email) {
      query += '&customer_email=eq.' + email.toLowerCase();
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
    const orderId = req.params.orderId;
    const orders = await supabaseQuery('orders?order_id=eq.' + orderId + '&select=*,order_items(*)', 'GET');
    
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
    
    const orders = await supabaseQuery('orders?order_id=eq.' + order_id + '&customer_phone=eq.' + phone, 'GET');
    
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found or phone does not match' });
    }
    
    const order = orders[0];
    
    const orderDate = new Date(order.created_at);
    const now = new Date();
    const daysDiff = Math.floor((now - orderDate) / (1000 * 60 * 60 * 24));
    
    if (daysDiff > 7) {
      return res.status(400).json({ error: 'Return window expired. Returns allowed within 7 days only.' });
    }
    
    const existingReturns = await supabaseQuery('returns?order_id=eq.' + order_id, 'GET');
    if (existingReturns.length > 0) {
      return res.status(400).json({ error: 'Return already requested for this order' });
    }
    
    const returnData = {
      order_id: order_id,
      return_reason: reason,
      return_description: description || '',
      return_status: 'requested',
      refund_amount: order.order_amount,
      refund_status: 'pending'
    };
    
    const savedReturn = await supabaseQuery('returns', 'POST', returnData);
    await supabaseQuery('orders?order_id=eq.' + order_id, 'PATCH', { order_status: 'return_requested' });
    
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
    const status = req.query.status;
    
    let query = 'orders?select=*,order_items(*),returns(*)&order=created_at.desc';
    
    if (status) {
      query += '&order_status=eq.' + status;
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
    
    await supabaseQuery('orders?order_id=eq.' + order_id, 'PATCH', updateData);
    
    res.json({ success: true, message: 'Order updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 11. ADMIN - PROCESS RETURN
// ----------------------------------------
app.post('/admin/process-return', async (req, res) => {
  try {
    const { order_id, action } = req.body;
    
    if (action === 'approve') {
      await supabaseQuery('returns?order_id=eq.' + order_id, 'PATCH', {
        return_status: 'approved',
        approved_at: new Date().toISOString()
      });
      await supabaseQuery('orders?order_id=eq.' + order_id, 'PATCH', { order_status: 'return_approved' });
    } else {
      await supabaseQuery('returns?order_id=eq.' + order_id, 'PATCH', { return_status: 'rejected' });
      await supabaseQuery('orders?order_id=eq.' + order_id, 'PATCH', { order_status: 'return_rejected' });
    }
    
    res.json({ success: true, message: 'Return ' + action + 'd' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// 12. ADMIN - PROCESS REFUND
// ----------------------------------------
app.post('/admin/process-refund', async (req, res) => {
  try {
    const { order_id } = req.body;
    
    const orders = await supabaseQuery('orders?order_id=eq.' + order_id, 'GET');
    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orders[0];
    
    const refund = await razorpay.payments.refund(order.razorpay_payment_id, {
      amount: order.order_amount * 100,
      notes: { reason: 'Customer return request' }
    });
    
    await supabaseQuery('returns?order_id=eq.' + order_id, 'PATCH', {
      refund_status: 'completed',
      refunded_at: new Date().toISOString()
    });
    await supabaseQuery('orders?order_id=eq.' + order_id, 'PATCH', { order_status: 'refunded' });
    
    res.json({ success: true, refund: refund });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// PROMOTIONS
// ----------------------------------------
app.post('/get-promotions', async (req, res) => {
  res.json({
    promotions: [
      { code: "WELCOME10", summary: "10% off on first order", description: "Get 10% off" },
      { code: "FLAT100", summary: "Flat Rs.100 off above Rs.999", description: "Flat Rs.100 off" }
    ]
  });
});

app.post('/apply-promotions', async (req, res) => {
  const { code } = req.body;
  const coupons = {
    "WELCOME10": { value: 10, value_type: "percentage", description: "10% off applied" },
    "FLAT100": { value: 10000, value_type: "fixed_amount", description: "Rs.100 off applied" }
  };
  if (coupons[code]) {
    res.json({ promotion: { reference_id: code, code: code, type: "coupon", value: coupons[code].value, value_type: coupons[code].value_type, description: coupons[code].description } });
  } else {
    res.status(400).json({ success: false, error: "Invalid coupon" });
  }
});

// ----------------------------------------
// SHIPPING INFO
// ----------------------------------------
app.post('/shipping-info', async (req, res) => {
  try {
    const addresses = req.body.addresses || [];
    res.json({
      addresses: addresses.map(function(addr) {
        return {
          id: addr.id,
          zipcode: addr.zipcode,
          country: addr.country || 'IN',
          serviceable: true,
          cod: true,
          shipping_methods: [
            { id: "standard", name: "Standard Delivery (5-7 days)", description: "5-7 business days", serviceable: true, shipping_fee: 0, cod: true, cod_fee: 5000 },
            { id: "express", name: "Express Delivery (2-3 days)", description: "2-3 business days", serviceable: true, shipping_fee: 10000, cod: true, cod_fee: 5000 }
          ]
        };
      })
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------
// PAYMENT SUCCESS
// ----------------------------------------
app.all('/payment-success', (req, res) => {
  const body = req.body || {};
  const query = req.query || {};
  const paymentId = body.razorpay_payment_id || query.razorpay_payment_id || '';
  const orderId = body.razorpay_order_id || query.razorpay_order_id || '';
  res.redirect('https://www.overstockbay.com?payment=success&payment_id=' + paymentId + '&order_id=' + orderId);
});

// ----------------------------------------
// ADMIN DASHBOARD
// ----------------------------------------
app.get('/admin', (req, res) => {
  const html = '<meta><meta><title>Admin - Overstockbay</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f3f4f6;min-height:100vh}.header{background:#000;color:#fff;padding:20px 30px;display:flex;justify-content:space-between;align-items:center}.header h1{font-size:22px}.refresh-btn{background:#16a34a;border:none;color:#fff;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:600}.container{max-width:1400px;margin:0 auto;padding:20px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-bottom:20px}.stat-card{background:#fff;padding:20px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}.stat-card h3{color:#6b7280;font-size:13px;margin-bottom:5px}.stat-card .value{font-size:28px;font-weight:700}.green{color:#16a34a}.blue{color:#2563eb}.orange{color:#ea580c}.red{color:#dc2626}.filters{background:#fff;padding:15px;border-radius:12px;margin-bottom:20px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}.filters select,.filters input{padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px}.filters button{padding:10px 20px;background:#000;color:#fff;border:none;border-radius:8px;cursor:pointer}.orders-table{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)}table{width:100%;border-collapse:collapse}th{background:#f9fafb;padding:12px;text-align:left;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb}td{padding:12px;border-bottom:1px solid #f3f4f6;font-size:14px}.status{display:inline-block;padding:4px 10px;border-radius:15px;font-size:11px;font-weight:600}.status.confirmed{background:#dbeafe;color:#1d4ed8}.status.processing{background:#fef3c7;color:#b45309}.status.shipped{background:#e0e7ff;color:#4338ca}.status.delivered{background:#d1fae5;color:#059669}.status.return_requested{background:#fee2e2;color:#dc2626}.action-btn{padding:5px 10px;border:none;border-radius:5px;cursor:pointer;font-size:11px;margin-right:3px}.action-btn.view{background:#e0e7ff;color:#4338ca}.action-btn.update{background:#d1fae5;color:#059669}.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);justify-content:center;align-items:center;z-index:1000}.modal.active{display:flex}.modal-content{background:#fff;padding:25px;border-radius:12px;max-width:500px;width:90%;max-height:80vh;overflow-y:auto}.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px}.close-btn{background:none;border:none;font-size:24px;cursor:pointer}.detail-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3f4f6}.detail-row label{color:#6b7280}.detail-row span{font-weight:600}.info-box{background:#f9fafb;padding:12px;border-radius:8px;margin:12px 0}.info-box h4{margin-bottom:8px;font-size:14px}.status-select{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;margin:12px 0}.modal-actions{display:flex;gap:10px;margin-top:15px}.modal-actions button{flex:1;padding:10px;border:none;border-radius:8px;font-weight:600;cursor:pointer}.btn-primary{background:#000;color:#fff}.btn-secondary{background:#f3f4f6;color:#374151}@media(max-width:768px){.stats{grid-template-columns:repeat(2,1fr)}}</style>Overstockbay Admin<button>Refresh</button>Total RevenueRs.0Total Orders0Pending0Returns0<select>All StatusConfirmedProcessingShippedDeliveredReturn Requested</select><input><button>SearchOrder IDCustomerProductAmountStatusDateActionsLoading orders...Order Details<button>x<script>var BACKEND="https://razorpay-magic-backend.onrender.com";var allOrders=[];async function loadOrders(){try{var status=document.getElementById("statusFilter").value;var url=BACKEND+"/admin/orders";if(status)url+="?status="+status;var response=await fetch(url);var data=await response.json();if(data.success){allOrders=data.orders||[];renderOrders();updateStats()}}catch(e){document.getElementById("ordersBody").innerHTML="<tr><td colspan=7 style=text-align:center;padding:40px>Error loading</td></tr>"}}function renderOrders(){var search=document.getElementById("searchInput").value.toLowerCase();var filtered=allOrders.filter(function(o){if(!search)return true;return o.order_id.toLowerCase().includes(search)||(o.customer_phone&&o.customer_phone.includes(search))});if(filtered.length===0){document.getElementById("ordersBody").innerHTML="<tr><td colspan=7 style=text-align:center;padding:40px>No orders found</td></tr>";return}var html="";for(var i=0;i<filtered.length;i++){var o=filtered[i];var items=o.order_items||[];var product=items.length>0?items[0].product_name:"N/A";var date=new Date(o.created_at).toLocaleDateString("en-IN");html+="<tr><td><strong>"+o.order_id+"</strong></td><td>"+(o.customer_name||"N/A")+"<br><small>"+(o.customer_phone||"")+"</small></td><td>"+product+"</td><td><strong>Rs."+o.order_amount+"</strong></td><td><span class=status\\ "+o.order_status+">"+o.order_status.replace(/_/g," ")+"</span></td><td>"+date+"</td><td><button class=\"action-btn view\" onclick=\"viewOrder('"+o.order_id+"')\" >View</button><button class=\"action-btn update\" onclick=\"updateStatus('"+o.order_id+"')\" >Update</button></td></tr>"}document.getElementById("ordersBody").innerHTML=html}function updateStats(){var total=0,pending=0,returns=0;for(var i=0;i<allOrders.length;i++){total+=parseFloat(allOrders[i].order_amount||0);if(["confirmed","processing","shipped"].includes(allOrders[i].order_status))pending++;if(allOrders[i].order_status.includes("return"))returns++}document.getElementById("totalRevenue").textContent="Rs."+total.toLocaleString("en-IN");document.getElementById("totalOrders").textContent=allOrders.length;document.getElementById("pendingOrders").textContent=pending;document.getElementById("returnOrders").textContent=returns}function viewOrder(id){var o=allOrders.find(function(x){return x.order_id===id});if(!o)return;var items=o.order_items||[];var html="<div class=detail-row><label>Order ID</label><span>"+o.order_id+"</span></div><div class=detail-row><label>Status</label><span class=\"status "+o.order_status+"\">"+o.order_status+"</span></div><div class=detail-row><label>Amount</label><span class=green>Rs."+o.order_amount+"</span></div><div class=info-box><h4>Product</h4>";for(var i=0;i<items.length;i++){html+="<div class=detail-row><label>"+items[i].product_name+"</label><span>Qty: "+items[i].quantity+"</span></div>"}html+="</div><div class=info-box><h4>Customer</h4><div class=detail-row><label>Name</label><span>"+(o.customer_name||"N/A")+"</span></div><div class=detail-row><label>Phone</label><span>"+(o.customer_phone||"N/A")+"</span></div><div class=detail-row><label>Email</label><span>"+(o.customer_email||"N/A")+"</span></div><div class=detail-row><label>Address</label><span>"+(o.customer_address||"")+" "+(o.customer_city||"")+" "+(o.customer_pincode||"")+"</span></div></div><div class=modal-actions><button class=btn-secondary onclick=closeModal()>Close</button></div>";document.getElementById("modalTitle").textContent="Order Details";document.getElementById("modalBody").innerHTML=html;document.getElementById("orderModal").classList.add("active")}function updateStatus(id){var o=allOrders.find(function(x){return x.order_id===id});if(!o)return;var html="<div class=detail-row><label>Order ID</label><span>"+o.order_id+"</span></div><div class=detail-row><label>Current</label><span class=\"status "+o.order_status+"\">"+o.order_status+"</span></div><select class=status-select id=newStatus><option value=confirmed>Confirmed</option><option value=processing>Processing</option><option value=shipped>Shipped</option><option value=delivered>Delivered</option></select><div class=modal-actions><button class=btn-secondary onclick=closeModal()>Cancel</button><button class=btn-primary onclick=\"saveStatus('"+id+"')\" >Update</button></div>";document.getElementById("modalTitle").textContent="Update Status";document.getElementById("modalBody").innerHTML=html;document.getElementById("newStatus").value=o.order_status;document.getElementById("orderModal").classList.add("active")}async function saveStatus(id){var status=document.getElementById("newStatus").value;await fetch(BACKEND+"/admin/update-order",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({order_id:id,status:status})});alert("Updated!");closeModal();loadOrders()}function closeModal(){document.getElementById("orderModal").classList.remove("active")}loadOrders();</script>';
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ----------------------------------------
// HEALTH CHECK
// ----------------------------------------
app.get('/', (req, res) => {
  res.send('Overstockbay Backend Running');
});

// ----------------------------------------
// START SERVER
// ----------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
