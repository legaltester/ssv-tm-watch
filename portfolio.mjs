// SSV Foundation portfolio — 15 marks.
// `national` describes how the authoritative office-of-record is reached.
//   kind: 'tsdr-api'  → USPTO TSDR JSON API (needs USPTO_API_KEY secret). Datacenter-friendly.
//   kind: 'scrape'    → Playwright loads `url` (the exact detail page validated by hand on 2026-07-07)
//                       and we extract visible status text. May be WAF-challenged from datacenter IPs.
//   kind: 'form'      → Playwright drives a search form (no stable deep link), then reads the case.
// TMView is queried for every mark in bulk via its search + detail API (see fetch_portfolio.mjs).

export const TMVIEW_SEARCH_BODY = {
  page: '1', pageSize: '30', criteria: 'C', basicSearch: 'SSV',
  fAName: ['SSV FOUNDATION', 'SSV Foundation'], fTMStatus: ['Filed', 'Registered'],
};

export const MARKS = [
  { id: 'US-99104870', mark: 'SSV',              office: 'USPTO',        st13: 'US500000099104870', app: '99104870',
    national: { kind: 'tsdr-api', serial: '99104870' } },
  { id: 'US-99104968', mark: 'SSV.NETWORK',      office: 'USPTO',        st13: 'US500000099104968', app: '99104968',
    national: { kind: 'tsdr-api', serial: '99104968' } },

  { id: 'EM-019056030', mark: 'SSV',             office: 'EUIPO',        st13: 'EM500000019056030', app: '019056030',
    national: { kind: 'scrape', url: 'https://euipo.europa.eu/eSearch/#details/trademarks/019056030' } },
  { id: 'EM-019070030', mark: 'ssv.network',     office: 'EUIPO',        st13: 'EM500000019070030', app: '019070030',
    national: { kind: 'scrape', url: 'https://euipo.europa.eu/eSearch/#details/trademarks/019070030' } },

  { id: 'GB-UK00004152137', mark: 'SSV',         office: 'UK IPO',       st13: 'GB500000004152137', app: 'UK00004152137',
    national: { kind: 'scrape', url: 'https://trademarks.ipo.gov.uk/ipo-tmcase/page/Results/1/UK00004152137' } },
  { id: 'GB-UK00004152144', mark: 'SSV.NETWORK', office: 'UK IPO',       st13: 'GB500000004152144', app: 'UK00004152144',
    national: { kind: 'scrape', url: 'https://trademarks.ipo.gov.uk/ipo-tmcase/page/Results/1/UK00004152144' } },

  { id: 'AU-2541093', mark: 'SSV',               office: 'IP Australia', st13: 'AU500000002541093', app: '2541093',
    national: { kind: 'scrape', url: 'https://search.ipaustralia.gov.au/trademarks/search/view/2541093' } },
  { id: 'AU-2541094', mark: 'SSV.NETWORK',       office: 'IP Australia', st13: 'AU500000002541094', app: '2541094',
    national: { kind: 'scrape', url: 'https://search.ipaustralia.gov.au/trademarks/search/view/2541094' } },

  { id: 'CA-2398060', mark: 'SSV',               office: 'CIPO',         st13: 'CA500000239806000', app: '2398060',
    national: { kind: 'scrape', url: 'https://ised-isde.canada.ca/cipo/trademark-search/2398060?lang=eng' } },
  { id: 'CA-2398059', mark: 'SSV.NETWORK & DESIGN', office: 'CIPO',      st13: 'CA500000239805900', app: '2398059',
    national: { kind: 'scrape', url: 'https://ised-isde.canada.ca/cipo/trademark-search/2398059?lang=eng' } },

  { id: 'NZ-1290682', mark: 'SSV',               office: 'IPONZ',        st13: 'NZ500000001290682', app: '1290682',
    national: { kind: 'form', appNumber: '1290682' } },

  { id: 'BR-940265788', mark: 'SSV',             office: 'INPI',         st13: 'BR500000940265788', app: '940265788',
    national: { kind: 'form', appNumber: '940265788' } },
  { id: 'BR-940266032', mark: 'SSV',             office: 'INPI',         st13: 'BR500000940266032', app: '940266032',
    national: { kind: 'form', appNumber: '940266032' } },
  { id: 'BR-940267160', mark: 'ssv.network',     office: 'INPI',         st13: 'BR500000940267160', app: '940267160',
    national: { kind: 'form', appNumber: '940267160' } },
  { id: 'BR-940267543', mark: 'ssv.network',     office: 'INPI',         st13: 'BR500000940267543', app: '940267543',
    national: { kind: 'form', appNumber: '940267543' } },
];
