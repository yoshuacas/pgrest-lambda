import {
  checkParsePolicySet,
  policySetTextToParts,
  policyToJson,
} from "@cedar-policy/cedar-wasm/nodejs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parsePolicySource } from "../rest/cedar.mjs";

/**
 * @typedef {Object} Finding
 * @property {string} file    - Relative path to the .cedar file
 * @property {number} line    - 1-based line number (0 if unknown)
 * @property {'error'|'warn'} severity
 * @property {string} rule    - Rule ID (E001, W001, etc.)
 * @property {string} message - Human-readable description
 */

/**
 * @typedef {Object} Summary
 * @property {number} policiesScanned
 * @property {number} errors
 * @property {number} warnings
 */

const MESSAGES = {
  E001: "Unconditional permit — no conditions and no principal/action/resource narrowing. Add a when clause or narrow the scope.",
  E002: "Tautological when clause — condition is always true. The permit is effectively unconditional.",
  W001: "Principal type missing — policy applies to all principal types including anon. Add 'principal is PgrestLambda::User' or similar.",
  W002: "Resource type missing — policy applies to all resource types. Add 'resource is PgrestLambda::Row' or 'resource is PgrestLambda::Table'.",
  W004: "Unscoped forbid — denies every principal, action, and resource with no conditions. This blocks all access.",
};

const KNOWN_ACTIONS = new Set(["select", "insert", "update", "delete", "call"]);

function findPolicyLine(fileText, policyText, searchFrom = 0) {
  const needle = policyText.trim().split("\n")[0].trim();
  const idx = fileText.indexOf(needle, searchFrom);
  if (idx === -1) return { line: 0, endOffset: searchFrom };
  const line = fileText.slice(0, idx).split("\n").length;
  return { line, endOffset: idx + needle.length };
}

function byteOffsetToLine(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function getSuppressedRules(json) {
  if (!json.annotations?.lint_allow) return new Set();
  const raw = json.annotations.lint_allow;
  const ids = new Set();
  for (const s of raw.split(",")) {
    const trimmed = s.trim();
    ids.add(RULE_NAME_TO_ID[trimmed] || trimmed);
  }
  return ids;
}

function syntaxFinding(file, cedarError, fileText) {
  const loc = cedarError.sourceLocations?.[0];
  const line = loc ? byteOffsetToLine(fileText, loc.start) : 0;
  return {
    file,
    line,
    severity: "error",
    rule: "E003",
    message: `Syntax error: ${cedarError.message}`,
  };
}

function isServiceRoleBypass(json) {
  const p = json.principal;
  if (p.op === "is" && p.entity_type?.endsWith("ServiceRole")) return true;
  if (p.op === "==" && p.entity?.__entity?.type?.endsWith("ServiceRole"))
    return true;
  if (p.op === "==" && p.entity?.type?.endsWith("ServiceRole")) return true;
  return false;
}

function checkE001(json) {
  if (json.effect !== "permit") return null;
  if (isServiceRoleBypass(json)) return null;
  const unscoped =
    json.principal.op === "All" &&
    json.action.op === "All" &&
    json.resource.op === "All";
  if (!unscoped) return null;
  if (json.conditions.length > 0) return null;
  return { severity: "error", rule: "E001", message: MESSAGES.E001 };
}

function isTautology(expr) {
  if ("Value" in expr && expr.Value === true) return true;
  if ("==" in expr) {
    const { left, right } = expr["=="];
    if ("Value" in left && "Value" in right) {
      return JSON.stringify(left.Value) === JSON.stringify(right.Value);
    }
  }
  return false;
}

function checkE002(json) {
  if (json.effect !== "permit") return null;
  for (const clause of json.conditions) {
    if (clause.kind !== "when") continue;
    if (isTautology(clause.body)) {
      return { severity: "error", rule: "E002", message: MESSAGES.E002 };
    }
  }
  return null;
}

function extractActionEntities(action) {
  if (action.op === "==" && action.entity) return [action.entity];
  if (action.op === "in") {
    if (action.entities) return action.entities;
    if (action.entity) return [action.entity];
  }
  return [];
}

function checkE004(json) {
  const entities = extractActionEntities(json.action);
  const findings = [];
  for (const entity of entities) {
    const id = entity?.__entity?.id ?? entity?.id;
    const type = entity?.__entity?.type ?? entity?.type;
    if (type === "PgrestLambda::Action" && id && !KNOWN_ACTIONS.has(id)) {
      findings.push({
        severity: "error",
        rule: "E004",
        message: `Unknown action '${id}'. Valid actions: select, insert, update, delete, call.`,
      });
    }
  }
  return findings.length ? findings : null;
}

function checkW001(json) {
  if (json.principal.op === "All") {
    return { severity: "warn", rule: "W001", message: MESSAGES.W001 };
  }
  return null;
}

function checkW002(json) {
  if (json.resource.op === "All") {
    if (isServiceRoleBypass(json)) return null;
    return { severity: "warn", rule: "W002", message: MESSAGES.W002 };
  }
  return null;
}

function collectColumnAccess(expr, accessed, guarded) {
  if (!expr || typeof expr !== "object") return;

  if ("." in expr) {
    const dot = expr["."];
    if (dot.left?.Var === "resource") {
      accessed.add(dot.attr);
    }
  }

  if ("has" in expr) {
    const has = expr.has;
    if (has.left?.Var === "resource") {
      guarded.add(has.attr);
    }
  }

  for (const key of Object.keys(expr)) {
    const val = expr[key];
    if (val && typeof val === "object") {
      if ("left" in val) {
        collectColumnAccess(val.left, accessed, guarded);
        if ("right" in val) {
          collectColumnAccess(val.right, accessed, guarded);
        }
      }
      if ("arg" in val) {
        collectColumnAccess(val.arg, accessed, guarded);
      }
      if ("if" in val) {
        collectColumnAccess(val["if"], accessed, guarded);
        collectColumnAccess(val["then"], accessed, guarded);
        collectColumnAccess(val["else"], accessed, guarded);
      }
    }
  }
}

function checkW003(json) {
  const findings = [];
  for (const clause of json.conditions) {
    if (clause.kind !== "when") continue;
    const accessed = new Set();
    const guarded = new Set();
    collectColumnAccess(clause.body, accessed, guarded);
    for (const col of accessed) {
      if (!guarded.has(col)) {
        findings.push({
          severity: "warn",
          rule: "W003",
          message:
            `Column access 'resource.${col}' without ` +
            `'resource has ${col}' guard — the policy ` +
            `fails-closed on tables missing this column.`,
        });
      }
    }
  }
  return findings.length ? findings : null;
}

function checkW004(json) {
  if (json.effect !== "forbid") return null;
  const unscoped =
    json.principal.op === "All" &&
    json.action.op === "All" &&
    json.resource.op === "All";
  if (!unscoped) return null;
  if (json.conditions.length > 0) return null;
  return { severity: "warn", rule: "W004", message: MESSAGES.W004 };
}

export const RULES = {
  E001: { id: "E001", severity: "error", check: checkE001 },
  E002: { id: "E002", severity: "error", check: checkE002 },
  E003: { id: "E003", severity: "error" },
  E004: { id: "E004", severity: "error", check: checkE004 },
  W001: { id: "W001", severity: "warn", check: checkW001 },
  W002: { id: "W002", severity: "warn", check: checkW002 },
  W003: { id: "W003", severity: "warn", check: checkW003 },
  W004: { id: "W004", severity: "warn", check: checkW004 },
};

const RULE_CHECKS = [
  RULES.E001,
  RULES.E002,
  RULES.E004,
  RULES.W001,
  RULES.W002,
  RULES.W003,
  RULES.W004,
];

const RULE_NAME_TO_ID = {
  "unconditional-permit": "E001",
  "tautological-when": "E002",
  "syntax-error": "E003",
  "unknown-action": "E004",
  "principal-type-missing": "W001",
  "resource-type-missing": "W002",
  "missing-has-guard": "W003",
  "unscoped-forbid": "W004",
};

export async function lintPolicies({ path }) {
  const source = parsePolicySource(path || undefined);

  if (source.scheme === "s3") {
    throw new Error(
      "S3 policy sources are not supported by the linter. Copy .cedar files locally and pass --path.",
    );
  }

  const dirPath = source.path;

  let dirEntries;
  try {
    dirEntries = await readdir(dirPath);
  } catch (err) {
    throw new Error(
      `Cannot read policy directory '${dirPath}': ${err.message}`,
    );
  }

  const cedarFiles = dirEntries.filter((f) => f.endsWith(".cedar")).sort();
  if (cedarFiles.length === 0) {
    throw new Error(`No .cedar files found in ${dirPath}.`);
  }

  const findings = [];
  let policiesScanned = 0;

  for (const fileName of cedarFiles) {
    const filePath = join(dirPath, fileName);
    const text = await readFile(filePath, "utf8");
    const relFile = relative(process.cwd(), filePath) || fileName;

    if (!text.trim()) continue;

    const parseResult = checkParsePolicySet({ staticPolicies: text });
    if (parseResult.type === "failure") {
      for (const err of parseResult.errors) {
        findings.push(syntaxFinding(relFile, err, text));
      }
      continue;
    }

    const parts = policySetTextToParts(text);
    if (parts.type === "failure") {
      for (const err of parts.errors) {
        findings.push(syntaxFinding(relFile, err, text));
      }
      continue;
    }

    let searchFrom = 0;

    for (const policyString of parts.policies) {
      const jsonResult = policyToJson(policyString);
      if (jsonResult.type === "failure") {
        for (const err of jsonResult.errors) {
          findings.push(syntaxFinding(relFile, err, text));
        }
        continue;
      }

      policiesScanned++;
      const json = jsonResult.json;

      const { line, endOffset } = findPolicyLine(
        text,
        policyString,
        searchFrom,
      );
      searchFrom = endOffset;

      const suppressed = getSuppressedRules(json);

      for (const rule of RULE_CHECKS) {
        const result = rule.check(json);
        if (!result) continue;

        const resultArray = Array.isArray(result) ? result : [result];
        for (const finding of resultArray) {
          if (suppressed.has(finding.rule)) continue;
          findings.push({
            file: relFile,
            line,
            ...finding,
          });
        }
      }
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;

  return {
    findings,
    summary: {
      policiesScanned,
      errors,
      warnings,
    },
  };
}
