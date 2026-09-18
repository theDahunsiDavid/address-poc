// Compare runner for the Nigerian address-verification providers.
//
// One code path for smoke and full runs — the smoke test is just the runner
// against a single known-good probe address (`--probe`) instead of the
// canonical dataset (`--fixture`, the default). Same measurement code, same
// output shape, so smoke results are directly comparable to the full run.
//
//   smoke:  npx tsx scripts/verify-compare.ts --probe
//   full:   npx tsx scripts/verify-compare.ts [--fixture data/<file>.json]
//
// For every fixture x verify-capable provider it calls provider.verify()
// in-process and records ok/providerStatus/canonical/raw/serverMs/error/code
// into logs/verify-compare/<run>/ (results.json + summary.md). Errors tagged
// code='no-match' are coverage misses; untagged errors are transport/config
// failures. Probe runs apply the pre-full-run gate: 2+ failed providers exit
// non-zero.
//
// `.env.local` is loaded if present; otherwise keys come from the environment.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { providers } from '../lib/providers';
import type { ProviderId } from '../lib/providers/meta';
import type { VerifyInput } from '../lib/providers/types';
import type { CanonicalAddress } from '../lib/schema';
import { keyStatus } from '../lib/config';
import { providerStatus, type ProviderStatus } from '../lib/verdict';
import { errorMessage, type CodedError } from '../lib/errors';

/** True when running the trial-keys probe (smoke) instead of a fixture file. */
function argFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const isProbe = argFlag('--probe');
const fixturePath = argValue('--fixture') ?? 'data/nigeria-verify-fixtures2.json';

// --- env --------------------------------------------------------------------

// Next loads .env.local for the app; this script loads it itself so the same
// keys work without a running dev server. Real environment values win.
function loadDotEnv(path = '.env.local'): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // no .env.local — keys already in process.env
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined && key) process.env[key] = val;
  }
}

// --- fixtures ---------------------------------------------------------------

interface Fixture {
  id: string;
  negative: boolean;
  line1: string;
  line2?: string | null;
  cityArea?: string | null;
  state?: string | null;
  postalCode?: string | null; // '' everywhere: deliberately withheld
}

/** Known-good probe used by the smoke run (see the dataset's probe history). */
const PROBE: Fixture = {
  id: 'probe-admiralty-1',
  negative: false,
  line1: '15 Admiralty Way',
  line2: null,
  cityArea: 'Ikoyi',
  state: 'Lagos',
  postalCode: '',
};

function loadFixtures(): Fixture[] {
  if (isProbe) return [PROBE];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch (err) {
    throw new Error(`fixture file not found or invalid: ${fixturePath} (${errorMessage(err)})`);
  }
  if (!Array.isArray(parsed)) throw new Error(`fixture file must be a JSON array: ${fixturePath}`);
  return parsed as Fixture[];
}

/** Mirror the API's optional-string handling: trim, drop empties. */
function s(v: string | null | undefined): string | undefined {
  return v && v.trim() ? v.trim() : undefined;
}

// --- run --------------------------------------------------------------------

interface VerifyRecord {
  provider: string;
  fixtureId: string;
  negative: boolean;
  line1: string;
  ok: boolean;
  error?: string;
  code?: string;
  keyMissing?: boolean;
  serverMs: number;
  providerStatus?: ProviderStatus;
  canonical?: CanonicalAddress;
  raw?: unknown;
}

function pad(s: string, n: number): string {
  return s.padEnd(n).slice(0, n);
}

async function main(): Promise<void> {
  loadDotEnv();

  const fixtures = loadFixtures();
  const verifyProviders = Object.values(providers).filter((p) => p.verify);
  const summaryLines: string[] = [];

  console.log(
    `${isProbe ? 'PROBE' : 'RUN'} — ${fixtures.length} fixture(s) x ${verifyProviders.length} provider(s) = ` +
      `${fixtures.length * verifyProviders.length} calls`,
  );
  console.log(pad('provider', 12) + pad('fixture', 28) + pad('ok', 8) + pad('status', 10) + pad('ms', 6) + 'error/code');
  summaryLines.push(
    `# Verify compare — ${isProbe ? 'smoke probe' : 'fixture run'}`,
    '',
    `- run: ${new Date().toISOString()}`,
    `- fixture: ${isProbe ? '15 Admiralty Way, Ikoyi, Lagos (built-in probe)' : fixturePath}`,
    `- calls: ${fixtures.length} x ${verifyProviders.length} = ${fixtures.length * verifyProviders.length}`,
  );

  const records: VerifyRecord[] = [];

  for (const fx of fixtures) {
    for (const p of verifyProviders) {
      const rec: VerifyRecord = {
        provider: p.id,
        fixtureId: fx.id,
        negative: fx.negative,
        line1: fx.line1,
        ok: false,
        serverMs: 0,
      };
      try {
        if (keyStatus(p.id as ProviderId) === 'missing') {
          rec.keyMissing = true;
          rec.error = 'trial key missing';
          records.push(rec);
          continue; // recorded below the table as a skip — flag, don't call.
        }
        const input: VerifyInput = {
          line1: fx.line1,
          line2: s(fx.line2),
          cityArea: s(fx.cityArea),
          state: s(fx.state),
          postalCode: s(fx.postalCode),
          country: 'Nigeria',
        };
        const start = performance.now();
        let result: Awaited<ReturnType<NonNullable<typeof p.verify>>>;
        try {
          result = await p.verify!(input);
        } finally {
          rec.serverMs = Math.round(performance.now() - start);
        }
        rec.ok = true;
        rec.canonical = result.canonical;
        rec.raw = result.raw;
        rec.providerStatus = providerStatus(p.id, result.raw);
      } catch (err) {
        rec.error = errorMessage(err);
        rec.code = err instanceof Error && 'code' in err ? (err as CodedError).code : undefined;
      }
      records.push(rec);
      console.log(
        pad(rec.provider, 12) +
          pad(rec.fixtureId, 28) +
          pad(rec.ok ? 'ok' : 'FAIL', 8) +
          pad(rec.providerStatus ?? '', 10) +
          pad(String(rec.serverMs), 6) +
          (rec.keyMissing ? 'KEY MISSING' : rec.error ?? ''),
      );
    }
  }

  // --- persistence ------------------------------------------------------------

  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = `logs/verify-compare/${runId}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/results.json`, `${JSON.stringify(records, null, 2)}\n`);

  // rollup + detail tables for summary.md
  const byProvider = new Map<string, VerifyRecord[]>();
  for (const r of records) {
    const list = byProvider.get(r.provider) ?? [];
    list.push(r);
    byProvider.set(r.provider, list);
  }
  summaryLines.push('', '| provider | calls | ok | no-match | failed | avg ms |', '|---|---|---|---|---|---|');
  for (const [pid, rs] of byProvider) {
    const ok = rs.filter((r) => r.ok).length;
    const noMatch = rs.filter((r) => r.code === 'no-match').length;
    const failed = rs.filter((r) => !r.ok && r.code !== 'no-match').length;
    const avg = Math.round(rs.reduce((a, r) => a + r.serverMs, 0) / rs.length);
    summaryLines.push(`| ${pid} | ${rs.length} | ${ok} | ${noMatch} | ${failed} | ${avg} |`);
  }
  summaryLines.push('', '| fixture | provider | ok | status | ms | code | error |', '|---|---|---|---|---|---|---|');
  for (const r of records) {
    summaryLines.push(
      `| ${r.fixtureId} | ${r.provider} | ${r.ok} | ${r.providerStatus ?? ''} | ${r.serverMs} | ${r.code ?? ''} | ${r.error ?? ''} |`,
    );
  }
  writeFileSync(`${dir}/summary.md`, `${summaryLines.join('\n')}\n`);
  console.log(`\nWrote ${dir}/results.json + summary.md`);

  // --- gate (probe runs only) ---------------------------------------------------

  if (isProbe) {
    const fails = records.filter((r) => !r.ok);
    console.log(`\nGATE: ${records.length - fails.length}/${records.length} provider calls passed the probe.`);
    if (fails.length === 0) {
      console.log('All providers operational — full run unblocked.');
    } else if (fails.length >= 2) {
      console.log(`BLOCKED: ${fails.length} providers failed (${fails.map((r) => r.provider).join(', ')}). `);
      console.log('Investigate before the full run, or re-run once for transient errors.');
      process.exit(2);
    } else {
      console.log(`${fails.length} provider failed — see summary; single-failure is not a blocker.`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});