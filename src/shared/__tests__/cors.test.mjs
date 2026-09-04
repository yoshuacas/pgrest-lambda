import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCorsHeaders, assertCorsConfig, CORS_HEADERS,
  ALLOW_HEADERS, EXPOSE_HEADERS, preflightHeaders,
} from '../cors.mjs';

const EXPECTED_ALLOW_HEADERS = ALLOW_HEADERS;
// Both literals are PostgREST's own, byte for byte: `corsMethods` after
// wai-cors folds in the simple methods (which is where HEAD comes from), and
// `corsExposedHeaders` (src/library/PostgREST/Cors.hs). They are pinned here
// rather than read off the module so a change to either has to be a deliberate
// edit in two places — the wire contract browsers see is the whole point.
const EXPECTED_ALLOW_METHODS =
  'GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD';
const EXPECTED_EXPOSE_HEADERS =
  'Content-Encoding, Content-Location, Content-Range, Content-Type, '
  + 'Date, Location, Server, Transfer-Encoding, Range-Unit';

// Pin the specific headers the @supabase/* SDK family sends so a
// future trim of ALLOW_HEADERS can't silently re-break CORS preflight
// for browsers using supabase-js. Update this list only when you've
// verified the SDK no longer sends the removed header.
const REQUIRED_ALLOW_HEADERS = [
  'Accept', 'Accept-Profile', 'Authorization', 'Content-Profile',
  'Content-Type', 'Prefer', 'Range', 'apikey', 'X-Client-Info',
  'X-Metadata', 'X-Region', 'X-Retry-Count',
  'X-Supabase-Api-Version', 'X-Upsert',
];
// The response headers the SDK actually reads cross-origin. `Content-Range` is
// how postgrest-js reports counts, `Location`/`Content-Location` identify a
// created row.
//
// `X-Total-Count` and `X-Relay-Error` used to be on this list. Neither is ever
// emitted by this engine (nothing outside cors.mjs mentions them) and neither
// is emitted by PostgREST, which the browser build of supabase-js is written
// against — exposing them named headers that never arrive. The list is now
// PostgREST's `corsExposedHeaders` verbatim; see EXPECTED_EXPOSE_HEADERS.
const REQUIRED_EXPOSE_HEADERS = [
  'Content-Range', 'Content-Location', 'Location', 'Content-Type',
];

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

describe('preflightHeaders', () => {
  it('echoes the requested headers behind Authorization', () => {
    const h = preflightHeaders('Foo,Bar');
    assert.equal(
      h['Access-Control-Allow-Headers'],
      'Authorization, Foo, Bar, Accept, Accept-Language, Content-Language',
      'preflight allow-list is Authorization, the asked-for headers, then the '
      + 'simple request headers — PostgREST\'s wai-cors policy',
    );
  });

  it('trims the spelling the browser sent', () => {
    const h = preflightHeaders(' apikey , X-Client-Info ');
    assert.equal(
      h['Access-Control-Allow-Headers'],
      'Authorization, apikey, X-Client-Info, Accept, Accept-Language, '
      + 'Content-Language',
      'each entry is trimmed, none dropped',
    );
  });

  it('falls back to the static allow-list with nothing to echo', () => {
    const h = preflightHeaders(undefined);
    assert.equal(
      h['Access-Control-Allow-Headers'], ALLOW_HEADERS,
      'a preflight that asks about no headers gets the static superset',
    );
  });

  it('caches the answer for a day', () => {
    assert.equal(
      preflightHeaders('Content-Type')['Access-Control-Max-Age'], '86400',
      'Max-Age is 60*60*24, as PostgREST sets it',
    );
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

describe('supabase-js compatibility', () => {
  it('allows every request header the @supabase/* SDKs send', () => {
    const headers = buildCorsHeaders(
      { allowedOrigins: '*', allowCredentials: false },
    );
    const allowed = headers['Access-Control-Allow-Headers']
      .toLowerCase()
      .split(/\s*,\s*/);
    for (const h of REQUIRED_ALLOW_HEADERS) {
      assert.ok(
        allowed.includes(h.toLowerCase()),
        `Access-Control-Allow-Headers must include "${h}" — the supabase-js SDK `
        + 'sends it and browsers will fail the CORS preflight without it.',
      );
    }
  });

  it('exposes every response header the @supabase/* SDKs read', () => {
    const headers = buildCorsHeaders(
      { allowedOrigins: '*', allowCredentials: false },
    );
    const exposed = headers['Access-Control-Expose-Headers']
      .toLowerCase()
      .split(/\s*,\s*/);
    for (const h of REQUIRED_EXPOSE_HEADERS) {
      assert.ok(
        exposed.includes(h.toLowerCase()),
        `Access-Control-Expose-Headers must include "${h}" — the supabase-js SDK `
        + 'reads it via response.headers.get() and browsers block unexposed headers.',
      );
    }
  });
});
