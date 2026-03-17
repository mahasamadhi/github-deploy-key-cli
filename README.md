# deploy-key-setup

Automated GitHub deploy key setup. Generates SSH keys and configures deploy keys via the GitHub API.

## What it does

1. **Generates SSH keys** for each repository (`~/.ssh/<name>_ed25519`)
2. **Creates SSH config** with host aliases (`Host github.com-<name>`)
3. **Adds GitHub to known_hosts** (prevents first-connect prompts)
4. **Adds deploy keys to GitHub** via API (requires a Personal Access Token)

After setup, you can clone private repos using:
```bash
git clone git@github.com-myapp:myorg/my-repo.git
```

## Installation

```bash
npm install
```

Or install globally:
```bash
npm install -g .
```

## CLI Usage

### Quick Start

```bash
# Create a config file
deploy-key-setup init

# Edit repos-config.json with your repos and token

# Run setup
deploy-key-setup setup -c repos-config.json
```

### Commands

#### `setup` - Set up deploy keys

```bash
# From config file
deploy-key-setup setup -c ./repos-config.json

# With token from command line
deploy-key-setup setup -c ./repos-config.json -t ghp_xxxx

# Interactive mode (prompts for everything)
deploy-key-setup setup

# Custom SSH directory
deploy-key-setup setup -c ./repos-config.json -s /home/ubuntu/.ssh

# Verbose output
deploy-key-setup setup -c ./repos-config.json -v
```

**Options:**
| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file |
| `-t, --token <token>` | GitHub personal access token |
| `-s, --ssh-dir <path>` | SSH directory (default: `~/.ssh`) |
| `-v, --verbose` | Enable verbose output |

#### `init` - Create example config

```bash
deploy-key-setup init
deploy-key-setup init -o ./my-config.json
```

#### `verify` - Check repository access

```bash
deploy-key-setup verify -c ./repos-config.json
```

#### `actions-setup` - Set up GitHub Actions SSH access to EC2

Generates an SSH keypair on your EC2 server, adds the public key to `authorized_keys`, and uploads the private key (plus optional host/user info) as encrypted GitHub Actions secrets on one or more repos.

```bash
# With config file + EC2 details
deploy-key-setup actions-setup -c ./repos-config.json --host 52.6.132.60 --user ubuntu

# With token from command line
deploy-key-setup actions-setup -t ghp_xxxx --host 52.6.132.60 --user ubuntu

# Custom key name
deploy-key-setup actions-setup -c ./repos-config.json --key-name my-deploy-key --host 52.6.132.60 --user ubuntu

# Interactive mode (prompts for repos, host, user)
deploy-key-setup actions-setup

# Verbose output
deploy-key-setup actions-setup -c ./repos-config.json --host 52.6.132.60 --user ubuntu -v
```

**Options:**
| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to config file |
| `-t, --token <token>` | GitHub personal access token |
| `-s, --ssh-dir <path>` | SSH directory (default: `~/.ssh`) |
| `-k, --key-name <name>` | SSH key filename (default: `github-actions-deploy`) |
| `--host <host>` | EC2 host/IP to store as `EC2_HOST` secret |
| `--user <user>` | EC2 user to store as `EC2_USER` secret |
| `-v, --verbose` | Enable verbose output |

**What it does:**
1. Generates `~/.ssh/github-actions-deploy` keypair (ed25519) on the EC2 server
2. Appends the public key to `~/.ssh/authorized_keys` so GitHub Actions can SSH in
3. Encrypts the private key using the repo's Actions public key (libsodium sealed box)
4. Uploads `EC2_SSH_KEY` as an encrypted secret to each repo via the GitHub API
5. Optionally uploads `EC2_HOST` and `EC2_USER` as secrets

**What gets created where:**
| Location | What |
|----------|------|
| EC2: `~/.ssh/github-actions-deploy` | Private key (stays on server) |
| EC2: `~/.ssh/github-actions-deploy.pub` | Public key |
| EC2: `~/.ssh/authorized_keys` | Public key appended here |
| GitHub: repo > Settings > Secrets | `EC2_SSH_KEY`, `EC2_HOST`, `EC2_USER` |

**Example GitHub Actions workflow using the secrets:**
```yaml
name: Deploy to EC2

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to EC2
        run: |
          echo "${{ secrets.EC2_SSH_KEY }}" > key.pem
          chmod 600 key.pem
          ssh -i key.pem -o StrictHostKeyChecking=no \
            ${{ secrets.EC2_USER }}@${{ secrets.EC2_HOST }} \
            "cd /app && git pull && npm install && pm2 restart all"

      - name: Cleanup
        if: always()
        run: rm -f key.pem
```

**GitHub token requirements for `actions-setup`:**

Your PAT needs these scopes to manage Actions secrets:
- Classic token: `repo` scope
- Fine-grained token: `Secrets` (read/write) + `Actions` (read/write) permissions on the target repos

#### `cert-setup` - Request ACM certificate with Route 53 DNS validation

Requests an ACM certificate for your apex domain + www subdomain, sets up DNS validation CNAME records in Route 53, waits for the certificate to be issued, and prints the ARN so you can paste it into CloudFormation.

```bash
# Basic usage
deploy-key-setup cert-setup --domain storage-bot.com

# Specify region (default: us-east-1)
deploy-key-setup cert-setup --domain storage-bot.com --region us-east-1

# Verbose output
deploy-key-setup cert-setup --domain storage-bot.com -v
```

**Options:**
| Option | Description |
|--------|-------------|
| `-d, --domain <domain>` | Apex domain (required, e.g. `storage-bot.com`) |
| `-r, --region <region>` | AWS region (default: `us-east-1`) |
| `-v, --verbose` | Enable verbose output |

**What it does (in order):**
1. Checks if an ACM certificate already exists for the domain — skips request if found
2. Requests a new ACM certificate for `storage-bot.com` and `www.storage-bot.com` with DNS validation
3. Polls ACM until the DNS validation records are available
4. Finds the Route 53 hosted zone matching the domain
5. Upserts the CNAME validation records into Route 53
6. Polls ACM every 15 seconds until the certificate status becomes `ISSUED` (10 minute timeout)
7. Prints the certificate ARN for use in CloudFormation

**Expected output:**
```
i Checking for existing certificate for storage-bot.com...
i No existing certificate found.
i Requesting certificate for storage-bot.com and www.storage-bot.com...
+ Certificate requested: arn:aws:acm:us-east-1:123456789:certificate/abc-123
i Finding Route 53 hosted zone for storage-bot.com...
+ Found hosted zone: Z1234567890ABC
i Adding DNS validation records to Route 53...
+ Added 2 validation record(s) to Route 53
i Waiting for certificate validation (this may take a few minutes)...
.......
+ Certificate issued!

============================================
Certificate ARN (paste into CloudFormation):
arn:aws:acm:us-east-1:123456789:certificate/abc-123
============================================
```

**AWS credentials:**

Uses the standard AWS credential chain (`fromNodeProviderChain`), which automatically picks up:
- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- `AWS_PROFILE` with SSO or credential files
- EC2 instance role (if running on EC2)

**Error handling:**
- No hosted zone found → `"No hosted zone found for storage-bot.com — is this domain in Route 53?"`
- Certificate stuck pending > 10 minutes → timeout with message to check Route 53 manually
- Certificate enters `FAILED` state → prints the failure reason from ACM and exits

**IAM permissions needed:**
```json
{
  "Effect": "Allow",
  "Action": [
    "acm:ListCertificates",
    "acm:RequestCertificate",
    "acm:DescribeCertificate",
    "route53:ListHostedZones",
    "route53:ChangeResourceRecordSets"
  ],
  "Resource": "*"
}
```

## Configuration File

Create a `repos-config.json`:

```json
{
  "personalAccessToken": "ghp_xxxxxxxxxxxx",
  "repos": [
    {
      "name": "backend",
      "org": "myorg",
      "repo": "backend-api",
      "keyType": "ed25519",
      "readOnly": true
    },
    {
      "name": "frontend",
      "org": "myorg",
      "repo": "frontend-app",
      "keyType": "ed25519",
      "readOnly": true
    }
  ]
}
```

### Config Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `personalAccessToken` | Yes | - | GitHub PAT with `repo` scope |
| `repos` | Yes | - | Array of repository configs |
| `repos[].name` | Yes | - | Short alias (used in SSH config) |
| `repos[].org` | Yes | - | GitHub organization or username |
| `repos[].repo` | Yes | - | Repository name |
| `repos[].keyType` | No | `ed25519` | SSH key type (`ed25519` or `rsa`) |
| `repos[].readOnly` | No | `true` | Whether deploy key is read-only |

## Module Usage

Use programmatically in your own scripts:

```javascript
const { setupDeployKeys } = require('deploy-key-setup');

async function main() {
  const results = await setupDeployKeys({
    token: process.env.GITHUB_TOKEN,
    sshDir: '/home/ubuntu/.ssh',
    repos: [
      { name: 'backend', org: 'myorg', repo: 'backend-api' },
      { name: 'frontend', org: 'myorg', repo: 'frontend-app' }
    ],
    verbose: true
  });

  console.log('Success:', results.success);
  console.log('Keys generated:', results.keys);
  console.log('Deploy keys added:', results.deployKeys);
}

main();
```

### Exported Functions

#### `setupDeployKeys(options)`

Full setup: generates keys, config, known_hosts, and adds deploy keys to GitHub.

```javascript
const results = await setupDeployKeys({
  token: 'ghp_xxx',           // Required: GitHub PAT
  repos: [...],               // Required: Array of repo configs
  sshDir: '~/.ssh',           // Optional: SSH directory
  keyType: 'ed25519',         // Optional: Default key type
  verbose: false              // Optional: Verbose logging
});
```

Returns:
```javascript
{
  success: true,              // Overall success
  keys: [...],                // Key generation results
  config: { success: true },  // SSH config result
  knownHosts: { success: true },
  deployKeys: [...]           // GitHub deploy key results
}
```

#### `setupActionsAccess(options)`

Full setup: generates keypair, adds to authorized_keys, and uploads secrets to GitHub Actions.

```javascript
const { setupActionsAccess } = require('deploy-key-setup');

const results = await setupActionsAccess({
  token: 'ghp_xxx',                    // Required: GitHub PAT
  repos: [                             // Required: repos to receive secrets
    { org: 'myorg', repo: 'my-app' }
  ],
  ec2Host: '52.6.132.60',              // Optional: stored as EC2_HOST secret
  ec2User: 'ubuntu',                   // Optional: stored as EC2_USER secret
  keyName: 'github-actions-deploy',    // Optional: key filename
  sshDir: '~/.ssh',                    // Optional: SSH directory
  verbose: false                       // Optional: verbose logging
});
```

Returns:
```javascript
{
  success: true,
  key: { name: 'github-actions-deploy', success: true, keyPath: '...', created: true },
  secrets: [
    { success: true, name: 'my-app', secretName: 'EC2_SSH_KEY' },
    { success: true, name: 'my-app', secretName: 'EC2_HOST' },
    { success: true, name: 'my-app', secretName: 'EC2_USER' }
  ]
}
```

#### `setupCert(options)`

Request ACM certificate and set up DNS validation.

```javascript
const { setupCert } = require('deploy-key-setup');

const results = await setupCert({
  domain: 'storage-bot.com',    // Required: apex domain
  region: 'us-east-1',          // Optional: AWS region
  verbose: false                // Optional: verbose logging
});

console.log(results.certificateArn);
// arn:aws:acm:us-east-1:123456789:certificate/abc-123
```

Returns:
```javascript
{
  success: true,
  certificateArn: 'arn:aws:acm:us-east-1:123456789:certificate/abc-123'
}
```

#### `verifyRepoAccess(token, repos)`

Check if token has access to repositories.

```javascript
const results = await verifyRepoAccess('ghp_xxx', [
  { name: 'app', org: 'myorg', repo: 'my-repo' }
]);
```

#### `generateKeys(repos, options)`

Generate SSH keys only (no GitHub interaction).

```javascript
const results = generateKeys(
  [{ name: 'app', org: 'myorg', repo: 'my-repo' }],
  { sshDir: '/tmp/.ssh' }
);
```

## GitHub Token

Create a Personal Access Token at: https://github.com/settings/tokens

Required scopes:
- `repo` (Full control of private repositories)

Or for fine-grained tokens:
- Repository access: Select specific repos
- Permissions: `Administration` (read/write) for deploy keys

## After Setup

Once setup completes, clone repositories using the host alias:

```bash
# Instead of:
git clone git@github.com:myorg/backend-api.git

# Use:
git clone git@github.com-backend:myorg/backend-api.git
```

The alias routes through the correct SSH key automatically.

## Files Created

### `setup` command
| File | Description |
|------|-------------|
| `~/.ssh/<name>_ed25519` | Private key |
| `~/.ssh/<name>_ed25519.pub` | Public key |
| `~/.ssh/config` | SSH config (appended) |
| `~/.ssh/known_hosts` | GitHub host keys (appended) |

### `actions-setup` command
| File | Description |
|------|-------------|
| `~/.ssh/github-actions-deploy` | Private key for Actions |
| `~/.ssh/github-actions-deploy.pub` | Public key |
| `~/.ssh/authorized_keys` | Public key appended here |

## Getting This Tool onto Your EC2

### SCP from Windows

From PowerShell:

```powershell
scp -i $env:USERPROFILE\.ssh\bf-apps-key.pem -r "C:\Users\bfica\IdeaProjects\github-deploy-key-cli" ubuntu@52.6.132.60:~/
```

Then SSH in and install:

```powershell
ssh -i $env:USERPROFILE\.ssh\bf-apps-key.pem ubuntu@52.6.132.60
cd ~/github-deploy-key-cli
npm install
```

## EC2 Setup Script

Once the tool is on your EC2:

```bash
#!/bin/bash
# Run on EC2 after copying/cloning deploy-key-setup

# Install Node.js (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Run setup
cd ~/deploy-key-setup
export GITHUB_TOKEN="ghp_xxxx"
node bin/cli.js setup -c repos-config.json

# Now clone your private repos
cd ~
git clone git@github.com-backend:myorg/backend-api.git
git clone git@github.com-frontend:myorg/frontend-app.git
```

### One-liner (after tool is on EC2)

```bash
cd ~/deploy-key-setup && GITHUB_TOKEN="ghp_xxx" node bin/cli.js setup -c repos-config.json
```

## Troubleshooting

### "Permission denied (publickey)"

- Verify the deploy key was added: `GitHub repo > Settings > Deploy keys`
- Check SSH config: `cat ~/.ssh/config`
- Test connection: `ssh -T git@github.com-<name>`

### "Key is already in use"

Deploy keys are unique per-repo. If you see this:
- The key already exists on GitHub (setup continues normally)
- Or the same key is used on another repo (generate a new key)

### Token scope errors

Ensure your token has the `repo` scope. Test with:
```bash
deploy-key-setup verify -c repos-config.json
```

## License

MIT
