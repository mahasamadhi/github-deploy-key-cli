#!/usr/bin/env node
const { Command } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { setupDeployKeys, setupActionsAccess, setupCert, verifyRepoAccess, logger } = require('../src');

/**
 * Fetch EC2 instance metadata (IMDSv2).
 * Returns the value or null if not running on EC2.
 */
async function fetchEC2Metadata(metadataPath) {
  try {
    // IMDSv2: get a token first
    const token = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '169.254.169.254',
        path: '/latest/api/token',
        method: 'PUT',
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
        timeout: 2000
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    // Fetch the metadata value using the token
    return await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '169.254.169.254',
        path: `/latest/meta-data/${metadataPath}`,
        method: 'GET',
        headers: { 'X-aws-ec2-metadata-token': token },
        timeout: 2000
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(res.statusCode === 200 ? data.trim() : null));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  } catch {
    return null;
  }
}

/**
 * Auto-detect EC2 host (public IP) and current OS user.
 */
async function detectEC2Details() {
  const user = os.userInfo().username;

  // Try public IP first, fall back to private IP
  let host = await fetchEC2Metadata('public-ipv4');
  if (!host) {
    host = await fetchEC2Metadata('local-ipv4');
  }

  return { host, user };
}

const program = new Command();

program
  .name('deploy-key-setup')
  .description('Automated GitHub deploy key setup')
  .version('1.0.0');

// Deploy keys command
program
  .command('deploy-keys')
  .description('Generate SSH keys and register them as GitHub deploy keys for cloning private repos')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-t, --token <token>', 'GitHub personal access token')
  .option('-s, --ssh-dir <path>', 'SSH directory (default: ~/.ssh)')
  .option('-v, --verbose', 'Enable verbose output')
  .action(async (options) => {
    try {
      let repos = [];
      let token = options.token || process.env.GITHUB_TOKEN;

      // Load from config file if provided
      if (options.config) {
        const configPath = path.resolve(options.config);
        if (!fs.existsSync(configPath)) {
          logger.error(`Config file not found: ${configPath}`);
          process.exit(1);
        }
        const raw = fs.readFileSync(configPath, 'utf8');
        let configData;
        try {
          configData = JSON.parse(raw);
        } catch (e) {
          logger.error(`Failed to parse config file: ${configPath}`);
          logger.error(`File starts with: ${JSON.stringify(raw.slice(0, 80))}`);
          throw e;
        }
        repos = configData.repos || [];
        token = token || configData.personalAccessToken;
      } else {
        // Try default config location
        const defaultPath = path.join(process.cwd(), 'repos-config.json');
        if (fs.existsSync(defaultPath)) {
          const raw = fs.readFileSync(defaultPath, 'utf8');
          let configData;
          try {
            configData = JSON.parse(raw);
          } catch (e) {
            logger.error(`Failed to parse config file: ${defaultPath}`);
            logger.error(`File starts with: ${JSON.stringify(raw.slice(0, 80))}`);
            throw e;
          }
          repos = configData.repos || [];
          token = token || configData.personalAccessToken;
        }
      }

      // If no token, prompt for it
      if (!token) {
        const answer = await inquirer.prompt([{
          type: 'password',
          name: 'token',
          message: 'Enter your GitHub personal access token:',
          mask: '*',
          validate: input => input.trim() !== '' ? true : 'Token is required'
        }]);
        token = answer.token;
      }

      // If no repos, prompt interactively
      if (repos.length === 0) {
        logger.info('No repositories found. Add them interactively:');
        let addMore = true;

        while (addMore) {
          const repoAnswers = await inquirer.prompt([
            {
              type: 'input',
              name: 'name',
              message: 'Short name for this repo (used in SSH config):',
              validate: input => input.trim() !== '' ? true : 'Name is required'
            },
            {
              type: 'input',
              name: 'org',
              message: 'GitHub org or username:',
              validate: input => input.trim() !== '' ? true : 'Org/username is required'
            },
            {
              type: 'input',
              name: 'repo',
              message: 'Repository name:',
              validate: input => input.trim() !== '' ? true : 'Repo name is required'
            },
            {
              type: 'list',
              name: 'keyType',
              message: 'SSH key type:',
              choices: ['ed25519', 'rsa'],
              default: 'ed25519'
            },
            {
              type: 'confirm',
              name: 'readOnly',
              message: 'Read-only deploy key?',
              default: true
            },
            {
              type: 'confirm',
              name: 'addAnother',
              message: 'Add another repository?',
              default: false
            }
          ]);

          const { addAnother, ...repo } = repoAnswers;
          repos.push(repo);
          addMore = addAnother;
        }
      }

      if (repos.length === 0) {
        logger.error('No repositories to set up.');
        process.exit(1);
      }

      // Show summary
      console.log(chalk.blue('\nRepositories to set up:'));
      repos.forEach(repo => {
        console.log(`  - ${chalk.green(repo.name)}: ${chalk.yellow(repo.org)}/${chalk.yellow(repo.repo)}`);
      });

      const confirm = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: 'Proceed with setup?',
        default: true
      }]);

      if (!confirm.proceed) {
        logger.info('Setup cancelled.');
        return;
      }

      // Run setup
      const spinner = ora('Setting up deploy keys...').start();

      const results = await setupDeployKeys({
        token,
        repos,
        sshDir: options.sshDir,
        verbose: options.verbose
      });

      spinner.stop();

      // Show results
      logger.summarize('SSH Key Generation:', results.keys);
      logger.summarize('Deploy Keys:', results.deployKeys);

      if (results.success) {
        console.log(chalk.green('\n+ Setup completed successfully!'));
        console.log(chalk.blue('\nTo clone a repository, use:'));
        repos.forEach(repo => {
          console.log(`  git clone git@github.com-${repo.name}:${repo.org}/${repo.repo}.git`);
        });
      } else {
        console.log(chalk.yellow('\n! Setup completed with some errors.'));
        process.exit(1);
      }
    } catch (error) {
      logger.error(error.message);
      if (options.verbose) console.error(error);
      process.exit(1);
    }
  });

// Generate config command
program
  .command('generate-config')
  .description('Generate an example repos-config.json file')
  .option('-o, --output <path>', 'Output file path', './repos-config.json')
  .action((options) => {
    const example = {
      personalAccessToken: 'ghp_your_deploy_key_token_here',
      actionsToken: 'ghp_your_actions_token_here',
      ec2Host: '',
      ec2User: '',
      repos: [
        {
          name: 'my-app',
          org: 'myorg',
          repo: 'my-repo',
          keyType: 'ed25519',
          readOnly: true
        }
      ]
    };

    const outputPath = path.resolve(options.output);
    fs.writeFileSync(outputPath, JSON.stringify(example, null, 2));
    logger.success(`Example config created: ${outputPath}`);
    logger.info('Edit the file and run: deploy-key-setup deploy-keys -c ' + options.output);
  });

// Actions SSH command
program
  .command('actions-ssh')
  .description('Generate SSH keypair and store as GitHub Actions secrets for EC2 access')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-t, --token <token>', 'GitHub personal access token')
  .option('-s, --ssh-dir <path>', 'SSH directory (default: ~/.ssh)')
  .option('-k, --key-name <name>', 'SSH key filename', 'github-actions-deploy')
  .option('--host <host>', 'EC2 host/IP to store as EC2_HOST secret')
  .option('--user <user>', 'EC2 user to store as EC2_USER secret')
  .option('-v, --verbose', 'Enable verbose output')
  .action(async (options) => {
    try {
      let repos = [];
      let token = options.token || process.env.GITHUB_TOKEN;
      let configEc2Host;
      let configEc2User;

      // Load from config file if provided, or try default location
      if (options.config) {
        const configPath = path.resolve(options.config);
        if (!fs.existsSync(configPath)) {
          logger.error(`Config file not found: ${configPath}`);
          process.exit(1);
        }
        const raw = fs.readFileSync(configPath, 'utf8');
        let configData;
        try {
          configData = JSON.parse(raw);
        } catch (e) {
          logger.error(`Failed to parse config file: ${configPath}`);
          logger.error(`File starts with: ${JSON.stringify(raw.slice(0, 80))}`);
          throw e;
        }
        repos = configData.repos || [];
        token = token || configData.actionsToken || configData.personalAccessToken;
        configEc2Host = configData.ec2Host;
        configEc2User = configData.ec2User;
      } else {
        const defaultPath = path.join(process.cwd(), 'repos-config.json');
        if (fs.existsSync(defaultPath)) {
          const raw = fs.readFileSync(defaultPath, 'utf8');
          let configData;
          try {
            configData = JSON.parse(raw);
          } catch (e) {
            logger.error(`Failed to parse config file: ${defaultPath}`);
            logger.error(`File starts with: ${JSON.stringify(raw.slice(0, 80))}`);
            throw e;
          }
          repos = configData.repos || [];
          token = token || configData.actionsToken || configData.personalAccessToken;
          configEc2Host = configData.ec2Host;
          configEc2User = configData.ec2User;
        }
      }

      // If no token, prompt for it
      if (!token) {
        const answer = await inquirer.prompt([{
          type: 'password',
          name: 'token',
          message: 'Enter your GitHub personal access token (needs admin:repo scope):',
          mask: '*',
          validate: input => input.trim() !== '' ? true : 'Token is required'
        }]);
        token = answer.token;
      }

      // If no repos, prompt interactively
      if (repos.length === 0) {
        logger.info('No repositories found. Add repos that need Actions SSH access:');
        let addMore = true;

        while (addMore) {
          const repoAnswers = await inquirer.prompt([
            {
              type: 'input',
              name: 'name',
              message: 'Short name for this repo:',
              validate: input => input.trim() !== '' ? true : 'Name is required'
            },
            {
              type: 'input',
              name: 'org',
              message: 'GitHub org or username:',
              validate: input => input.trim() !== '' ? true : 'Org/username is required'
            },
            {
              type: 'input',
              name: 'repo',
              message: 'Repository name:',
              validate: input => input.trim() !== '' ? true : 'Repo name is required'
            },
            {
              type: 'confirm',
              name: 'addAnother',
              message: 'Add another repository?',
              default: false
            }
          ]);

          const { addAnother, ...repo } = repoAnswers;
          repos.push(repo);
          addMore = addAnother;
        }
      }

      if (repos.length === 0) {
        logger.error('No repositories to set up.');
        process.exit(1);
      }

      // Resolve EC2 details: CLI flags > config file > auto-detect
      let ec2Host = options.host || configEc2Host;
      let ec2User = options.user || configEc2User;

      if (!ec2Host || !ec2User) {
        const spinner2 = ora('Detecting EC2 instance details...').start();
        const detected = await detectEC2Details();
        spinner2.stop();

        if (!ec2User && detected.user) {
          ec2User = detected.user;
          logger.info(`Auto-detected EC2 user: ${chalk.green(ec2User)}`);
        }
        if (!ec2Host && detected.host) {
          ec2Host = detected.host;
          logger.info(`Auto-detected EC2 host: ${chalk.green(ec2Host)}`);
        }

        if (!ec2Host) {
          logger.warn('Could not detect EC2 host IP. Use --host or add "ec2Host" to config.');
        }
      }

      // Show summary
      console.log(chalk.blue('\nActions SSH setup:'));
      console.log(`  Key: ${chalk.green(options.keyName)}`);
      repos.forEach(repo => {
        console.log(`  Repo: ${chalk.yellow(repo.org)}/${chalk.yellow(repo.repo)}`);
      });
      console.log(`  Secrets: ${chalk.green('EC2_SSH_KEY')}${ec2Host ? ', ' + chalk.green('EC2_HOST') : ''}${ec2User ? ', ' + chalk.green('EC2_USER') : ''}`);

      const confirm = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: 'Proceed with Actions setup?',
        default: true
      }]);

      if (!confirm.proceed) {
        logger.info('Setup cancelled.');
        return;
      }

      const spinner = ora('Setting up GitHub Actions SSH access...').start();

      const results = await setupActionsAccess({
        token,
        repos,
        sshDir: options.sshDir,
        keyName: options.keyName,
        ec2Host,
        ec2User,
        verbose: options.verbose
      });

      spinner.stop();

      // Show results
      if (results.key.success) {
        logger.success(`SSH key: ${results.key.keyPath}${results.key.created ? ' (created)' : ' (existed)'}`);
      } else {
        logger.error(`SSH key: ${results.key.error}`);
      }

      logger.summarize('Actions Secrets:', results.secrets);

      if (results.success) {
        console.log(chalk.green('\n+ Actions setup completed successfully!'));
        console.log(chalk.blue('\nYour GitHub Actions workflows can now SSH into this server.'));
        console.log(chalk.blue('Example workflow step:'));
        console.log(chalk.gray(`
    - name: Deploy to EC2
      run: |
        echo "\${{ secrets.EC2_SSH_KEY }}" > key.pem
        chmod 600 key.pem
        ssh -i key.pem -o StrictHostKeyChecking=no \\
          \${{ secrets.EC2_USER }}@\${{ secrets.EC2_HOST }} \\
          "cd /app && git pull && npm install"`));
      } else {
        console.log(chalk.yellow('\n! Setup completed with some errors.'));
        process.exit(1);
      }
    } catch (error) {
      logger.error(error.message);
      if (options.verbose) console.error(error);
      process.exit(1);
    }
  });

// ACM cert command
program
  .command('acm-cert')
  .description('Request an ACM certificate with Route 53 DNS validation')
  .requiredOption('-d, --domain <domain>', 'Apex domain (e.g. storage-bot.com)')
  .option('-r, --region <region>', 'AWS region', 'us-east-1')
  .option('-v, --verbose', 'Enable verbose output')
  .action(async (options) => {
    try {
      const results = await setupCert({
        domain: options.domain,
        region: options.region,
        verbose: options.verbose
      });

      if (results.success && results.certificateArn) {
        console.log('');
        console.log(chalk.green('============================================'));
        console.log(chalk.green('Certificate ARN (paste into CloudFormation):'));
        console.log(chalk.yellow(results.certificateArn));
        console.log(chalk.green('============================================'));
      } else {
        console.log(chalk.yellow('\n! Cert setup completed with errors.'));
        process.exit(1);
      }
    } catch (error) {
      logger.error(error.message);
      if (options.verbose) console.error(error);
      process.exit(1);
    }
  });

// Verify token command
program
  .command('verify-token')
  .description('Verify your GitHub PAT can access the configured repositories (run before deploy-keys)')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-t, --token <token>', 'GitHub personal access token')
  .action(async (options) => {
    try {
      let repos = [];
      let token = options.token || process.env.GITHUB_TOKEN;

      if (options.config) {
        const configPath = path.resolve(options.config);
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        repos = configData.repos || [];
        token = token || configData.personalAccessToken;
      }

      if (!token) {
        logger.error('Token required. Use --token or set GITHUB_TOKEN env var.');
        process.exit(1);
      }

      if (repos.length === 0) {
        logger.error('No repos to verify. Use --config to specify a config file.');
        process.exit(1);
      }

      const spinner = ora('Verifying repository access...').start();
      const results = await verifyRepoAccess(token, repos);
      spinner.stop();

      logger.summarize('Repository Access:', results);
    } catch (error) {
      logger.error(error.message);
      process.exit(1);
    }
  });

// Verify SSH command
program
  .command('verify-ssh')
  .description('Test SSH connections to GitHub for each configured repo (run after deploy-keys)')
  .option('-c, --config <path>', 'Path to configuration file')
  .action(async (options) => {
    try {
      let repos = [];

      if (options.config) {
        const configPath = path.resolve(options.config);
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        repos = configData.repos || [];
      } else {
        const defaultPath = path.join(process.cwd(), 'repos-config.json');
        if (fs.existsSync(defaultPath)) {
          const configData = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
          repos = configData.repos || [];
        }
      }

      if (repos.length === 0) {
        logger.error('No repos to verify. Use --config to specify a config file.');
        process.exit(1);
      }

      const { execSync } = require('child_process');
      const results = [];

      for (const repo of repos) {
        const host = `github.com-${repo.name}`;
        process.stdout.write(chalk.blue(`  Testing SSH to ${host}... `));
        try {
          // ssh -T always exits non-zero for GitHub, so we capture via stderr
          execSync(`ssh -T -o StrictHostKeyChecking=no -o ConnectTimeout=10 git@${host}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
          console.log(chalk.green('OK'));
          results.push({ name: repo.name, success: true });
        } catch (error) {
          const output = (error.stderr || '') + (error.stdout || '');
          if (output.includes('successfully authenticated')) {
            console.log(chalk.green('OK'));
            results.push({ name: repo.name, success: true });
          } else {
            console.log(chalk.red('FAILED'));
            logger.error(`  ${output.trim() || error.message}`);
            results.push({ name: repo.name, success: false, error: output.trim() || error.message });
          }
        }
      }

      logger.summarize('SSH Connections:', results);
    } catch (error) {
      logger.error(error.message);
      process.exit(1);
    }
  });

program.parse();
