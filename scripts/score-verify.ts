/**
 * score-verify.ts — scores a recorded verify-compare run against dataset ground truth.
 *
 * Consumes logs/verify-compare/<run>/results.json + data/nigeria-verify-fixtures2.json
 * (join on fixtureId), writes <run>/score.json (per-record axes + rollups) and
 * <run>/score.md (segmented report). No API calls, no .env needed.
 *
 * Usage: npx tsx scripts/score-verify.ts [runId|runDir] [--fixture <json>]
 *   runId omitted → the latest run under logs/verify-compare/.
 *
 * Scoring rules (documented in the report):
 *  - STREET-MATCH S ∈ [0,1]: |tokens(expected.line1) ∩ tokens(canonical line1+line2)| / |tokens(expected.line1)|
 *    after lowercase + suffix normalization (Rd→Road, St→Street, Ave→Avenue, Cres→Crescent, ...)
 *    and dropping structural tokens (plot, block, no, nr). Numeric tokens are kept.
 *  - LEVEL (provider self-certification): verified=3 premise, partial=2 street, ambiguous=2 street-unconfirmed,
 *    none=0, no-match=0. Reported as context; NOT the coverage judge.
 *  - Coverage judge is OUR band rule per expectedPrecision:
 *      premise: (numerics(expected) ∩ numerics(canonical) ≠ ∅) AND S ≥ 0.5
 *      street : S ≥ 0.5
 *      city   : S ≥ 0.5 OR state-norm(canonical.state) == state-norm(expected.state)
 *  - Negatives: echo (S ≥ 0.5 — confirmed the fabricated street), fused (0 < S < 0.5 — claimed a
 *    different real place), correct (S = 0 or no-match), unmeasured (failed).
 *  - Coords axis (only providers whose canonical carries lat/lng): haversine(canonical, expected) ≤ coordToleranceKm.
 *    Providers without geocoded output (smarty/precisely) are N/A, not zero.
 *  - Postcode axis: informational only (derived-postcode rate); unscored by design (0 reliable rows).
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------- types ----------
interface VerifyRecord {
  provider: string; fixtureId: string; negative: boolean; line1: string; ok: boolean;
  providerStatus: string | null; canonical: Canon | null; raw: unknown; serverMs: number;
  code?: string; error?: string;
}
interface Canon { line1?: string; line2?: string; cityArea?: string; state?: string; postalCode?: string; lat?: number; lng?: number; [k: string]: unknown }
interface Fixture {
  id: string; negative: boolean; line1: string; state: string; expectedPrecision: string | null;
  expectedLat: number | null; expectedLng: number | null; coordToleranceKm?: number | null;
  inputStyle?: string; postalCodeReliable?: boolean;
}
type Band = 'premise' | 'street' | 'city';

// ---------- token helpers ----------
const SUFFIX: Record<string, string> = {
  rd: 'road', st: 'street', av: 'avenue', ave: 'avenue', crs: 'crescent', ln: 'lane',
  dr: 'drive', blvd: 'boulevard', hwy: 'highway', pkwy: 'parkway', ter: 'terrace',
  terr: 'terrace', pl: 'place', ext: 'extension', byp: 'bypass', cir: 'circle',
  ct: 'court', sq: 'square', cres: 'crescent',
};
const STRUCTURAL = new Set(['plot', 'block', 'no', 'nr']);
const NUMBER_RE = /\d+/g;

function normToken(t: string): string {
  const lower = t.toLowerCase();
  return SUFFIX[lower] ?? lower;
}
function tokens(s: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of (s ?? '').split(/[^A-Za-z0-9]+/)) {
    if (!w) continue;
    const n = normToken(w);
    if (STRUCTURAL.has(n) || n.length === 0) continue;
    out.add(n);
  }
  return out;
}
function numerics(s: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of (s ?? '').matchAll(NUMBER_RE)) out.add(m[0]);
  return out;
}
function containment(expected: string, gotLine1: string | undefined, gotLine2: string | undefined): number {
  const exp = tokens(expected);
  if (exp.size === 0) return 1;
  const got = tokens(gotLine1);
  for (const t of tokens(gotLine2)) got.add(t);
  let hit = 0;
  for (const t of exp) if (got.has(t)) hit++;
  return hit / exp.size;
}
function normState(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/state$/, '').replace(/^ng$/, '');
}
// ---------- geo ----------
const EARTH_KM = 6371;
function havKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat); const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------- CLI ----------
let runArg: string | undefined;
let fixturePath = resolve('data/nigeria-verify-fixtures2.json');
let mergeBase: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--fixture') fixturePath = resolve(process.argv[++i]);
  else if (a === '--merge-base') mergeBase = process.argv[++i];
  else if (!a.startsWith('-')) runArg = a;
}
const base = resolve('logs/verify-compare');
let runDir: string;
if (runArg) {
  runDir = runArg.includes('/') ? resolve(runArg) : join(base, runArg);
} else {
  const dirs = readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  if (dirs.length === 0) { console.error('no runs under logs/verify-compare/'); process.exit(1); }
  runDir = join(base, dirs[dirs.length - 1]);
  console.log(`using latest run: ${dirs[dirs.length - 1]}`);
}
let results: VerifyRecord[] = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8'));

// Patch overlay: replace the base run's cells with this run's records where (provider, fixtureId)
// match, write a merged results.json to <base>-patched, and score that.
if (mergeBase) {
  const baseDir = mergeBase.includes('/') ? resolve(mergeBase) : join(base, mergeBase);
  const baseRecords: VerifyRecord[] = JSON.parse(readFileSync(join(baseDir, 'results.json'), 'utf8'));
  const patched = new Map(results.map(r => [`${r.provider}|${r.fixtureId}`, r]));
  const merged = baseRecords.map(r => patched.get(`${r.provider}|${r.fixtureId}`) ?? r);
  const mergedDir = `${baseDir}-patched`;
  mkdirSync(mergedDir, { recursive: true });
  writeFileSync(join(mergedDir, 'results.json'), `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`merged ${patched.size} patch cell(s) -> ${mergedDir}`);
  results = merged;
  runDir = mergedDir;
}
const fixtures: Fixture[] = JSON.parse(readFileSync(fixturePath, 'utf8'));
const fx = new Map(fixtures.map(f => [f.id, f]));

// ---------- per-record axes ----------
interface Row {
  r: VerifyRecord; f: Fixture; S: number; level: number; coordsKm: number | null; stateMatch: boolean;
  numHit: boolean; outcome: string; failed: boolean;
}
const rows: Row[] = [];
const LEVEL: Record<string, number> = { verified: 3, partial: 2, ambiguous: 2, none: 0 };

for (const r of results) {
  const f = fx.get(r.fixtureId);
  if (!f) { console.error(`unknown fixture ${r.fixtureId}`); process.exit(1); }
  const c = r.canonical ?? {};
  const S = containment(f.line1, c.line1, c.line2);
  const numHit = intersectNonEmpty(numerics(f.line1), numerics(c.line1));
  const level = r.ok && r.providerStatus ? (LEVEL[r.providerStatus] ?? 0) : 0;
  const coordsKm = (typeof c.lat === 'number' && typeof c.lng === 'number' && f.expectedLat != null && f.expectedLng != null)
    ? havKm(c.lat, c.lng, f.expectedLat, f.expectedLng) : null;
  const stateMatch = normState(c.state) !== '' && normState(c.state) === normState(f.state);
  const failed = !r.ok && r.code !== 'no-match';
  rows.push({ r, f, S, level, coordsKm, stateMatch, numHit, outcome: '', failed });
}
function intersectNonEmpty(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// ---------- classification ----------
const bands: Record<string, Band> = { premise: 'premise', street: 'street', city: 'city' };
for (const row of rows) {
  const { r, f, S, level, coordsKm, stateMatch, numHit } = row;
  if (row.failed) { row.outcome = 'unmeasured'; continue; }
  const noContent = !r.ok || !r.canonical || (!r.canonical.line1 && !r.canonical.line2);
  if (f.negative) {
    if (noContent) row.outcome = 'correct';
    else if (S >= 0.5) row.outcome = 'echo';
    else if (S > 0) row.outcome = 'fused';
    else row.outcome = 'correct';
    continue;
  }
  const band = bands[f.expectedPrecision ?? ''];
  if (noContent || level === 0) { row.outcome = 'not-found'; continue; }
  if (band === 'premise') row.outcome = (numHit && S >= 0.5) ? 'hit' : (S >= 0.5 ? 'street-only' : 'wrong-street');
  else if (band === 'street') row.outcome = S >= 0.5 ? 'hit' : 'wrong-street';
  else row.outcome = (S >= 0.5 || stateMatch) ? 'hit' : 'wrong-place';
}

// ---------- rollups ----------
interface Stat { total: number; hit: number; byOutcome: Record<string, number>; coordsOk: number; coordsN: number; pc: number; ms: number[] }
const statOf = (prov: string): Stat => ({ total: 0, hit: 0, byOutcome: {}, coordsOk: 0, coordsN: 0, pc: 0, ms: [] });
const all = new Map<string, Stat>();
const byBand = new Map<string, Map<string, Stat>>();
const byStyle = new Map<string, Map<string, Stat>>();
const neg = new Map<string, Stat>();

for (const row of rows) {
  const prov = row.r.provider;
  if (!all.has(prov)) { all.set(prov, statOf(prov)); neg.set(prov, statOf(prov)); }
  for (const m of [byBand, byStyle]) if (!m.has(prov)) m.set(prov, new Map());
  if (row.f.negative) {
    const s = neg.get(prov)!;
    s.total++; s.ms.push(row.r.serverMs);
    s.byOutcome[row.outcome] = (s.byOutcome[row.outcome] ?? 0) + 1;
    continue;
  }
  const s = all.get(prov)!;
  s.total++; s.ms.push(row.r.serverMs);
  const band = row.f.expectedPrecision ?? '?';
  const bs = (byBand.get(prov)!.get(band) ?? (() => { const st = statOf(prov); byBand.get(prov)!.set(band, st); return st; })()); bs.total++;
  const ss = (byStyle.get(prov)!.get(row.f.inputStyle ?? '?') ?? (() => { const st = statOf(prov); byStyle.get(prov)!.set(row.f.inputStyle ?? '?', st); return st; })()); ss.total++;
  const buckets = [s, bs, ss];
  for (const b of buckets) { b.byOutcome[row.outcome] = (b.byOutcome[row.outcome] ?? 0) + 1; }
  if (row.outcome === 'hit') { s.hit++; bs.hit++; ss.hit++; }
  if (row.outcome === 'hit' && row.coordsKm != null) { s.coordsN++; if (row.coordsKm <= (row.f.coordToleranceKm ?? 2)) s.coordsOk++; }
  if (row.r.canonical?.postalCode) s.pc++;
}

// ---------- output ----------
const pct = (b: number | undefined, n: number | undefined) => (n ? Math.round((100 * (b ?? 0)) / n) : 0);
const rowsOut: unknown[] = rows.map(row => ({
  provider: row.r.provider, fixtureId: row.r.fixtureId, negative: row.f.negative, ok: row.r.ok,
  status: row.r.providerStatus, outcome: row.outcome, S: +row.S.toFixed(3), level: row.level,
  coordsKm: row.coordsKm != null ? +row.coordsKm.toFixed(2) : null,
}));
const rollup: Record<string, unknown> = {};
for (const [prov, s] of all) rollup[prov] = {
  calls: s.total, coverage: pct(s.hit, s.total), byOutcome: s.byOutcome,
  coordsWithinTol: s.coordsN ? `${pct(s.coordsOk, s.coordsN)}% (${s.coordsOk}/${s.coordsN})` : 'n/a',
  derivedPostcode: `${pct(s.pc, s.total)}% (${s.pc}/${s.total})`,
  latencyMedianMs: s.ms.length ? s.ms.slice().sort((a, b) => a - b)[Math.floor(s.ms.length / 2)] : null,
};
const negRollup: Record<string, unknown> = {};
for (const [prov, s] of neg) negRollup[prov] = { ...s.byOutcome, measured: s.total };
const bandRollup: Record<string, unknown> = {};
for (const [prov, m] of byBand) {
  const o: Record<string, unknown> = {};
  for (const [band, s] of m) o[band] = { coverage: pct(s.hit, s.total), byOutcome: s.byOutcome, n: s.total };
  bandRollup[prov] = o;
}
writeFileSync(join(runDir, 'score.json'), JSON.stringify({ run: runDir, rows: rowsOut, rollup, negRollup, bandRollup }, null, 2));

// ---------- markdown report ----------
const L: string[] = [];
const push = (l = '') => L.push(l);
const med = (ms: number[]) => (ms.length ? ms.slice().sort((a, b) => a - b)[Math.floor(ms.length / 2)] : 0);
const provs = [...all.keys()];
push(`# Verify-compare score — ${runDir.split('/').pop()}`);
push();
push(`- calls: ${results.length} (${fixtures.length} fixtures × ${provs.length} providers)`);
push(`- coverage judge: ground-truth street-token match (**S**) against \`line1\`, band rules per \`expectedPrecision\``);
push(`- threshold: S ≥ 0.5 required for premise/street bands; premise rows additionally need the expected house/plot number present`);
push(`- city band: S ≥ 0.5 **or** canonical state = expected state`);
push(`- unmeasured = transport/quota failures (retried flag), not coverage misses`);
push();
push(`## Coverage by provider (35 real rows)`);
push();
push(`| provider | coverage | hit/total | outcomes (hit / street-only · wrong-street · wrong-place / not-found / unmeasured) |`);
push(`|---|---|---|---|`);
for (const p of provs) {
  const s = all.get(p)!;
  push(`| ${p} | **${pct(s.hit, s.total)}%** | ${s.hit}/${s.total} | ${s.byOutcome.hit ?? 0} / ${(s.byOutcome['street-only'] ?? 0) + (s.byOutcome['wrong-street'] ?? 0) + (s.byOutcome['wrong-place'] ?? 0)} · ${s.byOutcome['not-found'] ?? 0} · ${s.byOutcome.unmeasured ?? 0} |`);
}
push();
push(`## Coverage by expectedPrecision band`);
push();
push(`| provider | premise (n=${count(fx, 'premise')}) | street (n=${count(fx, 'street')}) | city (n=${count(fx, 'city')}) |`);
push(`|---|---|---|---|`);
for (const p of provs) {
  const m = byBand.get(p)!;
  push(`| ${p} | ${bandCell(m, 'premise')} | ${bandCell(m, 'street')} | ${bandCell(m, 'city')} |`);
}
push();
push(`## Coverage by inputStyle (n=${count(fx, undefined, 'structured')} structured / ${count(fx, undefined, 'narrative')} narrative)`);
push();
push(`| provider | structured (n=${count(fx, undefined, 'structured')}) | narrative (n=${count(fx, undefined, 'narrative')}) |`);
push(`|---|---|---|`);
for (const p of provs) {
  const m = byStyle.get(p)!;
  const str = m.get('structured'); const nar = m.get('narrative');
  push(`| ${p} | ${str ? `${pct(str.hit, str.total)}% (${str.hit}/${str.total})` : '-'} | ${nar ? `${pct(nar.hit, nar.total)}% (${nar.hit}/${nar.total})` : '-'} |`);
}
push();
push(`## Negatives (6 fabricated addresses) — false-positive check`);
push();
push(`| provider | echo (confirmed fake) | fused (claimed another real place) | correct (no-match / region-only fallback) | unmeasured |`);
push(`|---|---|---|---|---|`);
for (const p of provs) {
  const s = neg.get(p)!;
  push(`| ${p} | ${s.byOutcome.echo ?? 0} | ${s.byOutcome.fused ?? 0} | ${s.byOutcome.correct ?? 0} | ${s.byOutcome.unmeasured ?? 0} |`);
}
push();
push(`## Coordinates axis (of hit rows only — within coordToleranceKm of ground truth)`);
push();
push(`| provider | within tol | note |`);
push(`|---|---|---|`);
for (const p of provs) {
  const s = all.get(p)!;
  const note = s.coordsN === 0 ? (p === 'smarty' || p === 'precisely' ? 'verify product returns no coordinates — axis N/A' : 'no coord-bearing hit rows') : '';
  push(`| ${p} | ${s.coordsN ? `${pct(s.coordsOk, s.coordsN)}% (${s.coordsOk}/${s.coordsN})` : 'n/a'} | ${note} |`);
}
push();
push(`## Postcode derivation (informational — axis unscored by design: 0 \`postalCodeReliable\` rows)`);
push();
push(`| provider | derived postcode rate |`);
push(`|---|---|`);
for (const p of provs) {
  const s = all.get(p)!;
  push(`| ${p} | ${pct(s.pc, s.total)}% (${s.pc}/${s.total}) |`);
}
push();
push(`## Latency (real rows + negatives)`);
push();
push(`| provider | median ms | max ms |`);
push(`|---|---|---|`);
for (const p of provs) {
  const ms = all.get(p)!.ms.concat(neg.get(p)!.ms);
  push(`| ${p} | ${med(ms)} | ${ms.length ? Math.max(...ms) : '-'} |`);
}
push();
push(`## Provider self-certification (context only — coverage judge is S above)`);
push();
push(`| provider | verified | partial | ambiguous | none |`);
push(`|---|---|---|---|---|`);
const statusCounts = new Map<string, number[]>();
for (const p of provs) statusCounts.set(p, [0, 0, 0, 0]);
for (const row of rows) {
  if (row.f.negative) continue;
  const a = statusCounts.get(row.r.provider)!;
  if (!row.r.ok || !row.r.providerStatus) continue;
  a[['verified', 'partial', 'ambiguous', 'none'].indexOf(row.r.providerStatus)]++;
}
for (const p of provs) {
  const a = statusCounts.get(p)!;
  push(`| ${p} | ${a[0]} | ${a[1]} | ${a[2]} | ${a[3]} |`);
}
push();
push(`## Findings`);
push();
for (const p of provs) {
  const s = all.get(p)!;
  const nf = s.byOutcome['not-found'] ?? 0; const wrong = (s.byOutcome['wrong-street'] ?? 0) + (s.byOutcome['wrong-place'] ?? 0) + (s.byOutcome['street-only'] ?? 0);
  if (nf) push(`- **${p}** returned no usable answer on **${nf}** real rows`);
  if (wrong) push(`- **${p}** answered below expectation (street-only / wrong place) on **${wrong}** rows`);
}
const preciseTypo = rows.filter(r => r.r.provider === 'precisely' && /bourdilon/i.test(r.r.canonical?.line1 ?? '')).length;
if (preciseTypo) push(`- **Precisely data-quality**: canonical output spells the Ikoyi street \`BOURDILON\` (missing L) on **${preciseTypo}** responses — a data typo, not a scoring artifact`);
const loqateU = rows.filter(r => r.r.provider === 'loqate' && !r.f.negative && r.r.providerStatus === 'none' && r.S >= 0.6).length;
if (loqateU) push(`- **Loqate self-certification**: **${loqateU}** rows return street+number matching ground truth (S≥0.6) yet the verdict is \`none\` (AVC **U**-class = unverified) — Loqate's coverage understates what it actually returns`);
const loqateBad = rows.filter(r => r.r.provider === 'loqate' && r.outcome === 'hit' && r.coordsKm != null && r.coordsKm > 50);
if (loqateBad.length) push(`- **Loqate misgeocoding**: **${loqateBad.length}** street-matched rows return coordinates ${loqateBad.map(r => `${r.f.id} ${Math.round(r.coordsKm!)}km`).join(', ')} away from ground truth — street string matches but the geocoding plots the wrong region`);
const pgQuota = rows.filter(r => r.r.provider === 'postgrid' && r.outcome === 'unmeasured').length;
if (pgQuota) push(`- **PostGrid quota**: ${pgQuota} negative rows unmeasured (sandbox \`LookupLimitError\`) — its false-positive behavior is not in this table`);
push();
push(`*Rules: S = token containment of expected line1 in canonical line1+line2; suffix-normalized; structural tokens (plot/block/no/nr) excluded; numeric tokens required for premise. Postcode axis deliberately unscored (0 \`postalCodeReliable\` rows).*`);

writeFileSync(join(runDir, 'score.md'), L.join('\n'));
console.log(`wrote ${join(runDir, 'score.json')} and ${join(runDir, 'score.md')}`);
console.log(provs.map(p => `  ${p.padEnd(10)} coverage ${pct(all.get(p)!.hit, all.get(p)!.total)}%`).join('\n'));

// ---------- helpers ----------
function count(fx: Map<string, Fixture>, band?: string, style?: string): number {
  let n = 0;
  for (const f of fx.values()) {
    if (f.negative) continue;
    if (band && f.expectedPrecision !== band) continue;
    if (style && f.inputStyle !== style) continue;
    n++;
  }
  return n;
}
function bandCell(m: Map<string, Stat>, band: string): string {
  const s = m.get(band);
  return s ? `${pct(s.hit, s.total)}% (${s.hit}/${s.total})` : '-';
}