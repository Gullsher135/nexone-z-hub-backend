import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signRequest } from '../src/utils/storage.js';

const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
const KEY = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z' };

// These two requests and signatures are the examples published in the AWS Signature V4 documentation.
test('SigV4 matches the AWS "GET Object" example', () => {
  const r = signRequest({ ...KEY, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: sha('') });
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('SigV4 matches the AWS "PUT Object" example (special characters in the key)', () => {
  const r = signRequest({ ...KEY, method: 'PUT', host: 'examplebucket.s3.amazonaws.com', path: '/test$file.text', headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash: sha('Welcome to Amazon S3.') });
  assert.equal(r.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});
