// equivalence-map.mjs — the hand-written half of the Cedar equivalence
// measurement.
//
// For each of the 54 upstream cases carrying the `no-set-role` gap, this file
// records one verdict:
//
//   * `derived` — the outcome the upstream case asserts is decided by
//     table-level, function-level or row-level access control, so it can be
//     re-asked with a Cedar policy set standing in for the GRANT/RLS statement.
//     The derived case keeps upstream's request and upstream's expectation
//     byte-for-byte; only the authorization mechanism changes.
//
//   * `none` — no fair equivalent exists. Either the mechanism the upstream
//     case is actually testing is not authorization at all, or the Cedar layer
//     has no primitive that could express the upstream privilege, or the
//     extracted case is internally inconsistent. Recorded with the reason;
//     never counted as a pass and never counted in the denominator.
//
// Nothing in this file may relax an expectation. The derive step copies
// `request` and `expected` out of conformance/cases/ unchanged and a unit test
// asserts that they are deep-equal to the upstream case.

/** Upstream mechanism prose, keyed by the fixture statement it comes from. */
export const MECHANISMS = {
  grantAuthorsOnly:
    'GRANT ALL ON TABLE authors_only TO postgrest_test_author '
    + '(conformance/fixtures/dsql/06-privileges.sql:40), reached by SET ROLE '
    + 'postgrest_test_author from the JWT `role` claim',
  revokeAuthorsOnlyFromAnon:
    'REVOKE ALL PRIVILEGES ON TABLE authors_only FROM '
    + 'postgrest_test_anonymous (06-privileges.sql:18-23); the anonymous '
    + 'request runs as db-anon-role and PostgreSQL raises SQLSTATE 42501',
  grantPrivilegedHello:
    'REVOKE EXECUTE ON FUNCTION privileged_hello(text) FROM PUBLIC then '
    + 'GRANT EXECUTE TO postgrest_test_author (06-privileges.sql:54-57), '
    + 'reached by SET ROLE from the JWT `role` claim',
  revokePrivilegedHelloFromPublic:
    'REVOKE EXECUTE ON FUNCTION privileged_hello(text) FROM PUBLIC '
    + '(06-privileges.sql:54); the anonymous request runs as db-anon-role and '
    + 'PostgreSQL raises SQLSTATE 42501',
  setRoleNonexistent:
    'SET ROLE "not existing" fails in PostgreSQL because the role is not in '
    + 'pg_authid, and PostgREST maps SQLSTATE 22023 "role ... does not exist" '
    + 'to 401 (upstream issue #3601)',
  columnGrant:
    'column-level GRANT (GRANT SELECT (article_id, user_id) / '
    + 'GRANT SELECT (id, email), 06-privileges.sql:42-52): the row is '
    + 'reachable but one selected column is not, so PostgreSQL raises 42501 '
    + 'on the column',
  currentUser:
    'SET ROLE changes the PostgreSQL session role, and the function under '
    + 'test returns current_user',
  jwtGuc:
    'PostgREST publishes the verified JWT claims and the request headers as '
    + 'namespaced run-time parameters (set_config(\'request.jwt.claims\', ...)) '
    + 'that the SQL function reads with current_setting()',
  jwtVerification:
    'JWT decoding and claim validation inside PostgREST, before any role is '
    + 'assumed; the role never gets set and no privilege is ever consulted',
};

/** Cedar mechanism prose. */
export const CEDAR_MECHANISMS = {
  permitAuthorsOnlySelect:
    'permit(principal is PgrestLambda::User, action in [select, ...], '
    + 'resource is PgrestLambda::Row) when { principal.role == '
    + '"postgrest_test_author" && context.table == "authors_only" } '
    + '(conformance/cedar/policies/10-roles.cedar)',
  permitPrivilegedHelloCall:
    'permit(principal is PgrestLambda::User, action == call, resource == '
    + 'PgrestLambda::Function::"privileged_hello") when { principal.role == '
    + '"postgrest_test_author" } (conformance/cedar/policies/10-roles.cedar)',
  noPermitForAnonOnAuthorsOnly:
    'the anonymous grant in conformance/cedar/policies/00-anon.cedar excludes '
    + 'authors_only, so no policy permits the request and the Cedar layer is '
    + 'the deciding authority',
  noPermitForAnonOnPrivilegedHello:
    'the anonymous EXECUTE permit in '
    + 'conformance/cedar/policies/00-anon.cedar excludes privileged_hello, so '
    + 'no policy permits the call',
  noPermitForUnknownRole:
    'no permit matches principal.role, because the equivalence policy set '
    + 'grants authors_only to postgrest_test_author alone',
};

const GRANT_CAVEAT =
  'The engine did not verify this token — the harness supplies the identity '
  + 'from the payload — so a pass means only that a Cedar permit replaced a '
  + 'table-level GRANT on an empty table, not that any RLS policy or row '
  + 'filter was exercised.';

/** Whole-measurement caveat, written into cases.json as `doNotReadOverall`. */
export const DO_NOT_READ_OVERALL =
  'Do not read a passing grant equivalence as evidence that the *denial* '
  + 'shape matches upstream: the deny equivalences are measured separately '
  + 'and they fail. And do not read any of this as a PostgREST pass — the '
  + 'upstream cases stay failures in the PostgREST rate, which is the only '
  + 'number computed from upstream assertions run unmodified.';

/**
 * Verbatim-request grant equivalences: upstream expects 200 because a role
 * holds a privilege. Substituting a Cedar permit for the GRANT must produce
 * the same 200 and the same body.
 */
const GRANT_TABLE_READ = [
  'AsymmetricJwtSpec:29',
  'AsymmetricJwtSpec:38',
  'AudienceJwtSecretSpec:73',
  'AudienceJwtSecretSpec:126',
  'AudienceJwtSecretSpec:138',
  'AudienceJwtSecretSpec:150',
  'AudienceJwtSecretSpec:169',
  'AudienceJwtSecretSpec:181',
  'AudienceJwtSecretSpec:194',
  'AudienceJwtSecretSpec:206',
  'AudienceJwtSecretSpec:218',
  'AudienceJwtSecretSpec:230',
  'AudienceJwtSecretSpec:242',
  'AuthSpec:73',
  'AuthSpec:78',
  'AuthSpec:84',
  'AuthSpec:91',
  'AuthSpec:142',
  'AuthSpec:236',
  'AuthSpec:238',
  'BinaryJwtSecretSpec:23',
  'NoAnonSpec:18',
];

/** The equivalence verdict for every upstream case in the group. */
export const EQUIVALENCE_MAP = Object.fromEntries([
  // ---------------------------------------------------------------- grants
  ...GRANT_TABLE_READ.map((id) => [id, {
    equivalence: 'derived',
    upstreamMechanism: MECHANISMS.grantAuthorsOnly,
    cedarMechanism: CEDAR_MECHANISMS.permitAuthorsOnlySelect,
    policyFile: 'conformance/cedar/policies/10-roles.cedar',
    doNotRead: GRANT_CAVEAT,
  }]),
  ['AuthSpec:45', {
    equivalence: 'derived',
    upstreamMechanism: MECHANISMS.grantPrivilegedHello,
    cedarMechanism: CEDAR_MECHANISMS.permitPrivilegedHelloCall,
    policyFile: 'conformance/cedar/policies/10-roles.cedar',
    doNotRead:
      'A Cedar permit on PgrestLambda::Function is per function name, not per '
      + 'overload — upstream\'s GRANT names privileged_hello(text) — and the '
      + 'harness, not the engine, established the identity.',
  }],

  // ------------------------------------------------------------ denials
  ['AuthSpec:16', {
    equivalence: 'derived',
    upstreamMechanism: MECHANISMS.revokeAuthorsOnlyFromAnon,
    cedarMechanism: CEDAR_MECHANISMS.noPermitForAnonOnAuthorsOnly,
    policyFile: 'conformance/cedar/policies/00-anon.cedar',
    doNotRead:
      'this case measures the shape of a denial, not whether access was '
      + 'denied; both mechanisms deny, and the case still fails because the '
      + 'status, body and WWW-Authenticate header differ.',
  }],
  ['AuthSpec:41', {
    equivalence: 'derived',
    upstreamMechanism: MECHANISMS.revokePrivilegedHelloFromPublic,
    cedarMechanism: CEDAR_MECHANISMS.noPermitForAnonOnPrivilegedHello,
    policyFile: 'conformance/cedar/policies/00-anon.cedar',
    doNotRead:
      'this case measures the status of a denied function call, not whether '
      + 'the call was denied; both mechanisms deny it.',
  }],
  ['AuthSpec:130', {
    equivalence: 'derived',
    upstreamMechanism: MECHANISMS.revokeAuthorsOnlyFromAnon
      + '; the token carries no `role` claim, so PostgREST falls back to '
      + 'db-anon-role',
    cedarMechanism:
      'the engine treats a token with no `role` claim as role '
      + '"authenticated", and the equivalence policy set grants authors_only '
      + 'to postgrest_test_author alone, so no permit matches',
    policyFile: 'conformance/cedar/policies/10-roles.cedar',
    doNotRead:
      'the two mechanisms do not even agree on the identity — upstream falls '
      + 'back to the anonymous role, the engine to "authenticated" — so a '
      + 'matching outcome here would not mean the identities matched.',
  }],
  ['AuthSpec:135', {
    equivalence: 'derived',
    upstreamMechanism: MECHANISMS.revokeAuthorsOnlyFromAnon
      + '; the token carries an `id` claim but no `role`, so PostgREST falls '
      + 'back to db-anon-role',
    cedarMechanism:
      'the engine treats a token with no `role` claim as role '
      + '"authenticated", and the equivalence policy set grants authors_only '
      + 'to postgrest_test_author alone, so no permit matches',
    policyFile: 'conformance/cedar/policies/10-roles.cedar',
    doNotRead:
      'the two mechanisms do not even agree on the identity — upstream falls '
      + 'back to the anonymous role, the engine to "authenticated" — so a '
      + 'matching outcome here would not mean the identities matched.',
  }],
  ['ErrorSpec:123', {
    equivalence: 'derived',
    upstreamMechanism: MECHANISMS.setRoleNonexistent,
    cedarMechanism: CEDAR_MECHANISMS.noPermitForUnknownRole,
    policyFile: 'conformance/cedar/policies/10-roles.cedar',
    doNotRead:
      'Cedar\'s principal set is open, so "unknown role" and "known role '
      + 'without a grant" are the same outcome here; a pass would not mean '
      + 'the engine validated the role name.',
  }],

  // --------------------------------------------------- no fair equivalent
  //
  // (a) JWT decoding / claim validation. The upstream assertion is reached
  //     before any role is assumed, so there is no GRANT or RLS policy to
  //     substitute a Cedar permit for. These land in the `no-set-role` gap
  //     only because the harness supplies the authorizer identity itself and
  //     the request therefore reaches the Cedar check instead of being
  //     rejected at the token.
  ...[
    ['AuthSpec:96', 'the Authorization header is `Bearer ` with an empty token'],
    ['AuthSpec:108', 'the token is expired (exp in the past)'],
    ['AuthSpec:119', 'the token has two segments instead of three'],
    ['AuthSpec:152', 'the `exp` claim is a string, not a number'],
    ['AuthSpec:164', 'the `nbf` claim is a string, not a number'],
    ['AuthSpec:176', 'the `iat` claim is a string, not a number'],
    ['AuthSpec:188', 'the `aud` claim is an object, not a string or array'],
    ['AuthSpec:200', 'the `aud` array holds a non-string element'],
    ['ErrorSpec:53', 'the token has two segments instead of three'],
    ['ErrorSpec:110', 'the token is signed with the wrong secret'],
    ['ErrorSpec:138', 'the token is expired (exp 35 s in the past)'],
    ['ErrorSpec:152', 'the token is not yet valid (nbf 35 s in the future)'],
    ['ErrorSpec:166', 'the token was issued in the future (iat)'],
    ['ErrorSpec:193', 'the token has two segments instead of three'],
    ['ErrorSpec:205', 'the token is three segments of random characters'],
    ['ErrorSpec:217', "the token declares alg 'none'"],
  ].map(([id, why]) => [id, {
    equivalence: 'none',
    class: 'jwt-verification',
    upstreamMechanism: MECHANISMS.jwtVerification,
    reason:
      `The asserted 401 comes from JWT validation — ${why} — not from a `
      + 'privilege check. Substituting a Cedar policy set would not be '
      + 'testing the same mechanism: no policy set can make the engine reject '
      + 'a token, and no policy set is consulted upstream. The case appears '
      + 'in the no-set-role group only because this harness builds the '
      + 'authorizer context by decoding the payload without verifying it, so '
      + 'the request reaches the authorization layer at all.',
    doNotRead:
      'the absence of an equivalence here says nothing about whether the '
      + 'engine can reject this token: the engine has its own JWT '
      + 'verification path (jwt-secret / restJwt), it is simply not the '
      + 'mechanism upstream\'s SET ROLE cases stand in for.',
  }]),

  // (b) session identity and namespaced run-time parameters.
  ['AuthSpec:68', {
    equivalence: 'none',
    class: 'session-identity-guc',
    upstreamMechanism: MECHANISMS.jwtGuc,
    reason:
      'reveal_big_jwt() reads current_setting(\'request.jwt.claims\'). The '
      + 'engine publishes no namespaced run-time parameters, and a Cedar '
      + 'policy cannot create one: Cedar decides permit/forbid and (for '
      + 'reads) contributes a WHERE fragment. There is no policy set under '
      + 'which this function returns the claim values.',
    doNotRead:
      'this is a missing feature of the engine (request GUCs), not a '
      + 'limitation of Cedar; counting it as "no equivalent" must not be read '
      + 'as the outcome being unreachable in principle.',
  }],
  ...['AuthSpec:209', 'AuthSpec:218'].map((id) => [id, {
    equivalence: 'none',
    class: 'session-identity-guc',
    upstreamMechanism: MECHANISMS.currentUser,
    reason:
      'get_current_user() returns current_user. Cedar authorizes a request; '
      + 'it never changes the PostgreSQL session role, and Aurora DSQL has no '
      + 'SET ROLE, so current_user is always the connection\'s own user. No '
      + 'policy set can change what this function returns.',
    doNotRead:
      'the engine deliberately has no session-role switch — the identity '
      + 'lives in the authorizer context and the policy set, not in the '
      + 'database session — so "no equivalent" here is a statement about the '
      + 'architecture, not about a bug.',
  }]),
  ['AuthSpec:227', {
    equivalence: 'none',
    class: 'session-identity-guc',
    upstreamMechanism: MECHANISMS.currentUser
      + ', with a plpgsql pre-request function that RAISEs P0001 for the '
      + 'disabled id',
    reason:
      'the asserted 400 / P0001 body is raised by a plpgsql function that '
      + 'inspects the JWT claims and refuses to switch role. DSQL supports '
      + 'neither plpgsql nor SET ROLE, and a Cedar denial cannot carry a '
      + 'caller-authored SQLSTATE, message and hint.',
    doNotRead:
      'a Cedar forbid does deny the request; what it cannot reproduce is the '
      + 'error payload the upstream function chooses, so this is about the '
      + 'response body, not about whether access is blocked.',
  }],
  ['RpcSpec:923', {
    equivalence: 'none',
    class: 'session-identity-guc',
    upstreamMechanism: MECHANISMS.jwtGuc,
    reason:
      'get_guc_value(\'request.headers\', \'authorization\') reads a '
      + 'namespaced run-time parameter. The engine sets none, and no Cedar '
      + 'policy can create one.',
    doNotRead:
      'this measures request-GUC exposure, which CONTRACTS.md already lists '
      + 'as out of scope for this architecture; it is unrelated to whether '
      + 'authorization works.',
  }],

  // (c) column-level privileges.
  ...[
    ['DeleteSpec:124',
      'DELETE /app_users?id=eq.1 with Prefer: return=representation. '
      + 'postgrest_test_anonymous holds DELETE on app_users but SELECT only on '
      + '(id, email), so returning the representation touches the `password` '
      + 'column it may not read'],
    ['InsertSpec:716',
      'POST /limited_article_stars?select=article_id,user_id,created_at. '
      + 'postgrest_test_anonymous holds INSERT and SELECT on '
      + '(article_id, user_id) only, so selecting created_at is denied'],
    ['InsertSpec:724',
      'POST /limited_article_stars with Prefer: return=representation and no '
      + 'select, which returns every column including the two the role may '
      + 'not read'],
  ].map(([id, why]) => [id, {
    equivalence: 'none',
    class: 'column-level-privilege',
    upstreamMechanism: MECHANISMS.columnGrant,
    reason:
      `${why}. The Cedar layer has no column-level primitive at all: `
      + 'src/rest/cedar.mjs authorizes actions against '
      + 'PgrestLambda::Table / ::Row / ::Function and contributes row '
      + 'predicates, and nothing in the policy model names a column as a '
      + 'resource. There is therefore no policy set that permits the write '
      + 'and denies the column, which is what the upstream case asserts.',
    doNotRead:
      'this is the one genuine capability gap in the group: the finding is '
      + 'that the Cedar layer cannot express a column-level privilege, not '
      + 'that the case is uninteresting.',
  }]),

  // (d) the extracted case is internally inconsistent.
  ...[
    ['AudienceJwtSecretSpec:32',
      'the assertion at line 32 belongs to `it "succeeds when the audience '
      + 'claim matches"` (line 23), whose payload has aud "youraudience", but '
      + 'the extracted request carries aud "notyouraudience" — the payload of '
      + 'the *next* `it`'],
    ['AudienceJwtSecretSpec:85',
      'the assertion at line 85 belongs to `it "succeeds when the audience '
      + 'claim has more than 1 element and one matches"` (line 75), whose '
      + 'payload includes "youraudience", but the extracted request carries '
      + 'aud ["notyouraudience"] — the payload of the *next* `it`'],
  ].map(([id, why]) => [id, {
    equivalence: 'none',
    class: 'extraction-defect',
    upstreamMechanism: MECHANISMS.grantAuthorsOnly,
    reason:
      `${why}. The engine runs this spec range with jwt-aud=youraudience `
      + '(conformance/runner/run.mjs ENGINE_CONFIGS), so it answers 401 "JWT '
      + 'not in audience" — which is what upstream would answer to the '
      + 'request as extracted. Asserting 200 for that request contradicts '
      + 'upstream\'s own behaviour, so no policy set can make the case hold '
      + 'without disabling audience checking, and disabling it would be '
      + 'weakening the expectation.',
    doNotRead:
      'the grant equivalence these two cases would have measured is already '
      + 'measured by the eleven sibling AudienceJwtSecretSpec cases that '
      + 'extracted cleanly; excluding these two removes a harness defect from '
      + 'the numerator and the denominator, not an engine failure.',
  }]),
]);
