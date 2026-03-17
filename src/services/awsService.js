const {
  ACMClient,
  ListCertificatesCommand,
  RequestCertificateCommand,
  DescribeCertificateCommand
} = require('@aws-sdk/client-acm');
const {
  Route53Client,
  ListHostedZonesCommand,
  ChangeResourceRecordSetsCommand
} = require('@aws-sdk/client-route-53');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const logger = require('../utils/logger');

class AWSService {
  constructor(config = {}) {
    const region = config.region || 'us-east-1';
    const credentials = fromNodeProviderChain();

    this.acm = new ACMClient({ region, credentials });
    this.route53 = new Route53Client({ region: 'us-east-1', credentials });
  }

  async findExistingCertificate(domainName) {
    logger.info(`Checking for existing certificate for ${domainName}...`);

    const { CertificateSummaryList } = await this.acm.send(
      new ListCertificatesCommand({ CertificateStatuses: ['ISSUED', 'PENDING_VALIDATION'] })
    );

    const match = CertificateSummaryList.find(c => c.DomainName === domainName);
    if (!match) {
      logger.info('No existing certificate found.');
      return null;
    }

    const { Certificate } = await this.acm.send(
      new DescribeCertificateCommand({ CertificateArn: match.CertificateArn })
    );

    logger.info(`Found existing certificate: ${Certificate.CertificateArn} (${Certificate.Status})`);
    return { arn: Certificate.CertificateArn, status: Certificate.Status };
  }

  async requestCertificate(domainName, wwwDomain) {
    logger.info(`Requesting certificate for ${domainName} and ${wwwDomain}...`);

    const { CertificateArn } = await this.acm.send(
      new RequestCertificateCommand({
        DomainName: domainName,
        SubjectAlternativeNames: [wwwDomain],
        ValidationMethod: 'DNS'
      })
    );

    logger.success(`Certificate requested: ${CertificateArn}`);
    return { certificateArn: CertificateArn };
  }

  async getValidationRecords(certificateArn) {
    logger.info('Waiting for DNS validation records...');

    const maxAttempts = 10;
    for (let i = 0; i < maxAttempts; i++) {
      const { Certificate } = await this.acm.send(
        new DescribeCertificateCommand({ CertificateArn: certificateArn })
      );

      const options = Certificate.DomainValidationOptions || [];
      const records = options
        .filter(o => o.ResourceRecord)
        .map(o => ({ name: o.ResourceRecord.Name, value: o.ResourceRecord.Value }));

      if (records.length > 0) {
        logger.debug(`Got ${records.length} validation record(s)`);
        return records;
      }

      logger.debug(`Validation records not ready yet, retrying (${i + 1}/${maxAttempts})...`);
      await this._sleep(3000);
    }

    throw new Error('Timed out waiting for DNS validation records from ACM');
  }

  async findHostedZoneId(domainName) {
    logger.info(`Finding Route 53 hosted zone for ${domainName}...`);

    const dnsName = domainName.endsWith('.') ? domainName : `${domainName}.`;
    const { HostedZones } = await this.route53.send(new ListHostedZonesCommand({}));
    const zone = HostedZones.find(z => z.Name === dnsName);

    if (!zone) {
      throw new Error(
        `No hosted zone found for ${domainName} — is this domain in Route 53?`
      );
    }

    const zoneId = zone.Id.replace('/hostedzone/', '');
    logger.success(`Found hosted zone: ${zoneId}`);
    return zoneId;
  }

  async addValidationDnsRecords(hostedZoneId, records) {
    logger.info('Adding DNS validation records to Route 53...');

    const changes = records.map(record => ({
      Action: 'UPSERT',
      ResourceRecordSet: {
        Name: record.name,
        Type: 'CNAME',
        TTL: 300,
        ResourceRecords: [{ Value: record.value }]
      }
    }));

    await this.route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: { Changes: changes }
      })
    );

    logger.success(`Added ${records.length} validation record(s) to Route 53`);
  }

  async waitForCertificate(certificateArn) {
    logger.info('Waiting for certificate validation (this may take a few minutes)...');

    const maxWaitMs = 10 * 60 * 1000;
    const pollIntervalMs = 15000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const { Certificate } = await this.acm.send(
        new DescribeCertificateCommand({ CertificateArn: certificateArn })
      );

      if (Certificate.Status === 'ISSUED') {
        logger.success('Certificate issued!');
        return certificateArn;
      }

      if (Certificate.Status === 'FAILED') {
        const reason = Certificate.FailureReason || 'Unknown reason';
        throw new Error(`Certificate validation failed: ${reason}`);
      }

      process.stdout.write('.');
      await this._sleep(pollIntervalMs);
    }

    console.log('');
    throw new Error(
      'Certificate validation timed out after 10 minutes. Check your Route 53 records manually.'
    );
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AWSService;
