import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertBodySize, MAX_BODY_BYTES } from '../body-size.mjs';

describe('assertBodySize', () => {
  it('no-op when body is null', () => {
    assert.doesNotThrow(() => assertBodySize(null));
  });

  it('no-op when body is undefined', () => {
    assert.doesNotThrow(() => assertBodySize(undefined));
  });

  it('accepts an empty body', () => {
    assert.doesNotThrow(() => assertBodySize(''));
  });

  it('accepts body exactly at the limit', () => {
    const body = 'a'.repeat(MAX_BODY_BYTES);
    assert.doesNotThrow(() => assertBodySize(body));
  });

  it('rejects body one byte over the limit with PGRST006/413', () => {
    const body = 'a'.repeat(MAX_BODY_BYTES + 1);
    assert.throws(
      () => assertBodySize(body),
      (err) => err.code === 'PGRST006' && err.statusCode === 413,
    );
  });

  it('measures UTF-8 bytes, not characters', () => {
    // A 4-byte emoji repeated until it would exceed the byte cap in
    // fewer than MAX_BODY_BYTES characters.
    const fourByteChar = '🔥'; // 4 bytes in UTF-8
    const charCount = Math.floor(MAX_BODY_BYTES / 4) + 1;
    const body = fourByteChar.repeat(charCount);
    assert.throws(
      () => assertBodySize(body),
      (err) => err.code === 'PGRST006',
      'byte-length check should reject multibyte content',
    );
  });
});
