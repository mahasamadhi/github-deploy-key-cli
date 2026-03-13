const https = require('https');
const logger = require('../utils/logger');

class GitHubService {
  constructor(sshService) {
    this.sshService = sshService;
  }

  request(options, postData = null) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, headers: res.headers, data: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode, headers: res.headers, data });
          }
        });
      });
      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  }

  async verifyToken(token) {
    const { statusCode, headers, data } = await this.request({
      hostname: 'api.github.com',
      path: '/user',
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'deploy-key-setup',
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (statusCode === 200) {
      const scopes = headers['x-oauth-scopes'] || '';
      return { valid: true, user: data.login, scopes };
    }
    return { valid: false, error: data.message };
  }

  async verifyRepoAccess(repo, token) {
    const { statusCode, data } = await this.request({
      hostname: 'api.github.com',
      path: `/repos/${repo.org}/${repo.repo}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'deploy-key-setup',
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (statusCode === 200) {
      return { success: true, name: repo.name };
    }
    return { success: false, name: repo.name, error: `Cannot access ${repo.org}/${repo.repo}: ${data.message || statusCode}` };
  }

  async addDeployKey(repo, token) {
    const publicKey = this.sshService.getPublicKey(repo);

    if (!publicKey) {
      return { success: false, name: repo.name, error: 'Public key not found' };
    }

    logger.debug(`Adding deploy key for ${repo.org}/${repo.repo}...`);

    const postData = JSON.stringify({
      title: `${repo.name}-deploy-key`,
      key: publicKey,
      read_only: repo.readOnly !== false
    });

    const { statusCode, data } = await this.request({
      hostname: 'api.github.com',
      path: `/repos/${repo.org}/${repo.repo}/keys`,
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'deploy-key-setup',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    if (statusCode === 201) {
      logger.success(`Deploy key added for ${repo.org}/${repo.repo}`);
      return { success: true, name: repo.name, keyId: data.id };
    }

    if (statusCode === 422 && data.errors?.some(e => e.message?.includes('key is already in use'))) {
      logger.debug(`Deploy key already exists for ${repo.org}/${repo.repo}`);
      return { success: true, name: repo.name, existed: true };
    }

    logger.error(`Failed to add deploy key for ${repo.org}/${repo.repo}: ${data.message || statusCode}`);
    return { success: false, name: repo.name, error: data.message || `HTTP ${statusCode}` };
  }

  async addDeployKeys(repos, token) {
    logger.info('Adding deploy keys to GitHub...');
    const results = [];

    for (const repo of repos) {
      try {
        const result = await this.addDeployKey(repo, token);
        results.push(result);
      } catch (error) {
        results.push({ success: false, name: repo.name, error: error.message });
      }
    }

    return results;
  }
}

module.exports = GitHubService;
