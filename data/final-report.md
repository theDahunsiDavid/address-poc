# Nigerian Address Verification — Provider Comparison

## Executive summary

We tested five address-verification providers against 41 Nigerian addresses (35 real, 6 fabricated) to find who can reliably verify Nigerian addresses. The short answer: **nobody can officially certify a Nigerian address** (the country has no authoritative address database), so the useful question is *who gets it right, and who can be fooled*. **Geoapify** is the most trustworthy provider — it never confirmed a fabricated address and gives the best coordinates and postcodes — while **Smarty** has the best coverage but cannot certify anything and confirms fake addresses readily. For a product that needs a "verified" signal, use **Geoapify**; to also maximize address capture, add **Smarty** on top. Loqate, PostGrid and Precisely are not recommended for Nigeria.

## 1. The question

We are selecting an address-verification provider for Nigerian addresses. Users enter an address; the provider returns its best version of that address plus some signal of confidence (verified / partial / ambiguous / none) and, optionally, coordinates. We wanted to know: which provider, under identical conditions, actually finds the right place — and which ones confidently confirm addresses that do not exist.

## 2. The providers — two different kinds of products

The five providers split into two families, and the difference explains most of the results:

**Category A — Postal-address engines: Smarty, Precisely, Loqate, PostGrid.**
Built around postal-reference data and street-name parsing. They almost always return *something* — a cleanly formatted address — but whether that answer is real depends on their data. PostGrid silently resells Loqate's data (the two returned identical results on our probe).

**Category B — Map-based verification: Geoapify.**
Matches against open map data (OpenStreetMap). It can only say "found" if the place actually exists on a map; otherwise it says "no match" or falls back to a region.

Category A answers *always*. Category B answers *truthfully*. Both matter, differently.

## 3. Grading criteria

We judged each provider on each address using three measures:

1. **Gets the right place** — the returned address matches our ground-truth record at the required precision (house/plot → street → city). This is our *coverage* score. We judged it by matching the returned text and coordinates against our records — not by trusting the provider's own verdict.
2. **Doesn't invent** — on fabricated addresses, does it correctly say "no match", or does it confidently confirm something? This is the *false-positive* check.
3. **Bonus value** — useful extras a provider may return: coordinates (for map pinning), postcode, and speed.

**Explicitly out of scope: cost, SLAs, licensing, and enterprise support were not graded.** That is a separate procurement exercise. Also out of scope: official Nigerian validation — no authoritative source exists (NIPOST was unreachable throughout the study), so "verified" here means *consistent with two independent geo sources*, never official certification.

## 4. How we collected ground truth

- **41 test addresses**: 35 real (25 house/plot-level, 6 street-level, 4 city-level, spread across 14 states) and 6 fabricated.
- Every real address was **verified against two independent sources** (map presence + coordinates) before testing — no address was assumed real.
- The 6 fabricated addresses were designed to be plausible (real cities, real-sounding street names, some built on real streets with impossible house numbers) and were **confirmed to not exist**.
- **Postcodes were deliberately not graded**: with no official source, none of our ground-truth rows could be postcode-certified. We only report whether providers *derive* a postcode at all (Geoapify is the only one that does, on 63% of addresses).

## 5. How we tested

- All five providers via their live verification APIs using the same trial-tier credentials class, same address inputs, and **one shared test harness** — so the runs are directly comparable.
- 205 calls in total (41 addresses × 5 providers). PostGrid ran out of its sandbox quota partway and was re-measured on a second free account; Loqate hit a daily demo limit on one call and was re-run after reset.
- A "hit" = the returned address actually contains our recorded street (and the house number, when house-level was required). Provider verdicts (verified/partial/…) were recorded separately and reported as context, because — as the fabricated addresses would show — the verdict alone cannot be trusted.

## 6. Results

### Headline table (35 real addresses, 6 fabricated)

| provider | Coverage (right place) | Confirmed a fake address? | Coordinates | Postcode | Median speed |
|---|---|---|---|---|---|
| **Smarty** | **89%** (31/35) | **6 of 6** | none | none | 325 ms |
| **Precisely** | 71% (25/35) | 2 of 6¹ | none | none | 315 ms |
| **PostGrid** | 66% (23/35) | 3 of 6 | 55% accurate² | 3% | 501 ms |
| **Loqate** | 63% (22/35) | **6 of 6** | 50% accurate² | 6% | 245 ms |
| **Geoapify** | 57% (20/35) | **1 of 6** | 60% accurate² | **63%** | 1.1 s |

¹ one confirmed the fake street, one claimed a different nearby place. ² of correct matches, within a small distance tolerance of ground truth.

### What the numbers mean

**Coverage is cheap; trust is not.** Smarty has the highest coverage simply because it always produces a fully formed answer. But it confirmed all 6 fabricated addresses, and never once returned a house-level "verified" in Nigeria — its answers are candidates, not certifications.

**Every postal engine (Category A) can be fooled.** The pattern was identical across Smarty (6/6), Loqate (6/6), PostGrid (3/6) and Precisely (2/6): when the street exists in their data but the number doesn't, they don't report "no match" — they assign the impossible number to the real street and call it found.

**Geoapify (Category B) made mistakes in the safe direction.** Its 1 false confirmation (the only one at house level) aside, its misses were honest: "no match" or a broad region. Its real weakness is raw coverage — it missed several real addresses, concentrated in deep-rural and prose-style inputs (it found 0 of 2 narrative addresses), and it was by far the slowest (median 1.1 s, worst call 9 s).

**Data quality.** Precisely's Nigerian data misspells an Ikoyi street (`BOURDILON`). Loqate returned coordinates 150–173 km from the right location on two street-matched addresses. Smarty and Precisely return no coordinates at all (their trial offers no geo-code tier) — so map pinning requires Category B or a paid tier.

## 7. Recommendation

1. **Geoapify — use as the verification layer.** The only provider whose "found" means something: never confirmed fabricated addresses, most accurate coordinates (60% of correct matches), and the only one deriving postcodes (63%, e.g. `106104` for a Lekki address). Its lower coverage and higher latency are the safe kind of failure: it sometimes says no, but never says yes wrongly. Mitigate its misses and speed limits in the product design (fallbacks, UI loading states), not by switching providers.

2. **Smarty — optional coverage backstop, never the trust layer.** Highest recall (89%) and fast, which makes it a good "did we parse something usable" layer. But it cannot certify Nigerian addresses (no house-level verified result in 35 tries) and confirms fabricated streets readily. If used, pair it *under* Geoapify: let Smarty fill in addresses Geoapify refuses, and let Geoapify vouch for what Smarty claims.

3. **Loqate and PostGrid — not recommended.** Mid-range coverage, the same false-confirmation behavior, unreliable coordinates (Loqate plotted two matched addresses 150+ km away), and PostGrid is a Loqate reseller with a quota-fragile free tier.

4. **Precisely — not recommended.** No coordinates, never certifies house-level addresses in Nigeria, a street-name typo in its Nigerian data, and heavyweight enterprise integration.

**The decision in one line:** if the product must display a trustworthy "verified" status, pick **Geoapify**. If coverage/capture is the priority and candidates are acceptable, run **Smarty over Geoapify**. Skip the rest for Nigeria.

**Still open:** cost/licensing procurement; production-tier behavior of PostGrid (tested only on free accounts); validation beyond the 14 states and 41 addresses in this set.

---

## Appendix — study details

| Element | Value |
|---|---|
| Real addresses | 35 (house/plot 25, street 6, city 4) |
| Fabricated addresses | 6 (confirmed nonexistent) |
| States covered | 14 |
| Input styles | 33 structured, 2 narrative |
| Providers | 5 (Smarty, Precisely, Loqate, PostGrid, Geoapify) |
| Live calls | 205 (41 × 5), all re-measured after quota resets |

Coverage by required precision (a provider must match at or above the address's minimum acceptable level):

| provider | house/plot (25) | street (6) | city (4) |
|---|---|---|---|
| Smarty | 88% | 83% | 100% |
| Precisely | 76% | 50% | 75% |
| PostGrid | 68% | 67% | 50% |
| Loqate | 60% | 67% | 75% |
| Geoapify | 64% | 50% | 25% |

The full per-address results (205 rows) live in `logs/verify-compare/2026-09-18T14-32-29-patched/score.json`; the raw provider responses are in `results.json` alongside it.