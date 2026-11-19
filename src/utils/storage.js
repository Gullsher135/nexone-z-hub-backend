import crypto from 'node:crypto';

// S3-compatible object storage (Backblaze B2, Cloudflare R2, Tigris, AWS S3...) with no extra library:
// requests are signed with AWS Signature V4 using Node's own crypto. If the S3_* settings are not
// filled in, files stay in MongoDB, so local development works without any account.

const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (key, d) => crypto.createHmac('sha256', key).update(d).digest();
const encodeSeg = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const encodePath = (p) => p.split('/').map(encodeSeg).join('/');

// Builds the Authorization header for one request. Exported so it can be checked against AWS's published examples.
export function signRequest({ method, host, path, query = '', headers = {}, payloadHash, accessKey, secretKey, region, service = 's3', amzDate }) {
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const lower = {};
  Object.entries(all).forEach(([k, v]) => { lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' '); });
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, encodePath(path), query, names.map((n) => `${n}:${lower[n]}\n`).join(''), signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    signature, signedHeaders, canonicalRequest,
    headers: lower,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

function config() {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  const endpoint = /^https?:\/\//.test(S3_ENDPOINT) ? S3_ENDPOINT : `https://${S3_ENDPOINT}`;
  return { endpoint: new URL(endpoint), region: S3_REGION, bucket: S3_BUCKET, accessKey: S3_ACCESS_KEY_ID, secretKey: S3_SECRET_ACCESS_KEY };
}
export const s3Enabled = () => !!config();
export const storageLabel = () => { const c = config(); return c ? `S3-compatible bucket "${c.bucket}" at ${c.endpoint.host}` : 'MongoDB (set the S3_* variables to move files to free object storage)'; };

async function s3Fetch(method, key, { body, headers = {} } = {}) {
  const c = config();
  if (!c) throw new Error('Object storage is not configured');
  const payload = body || Buffer.alloc(0);
  const path = `${c.endpoint.pathname.replace(/\/$/, '')}/${c.bucket}/${key}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const signed = signRequest({ method, host: c.endpoint.host, path, headers, payloadHash: sha256hex(payload), accessKey: c.accessKey, secretKey: c.secretKey, region: c.region, amzDate });
  const { host, ...send } = signed.headers; // fetch fills in Host itself
  send.authorization = signed.authorization;
  let res;
  try {
    res = await fetch(`${c.endpoint.origin}${encodePath(path)}`, { method, headers: send, body: method === 'PUT' ? payload : undefined });
  } catch (err) {
    throw new Error(`File storage is unreachable: ${err.message}`);
  }
  return res;
}

export async function putObject(key, buffer, { contentType = 'application/octet-stream', filename = 'file' } = {}) {
  const disposition = `attachment; filename*=UTF-8''${encodeSeg(filename)}`; // always downloads, never renders in the page
  const res = await s3Fetch('PUT', key, { body: buffer, headers: { 'content-type': contentType, 'content-disposition': disposition } });
  if (!res.ok) throw new Error(`File storage rejected the upload (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

export async function getObject(key) {
  const res = await s3Fetch('GET', key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`File storage could not read the file (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteObject(key) {
  const res = await s3Fetch('DELETE', key);
  if (!res.ok && res.status !== 404 && res.status !== 204) throw new Error(`File storage could not delete the file (${res.status})`);
}
