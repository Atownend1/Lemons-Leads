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

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

// Security middleware
app.use(helmet());
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
      company TEXT NOT NULL,
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
    const { name, email, company, biggest_challenge } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    // Validation
    if (!name || !email || !company || !biggest_challenge) {
      return res.status(400).json({ 
        error: 'All fields are required' 
      });
    }

    if (!email.includes('@')) {
      return res.status(400).json({ 
        error: 'Invalid email format' 
      });
    }

    // Check if email already exists
    db.get('SELECT id FROM waitlist WHERE email = ?', [email], (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ 
          error: 'Database error' 
        });
      }

      if (row) {
        return res.status(409).json({ 
          error: 'Email already registered' 
        });
      }

      // Insert new waitlist entry
      const sql = `
        INSERT INTO waitlist (name, email, company, biggest_challenge, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      
      db.run(sql, [name, email, company, biggest_challenge, ip, userAgent], function(err) {
        if (err) {
          console.error('Insert error:', err);
          return res.status(500).json({ 
            error: 'Failed to save submission' 
          });
        }

        // Send confirmation email
        sendConfirmationEmail(name, email, company);

        // Log submission
        console.log(`New waitlist signup: ${name} (${email}) from ${company}`);

        res.status(201).json({ 
          success: true, 
          message: 'Successfully joined waitlist',
          id: this.lastID
        });
      });
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ 
      error: 'Internal server error' 
    });
  }
});

// Get waitlist count
app.get('/api/waitlist/count', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM waitlist', (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ count: row.count });
  });
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
app.get('/api/admin/waitlist', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  db.all('SELECT * FROM waitlist ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
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
