const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

class SSHService {
  static VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;

  constructor(config) {
    this.sshDir = config.sshDir || path.join(require('os').homedir(), '.ssh');
    this.keyType = config.keyType || 'ed25519';
    this.ensureSSHDirectory();
  }

  static validateRepoName(name) {
    if (!name || !SSHService.VALID_NAME_RE.test(name)) {
      throw new Error(
        `Invalid repo name "${name}": only alphanumeric characters, hyphens, and underscores are allowed`
      );
    }
  }

  ensureSSHDirectory() {
    if (!fs.existsSync(this.sshDir)) {
      fs.mkdirSync(this.sshDir, { recursive: true, mode: 0o700 });
      logger.success(`Created SSH directory: ${this.sshDir}`);
    }
  }

  getKeyName(repo) {
    return `${repo.name}_${repo.keyType || this.keyType}`;
  }

  getKeyPath(repo) {
    return path.join(this.sshDir, this.getKeyName(repo));
  }

  generateSSHKeys(repos) {
    logger.info('Generating SSH keys...');
    const results = [];

    for (const repo of repos) {
      SSHService.validateRepoName(repo.name);
      const keyPath = this.getKeyPath(repo);
      const keyType = repo.keyType || this.keyType;

      if (!['ed25519', 'rsa'].includes(keyType)) {
        results.push({ name: repo.name, success: false, error: `Invalid key type: ${keyType}` });
        continue;
      }

      try {
        if (!fs.existsSync(keyPath)) {
          logger.debug(`Generating ${keyType} key for ${repo.name}...`);
          execSync(`ssh-keygen -t ${keyType} -C "${repo.name}" -f "${keyPath}" -N ""`, { stdio: 'pipe' });
          logger.success(`SSH key generated: ${keyPath}`);
          results.push({ name: repo.name, success: true, keyPath, created: true });
        } else {
          logger.debug(`SSH key already exists: ${keyPath}`);
          results.push({ name: repo.name, success: true, keyPath, existed: true });
        }
      } catch (error) {
        logger.error(`Failed to generate SSH key for ${repo.name}: ${error.message}`);
        results.push({ name: repo.name, success: false, error: error.message });
      }
    }

    return results;
  }

  generateSSHConfig(repos) {
    logger.info('Generating SSH config...');
    const configPath = path.join(this.sshDir, 'config');

    try {
      let existingConfig = '';
      if (fs.existsSync(configPath)) {
        existingConfig = fs.readFileSync(configPath, 'utf8');
      }

      let newEntries = '';
      for (const repo of repos) {
        SSHService.validateRepoName(repo.name);
        const hostEntry = `Host github.com-${repo.name}`;
        if (!existingConfig.includes(hostEntry)) {
          newEntries += `${hostEntry}\n`;
          newEntries += `    HostName github.com\n`;
          newEntries += `    User git\n`;
          newEntries += `    IdentityFile ${this.getKeyPath(repo)}\n`;
          newEntries += `    IdentitiesOnly yes\n\n`;
        } else {
          logger.debug(`Config for ${repo.name} already exists, skipping`);
        }
      }

      if (newEntries) {
        const finalConfig = existingConfig + (existingConfig && !existingConfig.endsWith('\n') ? '\n' : '') + newEntries;
        fs.writeFileSync(configPath, finalConfig, { mode: 0o600 });
        logger.success(`SSH config updated: ${configPath}`);
      }

      return { success: true, configPath };
    } catch (error) {
      logger.error(`Failed to write SSH config: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  generateKnownHosts() {
    logger.info('Adding GitHub to known hosts...');
    const knownHostsPath = path.join(this.sshDir, 'known_hosts');

    try {
      let knownHosts = '';
      if (fs.existsSync(knownHostsPath)) {
        knownHosts = fs.readFileSync(knownHostsPath, 'utf8');
        if (knownHosts.includes('github.com')) {
          logger.debug('GitHub already in known_hosts');
          return { success: true, existed: true };
        }
      }

      logger.debug('Fetching GitHub host keys...');
      const hostKey = execSync('ssh-keyscan github.com 2>/dev/null', { encoding: 'utf8' });
      fs.writeFileSync(knownHostsPath, knownHosts + hostKey, { mode: 0o644 });
      logger.success(`Added GitHub to known hosts: ${knownHostsPath}`);
      return { success: true };
    } catch (error) {
      logger.error(`Failed to add GitHub to known hosts: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  getPublicKey(repo) {
    const publicKeyPath = `${this.getKeyPath(repo)}.pub`;
    if (fs.existsSync(publicKeyPath)) {
      return fs.readFileSync(publicKeyPath, 'utf8').trim();
    }
    return null;
  }
}

module.exports = SSHService;
