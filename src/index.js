const path = require('path');
const os = require('os');
const SSHService = require('./services/sshService');
const GitHubService = require('./services/githubService');
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

module.exports = {
  setupDeployKeys,
  verifyRepoAccess,
  generateKeys,
  SSHService,
  GitHubService,
  logger
};
