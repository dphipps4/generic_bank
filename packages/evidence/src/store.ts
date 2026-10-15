// Where trail frames are kept: an S3 bucket (MinIO, in box B) in the services, memory in tests.
// The S3 client is the few signed requests we need (AWS Signature Version 4), not an SDK.
import { createHash, createHmac } from 'node:crypto';

export interface FrameStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export function memoryStore(): FrameStore & { keys(): string[] } {
  const m = new Map<string, Buffer>();
  return {
    put: async (k, b) => void m.set(k, b),
    get: async (k) => m.get(k) ?? null,
    keys: () => [...m.keys()],
  };
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();

export function s3Store(o: {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}): FrameStore & { ensureBucket(): Promise<void> } {
  const region = o.region ?? 'us-east-1';
  const base = new URL(o.endpoint);

  async function request(
    method: 'GET' | 'PUT' | 'HEAD',
    path: string,
    body: Buffer = Buffer.alloc(0),
    contentType?: string,
  ) {
    const now = new Date();
    const date = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const day = date.slice(0, 8);
    const payloadHash = sha256(body);
    const headers: Record<string, string> = {
      host: base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const signed = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      '',
      ...signed.map((h) => `${h}:${headers[h]}`),
      '',
      signed.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
    const key = hmac(hmac(hmac(hmac(`AWS4${o.secretKey}`, day), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', key).update(toSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
    return fetch(new URL(path, base), {
      method,
      headers: { ...headers, authorization },
      ...(method === 'PUT' ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  }

  const objectPath = (key: string) =>
    `/${o.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

  return {
    async ensureBucket() {
      const head = await request('HEAD', `/${o.bucket}`);
      if (head.ok) return;
      const r = await request('PUT', `/${o.bucket}`);
      if (!r.ok && r.status !== 409)
        throw new Error(`could not create the ${o.bucket} bucket: ${r.status}`);
    },
    async put(key, body, contentType) {
      const r = await request('PUT', objectPath(key), body, contentType);
      if (!r.ok) throw new Error(`storing a frame failed: ${r.status}`);
    },
    async get(key) {
      const r = await request('GET', objectPath(key));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`reading a frame failed: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
  };
}
