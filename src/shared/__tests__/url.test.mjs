import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeRedirect } from '../url.mjs';

describe('isSafeRedirect', () => {
  it('test_isSafeRedirect_rejects_protocol_relative_url', () => {
    assert.equal(
      isSafeRedirect('//evil.com/phish', 'https://app.com'),
      false,
      'protocol-relative URL must be rejected',
    );
  });

  it('test_isSafeRedirect_accepts_same_origin', () => {
    assert.equal(
      isSafeRedirect('https://app.com/path', 'https://app.com'),
      true,
      'same-origin URL should be accepted',
    );
  });

  it('test_isSafeRedirect_rejects_different_origin', () => {
    assert.equal(
      isSafeRedirect('https://evil.com/phish', 'https://app.com'),
      false,
      'different-origin URL must be rejected',
    );
  });

  it('test_isSafeRedirect_rejects_javascript_protocol', () => {
    assert.equal(
      isSafeRedirect('javascript:alert(1)', 'https://app.com'),
      false,
      'javascript: URL must be rejected',
    );
  });

  it('test_isSafeRedirect_rejects_empty_string', () => {
    assert.equal(
      isSafeRedirect('', 'https://app.com'),
      false,
      'empty string must be rejected',
    );
  });

  it('test_isSafeRedirect_accepts_relative_path', () => {
    assert.equal(
      isSafeRedirect('/relative/path', 'https://app.com'),
      true,
      'relative path should be accepted',
    );
  });

  it('test_isSafeRedirect_rejects_protocol_relative_with_path', () => {
    assert.equal(
      isSafeRedirect('//evil.com/phish#fragment', 'https://app.com'),
      false,
      'protocol-relative URL with fragment must be rejected',
    );
  });
});
