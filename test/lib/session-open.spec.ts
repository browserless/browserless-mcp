import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import sinon from 'sinon';
import type { BrowserlessSession } from '../../src/@types/types.js';
import {
  sessionOpenAttributes,
  recordSessionOpen,
  whenSessionReady,
} from '../../src/lib/session-open.js';

describe('Session opening records', () => {
  const token = 'synthetic-session-key-0123456789';
  const auth: BrowserlessSession = {
    token,
    apiUrl: 'http://127.0.0.1:9',
    authMethod: 'api_key_query',
    transport: 'sse',
    userAgent: 'private raw agent',
    identityToken: 'private identity',
    userId: 'private user',
  };
  afterEach(() => sinon.restore());

  it('allowlists identity and attribution without raw credentials or agent strings', () => {
    const cases = [
      [auth, { name: 'c', version: '1' }],
      [
        { ...auth, authMethod: 'api_key_header', transport: 'streamable-http' },
        undefined,
      ],
      [{ ...auth, authMethod: 'oauth', accountId: 'account-1' }, { name: 'c' }],
      [auth, { name: 'c\n' + '😀'.repeat(300), version: 'v\u0000' }],
    ] as const;
    for (const [session, info] of cases) {
      const fields = sessionOpenAttributes(session, info);
      expect(fields).to.include({
        transport: session.transport,
        auth_method: session.authMethod,
        key_fp: createHash('sha256').update(token).digest('hex').slice(0, 16),
      });
      for (const key of [
        'token',
        'user_agent',
        'identityToken',
        'userId',
        'session_id',
      ])
        expect(fields).not.to.have.property(key);
      expect(JSON.stringify(fields)).not.to.match(
        /synthetic-session-key|private raw|private identity|private user/,
      );
      if ('accountId' in session)
        expect(fields.account_id).to.equal('account-1');
      else expect(fields).not.to.have.property('account_id');
      if (!info) {
        expect(fields.source).to.equal('unknown');
        expect(fields).not.to.have.property('client_name');
        expect(fields).not.to.have.property('client_version');
      }
    }
    expect(sessionOpenAttributes(auth, { name: 'c', version: '1' })).to.include(
      { client_name: 'c', client_version: '1' },
    );
    expect(
      sessionOpenAttributes(auth, { name: 'c\n' + '😀'.repeat(300) })
        .client_name,
    ).to.equal('c\\u000a' + '😀'.repeat(126));
  });

  it('keeps recognized attribution labels and discards arbitrary header values', () => {
    for (const source of [
      'cli_agent',
      'script_builder',
      'autologin',
      'agent_run',
      'mcp_client',
    ])
      expect(
        sessionOpenAttributes({ ...auth, source }, undefined).source,
      ).to.equal(source);
    const fields = sessionOpenAttributes(
      { ...auth, source: token, userAgent: token },
      undefined,
    );
    expect(fields).to.include({
      source: 'unknown',
      user_agent_family: 'unknown',
    });
    expect(JSON.stringify(fields)).not.to.include(token);
    expect(
      sessionOpenAttributes(
        { ...auth, userAgent: 'python-httpx/0.28.1' },
        undefined,
      ).user_agent_family,
    ).to.equal('python-httpx');
  });

  it('sends only SSE sessions through the queue and isolates telemetry failures', () => {
    const fireSessionStarted = sinon.stub();
    recordSessionOpen(
      { ...auth, source: token, userAgent: token },
      { name: 'c' },
      { fireSessionStarted },
    );
    expect(fireSessionStarted.callCount).to.equal(1);
    expect(fireSessionStarted.firstCall.args[0]).to.equal(token);
    expect(fireSessionStarted.firstCall.args[1]).not.to.have.property(
      'user_agent',
    );
    expect(JSON.stringify(fireSessionStarted.firstCall.args[1])).not.to.include(
      token,
    );
    expect(fireSessionStarted.firstCall.args[1]).to.include({
      transport: 'sse',
      key_fp: createHash('sha256').update(token).digest('hex').slice(0, 16),
    });
    recordSessionOpen({ ...auth, transport: 'streamable-http' }, undefined, {
      fireSessionStarted,
    });
    expect(fireSessionStarted.callCount).to.equal(1);
    fireSessionStarted.throws(new Error('unavailable'));
    expect(() =>
      recordSessionOpen(auth, undefined, { fireSessionStarted }),
    ).not.to.throw();
  });

  it('bounds and escapes client attribution in queue events too', () => {
    const fireSessionStarted = sinon.stub();
    recordSessionOpen(
      auth,
      {
        name: 'probe\n' + '😀'.repeat(300),
        version: 'v\u0000' + 'x'.repeat(300),
      },
      { fireSessionStarted },
    );
    expect(fireSessionStarted.firstCall.args[1]).to.include({
      client_name: 'probe\\u000a' + '😀'.repeat(122),
      client_version: 'v\\u0000' + 'x'.repeat(126),
    });
  });

  it('records once whether readiness preceded or follows connection', () => {
    for (const isReady of [true, false]) {
      const session = Object.assign(new EventEmitter(), { isReady });
      const called = sinon.spy();
      whenSessionReady(session, called);
      expect(called.callCount).to.equal(isReady ? 1 : 0);
      session.emit('ready');
      session.emit('ready');
      expect(called.callCount).to.equal(1);
    }
  });
});
