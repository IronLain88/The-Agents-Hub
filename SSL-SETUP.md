# SSL Setup for The-Agents-Hub

## Option 1: Let's Encrypt (Recommended - Free)

### 1. Install Certbot
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install certbot python3-certbot-nginx

# Or use snap
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
```

### 2. Obtain Certificate
```bash
# Standalone mode (nginx must be stopped temporarily)
sudo certbot certonly --standalone -d the-agents.net -d www.the-agents.net

# Or use nginx plugin (nginx stays running)
sudo certbot --nginx -d the-agents.net -d www.the-agents.net
```

### 3. Update nginx.conf
Replace these lines in nginx.conf:
```nginx
ssl_certificate /etc/letsencrypt/live/the-agents.net/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/the-agents.net/privkey.pem;
```

### 4. Auto-renewal (Certbot handles this)
Test renewal:
```bash
sudo certbot renew --dry-run
```

---

## Option 2: Cloudflare Origin Certificates (If using Cloudflare)

### 1. Generate Origin Certificate in Cloudflare Dashboard
- SSL/TLS → Origin Server → Create Certificate
- Choose "Let Cloudflare generate a private key and a CSR"
- Save the certificate and private key

### 2. Place files on server
```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/the-agents.net.pem      # Paste certificate
sudo nano /etc/ssl/cloudflare/the-agents.net.key      # Paste private key
sudo chmod 600 /etc/ssl/cloudflare/*.key
```

### 3. Update nginx.conf
```nginx
ssl_certificate /etc/ssl/cloudflare/the-agents.net.pem;
ssl_certificate_key /etc/ssl/cloudflare/the-agents.net.key;
```

---

## Option 3: Self-Signed (Testing only)

```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/the-agents.net.key \
  -out /etc/ssl/certs/the-agents.net.crt \
  -subj "/CN=the-agents.net"
```

Then update nginx.conf:
```nginx
ssl_certificate /etc/ssl/certs/the-agents.net.crt;
ssl_certificate_key /etc/ssl/private/the-agents.net.key;
```

---

## Apply Configuration

```bash
# Test nginx config
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx

# Or restart
sudo systemctl restart nginx
```

## Verify

```bash
# Check if nginx is listening
sudo ss -tlnp | grep 443

# Test HTTPS connection
curl -I https://the-agents.net
```
