// cedar.mjs — Cedar policy-based authorization module

import {
  isAuthorized,
  isAuthorizedPartial,
} from '@cedar-policy/cedar-wasm/nodejs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgRESTError } from './errors.mjs';

// --- Policy source resolution ---
//
// POLICIES_PATH accepts either:
//   • a plain filesystem path (default: ./policies)
//   • file:///absolute/path        (explicit filesystem)
//   • s3://<bucket>/<prefix>       (S3 object listing)
//
// Callers pass the raw value as config.policiesPath. parsePolicySource
// splits it into { scheme, ... } so the loader can dispatch on scheme.

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

export function parsePolicySource(raw) {
  if (!raw) return { scheme: 'file', path: './policies' };
  const m = SCHEME_RE.exec(raw);
  if (!m) {
    return { scheme: 'file', path: raw };
  }
  const [, scheme, rest] = m;
  if (scheme === 'file') {
    // file:///absolute/path  → path is everything after the scheme;
    // strip a single leading slash to accept triple-slash form.
    return { scheme: 'file', path: rest.startsWith('/') ? rest : '/' + rest };
  }
  if (scheme === 's3') {
    // s3://bucket/prefix/...  → first segment is the bucket, rest is the key prefix
    const slash = rest.indexOf('/');
    if (slash === -1) {
      return { scheme: 's3', bucket: rest, prefix: '' };
    }
    return { scheme: 's3', bucket: rest.slice(0, slash), prefix: rest.slice(slash + 1) };
  }
  throw new Error(
    `Unsupported POLICIES_PATH scheme '${scheme}'. Use a filesystem path or s3://<bucket>/<prefix>.`
  );
}

// --- Policy loading helpers (stateless) ---

async function loadFromFilesystem(dirPath) {
  try {
    const files = await readdir(dirPath);
    const texts = [];
    for (const file of files) {
      if (!file.endsWith('.cedar')) continue;
      const text = await readFile(join(dirPath, file), 'utf-8');
      texts.push(text);
    }
    return texts.join('\n');
  } catch {
    return '';
  }
}

async function loadFromS3(bucket, prefix, region) {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } =
    await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region });
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }));
  const policyTexts = [];
  for (const obj of list.Contents || []) {
    if (!obj.Key.endsWith('.cedar')) continue;
    const resp = await s3.send(new GetObjectCommand({
      Bucket: bucket, Key: obj.Key,
    }));
    policyTexts.push(await resp.Body.transformToString());
  }
  return policyTexts.join('\n');
}

// --- PG type to Cedar type mapping ---

function pgTypeToCedarType(pgType) {
  const t = pgType.toLowerCase();
  if (['text', 'varchar', 'char', 'character varying', 'uuid'].includes(t)) {
    return 'String';
  }
  if (['integer', 'smallint', 'bigint', 'int', 'serial', 'bigserial'].includes(t)) {
    return 'Long';
  }
  if (t === 'boolean') return 'Boolean';
  return 'String';
}

// --- Cedar schema generation ---

export function generateCedarSchema(dbSchema) {
  const attrs = {};
  for (const tableDef of Object.values(dbSchema.tables)) {
    for (const [colName, col] of Object.entries(tableDef.columns)) {
      attrs[colName] = { type: pgTypeToCedarType(col.type) };
    }
  }
  return {
    PgrestLambda: {
      entityTypes: {
        User: {
          shape: {
            type: 'Record',
            attributes: {
              email: { type: 'String' },
              role: { type: 'String' },
            },
          },
        },
        ServiceRole: {},
        AnonRole: {},
        Table: {},
        Function: {},
        Row: {
          memberOfTypes: ['Table'],
          shape: {
            type: 'Record',
            attributes: attrs,
          },
        },
      },
      actions: {
        select: {
          appliesTo: {
            principalTypes: ['User', 'ServiceRole', 'AnonRole'],
            resourceTypes: ['Table', 'Row'],
          },
        },
        insert: {
          appliesTo: {
            principalTypes: ['User', 'ServiceRole', 'AnonRole'],
            resourceTypes: ['Table', 'Row'],
          },
        },
        update: {
          appliesTo: {
            principalTypes: ['User', 'ServiceRole', 'AnonRole'],
            resourceTypes: ['Table', 'Row'],
          },
        },
        delete: {
          appliesTo: {
            principalTypes: ['User', 'ServiceRole', 'AnonRole'],
            resourceTypes: ['Table', 'Row'],
          },
        },
        call: {
          appliesTo: {
            principalTypes: ['User', 'ServiceRole', 'AnonRole'],
            resourceTypes: ['Function'],
          },
        },
      },
    },
  };
}

// --- Principal / entity construction ---

function buildPrincipalUid(role, userId) {
  if (role === 'service_role') {
    return { type: 'PgrestLambda::ServiceRole', id: 'service' };
  }
  if (role === 'anon') {
    return { type: 'PgrestLambda::AnonRole', id: 'anon' };
  }
  return { type: 'PgrestLambda::User', id: userId };
}

function buildEntities(principalUid, principal, schema) {
  const entities = [];
  if (principalUid.type === 'PgrestLambda::User') {
    const attrs = {
      email: principal.email || '',
      role: principal.role || 'authenticated',
    };
    for (const [key, val] of Object.entries(principal)) {
      if (key !== 'role' && key !== 'userId' && key !== 'email') {
        attrs[key] = val;
      }
    }
    entities.push({ uid: principalUid, attrs, parents: [] });
  } else {
    entities.push({ uid: principalUid, attrs: {}, parents: [] });
  }
  for (const tableName of Object.keys(schema.tables)) {
    entities.push({
      uid: { type: 'PgrestLambda::Table', id: tableName },
      attrs: {},
      parents: [],
    });
  }
  if (schema.functions) {
    for (const fnName of Object.keys(schema.functions)) {
      entities.push({
        uid: { type: 'PgrestLambda::Function', id: fnName },
        attrs: {},
        parents: [],
      });
    }
  }
  return entities;
}

// --- Residual-to-SQL translation ---

// Summarize an untranslatable Cedar expression for a developer-facing
// error. We don't try to pretty-print the whole node — just enough for
// them to find the offending clause in their .cedar file.
function describeNode(node) {
  if (!node || typeof node !== 'object') return typeof node;
  const keys = Object.keys(node);
  const op = keys[0];
  if (!op) return '(empty)';
  if (op === '==' || op === '!=' || op === '<' || op === '>' ||
      op === '<=' || op === '>=') {
    return `comparison '${op}' where neither side resolves to a column+value`;
  }
  return `unsupported operator '${op}'`;
}

function untranslatableError(node, reason) {
  const desc = describeNode(node);
  const err = new PostgRESTError(
    500,
    'PGRST000',
    `Authorization policy produced untranslatable condition: ${reason} (${desc}). ` +
    `See docs/authorization.md "Errors" for common causes.`,
  );
  err.cedarReason = reason;
  err.cedarNode = node;
  return err;
}

function isResourceRef(node) {
  if (node?.Var === 'resource') return true;
  if (Array.isArray(node?.unknown)
      && node.unknown[0]?.Value === 'resource') return true;
  return false;
}

function resolveColumn(node) {
  if (node?.['.'] && isResourceRef(node['.'].left)) {
    return node['.'].attr;
  }
  return null;
}

function resolveValue(node) {
  if (node && 'Value' in node) {
    const v = node.Value;
    if (v != null && typeof v === 'object' && v.__entity) {
      return v.__entity.id;
    }
    return v;
  }
  return undefined;
}

export function translateExpr(expr, values, tableName, schema) {
  if (expr == null) return null;

  if ('Value' in expr) {
    if (expr.Value === true) return null;
    if (expr.Value === false) return 'FALSE';
    return null;
  }

  if ('is' in expr) {
    return expr.is.entity_type === 'PgrestLambda::Row' ? null : 'FALSE';
  }

  if ('has' in expr) {
    const attr = expr.has.attr;
    if (schema?.tables?.[tableName]?.columns
        && !schema.tables[tableName].columns[attr]) {
      return 'FALSE';
    }
    return `"${attr}" IS NOT NULL`;
  }

  if ('&&' in expr) {
    const left = translateExpr(expr['&&'].left, values, tableName, schema);
    const right = translateExpr(expr['&&'].right, values, tableName, schema);
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    if (left === 'FALSE' || right === 'FALSE') return 'FALSE';
    return `(${left} AND ${right})`;
  }

  if ('||' in expr) {
    const left = translateExpr(expr['||'].left, values, tableName, schema);
    if (left === null) return null;
    const right = translateExpr(expr['||'].right, values, tableName, schema);
    if (right === null) return null;
    if (left === 'FALSE' && right === 'FALSE') return 'FALSE';
    if (left === 'FALSE') return right;
    if (right === 'FALSE') return left;
    return `(${left} OR ${right})`;
  }

  if ('!' in expr) {
    const inner = translateExpr(expr['!'].arg, values, tableName, schema);
    if (inner === null) return 'FALSE';
    if (inner === 'FALSE') return null;
    return `NOT (${inner})`;
  }

  const COMP_OPS = {
    '==': '=', '!=': '!=', '>': '>', '>=': '>=', '<': '<', '<=': '<=',
  };
  for (const [cedarOp, sqlOp] of Object.entries(COMP_OPS)) {
    if (cedarOp in expr) {
      const { left, right } = expr[cedarOp];
      const col = resolveColumn(left);
      const val = resolveValue(right);
      if (col && val !== undefined) {
        values.push(val);
        return `"${col}" ${sqlOp} $${values.length}`;
      }
      const col2 = resolveColumn(right);
      const val2 = resolveValue(left);
      if (col2 && val2 !== undefined) {
        values.push(val2);
        return `"${col2}" ${sqlOp} $${values.length}`;
      }
      throw untranslatableError(
        expr,
        "comparison must be between a resource column and a value (e.g. `resource.user_id == principal`). " +
        "Comparing two columns, or referencing a principal attribute that isn't in the JWT, isn't supported"
      );
    }
  }

  if ('if-then-else' in expr) {
    const ite = expr['if-then-else'];
    const ifSql = translateExpr(ite.if, values, tableName, schema);
    const thenSql = translateExpr(ite.then, values, tableName, schema);
    const elseSql = translateExpr(ite.else, values, tableName, schema);
    if (ifSql === null) return thenSql;
    if (ifSql === 'FALSE') return elseSql;
    const thenStr = thenSql === null ? 'TRUE' : thenSql;
    const elseStr = elseSql === null ? 'TRUE' : elseSql;
    return `CASE WHEN ${ifSql} THEN ${thenStr} ELSE ${elseStr} END`;
  }

  const UNTRANSLATABLE = [
    'in', 'contains', 'containsAll', 'containsAny',
    'like', 'isEmpty', 'hasTag', 'getTag',
  ];
  for (const op of UNTRANSLATABLE) {
    if (op in expr) {
      throw untranslatableError(
        expr,
        `operator '${op}' is not supported in row-level policies (the engine can't translate it to SQL)`
      );
    }
  }

  throw untranslatableError(
    expr,
    "expression shape is not recognized by the policy-to-SQL translator"
  );
}

// --- In-process residual evaluation for INSERT authz ---

export function evaluateExprAgainstRow(expr, row, principal) {
  if (expr == null) return true;

  if ('Value' in expr) {
    return expr.Value === true;
  }

  if ('is' in expr) {
    return expr.is.entity_type === 'PgrestLambda::Row';
  }

  if ('has' in expr) {
    const attr = expr.has.attr;
    return row[attr] !== undefined && row[attr] !== null;
  }

  if ('&&' in expr) {
    return evaluateExprAgainstRow(expr['&&'].left, row, principal)
        && evaluateExprAgainstRow(expr['&&'].right, row, principal);
  }

  if ('||' in expr) {
    return evaluateExprAgainstRow(expr['||'].left, row, principal)
        || evaluateExprAgainstRow(expr['||'].right, row, principal);
  }

  if ('!' in expr) {
    return !evaluateExprAgainstRow(expr['!'].arg, row, principal);
  }

  const COMP_OPS = {
    '==': (a, b) => a === b,
    '!=': (a, b) => a !== b,
    '>':  (a, b) => a > b,
    '>=': (a, b) => a >= b,
    '<':  (a, b) => a < b,
    '<=': (a, b) => a <= b,
  };
  for (const [cedarOp, comparator] of Object.entries(COMP_OPS)) {
    if (cedarOp in expr) {
      const { left, right } = expr[cedarOp];
      const col = resolveColumn(left);
      const val = resolveValue(right);
      if (col !== null && val !== undefined) {
        const rowVal = row[col];
        if (rowVal === undefined || rowVal === null) return false;
        return comparator(rowVal, val);
      }
      const col2 = resolveColumn(right);
      const val2 = resolveValue(left);
      if (col2 !== null && val2 !== undefined) {
        const rowVal = row[col2];
        if (rowVal === undefined || rowVal === null) return false;
        return comparator(val2, rowVal);
      }
      return false;
    }
  }

  if ('if-then-else' in expr) {
    const ite = expr['if-then-else'];
    const cond = evaluateExprAgainstRow(ite.if, row, principal);
    return cond
      ? evaluateExprAgainstRow(ite.then, row, principal)
      : evaluateExprAgainstRow(ite.else, row, principal);
  }

  if (process.env.NODE_ENV !== 'production') {
    const shape = Object.keys(expr)[0] || 'unknown';
    console.warn(
      `Cedar INSERT authz: untranslatable expression '${shape}'`,
    );
  }
  return false;
}

function evaluateResiduals(
  response, row, principalUid, tablePermitGranted,
) {
  let anyPermitGranted = tablePermitGranted;

  if (response.decision === 'allow') {
    anyPermitGranted = true;
  }

  for (const policyId of response.nontrivialResiduals) {
    const residual = response.residuals[policyId];
    const effect = residual.effect;

    let allCondsMet = true;
    for (const cond of residual.conditions || []) {
      if (cond.kind !== 'when') continue;
      if (!evaluateExprAgainstRow(
        cond.body, row, principalUid,
      )) {
        allCondsMet = false;
        break;
      }
    }

    if (allCondsMet && effect === 'forbid') {
      return false;
    }
    if (allCondsMet && effect === 'permit') {
      anyPermitGranted = true;
    }
  }

  return anyPermitGranted;
}

// --- Factory ---

export function createCedar(config) {
  let cachedPolicies = null;
  let policiesLoadedAt = 0;
  let cachedPoliciesPath = null;
  const policiesTtl = config.policiesTtl || 300_000;
  const production = config.production === true;

  const source = parsePolicySource(config.policiesPath);

  // In local/dev mode, surface *which* role was denied *what* action on
  // *which* table and point at the docs. Production keeps the terse form
  // so we don't leak the policy model to arbitrary callers.
  function denyMessage(principal, action, table) {
    if (production) {
      return `Not authorized to ${action} on '${table}'`;
    }
    const role = principal?.role ?? 'unknown';
    const src = currentSourceKey();
    return (
      `Not authorized: role='${role}' action='${action}' table='${table}'.\n` +
      `No Cedar policy grants it. Loaded from ${src}. ` +
      `See docs/authorization.md for the policy model and recipes.`
    );
  }

  function loadPolicyText() {
    if (source.scheme === 's3') {
      return loadFromS3(source.bucket, source.prefix, config.region);
    }
    return loadFromFilesystem(source.path);
  }

  function currentSourceKey() {
    if (source.scheme === 's3') {
      return `s3://${source.bucket}/${source.prefix}`;
    }
    return source.path;
  }

  async function loadPolicies() {
    const now = Date.now();
    const sourceKey = currentSourceKey();
    if (cachedPolicies
        && (now - policiesLoadedAt) < policiesTtl
        && sourceKey === cachedPoliciesPath) {
      return;
    }
    const text = await loadPolicyText();
    cachedPolicies = text ? { staticPolicies: text } : null;
    cachedPoliciesPath = sourceKey;
    policiesLoadedAt = now;
  }

  async function refreshPolicies() {
    cachedPolicies = null;
    policiesLoadedAt = 0;
    const text = await loadPolicyText();
    cachedPolicies = text ? { staticPolicies: text } : null;
    policiesLoadedAt = Date.now();
  }

  function _setPolicies(policies) {
    cachedPolicies = policies;
    policiesLoadedAt = Date.now();
    cachedPoliciesPath = currentSourceKey();
  }

  function authorize({
    principal, action, resource, resourceType, schema,
  }) {
    if (!cachedPolicies) {
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, action, resource),
      );
    }

    const principalUid = buildPrincipalUid(principal.role, principal.userId);
    const entities = buildEntities(principalUid, principal, schema);
    const actionUid = { type: 'PgrestLambda::Action', id: action };
    const type = resourceType || 'Table';
    const resourceUid = {
      type: `PgrestLambda::${type}`, id: resource,
    };

    const result = isAuthorized({
      principal: principalUid,
      action: actionUid,
      resource: resourceUid,
      context: { table: resource, resource_type: type },
      policies: cachedPolicies,
      entities,
    });

    if (result.type === 'success' && result.response.decision === 'allow') {
      return true;
    }

    const partial = isAuthorizedPartial({
      principal: principalUid,
      action: actionUid,
      resource: null,
      context: { table: resource, resource_type: type },
      policies: cachedPolicies,
      entities,
    });

    if (partial.type === 'residuals') {
      const resp = partial.response;
      if (resp.decision === 'allow') return true;
      if (resp.decision !== 'deny' && resp.nontrivialResiduals.length > 0) {
        return true;
      }
    }

    throw new PostgRESTError(
      403, 'PGRST403',
      denyMessage(principal, action, resource),
    );
  }

  function authorizeInsert({
    principal, resource, schema, rows,
  }) {
    if (!cachedPolicies) {
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, 'insert', resource),
      );
    }

    const principalUid = buildPrincipalUid(
      principal.role, principal.userId);
    const entities = buildEntities(
      principalUid, principal, schema);
    const actionUid = {
      type: 'PgrestLambda::Action', id: 'insert',
    };
    const resourceUid = {
      type: 'PgrestLambda::Table', id: resource,
    };

    const tableResult = isAuthorized({
      principal: principalUid,
      action: actionUid,
      resource: resourceUid,
      context: {
        table: resource, resource_type: 'Table',
      },
      policies: cachedPolicies,
      entities,
    });

    const tablePermitGranted =
      tableResult.type === 'success'
      && tableResult.response.decision === 'allow';

    const partial = isAuthorizedPartial({
      principal: principalUid,
      action: actionUid,
      resource: null,
      context: {
        table: resource, resource_type: 'Table',
      },
      policies: cachedPolicies,
      entities,
    });

    if (partial.type !== 'residuals') {
      if (tablePermitGranted) return true;
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, 'insert', resource),
      );
    }

    const resp = partial.response;

    if (resp.nontrivialResiduals.length === 0) {
      if (tablePermitGranted
          || resp.decision === 'allow') {
        return true;
      }
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, 'insert', resource),
      );
    }

    if (resp.decision === 'deny'
        && !tablePermitGranted) {
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, 'insert', resource),
      );
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!evaluateResiduals(
        resp, row, principalUid, tablePermitGranted,
      )) {
        const detail = rows.length > 1
          ? `Row ${i} of the batch violates the`
            + ` insert policy`
          : null;
        throw new PostgRESTError(
          403, 'PGRST403',
          denyMessage(principal, 'insert', resource),
          detail,
        );
      }
    }

    return true;
  }

  function buildAuthzFilter({
    principal, action, context, schema, startParam,
  }) {
    if (!cachedPolicies) {
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, action, context.table),
      );
    }

    const principalUid = buildPrincipalUid(principal.role, principal.userId);
    const entities = buildEntities(principalUid, principal, schema);
    const actionUid = { type: 'PgrestLambda::Action', id: action };

    const result = isAuthorizedPartial({
      principal: principalUid,
      action: actionUid,
      resource: null,
      context: context || {},
      policies: cachedPolicies,
      entities,
    });

    if (result.type === 'failure') {
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, action, context.table),
      );
    }

    const response = result.response;

    if (response.decision === 'allow'
        && response.nontrivialResiduals.length === 0) {
      return { conditions: [], values: [] };
    }

    if (response.decision === 'deny') {
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, action, context.table),
      );
    }

    const tempValues = new Array(startParam - 1);
    const permitConditions = [];
    const forbidConditions = [];
    let anyPermitGrantsAccess = false;

    for (const policyId of response.nontrivialResiduals) {
      const residual = response.residuals[policyId];
      const effect = residual.effect;

      for (const cond of residual.conditions || []) {
        if (cond.kind !== 'when') continue;
        let sql;
        try {
          sql = translateExpr(
            cond.body, tempValues, context.table, schema,
          );
        } catch (err) {
          if (err?.code === 'PGRST000' && !production) {
            err.message =
              `${err.message}\n` +
              `  policy id: ${policyId}\n` +
              `  policies loaded from: ${currentSourceKey()}`;
          }
          throw err;
        }
        if (sql === null) {
          if (effect === 'permit') {
            return { conditions: [], values: [] };
          }
          if (effect === 'forbid') {
            throw new PostgRESTError(
              403, 'PGRST403',
              denyMessage(principal, action, context.table),
            );
          }
        } else if (sql !== 'FALSE') {
          if (effect === 'permit') {
            permitConditions.push(sql);
            anyPermitGrantsAccess = true;
          } else if (effect === 'forbid') {
            forbidConditions.push(sql);
          }
        }
      }
    }

    if (!anyPermitGrantsAccess && forbidConditions.length === 0) {
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, action, context.table),
      );
    }

    const allConditions = [];
    if (permitConditions.length > 1) {
      allConditions.push(`(${permitConditions.join(' OR ')})`);
    } else if (permitConditions.length === 1) {
      allConditions.push(permitConditions[0]);
    }
    for (const fc of forbidConditions) {
      allConditions.push(`NOT (${fc})`);
    }

    const authzValues = tempValues.slice(startParam - 1);
    return { conditions: allConditions, values: authzValues };
  }

  return {
    loadPolicies,
    refreshPolicies,
    _setPolicies,
    authorize,
    authorizeInsert,
    buildAuthzFilter,
    generateCedarSchema,
  };
}
