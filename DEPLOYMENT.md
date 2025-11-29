# RistoManager AI - Deployment Guide

This guide explains how to deploy your RistoManager AI backend to Railway.

## Prerequisites

1. **Railway Account** - Sign up at [railway.app](https://railway.app)
2. **GitHub Account** - Your repository linked to GitHub
3. **Environment Variables** - Required API keys and database configuration

## Environment Variables Required

Set the following environment variables in Railway:

```
DATABASE_URL=postgresql://user:password@host:port/database
NODE_ENV=production
GEMINI_API_KEY=your_api_key_from_google
PORT=3000
```

### Getting Your Variables

**DATABASE_URL:**
- Railway will automatically create a PostgreSQL database
- Copy the connection string from Railway's PostgreSQL plugin
- Format: `postgresql://username:password@host:port/dbname`

**GEMINI_API_KEY:**
- Get from [Google AI Studio](https://aistudio.google.com/app/apikey)
- Click "Create API Key"
- Copy the key to Railway environment variables

## Deployment Options

### Option 1: Deploy from GitHub (Recommended)

1. **Connect GitHub Repository**
   - Go to [railway.app](https://railway.app/dashboard)
   - Click "Create New Project"
   - Select "Deploy from GitHub repo"
   - Authorize Railway to access your GitHub account
   - Select your `ristomanager-ai` repository

2. **Configure Services**
   - Railway will auto-detect the Dockerfile
   - Click the project → "Add" → Select "PostgreSQL"
   - This creates a database instance

3. **Set Environment Variables**
   - Go to your project settings
   - Click "Variables"
   - Add all variables from the list above
   - For `DATABASE_URL`, Railway will auto-populate this when you add PostgreSQL

4. **Deploy**
   - Railway auto-deploys on push to main branch
   - Check the "Deployments" tab for logs
   - Once deployed, you'll get a public URL

### Option 2: Deploy from CLI

1. **Install Railway CLI**
   ```bash
   npm i -g @railway/cli
   ```

2. **Login to Railway**
   ```bash
   railway login
   ```

3. **Initialize Project**
   ```bash
   railway init
   ```
   - Select your project or create a new one
   - Choose to add PostgreSQL database

4. **Set Environment Variables**
   ```bash
   railway variables set DATABASE_URL "postgresql://..."
   railway variables set GEMINI_API_KEY "your_key"
   railway variables set NODE_ENV "production"
   ```

5. **Deploy**
   ```bash
   railway up
   ```
   - This builds and deploys your application

### Option 3: Manual Docker Deployment

1. **Build Docker Image**
   ```bash
   docker build -t ristomanager:latest .
   ```

2. **Push to Docker Registry**
   ```bash
   # Login to your registry (Docker Hub, GitHub Container Registry, etc.)
   docker tag ristomanager:latest your-registry/ristomanager:latest
   docker push your-registry/ristomanager:latest
   ```

3. **Deploy to Railway**
   - Use Railway's "Deploy from Image" option
   - Provide the image URL and environment variables

## Local Testing with Docker

Test your setup locally before deploying:

```bash
# Build and run with docker-compose
docker-compose up

# The app will be available at http://localhost:3000
# PostgreSQL will be running on localhost:5432
```

## Post-Deployment

### Verify Deployment

1. Check the deployment logs in Railway dashboard
2. Test your API endpoints:
   ```bash
   curl https://your-deployed-url/reservations
   ```

3. Check database connection:
   - Go to PostgreSQL plugin in Railway
   - Verify it has created the schema (tables should exist)

### Database Management

1. **Backup Database**
   - Use Railway's built-in backup feature
   - Or use `pg_dump`:
     ```bash
     pg_dump "your_database_url" > backup.sql
     ```

2. **Access Database**
   - Use Railway's database explorer
   - Or connect via PostgreSQL client:
     ```bash
     psql "your_database_url"
     ```

## Troubleshooting

### App Won't Start

**Check logs:**
- Go to Railway project → "Logs" tab
- Look for error messages

**Common issues:**
- `DATABASE_URL` not set or incorrect format
- `GEMINI_API_KEY` missing
- PostgreSQL not initialized yet (wait a few minutes)

### Database Connection Failed

- Verify `DATABASE_URL` format: `postgresql://user:pass@host:port/db`
- Check if PostgreSQL service is running in Railway
- Ensure database is created (auto-created on first schema run)

### Port Issues

- Railway automatically assigns a port (usually 3000)
- Don't hardcode port 3000; use `process.env.PORT || 3000`
- Current code uses port 3000 directly - consider updating server.ts

## Monitoring

### View Logs
```bash
railway logs -s ristomanager
```

### Check Status
- Go to Railway dashboard
- See real-time logs and metrics
- Monitor CPU and memory usage

### Auto-Scaling
- Railway's paid plans support auto-scaling
- Configure in project settings → "Deploy"

## Updating Your App

1. **Make changes locally**
   ```bash
   git add .
   git commit -m "your message"
   git push origin main
   ```

2. **Railway auto-deploys** (if connected to GitHub)
   - No manual deployment needed
   - Check "Deployments" tab to see progress

## Custom Domain

1. Go to project settings → "Domains"
2. Click "Add Domain"
3. Enter your custom domain
4. Update DNS records with provided values
5. Wait for SSL certificate (usually within minutes)

## Cost Estimates

**Railway Pricing (as of 2024):**
- Node.js app: Included in free tier (3GB RAM + 100GB bandwidth)
- PostgreSQL: Free tier includes 1 database with 5GB storage
- Paid plans start at $5/month

## API Endpoints

After deployment, your backend will have these endpoints:

**Reservations:**
- `GET /reservations` - Get all reservations
- `POST /reservations` - Create reservation
- `PUT /reservations/:id` - Update reservation
- `DELETE /reservations/:id` - Delete reservation

**Tables:**
- `GET /tables` - Get all tables
- `POST /tables` - Create table
- `PUT /tables/:id` - Update table
- `DELETE /tables/:id` - Delete table

**Rooms:**
- `GET /rooms` - Get all rooms
- `POST /rooms` - Create room
- `DELETE /rooms/:id` - Delete room

**Dishes:**
- `GET /dishes` - Get all dishes
- `POST /dishes` - Create dish
- `DELETE /dishes/:id` - Delete dish

**Banquet Menus:**
- `GET /banquet-menus` - Get all menus
- `POST /banquet-menus` - Create menu
- `PUT /banquet-menus/:id` - Update menu
- `DELETE /banquet-menus/:id` - Delete menu

## Support

- **Railway Docs:** https://docs.railway.app
- **Railway Discord:** https://discord.gg/railway
- **Your Project Issues:** Check GitHub repository

---

**Happy deploying!** 🚀
