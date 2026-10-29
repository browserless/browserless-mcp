import { readFile } from 'node:fs/promises';
import type { McpConfig } from '../@types/types.js';
import type { AgentRunResult } from '../tools/agent.js';
import { downloadOwner, getDownload } from './download-store.js';
import { replayViews } from './view-store.js';

export interface MediaInput {
  type: 'image' | 'video';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/webm';
  body: Buffer;
  label: string;
  rationale: string;
  commandIndex: number;
  website?: string;
  width?: number;
  height?: number;
}

export const mediaOrigin = (
  config: Pick<McpConfig, 'transport' | 'mcpBaseUrl'>,
): string | undefined => {
  const url = URL.parse(config.mcpBaseUrl ?? '');
  if (
    config.transport !== 'httpStream' ||
    !url ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return;
  if (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    return url.origin;
  return undefined;
};

export function matchesMediaType(
  body: Buffer,
  mime: MediaInput['mimeType'],
): boolean {
  if (mime === 'image/png')
    return (
      body.length >= 24 &&
      body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  if (mime === 'image/jpeg')
    return (
      body.length >= 4 && body[0] === 255 && body[1] === 216 && body[2] === 255
    );
  if (mime === 'image/webp')
    return (
      body.length >= 12 &&
      body.toString('ascii', 0, 4) === 'RIFF' &&
      body.toString('ascii', 8, 12) === 'WEBP'
    );
  return (
    body.length >= 8 &&
    body.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
    body.subarray(0, 4096).includes(Buffer.from('webm'))
  );
}

export async function prepareAgentMedia(
  owner: string,
  token: string,
  run: AgentRunResult,
  rationale = '',
) {
  const inputs: MediaInput[] = [];
  for (const [index, command] of run.results.entries()) {
    const result = command.result as
      { base64?: unknown; download?: { id?: string } } | undefined;
    let body: Buffer, mimeType: MediaInput['mimeType'];
    if (command.method === 'screenshot' && typeof result?.base64 === 'string') {
      const types = {
        png: 'image/png',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
      } as const;
      const type = command.params.type ?? 'png';
      if (
        !(typeof type === 'string' && type in types) ||
        result.base64.length > 4 * Math.ceil((50 * 1024 * 1024) / 3) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)
      )
        continue;
      mimeType = types[type as keyof typeof types];
      body = Buffer.from(result.base64, 'base64');
    } else if (command.method === 'stopRecording' && result?.download?.id) {
      const stored = getDownload(result.download.id, downloadOwner(token));
      if (!stored || stored.mimeType !== 'video/webm') continue;
      mimeType = 'video/webm';
      body = await readFile(stored.path);
    } else continue;
    if (!matchesMediaType(body, mimeType)) continue;
    const type = mimeType === 'video/webm' ? 'video' : 'image';
    let website: string | undefined;
    try {
      website = new URL(command.pageUrl ?? '').hostname.slice(0, 256);
    } catch {
      /* Unknown capture location. */
    }
    inputs.push({
      type,
      mimeType,
      body,
      label: `${type === 'image' ? 'Screenshot' : 'Recording'} ${inputs.filter((item) => item.type === type).length + 1}`,
      rationale: rationale.slice(0, 500),
      commandIndex: index + 1,
      ...(website ? { website } : {}),
      ...(mimeType === 'image/png'
        ? { width: body.readUInt32BE(16), height: body.readUInt32BE(20) }
        : {}),
    });
  }
  return inputs.length ? replayViews.prepareMedia(owner, inputs) : undefined;
}
