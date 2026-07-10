// SSV Trademark Watch — dual-source fetcher.
//
// LAYER 1 (broad sweep):   TMView search + detail API — one call covers all 15 marks.
// LAYER 2 (authoritative): each national register, per office of record.
// The snapshot pairs both layers per mark and flags any disagreement, which is the
// discrepancy signal the Brains automation alerts on.
//
// Design rule carried over from the Brains build: NOTHING is fatal. Every source is
// wrapped so a WAF block, timeout, or markup change on one office (or on TMView) is
// recorded as `{ ok:false, reason }` and the run still produces a usable snapshot for
// every other source. National registers are fetched at most 3 at a time so a 2-core
// GitHub runner is never overwhelmed (the first version opened all of them at once and
// hit the job timeout).

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { MARKS, TMVIEW_SEARCH_BODY } from './portfolio.mjs';

const NAV_TIMEOUT = 30000;
const POST_NAV_WAIT = 4000;
const nowISO = () => new Date().toISOString();

// Bounded-concurrency map that mirrors Promise.allSettled's result shape.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = { status: 'fulfilled', value: await fn(items[idx]) }; }
      catch (e) { results[idx] = { status: 'rejected', reason: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- LAYER 1: TMView ----------
async function fetchTMView(page) {
  try {
    await page.goto('https://www.tmdn.org/tmview/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    const search = await page.evaluate(async (body) => {
      const r = await fetch('/tmview/api/search/results?translate=true', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('search HTTP ' + r.status);
      return r.json();
    }, TMVIEW_SEARCH_BODY);

    const marks = search.tradeMarks || [];
    const details = {};
    for (const t of marks) {
      try {
        details[t.ST13] = await page.evaluate(async (id) => {
          const r = await fetch(`/tmview/api/trademark/detail/${id}`);
          return r.ok ? r.json() : { error: 'HTTP ' + r.status };
        }, t.ST13);
      } catch (e) { details[t.ST13] = { error: String(e.message || e) }; }
      await page.waitForTimeout(500);
    }
    return { ok: true, count: marks.length, search: marks, details };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

function tmviewFieldsFor(mark, tmv) {
  if (!tmv.ok) return { ok: false, reason: 'tmview sweep unavailable: ' + tmv.reason };
  const s = (tmv.search || []).find((t) => t.applicationNumber === mark.app || t.ST13 === mark.st13);
  if (!s) return { ok: false, reason: 'mark not returned by TMView search' };
  const d = tmv.details[s.ST13] || {};
  const tm = d.tradeMark || {};
  const cancels = Array.isArray(d.cancellations) ? d.cancellations : d.cancellations?.events || [];
  return {
    ok: true,
    status: s.tradeMarkStatus ?? tm.markCurrentStatusCode ?? null,
    registrationDate: s.registrationDate?.slice(0, 10) ?? null,
    expirationDate: s.expirationDate?.slice(0, 10) ?? null,
    oppositionPeriodEnd: s.oppositionPeriodEnd?.slice(0, 10) ?? null,
    applicants: (d.applicants || []).map((a) => a.fullName || a.name || a.organizationName).filter(Boolean),
    representatives: (d.representatives || []).map((r) => r.fullName || r.name || r.organizationName).filter(Boolean),
    oppositions: (d.oppositions || []).length,
    cancellations: cancels.length,
    events: (d.recordals?.events || []).map((e) => ({ date: (e.eventDate || '').slice(0, 10), desc: e.eventDescription })),
  };
}

// ---------- LAYER 2: national registers ----------

// USPTO — public TMSearch API (KEYLESS). The tmsearch.uspto.gov frontend POSTs an
// Elasticsearch query to /prod-v1-0-0/tmsearch anonymously (auth/sessions/me returns 404
// for anonymous visitors), so we do the same from a page on that origin. Two strategies:
//   1) direct query on the serial (id / registrationId fields);
//   2) if that returns nothing (field-mapping uncertainty), the frontend's own proven
//      wordmark query ("SSV") — every hit's source carries id, so we match serials by
//      READING id rather than querying it, which works regardless of how id is indexed.
// Note: the API camelCases the ES envelope — hit.id = serial, hit.source = fields.
async function fetchUSPTOAll(browser, serials) {
  const page = await browser.newPage();
  try {
    await page.goto('https://tmsearch.uspto.gov/search/search-information', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(3000);
    const out = await page.evaluate(async (sns) => {
      async function q(body) {
        const r = await fetch('/prod-v1-0-0/tmsearch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) return { httpError: r.status };
        return r.json();
      }
      const bySerial = {};
      // Strategy 1: direct id / registrationId queries.
      for (const sn of sns) {
        const j = await q({
          query: { bool: { should: [{ term: { id: sn } }, { match_phrase: { id: sn } }, { term: { registrationId: sn } }], minimum_should_match: 1 } },
          size: 5, track_total_hits: true,
        });
        if (j.httpError) { bySerial[sn] = { httpError: j.httpError }; continue; }
        const rec = ((j.hits && j.hits.hits) || []).find((h) => String(h.id) === String(sn));
        if (rec) bySerial[sn] = { hit: { serial: rec.id, ...(rec.source || {}) }, via: 'id-query' };
      }
      // Strategy 2: wordmark sweep for any misses; match serials by reading id.
      if (sns.some((sn) => !bySerial[sn] || !bySerial[sn].hit)) {
        const j = await q({
          query: { bool: { must: [{ match: { WM: { query: 'SSV' } } }] } },
          size: 100, track_total_hits: true,
        });
        if (!j.httpError) {
          const recs = (j.hits && j.hits.hits) || [];
          for (const sn of sns) {
            if (bySerial[sn] && bySerial[sn].hit) continue;
            const rec = recs.find((h) => String(h.id) === String(sn));
            if (rec) bySerial[sn] = { hit: { serial: rec.id, ...(rec.source || {}) }, via: 'wordmark-sweep' };
          }
        }
      }
      return bySerial;
    }, serials.map(String));
    const results = {};
    for (const sn of serials) {
      const e = out[sn];
      if (!e || !e.hit) {
        results[sn] = { ok: false, reason: e && e.httpError ? 'TMSearch HTTP ' + e.httpError : 'serial not found via id-query or wordmark sweep' };
        continue;
      }
      const hit = e.hit;
      const alive = hit.alive === true || hit.alive === 'true';
      const status = alive
        ? (hit.registrationDate ? 'Registered' : 'Live/Pending')
        : (hit.abandonDate ? 'Dead/Abandoned' : (hit.cancelDate ? 'Dead/Cancelled' : 'Dead'));
      const owner = Array.isArray(hit.ownerName) ? hit.ownerName[0] : (hit.ownerName || null);
      results[sn] = {
        ok: true, source: 'USPTO TMSearch (' + e.via + ')', status, alive,
        statusCode: hit.statusCode != null ? hit.statusCode : null,
        registrationDate: (hit.registrationDate || '').slice(0, 10) || null,
        filedDate: (hit.filedDate || '').slice(0, 10) || null,
        abandonDate: (hit.abandonDate || '').slice(0, 10) || null,
        cancelDate: (hit.cancelDate || '').slice(0, 10) || null,
        owner, wordmark: hit.wordmark || hit.markName || null,
      };
    }
    return results;
  } catch (e) {
    return Object.fromEntries(serials.map((sn) => [sn, { ok: false, reason: String(e.message || e) }]));
  } finally { await page.close().catch(() => {}); }
}

// Generic scrape: load the validated detail URL, wait for the SPA, return visible text.
// Text-based extraction (not brittle CSS) so minor markup shifts don't break it.
async function scrapeDetail(browser, mark) {
  const page = await browser.newPage();
  try {
    await page.goto(mark.national.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(POST_NAV_WAIT);
    const text = (await page.evaluate(() => document.body.innerText || '')).replace(/\s+\n/g, '\n');
    if (!text || text.length < 40 || /maintenance|manuten|unavailable|access denied|forbidden|captcha|are you a robot/i.test(text)) {
      return { ok: false, reason: 'blocked/empty page (len ' + text.length + ') — likely WAF or maintenance' };
    }
    const statusLine = (text.match(/(Registered|Filed|Being Examined|Under Examination|Accepted|Advertised|Opposed|Refused|Removed|Withdrawn|Lapsed|Published|Registrado|Pending)[^\n]{0,60}/i) || [null])[0];
    const flags = ['opposition', 'cancellation', 'invalidity', 'revocation', 'refusal', 'adverse', 'non-use', 'objection', "examiner's report", 'acceptance due']
      .filter((k) => new RegExp(k, 'i').test(text));
    return { ok: true, source: 'scrape', statusLine, flags, textHash: text.length, sample: text.slice(0, 900) };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally { await page.close().catch(() => {}); }
}

// IPONZ — public search page (per Ivan: PublicSearch.aspx, simpler than the old Qbe form).
// The page is ASP.NET; the previous evaluate-based postback threw in fresh headless
// sessions, so this version uses ONLY native Playwright fill/click and discovers the
// form controls at runtime from a list of candidate selectors. Any miss soft-fails.
async function scrapeIPONZ(browser, mark) {
  const page = await browser.newPage();
  try {
    await page.goto('https://app.iponz.govt.nz/app/Extra/IP/TM/PublicSearch/PublicSearch.aspx?op=EXTRA_TM_PublicSearch&fcoOp=EXTRA_Default',
      { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(POST_NAV_WAIT);
    const inputSel = ['input[id*="Number" i]', 'input[name*="Number" i]', 'input[id*="Keyword" i]',
      'input[id*="txtSearch" i]', 'input[id*="Word" i]', 'input[type="text"]'];
    let filled = false;
    for (const sel of inputSel) {
      const el = page.locator(sel).first();
      if (await el.count()) { try { await el.fill(mark.national.appNumber, { timeout: 5000 }); filled = true; break; } catch (e) {} }
    }
    if (!filled) return { ok: false, reason: 'IPONZ: no fillable search input found on PublicSearch page' };
    const btnSel = ['input[type="submit"][value*="Search" i]', 'button:has-text("Search")',
      'a:has-text("Search")', 'input[type="submit"]'];
    let clicked = false;
    for (const sel of btnSel) {
      const el = page.locator(sel).first();
      if (await el.count()) { try { await el.click({ timeout: 5000 }); clicked = true; break; } catch (e) {} }
    }
    if (!clicked) { try { await page.keyboard.press('Enter'); } catch (e) {} }
    await page.waitForTimeout(POST_NAV_WAIT + 3000);
    let text = await page.evaluate(() => document.body.innerText || '');
    // If a results list shows our number, open the record for full status detail.
    if (text.includes(mark.national.appNumber)) {
      const link = page.locator('a', { hasText: mark.national.appNumber }).first();
      if (await link.count()) {
        try { await link.click({ timeout: 5000 }); await page.waitForTimeout(POST_NAV_WAIT); text = await page.evaluate(() => document.body.innerText || ''); } catch (e) {}
      }
    }
    if (!text.includes(mark.national.appNumber) && !/SSV/i.test(text)) {
      return { ok: false, reason: 'IPONZ: search returned no matching record (form/session path)' };
    }
    const statusLine = (text.match(/(Registered|Under Examination|Being Examined|Accepted|Opposed|Refused|Withdrawn|Lapsed|Abandoned|Removed)[^\n]{0,60}/i) || [null])[0];
    const flags = ['opposition', 'proceeding', 'hearing', 'non-use', 'revocation', 'invalidity']
      .filter((k) => new RegExp(k, 'i').test(text));
    return { ok: true, source: 'IPONZ PublicSearch', statusLine, flags, sample: text.slice(0, 900) };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally { await page.close().catch(() => {}); }
}

async function fetchNational(browser, mark, usptoResults) {
  const k = mark.national.kind;
  if (mark.office === 'USPTO') return (usptoResults && usptoResults[mark.national.serial]) || { ok: false, reason: 'USPTO batch did not run' };
  if (k === 'form' && mark.office === 'IPONZ') return scrapeIPONZ(browser, mark);
  if (k === 'form' && mark.office === 'INPI') {
    // INPI portal is session-based and was under maintenance on 2026-07-07; best-effort scrape of the public search.
    return scrapeDetail(browser, { ...mark, national: { ...mark.national, url: 'https://busca.inpi.gov.br/pePI/' } })
      .then((r) => r.ok ? { ...r, note: 'INPI landing reached; per-processo lookup is session-gated — verify manually if flagged' }
                        : { ...r, reason: (r.reason || '') + ' (INPI portal frequently gated)' });
  }
  return scrapeDetail(browser, mark);
}

// ---------- discrepancy logic ----------
function normStatus(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }
// Coarse life-state bucket. The PRIMARY alerting mechanism is per-source status CHANGE
// (handled in Brains by diffing each source against the previous snapshot), so a granular
// difference like "published" vs "registered" is NOT a discrepancy — both are non-dead.
// A cross-source discrepancy is only raised for a genuine conflict: one source says the
// mark is dead/abandoned/cancelled while the other says it is alive or registered.
function lifeState(x) {
  const n = normStatus(x);
  if (/refused|withdrawn|lapsed|removed|abandon|cancel|dead|expired|invalid|revoked/.test(n)) return 'dead';
  return 'alive'; // registered, published, filed, examined, accepted, pending, opposed, live…
}
function compareSources(tmv, nat) {
  if (!tmv?.ok || !nat?.ok) return { comparable: false };
  const conflict = (lifeState(tmv.status) === 'dead') !== (lifeState(nat.status || nat.statusLine) === 'dead');
  return { comparable: true, agree: !conflict, tmviewStatus: tmv.status || null, nationalStatus: nat.status || nat.statusLine || null };
}

// ---------- run (nothing here is allowed to abort the snapshot) ----------
let tmv = { ok: false, reason: 'not run' };
let nationalResults = MARKS.map(() => ({ status: 'rejected', reason: new Error('not run') }));
let browser;
try {
  browser = await chromium.launch();
  const tmvPage = await browser.newPage();
  tmv = await fetchTMView(tmvPage);
  await tmvPage.close().catch(() => {});
  const usSerials = MARKS.filter((m) => m.office === 'USPTO').map((m) => m.national.serial);
  const usptoResults = await fetchUSPTOAll(browser, usSerials);
  nationalResults = await mapLimit(MARKS, 3, (m) => fetchNational(browser, m, usptoResults));
} catch (e) {
  tmv = { ok: false, reason: 'browser launch/run error: ' + String(e.message || e) };
} finally {
  if (browser) await browser.close().catch(() => {});
}

const marks = MARKS.map((m, i) => {
  const tmView = tmviewFieldsFor(m, tmv);
  const settledNat = nationalResults[i];
  const national = settledNat.status === 'fulfilled' ? settledNat.value : { ok: false, reason: String(settledNat.reason) };
  return { id: m.id, mark: m.mark, office: m.office, app: m.app, tmView, national, discrepancy: compareSources(tmView, national) };
});

const snapshot = {
  fetched_at: nowISO(),
  sources: { tmview: tmv.ok ? `ok (${tmv.count} marks)` : `unavailable: ${tmv.reason}` },
  national_source_health: Object.fromEntries(
    marks.map((m) => [m.id, m.national.ok ? 'ok' : `unavailable: ${m.national.reason}`])),
  discrepancies: marks.filter((m) => m.discrepancy.comparable && !m.discrepancy.agree)
    .map((m) => ({ id: m.id, tmview: m.discrepancy.tmviewStatus, national: m.discrepancy.nationalStatus })),
  marks,
};

writeFileSync('snapshot.json', JSON.stringify(snapshot, null, 2));
const natOk = marks.filter((m) => m.national.ok).length;
console.log(`snapshot.json written @ ${snapshot.fetched_at}`);
console.log(`  TMView: ${tmv.ok ? tmv.count + ' marks' : 'UNAVAILABLE (' + tmv.reason + ')'}`);
console.log(`  National registers reached: ${natOk}/${MARKS.length}`);
console.log(`  Discrepancies flagged: ${snapshot.discrepancies.length}`);
