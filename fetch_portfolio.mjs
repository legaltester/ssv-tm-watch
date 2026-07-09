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

const USPTO_API_KEY = process.env.USPTO_API_KEY || null;
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

// USPTO — official TSDR JSON API (reliable from datacenter; needs a free API key).
async function fetchTSDR(serial) {
  if (!USPTO_API_KEY) return { ok: false, reason: 'USPTO_API_KEY secret not set — US source paused' };
  try {
    const r = await fetch(`https://tsdrapi.uspto.gov/ts/cd/casestatus/sn${serial}/info.json`, {
      headers: { 'USPTO-API-KEY': USPTO_API_KEY },
    });
    if (!r.ok) return { ok: false, reason: 'TSDR HTTP ' + r.status };
    const j = await r.json();
    const md = j?.trademarks?.[0]?.status || {};
    return {
      ok: true, source: 'TSDR API',
      status: md.statusDefinitionText || md.status || null,
      statusCode: md.statusCode || null,
      statusDate: (md.statusDate || '').slice(0, 10) || null,
      raw: md,
    };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
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

// IPONZ — no stable deep link; drive the search form, then read the case.
async function scrapeIPONZ(browser, mark) {
  const page = await browser.newPage();
  try {
    await page.goto('https://app.iponz.govt.nz/app/Extra/IP/TM/Qbe.aspx?sid=0&op=EXTRA_tm_qbe&directAccess=true',
      { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(POST_NAV_WAIT);
    await page.evaluate((n) => {
      const el = document.getElementById('MainContent_ctrlTMSearch_txtAppNr');
      if (el) el.value = n;
      // eslint-disable-next-line no-undef
      if (typeof WebForm_DoPostBackWithOptions === 'function') {
        WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions(
          'ctl00$MainContent$ctrlTMSearch$lnkbtnSearch', '', true,
          'MainContent_ctrlTMSearchValidationGroup', '', false, true));
      }
    }, mark.national.appNumber);
    await page.waitForTimeout(POST_NAV_WAIT);
    const text = await page.evaluate(() => document.body.innerText || '');
    if (!text.includes(mark.national.appNumber) && !/SSV/i.test(text)) {
      return { ok: false, reason: 'IPONZ result not reached (form/session)' };
    }
    const statusLine = (text.match(/(Registered|Under Examination|Accepted|Opposed|Refused|Withdrawn|Lapsed)[^\n]{0,60}/i) || [null])[0];
    return { ok: true, source: 'IPONZ form', statusLine, sample: text.slice(0, 900) };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  } finally { await page.close().catch(() => {}); }
}

async function fetchNational(browser, mark) {
  const k = mark.national.kind;
  if (k === 'tsdr-api') return fetchTSDR(mark.national.serial);
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
function compareSources(tmv, nat) {
  if (!tmv?.ok || !nat?.ok) return { comparable: false };
  const t = normStatus(tmv.status);
  const nText = normStatus(nat.status || nat.statusLine);
  const isReg = (x) => /registered|registrado/.test(x);
  const agree = isReg(t) === isReg(nText);
  return { comparable: true, agree, tmviewStatus: tmv.status || null, nationalStatus: nat.status || nat.statusLine || null };
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
  nationalResults = await mapLimit(MARKS, 3, (m) => fetchNational(browser, m));
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
