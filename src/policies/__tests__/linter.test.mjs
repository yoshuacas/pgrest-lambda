import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lintPolicies } from "../linter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");
const BIN = resolve(__dirname, "../../../bin/pgrest-lambda.mjs");
const POLICIES_DIR = resolve(__dirname, "../../../policies");

// --- helpers ---

async function tempDir() {
  return mkdtemp(join(tmpdir(), "linter-test-"));
}

async function fixtureDir(...filenames) {
  const dir = await tempDir();
  for (const f of filenames) {
    await copyFile(join(FIXTURES, f), join(dir, f));
  }
  return dir;
}

async function inlineDir(policies) {
  const dir = await tempDir();
  for (const [name, content] of Object.entries(policies)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

function findFindings(findings, rule) {
  return findings.filter((f) => f.rule === rule);
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, "lint-policies", ...args],
      { timeout: 15_000 },
      (err, stdout, stderr) => {
        resolve({
          exitCode: err ? err.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

// --- unit tests ---

describe("linter — E001 unconditional-permit", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("detects unconditional permit", async () => {
    dir = await fixtureDir("e001-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(e001.length, 1, "expected exactly 1 E001 finding");
    assert.match(e001[0].message, /Unconditional permit/);
    assert.equal(e001[0].severity, "error");
  });

  it("also triggers W001 and W002 on unconditional permit", async () => {
    dir = await fixtureDir("e001-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const w001 = findFindings(findings, "W001");
    const w002 = findFindings(findings, "W002");
    assert.ok(w001.length >= 1, "expected W001 for unscoped principal");
    assert.ok(w002.length >= 1, "expected W002 for unscoped resource");
  });

  it("clean fixture produces 0 E001 findings", async () => {
    dir = await fixtureDir("clean.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(e001.length, 0, "clean policies should not trigger E001");
  });

  it("narrowed principal prevents E001", async () => {
    dir = await inlineDir({
      "test.cedar":
        "permit(principal is PgrestLambda::User, action, resource);",
    });
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(e001.length, 0, "narrowed principal should prevent E001");
  });

  it("narrowed action prevents E001", async () => {
    dir = await inlineDir({
      "test.cedar":
        'permit(principal, action == PgrestLambda::Action::"select", resource);',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(e001.length, 0, "narrowed action should prevent E001");
  });

  it("narrowed resource prevents E001", async () => {
    dir = await inlineDir({
      "test.cedar": "permit(principal, action, resource is PgrestLambda::Row);",
    });
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(e001.length, 0, "narrowed resource should prevent E001");
  });

  it("when clause prevents E001", async () => {
    dir = await inlineDir({
      "test.cedar":
        'permit(principal, action, resource) when { context.table == "posts" };',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(e001.length, 0, "when clause should prevent E001");
  });

  it("@lint_allow suppresses E001 but W001/W002 still fire", async () => {
    dir = await inlineDir({
      "test.cedar":
        '@lint_allow("unconditional-permit")\npermit(principal, action, resource);',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(e001.length, 0, "E001 should be suppressed");
    const w001 = findFindings(findings, "W001");
    const w002 = findFindings(findings, "W002");
    assert.ok(w001.length >= 1, "W001 should still fire");
    assert.ok(w002.length >= 1, "W002 should still fire");
  });

  it("service-role bypass via == operator prevents E001", async () => {
    dir = await inlineDir({
      "test.cedar":
        'permit(principal == PgrestLambda::ServiceRole::"svc", action, resource);',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(
      e001.length,
      0,
      "service-role bypass via == should prevent E001",
    );
    const w002 = findFindings(findings, "W002");
    assert.equal(
      w002.length,
      0,
      "service-role bypass via == should prevent W002",
    );
  });
});

describe("linter — E002 tautological-when", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("detects when { true }", async () => {
    dir = await fixtureDir("e002-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const e002 = findFindings(findings, "E002");
    assert.ok(e002.length >= 1, "expected at least 1 E002 finding");
    assert.match(e002[0].message, /Tautological when/);
    assert.equal(e002[0].severity, "error");
  });

  it("detects when { 1 == 1 }", async () => {
    dir = await inlineDir({
      "test.cedar":
        '@lint_allow("W001,W002")\npermit(principal, action, resource) when { 1 == 1 };',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e002 = findFindings(findings, "E002");
    assert.equal(e002.length, 1, "expected 1 E002 for literal comparison");
  });

  it('detects when { "x" == "x" }', async () => {
    dir = await inlineDir({
      "test.cedar":
        '@lint_allow("W001,W002")\npermit(principal, action, resource) when { "x" == "x" };',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e002 = findFindings(findings, "E002");
    assert.equal(e002.length, 1, "expected 1 E002 for string comparison");
  });

  it("E001 does not fire when a when clause exists (even tautological)", async () => {
    dir = await fixtureDir("e002-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(
      e001.length,
      0,
      "E001 should not fire — conditions.length > 0 even though tautological",
    );
  });

  it("real condition does not trigger E002", async () => {
    dir = await inlineDir({
      "test.cedar":
        "permit(principal is PgrestLambda::User, action, resource is PgrestLambda::Row) when { resource has user_id };",
    });
    const { findings } = await lintPolicies({ path: dir });
    const e002 = findFindings(findings, "E002");
    assert.equal(e002.length, 0, "real condition should not trigger E002");
  });

  it("E002 does not fire on forbid with tautological when", async () => {
    dir = await inlineDir({
      "test.cedar": "forbid(principal, action, resource) when { true };",
    });
    const { findings } = await lintPolicies({ path: dir });
    const e002 = findFindings(findings, "E002");
    assert.equal(e002.length, 0, "E002 should not fire on forbid policies");
  });
});

describe("linter — E003 syntax-error", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("detects malformed Cedar", async () => {
    dir = await fixtureDir("e003-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const e003 = findFindings(findings, "E003");
    assert.ok(e003.length >= 1, "expected at least 1 E003 finding");
    assert.match(e003[0].message, /^Syntax error:/);
    assert.equal(e003[0].severity, "error");
  });

  it("syntax error has line > 0", async () => {
    dir = await fixtureDir("e003-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const e003 = findFindings(findings, "E003");
    assert.ok(e003[0].line > 0, "E003 finding should have line > 0");
  });
});

describe("linter — E004 unknown-action", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it('detects unknown action "drop"', async () => {
    dir = await fixtureDir("e004-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const e004 = findFindings(findings, "E004");
    assert.equal(e004.length, 1, "expected 1 E004 finding");
    assert.match(e004[0].message, /'drop'/);
    assert.equal(e004[0].severity, "error");
  });

  it('known action "select" does not trigger E004', async () => {
    dir = await inlineDir({
      "test.cedar":
        'permit(principal is PgrestLambda::User, action == PgrestLambda::Action::"select", resource is PgrestLambda::Row);',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e004 = findFindings(findings, "E004");
    assert.equal(e004.length, 0, "known action should not trigger E004");
  });

  it("detects unknown action in a list", async () => {
    dir = await inlineDir({
      "test.cedar":
        'permit(principal is PgrestLambda::User, action in [PgrestLambda::Action::"select", PgrestLambda::Action::"nuke"], resource is PgrestLambda::Row);',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e004 = findFindings(findings, "E004");
    assert.equal(e004.length, 1, 'expected 1 E004 for "nuke"');
    assert.match(e004[0].message, /'nuke'/);
  });

  it("reports all unknown actions in a list", async () => {
    dir = await inlineDir({
      "test.cedar":
        "permit(principal is PgrestLambda::User, " +
        'action in [PgrestLambda::Action::"nuke", ' +
        'PgrestLambda::Action::"yeet"], ' +
        "resource is PgrestLambda::Row);",
    });
    const { findings } = await lintPolicies({ path: dir });
    const e004 = findFindings(findings, "E004");
    assert.equal(e004.length, 2, "expected 2 E004 findings for nuke and yeet");
    const messages = e004.map((f) => f.message);
    assert.ok(
      messages.some((m) => m.includes("'nuke'")),
      "expected finding for nuke",
    );
    assert.ok(
      messages.some((m) => m.includes("'yeet'")),
      "expected finding for yeet",
    );
  });
});

describe("linter — W001 principal-type-missing", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("detects unscoped principal", async () => {
    dir = await fixtureDir("w001-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const w001 = findFindings(findings, "W001");
    assert.equal(w001.length, 1, "expected 1 W001 finding");
    assert.match(w001[0].message, /Principal type missing/);
    assert.equal(w001[0].severity, "warn");
  });

  it("clean fixture produces 0 W001 findings", async () => {
    dir = await fixtureDir("clean.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const w001 = findFindings(findings, "W001");
    assert.equal(w001.length, 0, "clean policies should not trigger W001");
  });

  it("W001 fires on forbid with unscoped principal", async () => {
    dir = await inlineDir({
      "test.cedar":
        "forbid(principal, " +
        'action == PgrestLambda::Action::"delete", ' +
        "resource is PgrestLambda::Row);",
    });
    const { findings } = await lintPolicies({ path: dir });
    const w001 = findFindings(findings, "W001");
    assert.equal(
      w001.length,
      1,
      "W001 should fire on forbid with unscoped principal",
    );
    const w004 = findFindings(findings, "W004");
    assert.equal(w004.length, 0, "W004 should not fire — action is narrowed");
  });
});

describe("linter — W002 resource-type-missing", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("detects unscoped resource", async () => {
    dir = await fixtureDir("w002-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const w002 = findFindings(findings, "W002");
    assert.equal(w002.length, 1, "expected 1 W002 finding");
    assert.match(w002[0].message, /Resource type missing/);
    assert.equal(w002[0].severity, "warn");
  });

  it("service-role bypass is exempt from W002", async () => {
    dir = await inlineDir({
      "test.cedar":
        "permit(principal is PgrestLambda::ServiceRole, action, resource);",
    });
    const { findings } = await lintPolicies({ path: dir });
    const w002 = findFindings(findings, "W002");
    assert.equal(
      w002.length,
      0,
      "service-role bypass should be exempt from W002",
    );
  });
});

describe("linter — W003 missing-has-guard", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("detects column access without has guard", async () => {
    dir = await fixtureDir("w003-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const w003 = findFindings(findings, "W003");
    assert.equal(w003.length, 1, "expected 1 W003 finding");
    assert.match(w003[0].message, /user_id/);
    assert.equal(w003[0].severity, "warn");
  });

  it("has guard prevents W003", async () => {
    dir = await inlineDir({
      "test.cedar": `permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when { resource has user_id && resource.user_id == principal };`,
    });
    const { findings } = await lintPolicies({ path: dir });
    const w003 = findFindings(findings, "W003");
    assert.equal(w003.length, 0, "guarded column should not trigger W003");
  });

  it("partial guard only protects guarded column", async () => {
    dir = await inlineDir({
      "test.cedar": `permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when { resource has status && resource.status == "archived" && resource.user_id == principal };`,
    });
    const { findings } = await lintPolicies({ path: dir });
    const w003 = findFindings(findings, "W003");
    assert.equal(w003.length, 1, "expected 1 W003 for unguarded user_id");
    assert.match(w003[0].message, /user_id/);
  });
});

describe("linter — W004 unscoped-forbid", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("detects unscoped forbid", async () => {
    dir = await fixtureDir("w004-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const w004 = findFindings(findings, "W004");
    assert.equal(w004.length, 1, "expected 1 W004 finding");
    assert.equal(w004[0].severity, "warn");
  });

  it("unscoped forbid also triggers W001 and W002", async () => {
    dir = await fixtureDir("w004-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const w001 = findFindings(findings, "W001");
    const w002 = findFindings(findings, "W002");
    assert.ok(w001.length >= 1, "expected W001 for unscoped principal");
    assert.ok(w002.length >= 1, "expected W002 for unscoped resource");
  });

  it("forbid with when clause does not trigger W004", async () => {
    dir = await inlineDir({
      "test.cedar":
        'forbid(principal, action, resource) when { context.table == "secret" };',
    });
    const { findings } = await lintPolicies({ path: dir });
    const w004 = findFindings(findings, "W004");
    assert.equal(w004.length, 0, "when clause should prevent W004");
  });

  it("forbid with narrowed action does not trigger W004", async () => {
    dir = await inlineDir({
      "test.cedar":
        'forbid(principal, action == PgrestLambda::Action::"delete", resource);',
    });
    const { findings } = await lintPolicies({ path: dir });
    const w004 = findFindings(findings, "W004");
    assert.equal(w004.length, 0, "narrowed action should prevent W004");
  });
});

describe("linter — default policies clean run", () => {
  it("reports 0 findings on policies/default.cedar", async () => {
    const { findings, summary } = await lintPolicies({
      path: POLICIES_DIR,
    });
    assert.equal(findings.length, 0, "default policies should have 0 findings");
    assert.equal(summary.policiesScanned, 3, "default.cedar has 3 policies");
  });
});

describe("linter — annotation suppression", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("full suppression yields 0 findings", async () => {
    dir = await fixtureDir("suppressed.cedar");
    const { findings } = await lintPolicies({ path: dir });
    assert.equal(
      findings.length,
      0,
      "all rules suppressed should yield 0 findings",
    );
  });

  it("partial suppression: E001 suppressed, W001+W002 still fire", async () => {
    dir = await inlineDir({
      "test.cedar":
        '@lint_allow("unconditional-permit")\npermit(principal, action, resource);',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(e001.length, 0, "E001 should be suppressed");
    const w001 = findFindings(findings, "W001");
    const w002 = findFindings(findings, "W002");
    assert.equal(w001.length, 1, "W001 should fire");
    assert.equal(w002.length, 1, "W002 should fire");
  });

  it("@lint_allow with human-readable name suppresses E002", async () => {
    dir = await inlineDir({
      "test.cedar":
        '@lint_allow("tautological-when,W001,W002")\n' +
        "permit(principal, action, resource) when { true };",
    });
    const { findings } = await lintPolicies({ path: dir });
    const e002 = findFindings(findings, "E002");
    assert.equal(
      e002.length,
      0,
      "E002 should be suppressed via human-readable name",
    );
  });

  it("@lint_allow with human-readable names for warnings", async () => {
    dir = await inlineDir({
      "test.cedar":
        '@lint_allow("principal-type-missing,resource-type-missing")\n' +
        'permit(principal, action, resource) when { context.table == "x" };',
    });
    const { findings } = await lintPolicies({ path: dir });
    const w001 = findFindings(findings, "W001");
    const w002 = findFindings(findings, "W002");
    assert.equal(
      w001.length,
      0,
      "W001 should be suppressed via human-readable name",
    );
    assert.equal(
      w002.length,
      0,
      "W002 should be suppressed via human-readable name",
    );
  });

  it("W001+W002 suppressed with when clause: no findings", async () => {
    dir = await inlineDir({
      "test.cedar":
        '@lint_allow("W001,W002")\npermit(principal, action, resource) when { context.table == "x" };',
    });
    const { findings } = await lintPolicies({ path: dir });
    const w001 = findFindings(findings, "W001");
    const w002 = findFindings(findings, "W002");
    const e001 = findFindings(findings, "E001");
    assert.equal(w001.length, 0, "W001 should be suppressed");
    assert.equal(w002.length, 0, "W002 should be suppressed");
    assert.equal(e001.length, 0, "E001 should not fire — when clause present");
  });

  it("@lint_allow cannot suppress E003 syntax errors", async () => {
    dir = await inlineDir({
      "test.cedar": '@lint_allow("E003")\npermit(principal, action, resource',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e003 = findFindings(findings, "E003");
    assert.ok(
      e003.length >= 1,
      "E003 should still fire — annotations cannot suppress parse errors",
    );
  });

  it("empty @lint_allow suppresses nothing", async () => {
    dir = await inlineDir({
      "test.cedar": '@lint_allow("")\npermit(principal, action, resource);',
    });
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    const w001 = findFindings(findings, "W001");
    const w002 = findFindings(findings, "W002");
    assert.equal(
      e001.length,
      1,
      "E001 should fire — empty annotation suppresses nothing",
    );
    assert.equal(w001.length, 1, "W001 should fire");
    assert.equal(w002.length, 1, "W002 should fire");
  });
});

describe("linter — summary counts", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("clean directory: correct summary", async () => {
    dir = await fixtureDir("clean.cedar");
    const { summary } = await lintPolicies({ path: dir });
    assert.ok(
      summary.policiesScanned >= 2,
      `expected >= 2 policies, got ${summary.policiesScanned}`,
    );
    assert.equal(summary.errors, 0);
    assert.equal(summary.warnings, 0);
  });

  it("mixed violations: errors and warnings counted", async () => {
    dir = await fixtureDir("e001-violation.cedar", "w001-violation.cedar");
    const { summary } = await lintPolicies({ path: dir });
    assert.ok(summary.errors >= 1, "expected at least 1 error");
    assert.ok(summary.warnings >= 1, "expected at least 1 warning");
  });

  it("findings reference the correct file", async () => {
    dir = await fixtureDir("clean.cedar", "e001-violation.cedar");
    const { findings } = await lintPolicies({ path: dir });
    const e001 = findFindings(findings, "E001");
    assert.equal(e001.length, 1);
    assert.ok(
      e001[0].file.includes("e001-violation.cedar"),
      "E001 finding should reference e001-violation.cedar",
    );
    assert.ok(
      !e001[0].file.includes("clean.cedar"),
      "E001 finding should not reference clean.cedar",
    );
  });
});

describe("linter — edge cases", () => {
  let dir;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true });
  });

  it("nonexistent directory throws", async () => {
    await assert.rejects(
      () => lintPolicies({ path: "/tmp/nonexistent-lint-dir-xyz" }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.doesNotMatch(
          err.message,
          /not implemented/,
          "should throw a real error, not the stub",
        );
        return true;
      },
      "nonexistent directory should throw",
    );
  });

  it('empty directory throws "No .cedar files found"', async () => {
    dir = await tempDir();
    await assert.rejects(
      () => lintPolicies({ path: dir }),
      (err) => {
        assert.match(err.message, /No \.cedar files found/);
        return true;
      },
      'empty dir should throw with "No .cedar files found"',
    );
  });

  it("empty file is skipped", async () => {
    dir = await tempDir();
    await writeFile(join(dir, "empty.cedar"), "", "utf8");
    await writeFile(
      join(dir, "valid.cedar"),
      'permit(principal is PgrestLambda::User, action == PgrestLambda::Action::"select", resource is PgrestLambda::Row);',
      "utf8",
    );
    const { summary } = await lintPolicies({ path: dir });
    assert.equal(
      summary.policiesScanned,
      1,
      "empty file should not be counted in policiesScanned",
    );
  });
});

// --- CLI smoke tests ---

describe("CLI smoke tests — lint-policies", () => {
  let cleanDir;
  let violationsDir;
  let warningsOnlyDir;

  beforeEach(async () => {
    cleanDir = await fixtureDir("clean.cedar");
    violationsDir = await fixtureDir("e001-violation.cedar");
    warningsOnlyDir = await fixtureDir("w001-violation.cedar");
  });

  afterEach(async () => {
    if (cleanDir) await rm(cleanDir, { recursive: true });
    if (violationsDir) await rm(violationsDir, { recursive: true });
    if (warningsOnlyDir) await rm(warningsOnlyDir, { recursive: true });
  });

  it("exit 0 on clean policies", async () => {
    const { exitCode, stdout } = await runCli(["--path", cleanDir]);
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
    assert.match(stdout, /0 errors, 0 warnings/);
  });

  it("exit 1 on violations", async () => {
    const { exitCode, stdout } = await runCli(["--path", violationsDir]);
    assert.equal(exitCode, 1, `expected exit 1, got ${exitCode}`);
    assert.match(stdout, /E001/);
  });

  it("--max-severity off exits 0 even with violations", async () => {
    const { exitCode, stdout } = await runCli([
      "--path",
      violationsDir,
      "--max-severity",
      "off",
    ]);
    assert.equal(exitCode, 0, `expected exit 0 with --max-severity off`);
    assert.match(stdout, /E001/, "findings should still be printed");
  });

  it("--max-severity warn exits 1 on warnings", async () => {
    const { exitCode } = await runCli([
      "--path",
      violationsDir,
      "--max-severity",
      "warn",
    ]);
    assert.equal(exitCode, 1, "expected exit 1 when warnings exceed threshold");
  });

  it("exit 2 on nonexistent path", async () => {
    const { exitCode, stderr } = await runCli([
      "--path",
      "./nonexistent-dir-xyz",
    ]);
    assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}`);
    assert.ok(stderr.length > 0, "expected error message on stderr");
    assert.doesNotMatch(
      stderr,
      /Unknown command/,
      "lint-policies command must be registered in the CLI",
    );
  });

  it("exit 2 on empty directory", async () => {
    const emptyDir = join(FIXTURES, "empty-dir");
    const { exitCode, stderr } = await runCli(["--path", emptyDir]);
    assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}`);
    assert.match(stderr, /No \.cedar files/i);
  });

  it("--format json outputs valid JSON with findings array", async () => {
    const { exitCode, stdout } = await runCli([
      "--format",
      "json",
      "--path",
      violationsDir,
    ]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.findings), "expected findings array");
    assert.ok(parsed.summary, "expected summary object");
  });

  it("--quiet with clean dir produces no stdout", async () => {
    const { exitCode, stdout } = await runCli(["--quiet", "--path", cleanDir]);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), "", "expected no output with --quiet");
  });

  it("--format invalid exits 2", async () => {
    const { exitCode, stderr } = await runCli([
      "--format",
      "invalid",
      "--path",
      cleanDir,
    ]);
    assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}`);
    assert.ok(stderr.length > 0, "expected error message on stderr");
    assert.doesNotMatch(
      stderr,
      /Unknown command/,
      "lint-policies command must be registered in the CLI",
    );
    assert.match(stderr, /format/i, "error should mention format");
  });

  it("--max-severity warn exits 1 on warnings only", async () => {
    const { exitCode } = await runCli([
      "--path",
      warningsOnlyDir,
      "--max-severity",
      "warn",
    ]);
    assert.equal(
      exitCode,
      1,
      "expected exit 1 when only warnings exceed threshold",
    );
  });

  describe("test_cli_summary_pluralization", () => {
    it("0 policies → plural nouns", async () => {
      const dir = await inlineDir({ "blank.cedar": " " });
      try {
        const { stdout } = await runCli(["--path", dir]);
        assert.match(
          stdout,
          /^0 policies scanned, 0 errors, 0 warnings$/m,
        );
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it("1 policy → singular nouns", async () => {
      const dir = await inlineDir({
        "one.cedar": [
          "permit(",
          '    principal is PgrestLambda::User,',
          '    action == PgrestLambda::Action::"select",',
          "    resource is PgrestLambda::Row",
          ") when {",
          "    resource has user_id && resource.user_id == principal",
          "};",
        ].join("\n"),
      });
      try {
        const { stdout } = await runCli(["--path", dir]);
        assert.match(
          stdout,
          /^1 policy scanned, 0 errors, 0 warnings$/m,
        );
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it("2 policies with 1 error and 1 warning → singular error/warning", async () => {
      const dir = await inlineDir({
        "a.cedar": '@lint_allow("W001,W002")\npermit(principal, action, resource);',
        "b.cedar": [
          "permit(",
          "    principal,",
          '    action == PgrestLambda::Action::"select",',
          "    resource is PgrestLambda::Row",
          ') when { context.table == "posts" };',
        ].join("\n"),
      });
      try {
        const { stdout } = await runCli(["--path", dir]);
        assert.match(
          stdout,
          /^2 policies scanned, 1 error, 1 warning$/m,
        );
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });
});
