const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting - More lenient for development
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 20 : 1000, // 20 in production, 1000 in development
  message: 'Too many requests from this IP, please try again later.',
  skipSuccessfulRequests: true, // Don't count successful requests
  skipFailedRequests: false // Do count failed requests
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
}));
app.use(cors());
app.use(limiter);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files
app.use(express.static('.'));

// Database setup
const db = new sqlite3.Database('./waitlist.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database');
    createTable();
  }
});

// Create waitlist table
function createTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      company TEXT NOT NULL,
      plan TEXT,
      biggest_challenge TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT
    )
  `;
  
  db.run(sql, (err) => {
    if (err) {
      console.error('Error creating table:', err.message);
    } else {
      console.log('Waitlist table ready');
    }
  });
}

// Database utility functions
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Enhanced input validation
function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function sanitizeInput(input) {
  return input.trim().replace(/[<>]/g, '');
}

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'alex@lemonsleads.co.uk',
    pass: process.env.EMAIL_PASS || 'your-app-password'
  }
});

// Waitlist submission endpoint
app.post('/api/waitlist', async (req, res) => {
  try {
    const { name, email, phone, company, plan, biggest_challenge } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    // Enhanced validation
    if (!name || !email || !company || !biggest_challenge) {
      return res.status(400).json({ 
        error: 'Name, email, company, and biggest challenge are required',
        missing: []
      });
    }

    // Check field lengths
    if (name.length > 100 || email.length > 100 || (phone && phone.length > 20) || company.length > 100 || (plan && plan.length > 50) || biggest_challenge.length > 500) {
      return res.status(400).json({ 
        error: 'Field lengths exceed maximum allowed' 
      });
    }

    // Enhanced email validation
    if (!validateEmail(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format' 
      });
    }

    // Sanitize inputs
    const sanitizedName = sanitizeInput(name);
    const sanitizedEmail = sanitizeInput(email);
    const sanitizedPhone = phone ? sanitizeInput(phone) : null;
    const sanitizedCompany = sanitizeInput(company);
    const sanitizedPlan = plan ? sanitizeInput(plan) : null;
    const sanitizedChallenge = sanitizeInput(biggest_challenge);

    // Check if email already exists
    const existingUser = await dbGet('SELECT id FROM waitlist WHERE email = ?', [sanitizedEmail]);
    if (existingUser) {
      return res.status(409).json({ 
        error: 'Email already registered' 
      });
    }

    // Insert new waitlist entry
    const result = await dbRun(
      `INSERT INTO waitlist (name, email, phone, company, plan, biggest_challenge, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sanitizedName, sanitizedEmail, sanitizedPhone, sanitizedCompany, sanitizedPlan, sanitizedChallenge, ip, userAgent]
    );

    // Send confirmation email
    await sendConfirmationEmail(sanitizedName, sanitizedEmail, sanitizedCompany);

    // Log submission
    console.log(`New waitlist signup: ${sanitizedName} (${sanitizedEmail}) from ${sanitizedCompany}`);

    res.status(201).json({ 
      success: true, 
      message: 'Successfully joined waitlist',
      id: result.id
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ 
      error: 'Internal server error' 
    });
  }
});

// Get waitlist count
app.get('/api/waitlist/count', async (req, res) => {
  try {
    const row = await dbGet('SELECT COUNT(*) as count FROM waitlist');
    res.json({ count: row.count });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Stripe Payment Link Creation
app.post('/api/create-payment-link', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }
  
  try {
    const { priceId, quantity = 1, metadata = {} } = req.body;
    
    if (!priceId) {
      return res.status(400).json({ error: 'Price ID is required' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: quantity,
      }],
      mode: 'subscription',
      success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/cancel.html`,
      metadata: metadata,
    });

    res.json({ 
      success: true, 
      sessionId: session.id,
      url: session.url 
    });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ 
      error: 'Failed to create payment link',
      details: error.message 
    });
  }
});

// Stripe Webhook Handler
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }
  
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('Payment successful:', session.id);
      // Handle successful payment - you can add logic here
      break;
    case 'customer.subscription.created':
      const subscription = event.data.object;
      console.log('Subscription created:', subscription.id);
      break;
    case 'customer.subscription.updated':
      const updatedSubscription = event.data.object;
      console.log('Subscription updated:', updatedSubscription.id);
      break;
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// Get Stripe publishable key
app.get('/api/stripe-key', (req, res) => {
  res.json({ 
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY 
  });
});

// Send confirmation email
async function sendConfirmationEmail(name, email, company) {
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER || 'alex@lemonsleads.co.uk',
      to: email,
      subject: '🍋 Welcome to the Lemons Leads Waitlist!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #FFD700;">🍋 Welcome to the Waitlist!</h1>
          <p>Hi ${name},</p>
          <p>Thanks for joining the Lemons Leads waitlist! You're now one of only 10 spots available.</p>
          
          <h2 style="color: #F4C2C2;">What happens next?</h2>
          <ul>
            <li><strong>Within 24 hours:</strong> You'll receive your 50% discount code</li>
            <li><strong>This week:</strong> Free lead nurture template</li>
            <li><strong>Next week:</strong> Launch date announcement</li>
          </ul>
          
          <p><strong>Company:</strong> ${company}</p>
          <p><strong>Your spot:</strong> Reserved ✅</p>
          
          <p style="background: #FFD700; color: #F4C2C2; padding: 15px; border-radius: 8px; text-align: center;">
            <strong>You're saving £97/month when we launch!</strong>
          </p>
          
          <p>Questions? Reply to this email or contact alex@lemonsleads.co.uk</p>
          
          <p>Best regards,<br>Alex Townend<br>Lemons Leads</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`Confirmation email sent to ${email}`);
  } catch (error) {
    console.error('Email error:', error);
  }
}

// Admin endpoint to view submissions (protected)
app.get('/api/admin/waitlist', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rows = await dbAll('SELECT * FROM waitlist ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin dashboard stats endpoint
app.get('/api/admin/stats', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get total count
    const totalCount = await dbGet('SELECT COUNT(*) as count FROM waitlist');
    
    // Get count by plan
    const planStats = await dbAll(`
      SELECT plan, COUNT(*) as count 
      FROM waitlist 
      WHERE plan IS NOT NULL 
      GROUP BY plan
    `);
    
    // Get recent submissions (last 7 days)
    const recentSubmissions = await dbAll(`
      SELECT COUNT(*) as count 
      FROM waitlist 
      WHERE created_at >= datetime('now', '-7 days')
    `);
    
    // Get top companies
    const topCompanies = await dbAll(`
      SELECT company, COUNT(*) as count 
      FROM waitlist 
      GROUP BY company 
      ORDER BY count DESC 
      LIMIT 5
    `);

    res.json({
      total: totalCount.count,
      byPlan: planStats,
      recent7Days: recentSubmissions[0].count,
      topCompanies: topCompanies,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Admin export endpoint (CSV)
app.get('/api/admin/export', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rows = await dbAll('SELECT * FROM waitlist ORDER BY created_at DESC');
    
    // Convert to CSV format
    const csvHeaders = ['ID', 'Name', 'Email', 'Phone', 'Company', 'Plan', 'Biggest Challenge', 'Created At', 'IP Address'];
    const csvRows = rows.map(row => [
      row.id,
      `"${row.name}"`,
      `"${row.email}"`,
      `"${row.phone || ''}"`,
      `"${row.company}"`,
      `"${row.plan || ''}"`,
      `"${row.biggest_challenge}"`,
      row.created_at,
      row.ip_address || ''
    ].join(','));
    
    const csvContent = [csvHeaders.join(','), ...csvRows].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waitlist-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csvContent);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    database: 'connected'
  });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve admin dashboard
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Serve test page
app.get('/test', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

// Serve simple test page
app.get('/simple-test', (req, res) => {
  res.sendFile(path.join(__dirname, 'simple-test.html'));
});

// Serve thank you page
app.get('/thank-you.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'thank-you.html'));
});

// Also serve thanks.html (for compatibility)
app.get('/thanks.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'thank-you.html'));
});

// Serve success page
app.get('/thank-you-success.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'thank-you-success.html'));
});

// Serve payment page
app.get('/payment.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'payment.html'));
});

// Serve success page
app.get('/success.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'success.html'));
});

// Serve cancel page
app.get('/cancel.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'cancel.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🍋 Lemons Leads backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Waitlist endpoint: http://localhost:${PORT}/api/waitlist`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database connection closed');
    }
    process.exit(0);
  });
});
