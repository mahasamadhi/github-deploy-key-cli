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

| File | Description |
|------|-------------|
| `~/.ssh/<name>_ed25519` | Private key |
| `~/.ssh/<name>_ed25519.pub` | Public key |
| `~/.ssh/config` | SSH config (appended) |
| `~/.ssh/known_hosts` | GitHub host keys (appended) |

## Getting This Tool onto Your EC2

### Option 1: SCP from Windows (recommended for private tool)

From your Windows machine (PowerShell or Git Bash):

```bash
# Copy the entire folder to EC2
scp -i ~/.ssh/your-ec2-key.pem -r ./deploy-key-setup ubuntu@YOUR_EC2_IP:~/

# Or copy just the essential files (smaller transfer)
scp -i ~/.ssh/your-ec2-key.pem -r ./deploy-key-setup/src ./deploy-key-setup/bin ./deploy-key-setup/package.json ubuntu@YOUR_EC2_IP:~/deploy-key-setup/
```

Then SSH in and install:

```bash
ssh -i ~/.ssh/your-ec2-key.pem ubuntu@YOUR_EC2_IP
cd ~/deploy-key-setup
npm install
```

### Option 2: Git clone (if repo is on GitHub)

```bash
ssh -i ~/.ssh/your-ec2-key.pem ubuntu@YOUR_EC2_IP
git clone https://github.com/yourorg/deploy-key-setup.git
cd deploy-key-setup
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
