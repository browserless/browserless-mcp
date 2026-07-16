import { expect } from 'chai';
import { resolveMcpSource } from '../../src/lib/utils.js';

describe('resolveMcpSource', () => {
  it('trusts the explicit header source over clientInfo', () => {
    const props = resolveMcpSource('cli_agent', {
      name: 'claude-ai',
      version: '1.0',
    });
    expect(props.source).to.equal('cli_agent');
    expect(props.client_name).to.equal('claude-ai');
    expect(props.client_version).to.equal('1.0');
  });

  it('falls back to mcp_client for an external client, keeping the raw name', () => {
    const props = resolveMcpSource(undefined, {
      name: 'cursor-vscode',
      version: '2.3',
    });
    expect(props.source).to.equal('mcp_client');
    expect(props.client_name).to.equal('cursor-vscode');
  });

  it('reports unknown when there is neither a header nor clientInfo', () => {
    expect(resolveMcpSource(undefined, undefined).source).to.equal('unknown');
    expect(resolveMcpSource(undefined, {}).source).to.equal('unknown');
  });
});
