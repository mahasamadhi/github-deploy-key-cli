const path = require('path');
const os = require('os');
const SSHService = require('./services/sshService');
const GitHubService = require('./services/githubService');
const AWSService = require('./services/awsService');
const logger = require('./utils/logger');

/**
 * Set up deploy keys for GitHub repositories
 *
 * @param {Object} options - Configuration options
 * @param {string} options.token - GitHub personal access token with repo scope
 * @param {Array} options.repos - Array of repository configurations
 * @param {string} [options.sshDir] - SSH directory (default: ~/.ssh)
 * @param {string} [options.keyType] - Default key type (default: ed25519)
 * @param {boolean} [options.verbose] - Enable verbose logging
 * @returns {Promise<Object>} Results of the setup process
 *
 * @example
 * const { setupDeployKeys } = require('deploy-key-setup');
 *
 * const results = await setupDeployKeys({
 *   token: 'ghp_xxxx',
 *   repos: [
 *     { name: 'my-app', org: 'myorg', repo: 'my-repo' }
 *   ]
 * });
 */
async function setupDeployKeys(options) {
  const { token, repos, sshDir, keyType, verbose } = options;

  if (!token) {
    throw new Error('GitHub token is required');
  }

  if (!repos || repos.length === 0) {
    throw new Error('At least one repository is required');
  }

  logger.setVerbose(verbose || false);

  const config = {
    sshDir: sshDir || path.join(os.homedir(), '.ssh'),
    keyType: keyType || 'ed25519'
  };

  const sshService = new SSHService(config);
  const githubService = new GitHubService(sshService);

  const results = {
    keys: [],
    config: null,
    knownHosts: null,
    deployKeys: [],
    success: true
  };

  // 1. Verify token
  logger.info('Verifying GitHub token...');
  const tokenResult = await githubService.verifyToken(token);
  if (!tokenResult.valid) {
    throw new Error(`Invalid GitHub token: ${tokenResult.error}`);
  }
  logger.success(`Authenticated as ${tokenResult.user}`);

  const scopeList = tokenResult.scopes.split(',').map(s => s.trim());
  if (!scopeList.includes('repo')) {
    logger.warn('Token may not have "repo" scope - deploy key creation might fail');
  }

  // 2. Generate SSH keys
  results.keys = sshService.generateSSHKeys(repos);
  if (results.keys.some(r => !r.success)) {
    results.success = false;
  }

  // 3. Generate SSH config
  results.config = sshService.generateSSHConfig(repos);
  if (!results.config.success) {
    results.success = false;
  }

  // 4. Add GitHub to known hosts
  results.knownHosts = sshService.generateKnownHosts();
  if (!results.knownHosts.success) {
    results.success = false;
  }

  // 5. Add deploy keys to GitHub
  results.deployKeys = await githubService.addDeployKeys(repos, token);
  if (results.deployKeys.some(r => !r.success)) {
    results.success = false;
  }

  return results;
}

/**
 * Verify access to repositories
 *
 * @param {string} token - GitHub personal access token
 * @param {Array} repos - Array of repository configurations
 * @returns {Promise<Array>} Results for each repository
 */
async function verifyRepoAccess(token, repos) {
  const sshService = new SSHService({ sshDir: path.join(os.homedir(), '.ssh') });
  const githubService = new GitHubService(sshService);

  const results = [];
  for (const repo of repos) {
    results.push(await githubService.verifyRepoAccess(repo, token));
  }
  return results;
}

/**
 * Generate SSH keys only (no GitHub interaction)
 *
 * @param {Array} repos - Array of repository configurations
 * @param {Object} [options] - Options
 * @param {string} [options.sshDir] - SSH directory
 * @param {string} [options.keyType] - Default key type
 * @returns {Object} Results of key generation
 */
function generateKeys(repos, options = {}) {
  const sshService = new SSHService({
    sshDir: options.sshDir || path.join(os.homedir(), '.ssh'),
    keyType: options.keyType || 'ed25519'
  });

  return {
    keys: sshService.generateSSHKeys(repos),
    config: sshService.generateSSHConfig(repos),
    knownHosts: sshService.generateKnownHosts()
  };
}

/**
 * Set up GitHub Actions SSH access to this EC2 server
 *
 * @param {Object} options - Configuration options
 * @param {string} options.token - GitHub personal access token
 * @param {Array} options.repos - Array of { org, repo, name } to receive the secrets
 * @param {string} [options.sshDir] - SSH directory (default: ~/.ssh)
 * @param {string} [options.keyName] - Key filename (default: github-actions-deploy)
 * @param {string} [options.ec2Host] - EC2 host/IP to store as EC2_HOST secret
 * @param {string} [options.ec2User] - EC2 user to store as EC2_USER secret
 * @param {boolean} [options.verbose] - Enable verbose logging
 * @returns {Promise<Object>} Results of the setup process
 */
async function setupActionsAccess(options) {
  const { token, repos, sshDir, keyName, ec2Host, ec2User, verbose } = options;

  if (!token) {
    throw new Error('GitHub token is required');
  }

  if (!repos || repos.length === 0) {
    throw new Error('At least one repository is required');
  }

  logger.setVerbose(verbose || false);

  const config = {
    sshDir: sshDir || path.join(os.homedir(), '.ssh'),
    keyType: 'ed25519'
  };

  const sshService = new SSHService(config);
  const githubService = new GitHubService(sshService);

  const results = {
    key: null,
    secrets: [],
    success: true
  };

  // 1. Verify token
  logger.info('Verifying GitHub token...');
  const tokenResult = await githubService.verifyToken(token);
  if (!tokenResult.valid) {
    throw new Error(`Invalid GitHub token: ${tokenResult.error}`);
  }
  logger.success(`Authenticated as ${tokenResult.user}`);

  // 2. Generate keypair and add to authorized_keys
  results.key = sshService.generateActionsKey(keyName || 'github-actions-deploy');
  if (!results.key.success) {
    results.success = false;
    return results;
  }

  // 3. Build secrets map
  const secrets = {
    EC2_SSH_KEY: results.key.privateKey
  };
  if (ec2Host) {
    secrets.EC2_HOST = ec2Host;
  }
  if (ec2User) {
    secrets.EC2_USER = ec2User;
  }

  // 4. Upload secrets to all repos
  results.secrets = await githubService.addActionsSecrets(repos, token, secrets);
  if (results.secrets.some(r => !r.success)) {
    results.success = false;
  }

  return results;
}

/**
 * Set up ACM certificate with DNS validation for a frontend deployment
 *
 * @param {Object} options - Configuration options
 * @param {string} options.domain - Apex domain (e.g. storage-bot.com)
 * @param {string} [options.region] - AWS region (default: us-east-1)
 * @param {boolean} [options.verbose] - Enable verbose logging
 * @returns {Promise<Object>} Results including certificate ARN
 */
async function setupCert(options) {
  const { domain, region, verbose } = options;

  if (!domain) {
    throw new Error('Domain is required');
  }

  logger.setVerbose(verbose || false);

  const awsService = new AWSService({ region: region || 'us-east-1' });
  const wwwDomain = `www.${domain}`;

  const results = {
    certificateArn: null,
    success: true
  };

  // 1. Check for existing certificate
  const existing = await awsService.findExistingCertificate(domain);
  let certArn;

  if (existing && existing.status === 'ISSUED') {
    certArn = existing.arn;
    results.certificateArn = certArn;
    return results;
  }

  if (existing && existing.status === 'PENDING_VALIDATION') {
    certArn = existing.arn;
  } else {
    // 2. Request new certificate
    const certResult = await awsService.requestCertificate(domain, wwwDomain);
    certArn = certResult.certificateArn;
  }

  // 3. Get validation records
  const validationRecords = await awsService.getValidationRecords(certArn);

  // 4. Find hosted zone
  const hostedZoneId = await awsService.findHostedZoneId(domain);

  // 5. Add DNS records
  await awsService.addValidationDnsRecords(hostedZoneId, validationRecords);

  // 6. Wait for validation
  await awsService.waitForCertificate(certArn);

  results.certificateArn = certArn;
  return results;
}

module.exports = {
  setupDeployKeys,
  setupActionsAccess,
  setupCert,
  verifyRepoAccess,
  generateKeys,
  SSHService,
  GitHubService,
  AWSService,
  logger
};
