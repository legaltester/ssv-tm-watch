# SSV Trademark Watch — fetcher (the automated confirmation layer)

Two source layers, per the original design (ping both, flag disagreements):

- **TMView** — the easy broad sweep. One API call covers all 15 marks.
- **National registers** — the authoritative confirmation, office by office. USPTO via the
  official TSDR API; the rest via a real browser (Playwright) hitting the exact detail pages.

The fetcher writes `snapshot.json` (both layers per mark + a `discrepancies` list). The Brains
automation reads that file and alerts on any change in **either** source and on any TMView↔national
mismatch. Brains itself can reach `raw.githubusercontent.com`, which is why the fetcher lives here:
it does the reaching Brains' sandbox can't.

```
GitHub Actions (Playwright, daily 06:15 CET)          Brains "SSV Trademark Watch" (07:30 CET)
  TMView API  +  national registers          →   reads raw.githubusercontent.com/…/snapshot.json
  → commit snapshot.json                          → diff vs board → discrepancy + deadline alerts → email
```

## Setup — the parts only you can do (~2 minutes)

I built every file and validated it parses; I could not create the repo because that needs your
GitHub login (I won't handle your password). Do these, then tell me "continue" and I'll finish the
wiring, or run the workflow yourself.

1. **Log in to GitHub**, then create a new repo — suggested `ssv-tm-watch`. **Private is fine**;
   if private, Brains needs a read token (store it as a Brains secret). Public is simplest and the
   data is public trademark records either way.
2. **Add the files** (drag-drop in the web UI, or `gh` — see below), keeping `.github/workflows/`.
3. **(US source) Add the USPTO API key.** Get a free key at `account.uspto.gov` → API keys, then in
   the repo: Settings → Secrets and variables → Actions → New secret → name `USPTO_API_KEY`.
   *You must enter this — I don't handle API keys.* Without it, all 14 other checks run; US shows
   "source paused" until the key is added.
4. **Actions tab → "SSV trademark snapshot" → Run workflow.** This first manual run is the real test
   (see caveats). A green run commits `snapshot.json`.

One-paste alternative if you have the GitHub CLI:
```bash
gh repo create ssv-tm-watch --private --source=. --push   # run from this folder
gh secret set USPTO_API_KEY                                # paste your key when prompted
gh workflow run "SSV trademark snapshot"
```

## Wire Brains (paste to the brain agent after the first green run)

> Update SSV Trademark Watch to read primary data from
> `https://raw.githubusercontent.com/<YOUR_USER>/ssv-tm-watch/main/snapshot.json`
> (add raw.githubusercontent.com to the http_fetch allowlist). Each run: fetch it; treat `fetched_at`
> older than 48h as a monitoring gap (damped rules unchanged); for every mark diff BOTH `tmView` and
> `national` against the board and alert on any change; raise a HIGH discrepancy alert for anything in
> the snapshot's `discrepancies` list; keep the v11 deadline ladder, idempotency, outbox and fallback.

## Honest caveats

- **Datacenter IPs may be challenged.** GitHub runners are datacenter IPs. USPTO's TSDR **API** is
  built for automation and should be reliable. The scraped registers (EUIPO, UK IPO, IP Australia,
  CIPO, IPONZ, INPI) may hit a WAF or bot-check from a datacenter IP even though they worked from your
  residential browser during setup. The fetcher is built so each blocked source reports
  `unavailable: …` in `national_source_health` and the run still succeeds for everything else — the
  first workflow run tells you exactly which registers cooperate. Any that don't stay on the
  Claude-in-Chrome / counsel deep-dive path (your residential browser is never WAF-blocked).
- **INPI (Brazil)** is session-gated and was under maintenance on 2026-07-07; it's best-effort and
  will often flag "verify manually."
- **Selectors are validated by observation, not by a live datacenter run** — the first workflow run
  is the true validation. If an office changed its markup, it degrades to `unavailable`, never a crash.
- Politeness: 700ms between TMView detail calls; one run per day.
