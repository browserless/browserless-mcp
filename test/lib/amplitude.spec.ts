import { expect } from 'chai';
import sinon from 'sinon';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { AmplitudeHelper, djb2 } from '../../src/lib/amplitude.js';

describe('AmplitudeHelper', () => {
  let sqsSendStub: sinon.SinonStub;

  beforeEach(() => {
    sqsSendStub = sinon.stub(SQSClient.prototype, 'send');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('does not initialize when disabled', () => {
    const helper = new AmplitudeHelper(false, 'https://sqs.example.com/queue', 'us-east-1');
    // send should return false since disabled
    return helper.send('Test Event', 123, { token: 'abc' }).then((result) => {
      expect(result).to.be.false;
      expect(sqsSendStub.called).to.be.false;
    });
  });

  it('does not initialize when queue URL is missing', () => {
    const helper = new AmplitudeHelper(true, undefined, 'us-east-1');
    return helper.send('Test Event', 123, { token: 'abc' }).then((result) => {
      expect(result).to.be.false;
      expect(sqsSendStub.called).to.be.false;
    });
  });

  it('sends event to SQS when enabled and configured', async () => {
    sqsSendStub.resolves({ Failed: [] });

    const helper = new AmplitudeHelper(true, 'https://sqs.example.com/queue', 'us-east-1');
    const result = await helper.send('MCP Tool Request', 12345, {
      token: 'test-token',
      tool: 'browserless_smartscraper',
      url: 'https://example.com',
    });

    expect(result).to.be.true;
    expect(sqsSendStub.calledOnce).to.be.true;

    const command = sqsSendStub.firstCall.args[0];
    expect(command).to.be.instanceOf(SendMessageBatchCommand);
    expect(command.input.QueueUrl).to.equal('https://sqs.example.com/queue');

    const entries = command.input.Entries;
    expect(entries).to.have.length(1);

    const event = JSON.parse(entries[0].MessageBody);
    expect(event.event_type).to.equal('MCP Tool Request');
    expect(event.session_id).to.equal(12345);
    expect(event.event_properties.token).to.equal('test-token');
    expect(event.event_properties.tool).to.equal('browserless_smartscraper');
    expect(event.event_properties.url).to.equal('https://example.com');
    expect(event.time).to.be.a('number');
  });

  it('returns false when SQS reports failed entries', async () => {
    sqsSendStub.resolves({
      Failed: [{ Id: 'msg-1', Code: 'InternalError', SenderFault: false }],
    });

    const helper = new AmplitudeHelper(true, 'https://sqs.example.com/queue', 'us-east-1');
    const result = await helper.send('Test Event', 123, { token: 'abc' });

    expect(result).to.be.false;
  });

  it('retries on SQS errors and returns false after exhausting retries', async () => {
    sqsSendStub.rejects(new Error('Network error'));

    const helper = new AmplitudeHelper(true, 'https://sqs.example.com/queue', 'us-east-1');
    const result = await helper.send('Test Event', 123, { token: 'abc' });

    expect(result).to.be.false;
    // 3 retries
    expect(sqsSendStub.callCount).to.equal(3);
  });

  it('succeeds on retry after initial failure', async () => {
    sqsSendStub
      .onFirstCall().rejects(new Error('Temporary failure'))
      .onSecondCall().resolves({ Failed: [] });

    const helper = new AmplitudeHelper(true, 'https://sqs.example.com/queue', 'us-east-1');
    const result = await helper.send('Test Event', 123, { token: 'abc' });

    expect(result).to.be.true;
    expect(sqsSendStub.callCount).to.equal(2);
  });

  it('does not re-initialize if already initialized', () => {
    const helper = new AmplitudeHelper(true, 'https://sqs.example.com/queue', 'us-east-1');
    // Call initialize again — should be a no-op
    helper.initialize('https://other.example.com/queue', 'eu-west-1');

    sqsSendStub.resolves({ Failed: [] });
    return helper.send('Test Event', 123, { token: 'abc' }).then(() => {
      const command = sqsSendStub.firstCall.args[0];
      // Should still use the original queue URL
      expect(command.input.QueueUrl).to.equal('https://sqs.example.com/queue');
    });
  });
});

describe('djb2', () => {
  it('returns a consistent hash for the same input', () => {
    const hash1 = djb2('test-token');
    const hash2 = djb2('test-token');
    expect(hash1).to.equal(hash2);
  });

  it('returns different hashes for different inputs', () => {
    const hash1 = djb2('token-a');
    const hash2 = djb2('token-b');
    expect(hash1).to.not.equal(hash2);
  });

  it('returns an unsigned 32-bit integer', () => {
    const hash = djb2('any-string');
    expect(hash).to.be.at.least(0);
    expect(hash).to.be.at.most(0xFFFFFFFF);
  });
});
