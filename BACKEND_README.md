# 🍋 Lemons Leads Backend API

A Node.js/Express backend for handling waitlist form submissions with email notifications and data storage.

## 🚀 Features

- **Form Processing**: Handles waitlist submissions with validation
- **Email Notifications**: Sends welcome emails to new signups
- **Data Storage**: SQLite database for storing submissions
- **Security**: Rate limiting, CORS, and input validation
- **Admin Panel**: Protected endpoint to view submissions
- **Health Monitoring**: Health check endpoint

## 📋 Requirements

- Node.js 16+ 
- npm or yarn
- Gmail account for sending emails

## 🛠️ Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Copy `env.example` to `.env` and configure:

```bash
cp env.example .env
```

Edit `.env` with your settings:
```env
# Email Configuration
EMAIL_USER=alex@lemonsleads.co.uk
EMAIL_PASS=your-gmail-app-password

# Admin Access
ADMIN_KEY=your-secure-admin-key-here

# Server Configuration
PORT=3000
```

### 3. Gmail App Password Setup
1. Enable 2-factor authentication on your Gmail account
2. Generate an App Password:
   - Go to Google Account settings
   - Security → 2-Step Verification → App passwords
   - Generate password for "Mail"
   - Use this password in `EMAIL_PASS`

### 4. Start the Server
```bash
# Development mode (auto-restart on changes)
npm run dev

# Production mode
npm start
```

## 📡 API Endpoints

### POST `/api/waitlist`
Submit a new waitlist entry.

**Request Body:**
```json
{
  "name": "John Doe",
  "email": "john@company.com",
  "company": "Company Name",
  "biggest_challenge": "follow-up"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Successfully joined waitlist",
  "id": 1
}
```

### GET `/api/waitlist/count`
Get total number of waitlist signups.

**Response:**
```json
{
  "count": 7
}
```

### GET `/api/admin/waitlist`
View all waitlist submissions (requires admin key).

**Headers:**
```
x-admin-key: your-admin-key
```

### GET `/api/health`
Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "database": "connected"
}
```

## 🗄️ Database

The backend automatically creates a SQLite database (`waitlist.db`) with the following schema:

```sql
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  company TEXT NOT NULL,
  biggest_challenge TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT
);
```

## 📧 Email Templates

The backend sends professional welcome emails with:
- Personalized greeting
- 50% discount confirmation
- Next steps timeline
- Company branding
- Contact information

## 🔒 Security Features

- **Input Validation**: All form fields are validated
- **Duplicate Prevention**: Email addresses must be unique
- **Rate Limiting**: Prevents spam submissions
- **CORS Protection**: Configurable cross-origin requests
- **Helmet Security**: HTTP security headers
- **Admin Authentication**: Protected admin endpoints

## 🚀 Deployment

### Local Development
```bash
npm run dev
# Server runs on http://localhost:3000
```

### Production Deployment
1. Set environment variables
2. Use PM2 or similar process manager:
```bash
npm install -g pm2
pm2 start server.js --name "lemons-leads"
pm2 startup
pm2 save
```

### Environment Variables
- `PORT`: Server port (default: 3000)
- `EMAIL_USER`: Gmail address
- `EMAIL_PASS`: Gmail app password
- `ADMIN_KEY`: Secret key for admin access

## 📊 Monitoring

### Logs
The server logs:
- Database connections
- Form submissions
- Email confirmations
- Errors and warnings

### Health Checks
Monitor `/api/health` endpoint for:
- Server status
- Database connectivity
- Timestamp information

## 🐛 Troubleshooting

### Common Issues

1. **Email not sending**
   - Check Gmail app password
   - Verify 2FA is enabled
   - Check email credentials in `.env`

2. **Database errors**
   - Ensure write permissions in project directory
   - Check SQLite installation

3. **Port conflicts**
   - Change `PORT` in `.env`
   - Check if port 3000 is available

### Debug Mode
Enable detailed logging by setting:
```env
NODE_ENV=development
```

## 📞 Support

For backend issues, check:
1. Server logs in terminal
2. Database file permissions
3. Environment variable configuration
4. Network connectivity

## 🔄 Updates

To update the backend:
```bash
git pull origin main
npm install
npm restart
```

---

Built with ❤️ for Lemons Leads
