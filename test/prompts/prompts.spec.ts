import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import { registerScrapeUrlPrompt } from '../../src/prompts/scrape-url.js';
import { registerExtractContentPrompt } from '../../src/prompts/extract-content.js';
describe('Prompts', () => {
  describe('scrape-url prompt', () => {
    it('registers without error', () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      expect(() => registerScrapeUrlPrompt(server)).to.not.throw();
    });

    it('load returns correct message for URL', async () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      const addPromptSpy = sinon.spy(server, 'addPrompt');
      registerScrapeUrlPrompt(server);

      const prompt = addPromptSpy.firstCall.args[0];
      const result = await prompt.load(
        { url: 'https://example.com', includeScreenshot: 'false' },
      );

      expect(result).to.have.property('messages');
      const messages = (result as { messages: unknown[] }).messages;
      expect(messages).to.have.length(1);
      const msg = messages[0] as { role: string; content: { type: string; text: string } };
      expect(msg.role).to.equal('user');
      expect(msg.content.text).to.include('https://example.com');
      expect(msg.content.text).to.include('screenshot=false');
    });

    it('load handles includeScreenshot=true', async () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      const addPromptSpy = sinon.spy(server, 'addPrompt');
      registerScrapeUrlPrompt(server);

      const prompt = addPromptSpy.firstCall.args[0];
      const result = await prompt.load(
        { url: 'https://example.com', includeScreenshot: 'true' },
      );

      const messages = (result as { messages: unknown[] }).messages;
      const msg = messages[0] as { role: string; content: { type: string; text: string } };
      expect(msg.content.text).to.include('screenshot=true');
    });
  });

  describe('extract-content prompt', () => {
    it('registers without error', () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      expect(() =>
        registerExtractContentPrompt(server),
      ).to.not.throw();
    });

    it('load returns correct message with URL and instructions', async () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      const addPromptSpy = sinon.spy(server, 'addPrompt');
      registerExtractContentPrompt(server);

      const prompt = addPromptSpy.firstCall.args[0];
      const result = await prompt.load(
        { url: 'https://example.com', instructions: 'Get all prices' },
      );

      expect(result).to.have.property('messages');
      const messages = (result as { messages: unknown[] }).messages;
      expect(messages).to.have.length(1);
      const msg = messages[0] as { role: string; content: { type: string; text: string } };
      expect(msg.role).to.equal('user');
      expect(msg.content.text).to.include('https://example.com');
      expect(msg.content.text).to.include('Get all prices');
    });
  });

  describe('both prompts together', () => {
    it('can coexist on the same server', () => {
      const server = new FastMCP({ name: 'test', version: '0.1.0' });
      registerScrapeUrlPrompt(server);
      registerExtractContentPrompt(server);
    });
  });
});
