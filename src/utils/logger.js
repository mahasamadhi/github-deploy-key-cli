const chalk = require('chalk');

class Logger {
  constructor(options = {}) {
    this.verbose = options.verbose || false;
  }

  setVerbose(verbose) {
    this.verbose = verbose;
  }

  log(message) {
    console.log(message);
  }

  info(message) {
    console.log(chalk.blue(`i ${message}`));
  }

  success(message) {
    console.log(chalk.green(`+ ${message}`));
  }

  warn(message) {
    console.log(chalk.yellow(`! ${message}`));
  }

  error(message) {
    console.error(chalk.red(`x ${message}`));
  }

  debug(message) {
    if (this.verbose) {
      console.log(chalk.gray(`  ${message}`));
    }
  }

  summarize(title, results) {
    this.log('\n' + chalk.bold(title));
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    this.log(`${chalk.green(`${succeeded} succeeded`)}, ${chalk.red(`${failed} failed`)}`);

    if (failed > 0) {
      this.log('\n' + chalk.bold('Failed operations:'));
      results.filter(r => !r.success).forEach(result => {
        this.error(`${result.repo || result.name}: ${result.error}`);
      });
    }
  }
}

module.exports = new Logger();
