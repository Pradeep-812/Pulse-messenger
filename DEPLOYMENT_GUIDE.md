# 🚀 Pulse Messenger — Production DevOps & Deployment Guide

This guide covers complete production deployment with **PM2** (Process Manager), **NGINX** (Reverse Proxy & SSL Termination), and **Let's Encrypt (Certbot)** for free automated SSL certificates.

---

## 1. Prerequisites (Ubuntu / Debian Server)

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js (v20+ or v22 LTS)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx git

# Verify installations
node -v
npm -v
nginx -v
```

---

## 2. Deploy Code & Install Dependencies

```bash
# Clone or copy Pulse Messenger into /var/www/pulse-messenger
cd /var/www/pulse-messenger

# Install production dependencies
npm install --production

# Install PM2 globally
sudo npm install -g pm2
```

---

## 3. Environment Variables Configuration

Create `/var/www/pulse-messenger/.env`:
```env
PORT=3000
NODE_ENV=production
JWT_SECRET=your_super_secret_production_key_here_at_least_32_characters
ENCRYPTION_KEY=your_aes_256_hex_key_here
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key
VAPID_SUBJECT=mailto:admin@yourdomain.com
```

---

## 4. Run Pulse with PM2 (24/7 Zero Downtime)

```bash
# Create logs directory
mkdir -p logs

# Start using ecosystem configuration
pm2 start ecosystem.config.js

# Save process list for system reboot auto-start
pm2 save

# Setup PM2 startup script on system boot
sudo pm2 startup
```

Useful PM2 Commands:
- `pm2 status`: View application status & memory usage
- `pm2 logs pulse-messenger`: Stream real-time logs
- `pm2 restart pulse-messenger`: Graceful restart
- `pm2 reload pulse-messenger`: Zero-downtime cluster reload

---

## 5. NGINX Reverse Proxy Setup

1. Copy the provided NGINX configuration:
   ```bash
   sudo cp nginx/pulse.conf /etc/nginx/sites-available/pulse.conf
   ```
2. Replace `pulse.yourdomain.com` with your actual domain in `/etc/nginx/sites-available/pulse.conf`.
3. Enable the site and test configuration:
   ```bash
   sudo ln -s /etc/nginx/sites-available/pulse.conf /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

---

## 6. Free SSL Certificate with Let's Encrypt (Certbot)

Point your domain's DNS **A Record** to your server IP address, then run:

```bash
sudo certbot --nginx -d pulse.yourdomain.com
```

Certbot will automatically verify domain ownership, generate SSL certificates, and configure automatic 90-day renewal!

Test auto-renewal:
```bash
sudo certbot renew --dry-run
```

---

## 7. Firewall (UFW) Security

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Your production Pulse Messenger instance is now live, encrypted with HTTPS/WSS, protected by rate limiting and automated spam filters, and managed 24/7 by PM2!
