# deploy-key-setup

CLI tools for EC2 deployment setup: GitHub deploy keys, Actions SSH access, and ACM certificates.

## Where to Run Each Command

| Command | Run where | Why |
|---------|-----------|-----|
| `deploy-keys` | **On the EC2** | Generates SSH keys on the server that needs to clone repos |
| `actions-ssh` | **On the EC2** | Generates keypair on the server and adds public key to `authorized_keys` |
| `acm-cert` | Anywhere with AWS creds | Only talks to AWS APIs, no local files needed |
| `verify-token` | Anywhere with network | Checks your PAT can access each repo (run before `deploy-keys`) |
| `verify-ssh` | **On the EC2** | Tests SSH connections to GitHub through deploy keys (run after `deploy-keys`) |

## Getting It onto Your EC2

**Package and transfer:**
```bash
npm pack                        # creates deploy-key-setup-1.0.0.tgz
scp deploy-key-setup-1.0.0.tgz ubuntu@<ec2-ip>:~/
```

**Install on the server:**
```bash
ssh ubuntu@<ec2-ip>
sudo npm install -g deploy-key-setup-1.0.0.tgz
deploy-key-setup <command>      # available globally
```

If Node.js isn't installed yet:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

---

## `deploy-keys` — Deploy Keys for Cloning Private Repos

> **Run this on the EC2 server.** It generates SSH keys locally on the machine that needs to clone.

Generates per-repo SSH keys and registers them as GitHub deploy keys so you can `git clone` private repos.

**Prerequisites:** GitHub PAT with `repo` scope ([create one here](https://github.com/settings/tokens))

**Config file** (`repos-config.json`):
```json
{
  "personalAccessToken": "ghp_xxxxxxxxxxxx",
  "actionsToken": "ghp_yyyyyyyyyyyy",
  "repos": [
    { "name": "backend", "org": "myorg", "repo": "backend-api", "keyType": "ed25519", "readOnly": true },
    { "name": "frontend", "org": "myorg", "repo": "frontend-app", "keyType": "ed25519", "readOnly": true }
  ]
}
```

**Token scopes:**

| Token | Used by | Required scopes |
|-------|---------|-----------------|
| `personalAccessToken` | `deploy-keys`, `verify-token` | `repo` |
| `actionsToken` | `actions-ssh` | `repo`, `admin:repo` (for Actions secrets) |

**Run:**
```bash
deploy-key-setup generate-config                          # generates example repos-config.json
deploy-key-setup deploy-keys -c repos-config.json         # or just: deploy-key-setup deploy-keys (interactive)
```

**Then clone with:**
```bash
git clone git@github.com-backend:myorg/backend-api.git
git clone git@github.com-frontend:myorg/frontend-app.git
```

**Creates:** `~/.ssh/<name>_ed25519`, `~/.ssh/config` entries, `~/.ssh/known_hosts`

---

## `actions-ssh` — GitHub Actions SSH Access to EC2

> **Run this on the EC2 server.** It generates the keypair locally and adds the public key to this machine's `authorized_keys`.

Generates an SSH keypair, adds the public key to `authorized_keys`, and uploads the private key as an encrypted GitHub Actions secret (`EC2_SSH_KEY`) so workflows can SSH in.

**Prerequisites:** GitHub PAT with `repo` + `admin:repo` scopes (uses `actionsToken` from config)

**Run:**
```bash
deploy-key-setup actions-ssh -c repos-config.json --host 52.6.132.60 --user ubuntu
```

Or interactive: `deploy-key-setup actions-ssh`

| Option | Description |
|--------|-------------|
| `--host <ip>` | Sets `EC2_HOST` secret |
| `--user <user>` | Sets `EC2_USER` secret |
| `--key-name <name>` | Key filename (default: `github-actions-deploy`) |

**Creates on EC2:** `~/.ssh/github-actions-deploy`, appends to `~/.ssh/authorized_keys`
**Creates on GitHub:** `EC2_SSH_KEY`, `EC2_HOST`, `EC2_USER` secrets

**Use in a workflow:**
```yaml
- name: Deploy to EC2
  run: |
    echo "${{ secrets.EC2_SSH_KEY }}" > key.pem
    chmod 600 key.pem
    ssh -i key.pem -o StrictHostKeyChecking=no \
      ${{ secrets.EC2_USER }}@${{ secrets.EC2_HOST }} \
      "cd /app && git pull && npm install && pm2 restart all"
    rm -f key.pem
```

---

## `acm-cert` — ACM Certificate with Route 53 DNS Validation

> Run anywhere with AWS credentials (local machine, EC2, CI — doesn't matter).

Requests an ACM certificate (apex + www), creates DNS validation records in Route 53, waits for it to be issued, and prints the ARN for CloudFormation.

**Prerequisites:** AWS credentials configured (env vars, `AWS_PROFILE`, or EC2 instance role). IAM needs `acm:ListCertificates`, `acm:RequestCertificate`, `acm:DescribeCertificate`, `route53:ListHostedZones`, `route53:ChangeResourceRecordSets`.

**Run:**
```bash
deploy-key-setup acm-cert --domain storage-bot.com
```

**Output:**
```
+ Certificate issued!

============================================
Certificate ARN (paste into CloudFormation):
arn:aws:acm:us-east-1:123456789:certificate/abc-123
============================================
```

Skips automatically if a certificate already exists. Times out after 10 minutes if validation doesn't complete.

---

## `verify-token` — Check PAT Access (Pre-Check)

Run before `deploy-keys` to confirm your token can see each repo:
```bash
deploy-key-setup verify-token -c repos-config.json
```

---

## `verify-ssh` — Test SSH Connections (Post-Check)

Run after `deploy-keys` to confirm SSH clone access works end-to-end:
```bash
deploy-key-setup verify-ssh -c repos-config.json
```
