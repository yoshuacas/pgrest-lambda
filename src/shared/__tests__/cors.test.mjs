import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorsHeaders, assertCorsConfig, CORS_HEADERS } from '../cors.mjs';

const EXPECTED_ALLOW_HEADERS =
  'Accept, Authorization, Content-Type, Prefer, apikey, X-Client-Info';
const EXPECTED_ALLOW_METHODS =
  'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const EXPECTED_EXPOSE_HEADERS = 'Content-Range';

function assertStaticHeaders(headers) {
  assert.equal(
    headers['Access-Control-Allow-Headers'],
    EXPECTED_ALLOW_HEADERS,
    'Allow-Headers must match static value',
  );
  assert.equal(
    headers['Access-Control-Allow-Methods'],
    EXPECTED_ALLOW_METHODS,
    'Allow-Methods must match static value',
  );
  assert.equal(
    headers['Access-Control-Expose-Headers'],
    EXPECTED_EXPOSE_HEADERS,
    'Expose-Headers must match static value',
  );
}

describe('buildCorsHeaders', () => {
  describe('wildcard (default)', () => {
    it('returns * with no Vary when no origin is provided', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: '*', allowCredentials: false },
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'], '*',
        'Allow-Origin should be *',
      );
      assert.equal(
        headers['Vary'], undefined,
        'Vary should not be present for wildcard',
      );
    });

    it('returns * with no Vary even when origin is provided', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: '*', allowCredentials: false },
        'https://example.com',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'], '*',
        'Allow-Origin should be * regardless of origin',
      );
      assert.equal(
        headers['Vary'], undefined,
        'Vary should not be present for wildcard',
      );
    });

    it('returns static defaults when corsConfig is undefined', () => {
      const headers = buildCorsHeaders(undefined);
      assert.equal(
        headers['Access-Control-Allow-Origin'],
        CORS_HEADERS['Access-Control-Allow-Origin'],
        'Allow-Origin should match static CORS_HEADERS',
      );
      assertStaticHeaders(headers);
    });
  });

  describe('array allowlist', () => {
    it('reflects origin when it matches the allowlist', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: ['https://app.example.com'], allowCredentials: false },
        'https://app.example.com',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'],
        'https://app.example.com',
        'Allow-Origin should reflect the matched origin',
      );
      assert.equal(
        headers['Vary'], 'Origin',
        'Vary should be Origin for array allowlist',
      );
    });

    it('omits Allow-Origin when origin does not match', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: ['https://app.example.com'], allowCredentials: false },
        'https://evil.com',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'], undefined,
        'Allow-Origin should not be present for non-matching origin',
      );
      assert.equal(
        headers['Vary'], 'Origin',
        'Vary should be Origin even when origin is rejected',
      );
    });

    it('omits Allow-Origin when allowedOrigins is empty', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: [], allowCredentials: false },
        'https://anything.com',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'], undefined,
        'Allow-Origin should not be present for empty allowlist',
      );
      assert.equal(
        headers['Vary'], 'Origin',
        'Vary should be Origin for empty array',
      );
    });

    it('matches second entry in multi-origin list', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: ['https://a.com', 'https://b.com'], allowCredentials: false },
        'https://b.com',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'],
        'https://b.com',
        'Allow-Origin should reflect the matched origin',
      );
    });

    it('rejects literal "null" origin from sandboxed iframe', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: ['https://a.com'], allowCredentials: false },
        'null',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'], undefined,
        'Allow-Origin should not be present for "null" origin',
      );
      assert.equal(
        headers['Vary'], 'Origin',
        'Vary should be Origin',
      );
    });
  });

  describe('function allowlist', () => {
    it('reflects origin when function returns true', () => {
      const headers = buildCorsHeaders(
        {
          allowedOrigins: (o) => o.endsWith('.example.com'),
          allowCredentials: false,
        },
        'https://app.example.com',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'],
        'https://app.example.com',
        'Allow-Origin should reflect origin when function allows it',
      );
      assert.equal(
        headers['Vary'], 'Origin',
        'Vary should be Origin for function allowlist',
      );
    });

    it('omits Allow-Origin when function returns false', () => {
      const headers = buildCorsHeaders(
        {
          allowedOrigins: (o) => o.endsWith('.example.com'),
          allowCredentials: false,
        },
        'https://evil.com',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'], undefined,
        'Allow-Origin should not be present when function rejects',
      );
      assert.equal(
        headers['Vary'], 'Origin',
        'Vary should be Origin even when function rejects',
      );
    });

    it('passes the raw origin string to the function', () => {
      let captured = null;
      buildCorsHeaders(
        {
          allowedOrigins: (o) => { captured = o; return true; },
          allowCredentials: false,
        },
        'https://test-origin.io',
      );
      assert.equal(
        captured,
        'https://test-origin.io',
        'function should receive the raw origin string',
      );
    });
  });

  describe('credentials', () => {
    it('sets Allow-Credentials when allowCredentials=true and origin matches', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: ['https://a.com'], allowCredentials: true },
        'https://a.com',
      );
      assert.equal(
        headers['Access-Control-Allow-Credentials'], 'true',
        'Allow-Credentials should be "true"',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'],
        'https://a.com',
        'Allow-Origin should reflect matched origin',
      );
    });

    it('omits Allow-Credentials when allowCredentials=true but origins is wildcard', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: '*', allowCredentials: true },
      );
      assert.equal(
        headers['Access-Control-Allow-Credentials'], undefined,
        'Allow-Credentials should not be present with wildcard origin',
      );
      assert.equal(
        headers['Access-Control-Allow-Origin'], '*',
        'Allow-Origin should still be *',
      );
    });

    it('omits Allow-Credentials when allowCredentials=false', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: ['https://a.com'], allowCredentials: false },
        'https://a.com',
      );
      assert.equal(
        headers['Access-Control-Allow-Credentials'], undefined,
        'Allow-Credentials should not be present when false',
      );
    });
  });

  describe('static headers preserved', () => {
    it('includes static headers with wildcard config', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: '*', allowCredentials: false },
      );
      assertStaticHeaders(headers);
    });

    it('includes static headers with array config', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: ['https://a.com'], allowCredentials: false },
        'https://a.com',
      );
      assertStaticHeaders(headers);
    });

    it('includes static headers with function config', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: () => true, allowCredentials: false },
        'https://a.com',
      );
      assertStaticHeaders(headers);
    });

    it('includes static headers when origin is rejected', () => {
      const headers = buildCorsHeaders(
        { allowedOrigins: ['https://a.com'], allowCredentials: false },
        'https://evil.com',
      );
      assertStaticHeaders(headers);
    });
  });
});

describe('assertCorsConfig', () => {
  it('throws when wildcard in production mode', () => {
    assert.throws(
      () => assertCorsConfig({ allowedOrigins: '*' }, true),
      (err) => {
        assert.ok(err instanceof Error, 'should be an Error');
        assert.ok(
          err.message.startsWith('pgrest-lambda:'),
          'message should start with pgrest-lambda:',
        );
        assert.ok(
          err.message.includes('production'),
          'message should mention production',
        );
        assert.ok(
          err.message.includes('allowedOrigins'),
          'message should mention allowedOrigins',
        );
        return true;
      },
    );
  });

  it('does not throw for array allowlist in production', () => {
    const result = assertCorsConfig(
      { allowedOrigins: ['https://a.com'] }, true,
    );
    assert.equal(
      result, undefined,
      'should return undefined (no error)',
    );
  });

  it('does not throw for wildcard in non-production', () => {
    const result = assertCorsConfig(
      { allowedOrigins: '*' }, false,
    );
    assert.equal(
      result, undefined,
      'should return undefined (no error)',
    );
  });
});
