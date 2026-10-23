import dns from 'node:dns';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { FILE_TRANSFER_MAX_BYTES } from './download-store.js';

const failure = (reason = 'failed') =>
  new Error(`Native file download ${reason}`);

function isPublic(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  // Mapped IPv4, transition mechanisms, and all special-purpose ranges are
  // deliberately excluded rather than translated into another address family.
  if (parsed.range() !== 'unicast') return false;
  if (parsed instanceof ipaddr.IPv6) {
    // Only the currently allocated global-unicast space; exclude the IETF
    // special-purpose block as well (including documentation and ORCHID).
    return (
      parsed.match(ipaddr.IPv6.parse('2000::'), 3) &&
      !parsed.match(ipaddr.IPv6.parse('2001::'), 23) &&
      !parsed.match(ipaddr.IPv6.parse('3fff::'), 20)
    );
  }
  return !parsed.match(ipaddr.IPv4.parse('198.18.0.0'), 15);
}

/** No native hosts are trusted by default. Host grants are explicit code inputs. */
export async function downloadNativeFile(
  candidate: string,
  allowedHosts: readonly string[] = [],
): Promise<Buffer> {
  if (!allowedHosts.length)
    throw failure('disabled: no trusted hosts configured');
  let url: URL;
  try {
    url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !allowedHosts.includes(url.hostname) ||
      // Literals bypass Node's lookup hook; reject them rather than bypassing
      // the connection-bound DNS policy.
      isIP(url.hostname) ||
      url.hostname.startsWith('[')
    )
      throw failure();
  } catch {
    throw failure();
  }

  return new Promise<Buffer>((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const fail = (reason = 'failed') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      response?.destroy();
      request?.destroy();
      reject(failure(reason));
    };
    const timer = setTimeout(() => fail('timed out after 30 seconds'), 30_000);
    try {
      request = https.request(
        {
          hostname: url.hostname,
          servername: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: 'GET',
          agent: false,
          // https forwards this net.connect option, absent from RequestOptions.
          ...{ autoSelectFamily: false },
          // The TLS socket uses this exact validated answer. No preflight lookup
          // followed by a second (potentially rebound) resolution is performed.
          lookup: (hostname, _options, callback) => {
            dns.lookup(
              hostname,
              { all: true, verbatim: true },
              (error, records) => {
                if (settled) return;
                if (
                  error ||
                  !records?.length ||
                  records.some(
                    (r) => !isPublic(r.address) || isIP(r.address) !== r.family,
                  )
                ) {
                  callback(failure(), '', 4);
                  return;
                }
                callback(null, records[0].address, records[0].family);
              },
            );
          },
        },
        (incoming) => {
          response = incoming;
          incoming.on('error', () => fail());
          incoming.on('aborted', () => fail());
          incoming.on('close', () => {
            if (!incoming.complete) fail();
          });
          if (settled) {
            incoming.destroy();
            return;
          }
          const length = incoming.headers['content-length'];
          if (incoming.statusCode !== 200) {
            const code = incoming.statusCode ?? 0;
            fail(
              code >= 300 && code < 400
                ? 'rejected redirect'
                : `failed: HTTP ${code} (link may have expired)`,
            );
            return;
          }
          if (
            length !== undefined &&
            (!/^\d+$/.test(length) || Number(length) > FILE_TRANSFER_MAX_BYTES)
          ) {
            fail(
              'rejected invalid or oversized Content-Length (50 MiB size limit)',
            );
            return;
          }
          incoming.on('data', (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > FILE_TRANSFER_MAX_BYTES) {
              fail('exceeded the 50 MiB size limit');
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(Buffer.concat(chunks, size));
          });
        },
      );
      request.on('error', () => fail());
      request.end();
    } catch {
      fail();
    }
  });
}
