import { expect } from 'chai';
import { resolveMcpSource, stableStringify } from '../../src/lib/utils.js';

describe('stableStringify', () => {
  it('sorts object keys', () => {
    expect(stableStringify({ b: 1, a: 2 })).to.equal('{"a":2,"b":1}');
    expect(stableStringify({ a: 2, b: 1 })).to.equal('{"a":2,"b":1}');
  });

  it('sorts nested object keys including objects inside arrays', () => {
    const expected = '{"x":{"a":[{"c":2,"d":1}],"b":1}}';
    expect(stableStringify({ x: { b: 1, a: [{ d: 1, c: 2 }] } })).to.equal(
      expected,
    );
    expect(stableStringify({ x: { a: [{ c: 2, d: 1 }], b: 1 } })).to.equal(
      expected,
    );
  });

  it('preserves array order', () => {
    expect(stableStringify([1, 2])).to.equal('[1,2]');
    expect(stableStringify([2, 1])).to.equal('[2,1]');
  });

  it('omits undefined object properties', () => {
    expect(stableStringify({ a: undefined, b: 1 })).to.equal('{"b":1}');
    expect(stableStringify({ b: 1 })).to.equal('{"b":1}');
  });

  it('serializes primitive JSON values', () => {
    for (const value of ['s', 1, null, true]) {
      expect(stableStringify(value)).to.equal(JSON.stringify(value));
    }
  });
});

describe('resolveMcpSource', () => {
  it('trusts the explicit header source over clientInfo', () => {
    const props = resolveMcpSource(
      { source: 'cli_agent' },
      {
        name: 'claude-ai',
        version: '1.0',
      },
      'httpStream',
    );
    expect(props.source).to.equal('cli_agent');
    expect(props.client_name).to.equal('claude-ai');
    expect(props.client_version).to.equal('1.0');
  });

  it('falls back to mcp_client for an external client, keeping the raw name', () => {
    const props = resolveMcpSource(
      undefined,
      {
        name: 'cursor-vscode',
        version: '2.3',
      },
      'httpStream',
    );
    expect(props.source).to.equal('mcp_client');
    expect(props.client_name).to.equal('cursor-vscode');
  });

  it('reports unknown when there is neither a header nor clientInfo', () => {
    expect(resolveMcpSource(undefined, undefined, 'stdio').source).to.equal(
      'unknown',
    );
    expect(resolveMcpSource(undefined, {}, 'stdio').source).to.equal('unknown');
  });

  it('attributes a local SDK session to interactive stdio with an env token', () => {
    expect(
      resolveMcpSource(undefined, { name: 'mcp', version: '0.1.0' }, 'stdio'),
    ).to.deep.equal({
      source: 'mcp_client',
      client_name: 'mcp',
      client_version: '0.1.0',
      transport: 'stdio',
      auth_method: 'env_token',
      user_agent_family: 'unknown',
      client_family: 'sdk_default',
      usage_mode: 'interactive',
    });
  });

  it('attributes OAuth sessions while keeping the external client name', () => {
    expect(
      resolveMcpSource(
        {
          authMethod: 'oauth',
          transport: 'streamable-http',
          userAgent: 'Claude-User/1.0',
        },
        { name: 'Anthropic/ClaudeAI', version: '1.0.0' },
        'httpStream',
      ),
    ).to.deep.equal({
      source: 'mcp_client',
      client_name: 'Anthropic/ClaudeAI',
      client_version: '1.0.0',
      auth_method: 'oauth',
      transport: 'streamable-http',
      user_agent: 'Claude-User/1.0',
      user_agent_family: 'claude-user',
      client_family: 'anthropic',
      usage_mode: 'interactive',
    });
  });

  it('falls back to HTTP transport without inventing OAuth provenance', () => {
    expect(
      resolveMcpSource({}, { name: 'Anthropic/ClaudeAI' }, 'httpStream'),
    ).to.include({
      transport: 'streamable-http',
      auth_method: 'env_token',
      usage_mode: 'unknown',
    });
  });
});
