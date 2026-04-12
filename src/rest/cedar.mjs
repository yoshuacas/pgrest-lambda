// cedar.mjs — Cedar policy-based authorization module

import {
  isAuthorized,
  isAuthorizedPartial,
} from '@cedar-policy/cedar-wasm/nodejs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgRESTError } from './errors.mjs';

// --- Module-scoped policy cache ---

let cachedPolicies = null;
let policiesLoadedAt = 0;
let cachedPoliciesPath = null;
const POLICIES_TTL = 300_000; // 5 minutes

// --- Policy loading ---

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

async function loadFromS3(bucket, prefix) {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } =
    await import('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region: process.env.REGION_NAME,
  });
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

async function loadPolicyText() {
  const bucket = process.env.POLICIES_BUCKET;
  const prefix = process.env.POLICIES_PREFIX;
  if (bucket) {
    return loadFromS3(bucket, prefix || 'policies/');
  }
  const dirPath = process.env.POLICIES_PATH || './policies';
  return loadFromFilesystem(dirPath);
}

function currentSourceKey() {
  const bucket = process.env.POLICIES_BUCKET;
  if (bucket) {
    const prefix = process.env.POLICIES_PREFIX || 'policies/';
    return `s3://${bucket}/${prefix}`;
  }
  return process.env.POLICIES_PATH || './policies';
}

export async function loadPolicies() {
  const now = Date.now();
  const sourceKey = currentSourceKey();
  if (cachedPolicies
      && (now - policiesLoadedAt) < POLICIES_TTL
      && sourceKey === cachedPoliciesPath) {
    return;
  }
  const text = await loadPolicyText();
  cachedPolicies = text ? { staticPolicies: text } : null;
  cachedPoliciesPath = sourceKey;
  policiesLoadedAt = now;
}

export async function refreshPolicies() {
  cachedPolicies = null;
  policiesLoadedAt = 0;
  const text = await loadPolicyText();
  cachedPolicies = text ? { staticPolicies: text } : null;
  policiesLoadedAt = Date.now();
}

export function _setPolicies(policies) {
  cachedPolicies = policies;
  policiesLoadedAt = Date.now();
  cachedPoliciesPath = process.env.POLICIES_PATH || './policies';
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
  return entities;
}

// --- Residual-to-SQL translation ---

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

// Returns a SQL condition string, null for TRUE, or 'FALSE'.
export function translateExpr(expr, values, tableName, schema) {
  if (expr == null) return null;

  // Boolean literal
  if ('Value' in expr) {
    if (expr.Value === true) return null;
    if (expr.Value === false) return 'FALSE';
    return null;
  }

  // Type check: is
  if ('is' in expr) {
    return expr.is.entity_type === 'PgrestLambda::Row' ? null : 'FALSE';
  }

  // Has-attribute
  if ('has' in expr) {
    const attr = expr.has.attr;
    if (schema?.tables?.[tableName]?.columns
        && !schema.tables[tableName].columns[attr]) {
      return 'FALSE';
    }
    return `"${attr}" IS NOT NULL`;
  }

  // AND
  if ('&&' in expr) {
    const left = translateExpr(expr['&&'].left, values, tableName, schema);
    const right = translateExpr(expr['&&'].right, values, tableName, schema);
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    if (left === 'FALSE' || right === 'FALSE') return 'FALSE';
    return `(${left} AND ${right})`;
  }

  // OR (lazy: true OR anything = true)
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

  // NOT
  if ('!' in expr) {
    const inner = translateExpr(expr['!'].arg, values, tableName, schema);
    if (inner === null) return 'FALSE';
    if (inner === 'FALSE') return null;
    return `NOT (${inner})`;
  }

  // Comparison operators
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
      throw new PostgRESTError(
        500, 'PGRST000',
        'Authorization policy produced untranslatable condition',
      );
    }
  }

  // if-then-else
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

  // Untranslatable expressions
  const UNTRANSLATABLE = [
    'in', 'contains', 'containsAll', 'containsAny',
    'like', 'isEmpty', 'hasTag', 'getTag',
  ];
  for (const op of UNTRANSLATABLE) {
    if (op in expr) {
      throw new PostgRESTError(
        500, 'PGRST000',
        'Authorization policy produced untranslatable condition',
      );
    }
  }

  throw new PostgRESTError(
    500, 'PGRST000',
    'Authorization policy produced untranslatable condition',
  );
}

// --- Table-level authorization ---

export function authorize({ principal, action, resource, schema }) {
  if (!cachedPolicies) {
    throw new PostgRESTError(
      403, 'PGRST403',
      `Not authorized to ${action} on '${resource}'`,
    );
  }

  const principalUid = buildPrincipalUid(principal.role, principal.userId);
  const entities = buildEntities(principalUid, principal, schema);
  const actionUid = { type: 'PgrestLambda::Action', id: action };

  // Concrete check with Table resource
  const result = isAuthorized({
    principal: principalUid,
    action: actionUid,
    resource: { type: 'PgrestLambda::Table', id: resource },
    context: { table: resource },
    policies: cachedPolicies,
    entities,
  });

  if (result.type === 'success' && result.response.decision === 'allow') {
    return true;
  }

  // Fallback: partial evaluation to check row-level policies
  const partial = isAuthorizedPartial({
    principal: principalUid,
    action: actionUid,
    resource: null,
    context: { table: resource },
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
    `Not authorized to ${action} on '${resource}'`,
  );
}

// --- Row-level partial evaluation ---

export function buildAuthzFilter({
  principal, action, context, schema, startParam,
}) {
  if (!cachedPolicies) {
    throw new PostgRESTError(
      403, 'PGRST403',
      `Not authorized to ${action} on '${context.table}'`,
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
      `Not authorized to ${action} on '${context.table}'`,
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
      `Not authorized to ${action} on '${context.table}'`,
    );
  }

  // Process residuals — use temp array with offset for param numbering
  const tempValues = new Array(startParam - 1);
  const permitConditions = [];
  const forbidConditions = [];
  let anyPermitGrantsAccess = false;

  for (const policyId of response.nontrivialResiduals) {
    const residual = response.residuals[policyId];
    const effect = residual.effect;

    for (const cond of residual.conditions || []) {
      if (cond.kind !== 'when') continue;
      const sql = translateExpr(
        cond.body, tempValues, context.table, schema,
      );
      if (sql === null) {
        if (effect === 'permit') {
          return { conditions: [], values: [] };
        }
        if (effect === 'forbid') {
          throw new PostgRESTError(
            403, 'PGRST403',
            `Not authorized to ${action} on '${context.table}'`,
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

  // If no permit grants access, deny
  if (!anyPermitGrantsAccess && forbidConditions.length === 0) {
    throw new PostgRESTError(
      403, 'PGRST403',
      `Not authorized to ${action} on '${context.table}'`,
    );
  }

  // Build combined conditions
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
