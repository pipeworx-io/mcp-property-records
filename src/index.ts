interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}
/**
 * Property Records MCP — address-level US property records (sales history,
 * assessed value, owner, physical characteristics) straight from county / city
 * open-data portals. 100% keyless: no vendor API key, no BYOK.
 *
 * SCOPE HONESTY. US property records are maintained per-county; there is no
 * national keyless source. This pack therefore covers a SET of jurisdictions
 * (currently DC, New York City, Philadelphia, Cook County IL, San Francisco)
 * and says so plainly:
 *   - `property_coverage` enumerates exactly what is supported and which fields
 *     each jurisdiction actually publishes.
 *   - `property_lookup` on an address outside coverage returns
 *     { covered: false, ... } naming the jurisdiction it inferred plus the
 *     supported list. It never fabricates a record and never returns a bare
 *     empty result that could read as "this property has no sales".
 *
 * Field availability genuinely differs per source (e.g. San Francisco publishes
 * a last-sale DATE but no sale price and no owner name; NYC's roll has no
 * bed/bath counts). Each response carries `source_name`, `source_url`,
 * `fields_available` and `note` so the caller knows which portal answered and
 * what that portal does not have.
 *
 * Stateless: the gateway owns auth + rate limiting. Expected-empty results are
 * returned as shaped objects, never thrown.
 */


const TIMEOUT_MS = 10_000;
const UA = 'pipeworx-property-records/0.1 (+https://pipeworx.io)';

// ── Coverage table (the honesty surface) ────────────────────────────────────

interface JurisdictionMeta {
  slug: string;
  name: string;
  aliases: string[];          // lowercase city/region tokens that imply this jurisdiction
  zip_prefixes: string[];     // leading-digit prefixes that imply this jurisdiction
  source_name: string;
  source_url: string;
  sales_history: string;
  owner: string;
  assessment: string;
  characteristics: string;
  vintage: string;
  cadence: string;
  caveats?: string;
}

const COVERAGE: JurisdictionMeta[] = [
  {
    slug: 'dc',
    name: 'Washington, District of Columbia',
    aliases: ['washington dc', 'washington d c', 'district of columbia', 'washington, dc', 'dc'],
    zip_prefixes: ['200', '201', '202', '203', '204', '205'],
    source_name: 'DC Office of Tax & Revenue / DC GIS (Integrated Tax System + CAMA)',
    source_url:
      'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/MapServer',
    sales_history: 'Yes — full assessor sales table (all recorded sales, ~1900 to present, 421k rows) with qualified/unqualified flag and sale code.',
    owner: 'Yes — current owner of record plus secondary owner name.',
    assessment: 'Yes — current total assessed value, land vs building split, proposed next-year value, annual tax, homestead flag, tax class.',
    characteristics: 'Yes — bedrooms, full/half baths, rooms, stories, year built (AYB), effective year built, remodel year, gross building area, style, structure, grade, condition, exterior wall, fireplaces.',
    vintage: 'Assessment roll refreshed continuously (per-record extract date returned as assessment_as_of); sales table current to within ~2 weeks.',
    cadence: 'Daily.',
    caveats: 'Addresses in DC require a quadrant (NW/NE/SW/SE). Omitting it can match up to four different properties — all are returned in other_matches.',
  },
  {
    slug: 'nyc',
    name: 'New York City (Manhattan, Bronx, Brooklyn, Queens, Staten Island)',
    aliases: [
      'new york city', 'new york', 'nyc', 'manhattan', 'brooklyn', 'bronx', 'the bronx',
      'queens', 'staten island', 'new york ny',
    ],
    zip_prefixes: ['100', '101', '102', '103', '104', '111', '112', '113', '114', '116'],
    source_name: 'NYC Department of Finance (Annualized Sales + Rolling Sales + Property Valuation & Assessment roll)',
    source_url: 'https://data.cityofnewyork.us/resource/w2pb-icbu.json',
    sales_history: 'Yes — arms-length and non-arms-length recorded sales, 2016 to present (annualized citywide file, 845k rows) merged with the rolling last-12-months file.',
    owner: 'Yes — owner of record from the assessment roll.',
    assessment: 'Yes — current-year market value and actual assessed value, prior-year and tentative-roll values, tax class, zoning.',
    characteristics: 'Partial — year built, gross square feet, land area, unit count, stories, lot/building frontage and depth, building class. No bedroom or bathroom counts (the DOF roll does not publish them).',
    vintage: 'Sales through the most recent published quarter; assessment roll is the current fiscal-year tentative/final roll.',
    cadence: 'Sales refreshed monthly-to-quarterly; roll annually with periodic revisions.',
    caveats: 'Sales are recorded per BBL (borough-block-lot), so condo and co-op lines share a building address with a unit suffix. A $0 sale price means a non-arms-length transfer (deed correction, inheritance, related party) — it is reported as-is, flagged non_arms_length.',
  },
  {
    slug: 'philadelphia',
    name: 'Philadelphia, Pennsylvania',
    aliases: ['philadelphia', 'philly', 'phila', 'philadelphia pa'],
    zip_prefixes: ['191'],
    source_name: 'City of Philadelphia OPA property assessments + Realty Transfer Tax recorded documents',
    source_url: 'https://phl.carto.com/api/v2/sql',
    sales_history: 'Yes — the deepest of the covered jurisdictions: every recorded deed from the Realty Transfer Tax file with grantor (seller) and grantee (buyer) names, document type, and total consideration.',
    owner: 'Yes — owner_1 / owner_2 from the assessment file, plus grantee of the most recent deed.',
    assessment: 'Yes — market value, taxable land, taxable building, exempt land, exempt building, homestead exemption.',
    characteristics: 'Yes — bedrooms, bathrooms, rooms, stories, livable area, total lot area, year built (with estimate flag), central air, exterior and interior condition, quality grade, garage, fireplaces, zoning.',
    vintage: 'Assessments current; transfer documents recorded through the last few weeks.',
    cadence: 'Daily.',
  },
  {
    slug: 'cook',
    name: 'Cook County, Illinois (Chicago and suburbs)',
    aliases: [
      'chicago', 'cook county', 'cook county il', 'evanston', 'oak park', 'skokie',
      'cicero', 'berwyn', 'schaumburg', 'arlington heights', 'des plaines', 'palatine',
      'orland park', 'oak lawn', 'tinley park', 'mount prospect', 'wilmette', 'niles',
    ],
    zip_prefixes: ['606', '607', '608'],
    source_name: 'Cook County Assessor open data (Parcel Addresses + Parcel Sales + Assessed Values + Improvement Characteristics)',
    source_url: 'https://datacatalog.cookcountyil.gov/resource/wvhk-k5uv.json',
    sales_history: 'Yes — 1971 to present (2.6M rows) with document number, deed type, seller name, buyer name, multi-parcel flag, and the assessor\'s own outlier filters.',
    owner: 'Partial — the taxpayer/owner name carried on the parcel-address file. This is the name the tax bill goes to, which is usually but not always the deed owner. The buyer name on the latest sale is also returned.',
    assessment: 'Yes — mailed, certified and Board of Review assessed values with land vs building split. Illinois assesses residential property at 10% of market value, so multiply by ~10 for an approximate market value; the ratio is returned as assessment_ratio_note.',
    characteristics: 'Yes — bedrooms, full/half baths, rooms, building square feet, land square feet, year built, residence type, exterior wall, central air, basement, garage, porch, condition.',
    vintage: 'Current assessment year (returned as assessment_year); sales current to within ~2 months.',
    cadence: 'Daily.',
  },
  {
    slug: 'sf',
    name: 'San Francisco, California',
    aliases: ['san francisco', 'san francisco ca', 'sf'],
    zip_prefixes: ['941'],
    source_name: 'SF Office of the Assessor-Recorder — Secured Property Tax Roll',
    source_url: 'https://data.sfgov.org/resource/wv5m-vpq2.json',
    sales_history: 'Date only — the roll carries the most recent transfer DATE (last_sale_date) but NO sale price and no prior transfers. California counties do not publish transfer consideration in open data, so price questions for San Francisco cannot be answered from this source.',
    owner: 'Not published — the SF open-data roll omits the owner name. Owner is available only through the Assessor-Recorder\'s paid/manual record search.',
    assessment: 'Yes — assessed land value, assessed improvement value, assessed fixtures, assessed personal property, homeowner and misc exemption values.',
    characteristics: 'Yes — bedrooms, bathrooms, rooms, stories, units, property (building) area, basement area, lot area, lot depth/frontage, year built, construction type, zoning, assessor neighborhood.',
    vintage: 'Most recent closed roll year available for the parcel (returned as roll_year); the file holds every roll year back to 2007.',
    cadence: 'Annually, on roll close.',
    caveats: 'No sale price and no owner name. If the question is "how much did it sell for" or "who owns it", say so rather than substituting the assessed value.',
  },
];

const COVERED_SLUGS = COVERAGE.map((j) => j.slug);
const COVERAGE_SUMMARY = COVERAGE.map((j) => `${j.slug} (${j.name})`).join('; ');

// ── Tool definitions ───────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'property_lookup',
    description:
      'Address-level US property records from county and city open-data portals — keyless public records, no API key. Answers "when did this house last sell", "how much did <address> sell for", "who owns this property", "what is the assessed value of <address>", "property sale history", "county assessor data for an address". Returns the property sale history (dated transactions with price where the county publishes it), current assessed value, owner of record, parcel id (DC SSL / NYC BBL / Philadelphia OPA account / Cook County PIN / SF block-lot), land use or building class, year built, square footage, and bed/bath counts where available. ' +
      `SUPPORTED JURISDICTIONS ONLY — property records are maintained per county and there is no national keyless source. Currently covered: ${COVERAGE_SUMMARY}. ` +
      'An address in any other county returns covered:false with the inferred jurisdiction and the supported list, so you can tell the user plainly that this county is not in the dataset rather than guessing. Call property_coverage first if you want the field-by-field capability matrix. ' +
      'Examples: {"address":"1642 30th St NW, Washington DC"} → DC row house, SSL 1282 0198, owner, $1,354,300 assessed, sold 2012-08-09 for $1,085,000, 3 bed / 2.5 bath / 1,510 sqft built 1907. {"address":"232 East 6th Street, Manhattan"} → NYC BBL 1004610024 with the 2016-present sale list. {"address":"228 Spruce St, Philadelphia"} → full recorded deed chain with grantor/grantee. {"address":"3000 N Sheffield Ave, Chicago"} → Cook County PIN, sale, assessed value. {"address":"450 Sutter St, San Francisco"} → assessed value and characteristics (no price — SF does not publish it).',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description:
            'Street address as free text. City / state / ZIP are optional but improve jurisdiction inference, e.g. "1600 Pennsylvania Ave NW", "232 East 6th Street, New York, NY 10003", "3000 N Sheffield Ave, Chicago IL". Punctuation, casing, and Ave/Avenue or St/Street spelling are all handled.',
        },
        jurisdiction: {
          type: 'string',
          description: `Optional. Skip inference and query a specific portal. One of: ${COVERED_SLUGS.join(' | ')}.`,
        },
        max_sales: {
          type: ['number', 'string'],
          description: 'Maximum sale/transfer records to return, 1-50 (default 20, newest first).',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'property_coverage',
    description:
      'The capability matrix for property_lookup: every county and city this pack can answer address-level property-record questions for, and exactly which fields each one publishes — sales history (and whether it includes a price), owner name, assessed value, physical characteristics — plus the data vintage, refresh cadence, per-jurisdiction caveats, and the upstream source URL. Use this before promising a user an answer, to check whether their county is in the dataset and whether the specific field they asked about (sale price, owner, bed/bath) actually exists there. US property records are county-maintained and there is no national keyless source, so this list is the whole supported set. Example: {} → 5 jurisdictions, of which 4 publish sale prices and 4 publish owner names.',
    inputSchema: {
      type: 'object',
      properties: {
        jurisdiction: {
          type: 'string',
          description: `Optional. Return detail for one jurisdiction only: ${COVERED_SLUGS.join(' | ')}.`,
        },
      },
      required: [],
    },
  },
];

// ── HTTP with per-source 10s abort ─────────────────────────────────────────

async function getJson<T>(url: string, label: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`${label}: HTTP ${res.status} ${body}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') throw new Error(`${label}: timed out after ${TIMEOUT_MS}ms`);
    // `label` in front of a class token would push it off position 0, which
    // silently reclassifies the error and leaks the token. Hoist it.
    const { token, body } = splitClassPrefix(e.message);
    throw new Error(`${token}${label}: ${body}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a set of source calls without letting one failure kill the whole lookup. */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── Address normalization ──────────────────────────────────────────────────

const TYPE_TO_ABBR: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', PLACE: 'PL', ROAD: 'RD', DRIVE: 'DR',
  BOULEVARD: 'BLVD', LANE: 'LN', COURT: 'CT', CIRCLE: 'CIR', TERRACE: 'TER',
  PARKWAY: 'PKWY', HIGHWAY: 'HWY', SQUARE: 'SQ', TRAIL: 'TRL', PLAZA: 'PLZ',
  ALLEY: 'ALY', CRESCENT: 'CRES', EXPRESSWAY: 'EXPY', TURNPIKE: 'TPKE',
  WAY: 'WAY', ROW: 'ROW', WALK: 'WALK', LOOP: 'LOOP', PATH: 'PATH', MALL: 'MALL',
};
const ABBR_TO_TYPE: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [full, abbr] of Object.entries(TYPE_TO_ABBR)) m[abbr] = full;
  // Extra abbreviations seen in the wild / in SF's 2-char roll format.
  m.AV = 'AVENUE'; m.BL = 'BOULEVARD'; m.STR = 'STREET'; m.AVE = 'AVENUE';
  m.PKY = 'PARKWAY'; m.TERR = 'TERRACE'; m.CRT = 'COURT'; m.WY = 'WAY';
  return m;
})();
const STREET_TYPE_TOKENS = new Set([...Object.keys(TYPE_TO_ABBR), ...Object.keys(ABBR_TO_TYPE)]);

const DIR_TO_ABBR: Record<string, string> = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHWEST: 'NW', NORTHEAST: 'NE', SOUTHWEST: 'SW', SOUTHEAST: 'SE',
};
const ABBR_TO_DIR: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [full, abbr] of Object.entries(DIR_TO_ABBR)) m[abbr] = full;
  return m;
})();

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR',
  'PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR','VI','GU',
]);

/** Every covered city/region alias, longest first so "new york city" beats "new york". */
const ALIAS_LIST = COVERAGE.flatMap((j) => j.aliases.map((a) => a.toUpperCase())).sort(
  (a, b) => b.length - a.length,
);

interface ParsedAddress {
  input: string;
  house_number: string | null;
  street_tokens: string[];
  street: string;
  unit: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

function ordinalSuffix(n: string): string {
  const last2 = Number(n.slice(-2));
  if (last2 >= 11 && last2 <= 13) return 'TH';
  switch (n.slice(-1)) {
    case '1': return 'ST';
    case '2': return 'ND';
    case '3': return 'RD';
    default: return 'TH';
  }
}

function parseAddress(raw: string): ParsedAddress {
  let s = String(raw || '')
    .toUpperCase()
    .replace(/[.,;:'"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // ZIP (5 digits, optionally +4). Only strip when it is not the house number,
  // i.e. it must not be the first token.
  let zip: string | null = null;
  const zipMatch = s.match(/(?:^|\s)(\d{5})(?:-\d{4})?(?=\s|$)/g);
  if (zipMatch) {
    const cand = zipMatch[zipMatch.length - 1].trim().slice(0, 5);
    const firstTok = s.split(' ')[0];
    if (cand !== firstTok) {
      zip = cand;
      s = s.replace(new RegExp(`(?:^|\\s)${cand}(?:-\\d{4})?(?=\\s|$)`), ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Unit / apartment.
  let unit: string | null = null;
  const unitRe = /\s(?:APT|APARTMENT|UNIT|STE|SUITE|#)\s*([A-Z0-9][A-Z0-9-]*)\b/;
  const um = s.match(unitRe);
  if (um) {
    unit = um[1];
    s = s.replace(unitRe, ' ').replace(/\s+/g, ' ').trim();
  }

  // Known city / region phrase (longest match wins) — used for jurisdiction
  // inference AND removed from the street part so it never poisons the query.
  let city: string | null = null;
  for (const alias of ALIAS_LIST) {
    // A bare 2-letter alias like "DC" or "SF" must be a standalone trailing token.
    const re = alias.length <= 2
      ? new RegExp(`\\s${alias}$`)
      : new RegExp(`(?:^|\\s)${alias.replace(/\s+/g, '\\s+')}(?=\\s|$)`);
    if (re.test(s)) {
      city = alias;
      s = s.replace(re, ' ').replace(/\s+/g, ' ').trim();
      break;
    }
  }

  // Trailing state abbreviation.
  let state: string | null = null;
  const toks0 = s.split(' ').filter(Boolean);
  if (toks0.length > 1) {
    const last = toks0[toks0.length - 1];
    // NW/NE/SW/SE are DC quadrants, not states; never eat a directional.
    if (US_STATES.has(last) && !ABBR_TO_DIR[last]) {
      state = last;
      toks0.pop();
      s = toks0.join(' ');
    }
  }

  const toks = s.split(' ').filter(Boolean);
  let house_number: string | null = null;
  if (toks.length && /^\d+[A-Z]?(?:-\d+[A-Z]?)?$/.test(toks[0])) {
    house_number = toks.shift() as string;
  }

  return {
    input: String(raw || ''),
    house_number,
    street_tokens: toks,
    street: toks.join(' '),
    unit,
    city,
    state,
    zip,
  };
}

/**
 * Portals disagree on abbreviation style — DC writes "30TH ST NW", NYC writes
 * "EAST 6TH STREET", Cook writes "N SHEFFIELD AVE", SF writes "GREENWICH ST".
 * Rather than guess, emit the small cross-product of {directional abbreviated |
 * spelled out} x {street type abbreviated | spelled out} x {ordinal with |
 * without suffix} and OR them in the WHERE clause.
 */
/**
 * Index of the street-type token ("ST", "AVENUE", …). It is NOT always last:
 * DC and Chicago append a directional, so "30TH STREET NW" has the type at
 * index 1. Never index 0 — a street genuinely named "Court" or "Park" must not
 * be rewritten into an abbreviation.
 */
function streetTypeIndex(tokens: string[]): number {
  for (let i = tokens.length - 1; i >= 1; i--) {
    if (STREET_TYPE_TOKENS.has(tokens[i])) return i;
  }
  return -1;
}

/**
 * Spelled-out ordinals for numbered streets. Callers write "Fifth Avenue" and
 * "Third St"; every portal we hit stores the digit form ("5 AVENUE" in NYC's
 * roll, "5TH ST NW" in DC). Measured 2026-07-27: "350 Fifth Avenue, Manhattan"
 * found nothing while "350 5th Ave" matched — same street, and nothing in the
 * response told the caller the spelling was the problem.
 */
const ORDINAL_WORDS: Record<string, string> = {
  FIRST: '1', SECOND: '2', THIRD: '3', FOURTH: '4', FIFTH: '5', SIXTH: '6',
  SEVENTH: '7', EIGHTH: '8', NINTH: '9', TENTH: '10', ELEVENTH: '11',
  TWELFTH: '12', THIRTEENTH: '13', FOURTEENTH: '14', FIFTEENTH: '15',
  SIXTEENTH: '16', SEVENTEENTH: '17', EIGHTEENTH: '18', NINETEENTH: '19',
  TWENTIETH: '20', THIRTIETH: '30', FORTIETH: '40', FIFTIETH: '50',
  SIXTIETH: '60', SEVENTIETH: '70', EIGHTIETH: '80', NINETIETH: '90',
};

/** ["FIFTH","AVENUE"] → ["5TH","AVENUE"]; null when nothing was spelled out. */
function digitizeOrdinals(tokens: string[]): string[] | null {
  const typeIdx = streetTypeIndex(tokens);
  let hit = false;
  const out = tokens.map((tok, i) => {
    const n = i === typeIdx ? undefined : ORDINAL_WORDS[tok];
    if (!n) return tok;
    hit = true;
    return `${n}${ordinalSuffix(n)}`;
  });
  return hit ? out : null;
}

function streetVariants(tokens: string[]): string[] {
  const out = baseVariants(tokens);
  // Token count is preserved, so streetTypeIndex still points at the same slot
  // and looseVariants can keep indexing these by position.
  const digits = digitizeOrdinals(tokens);
  if (digits) for (const v of baseVariants(digits)) if (!out.includes(v)) out.push(v);
  return out;
}

function baseVariants(tokens: string[]): string[] {
  if (!tokens.length) return [];
  const typeIdx = streetTypeIndex(tokens);
  const out: string[] = [];
  for (const dirAbbr of [true, false]) {
    for (const typeAbbr of [true, false]) {
      for (const ordSuffix of [true, false]) {
        const mapped = tokens.map((tok, i) => {
          if (i === typeIdx) {
            return typeAbbr ? (TYPE_TO_ABBR[tok] ?? tok) : (ABBR_TO_TYPE[tok] ?? tok);
          }
          if (DIR_TO_ABBR[tok]) return dirAbbr ? DIR_TO_ABBR[tok] : tok;
          if (ABBR_TO_DIR[tok]) return dirAbbr ? tok : ABBR_TO_DIR[tok];
          const ord = tok.match(/^(\d+)(ST|ND|RD|TH)$/);
          if (ord) return ordSuffix ? tok : ord[1];
          if (/^\d+$/.test(tok)) return ordSuffix ? `${tok}${ordinalSuffix(tok)}` : tok;
          return tok;
        });
        const v = mapped.join(' ');
        if (!out.includes(v)) out.push(v);
      }
    }
  }
  return out;
}

/**
 * Second-chance patterns, used only when the exact variants matched nothing.
 * Replaces the street-type token with a LIKE wildcard so "5027 Spruce Avenue"
 * still finds "5027 SPRUCE ST" — callers routinely guess the wrong suffix, and
 * a wrong-suffix miss is indistinguishable to the user from "no such property".
 * Kept out of the first pass so precision stays high when the input is right.
 */
function looseVariants(tokens: string[]): string[] {
  const typeIdx = streetTypeIndex(tokens);
  if (typeIdx < 0) return [];
  // On a NUMBERED street the type token is the only thing distinguishing one
  // street from another — "5 AVENUE" and "5 STREET" are different streets in
  // the same borough — and wildcarding it also lets the number itself bleed
  // ("350 5%" matches "350 57 STREET"). Measured 2026-07-27: "350 5th Ave,
  // New York, NY" answered with 350 57th Street in BROOKLYN, carrying that
  // property's real sale history. A confident wrong answer is worse than a
  // miss here, so numbered streets get no second chance.
  const stem = tokens[typeIdx - 1] ?? '';
  if (/^\d+(?:ST|ND|RD|TH)?$/.test(stem) || ORDINAL_WORDS[stem]) return [];
  const out: string[] = [];
  for (const v of streetVariants(tokens)) {
    const parts = v.split(' ');
    parts[typeIdx] = '%';
    // "30TH % NW" → "30TH% NW"; a wildcard needs no surrounding space to match.
    const pat = parts.join(' ').replace(/ % /g, '% ').replace(/ %$/, '%');
    if (!out.includes(pat)) out.push(pat);
  }
  return out;
}

/** Single-quote escape for SoQL / SQL / ArcGIS WHERE literals. */
const q = (s: string) => s.replace(/'/g, "''");

// ── Jurisdiction inference ─────────────────────────────────────────────────

interface Inference {
  slug: string | null;
  basis: string;
}

function inferJurisdiction(p: ParsedAddress): Inference {
  if (p.city) {
    const hit = COVERAGE.find((j) => j.aliases.some((a) => a.toUpperCase() === p.city));
    if (hit) return { slug: hit.slug, basis: `city/region token "${p.city}" in the address` };
    return { slug: null, basis: `city/region token "${p.city}" is not a covered jurisdiction` };
  }
  if (p.zip) {
    const hit = COVERAGE.find((j) => j.zip_prefixes.some((z) => p.zip!.startsWith(z)));
    if (hit) return { slug: hit.slug, basis: `ZIP ${p.zip} falls inside ${hit.name}` };
    return { slug: null, basis: `ZIP ${p.zip} is outside every covered jurisdiction` };
  }
  if (p.state === 'DC') return { slug: 'dc', basis: 'state token "DC"' };
  // A quadrant suffix with no city is the DC addressing convention.
  const lastTok = p.street_tokens[p.street_tokens.length - 1];
  if (lastTok && ['NW', 'NE', 'SW', 'SE'].includes(lastTok)) {
    return { slug: 'dc', basis: `quadrant suffix "${lastTok}" is the Washington DC addressing convention` };
  }
  if (p.state) return { slug: null, basis: `state "${p.state}" given but no covered city or ZIP` };
  return { slug: null, basis: 'no city, state, or ZIP in the address' };
}

// ── Shared output shapes ───────────────────────────────────────────────────

interface SaleRecord {
  date: string | null;
  price: number | null;
  doc_type?: string | null;
  document_number?: string | null;
  seller?: string | null;
  buyer?: string | null;
  qualified?: string | null;
  non_arms_length?: boolean;
  unit?: string | null;
}

interface PropertyResult {
  covered: true;
  jurisdiction: string;
  jurisdiction_name: string;
  matched_address: string;
  parcel_id: string | null;
  parcel_id_type: string;
  owner?: string | null;
  assessed_value?: number | null;
  assessed_land_value?: number | null;
  assessed_building_value?: number | null;
  market_value?: number | null;
  land_use?: string | null;
  building_class?: string | null;
  year_built?: number | null;
  square_feet?: number | null;
  lot_square_feet?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  half_bathrooms?: number | null;
  rooms?: number | null;
  stories?: number | null;
  units?: number | null;
  zoning?: string | null;
  neighborhood?: string | null;
  extra?: Record<string, unknown>;
  sales: SaleRecord[];
  sales_count: number;
  last_sale?: SaleRecord | null;
  other_matches?: Array<{ address: string; parcel_id: string | null; hint?: string | null }>;
  match_count: number;
  source_name: string;
  source_url: string;
  fields_available: { sales_price: boolean; owner: boolean; assessment: boolean; characteristics: boolean };
  note: string;
  address_interpreted: {
    house_number: string | null;
    street: string;
    unit: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    inference_basis: string;
  };
  warnings?: string[];
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** ArcGIS returns dates as epoch milliseconds. */
function esriDate(v: unknown): string | null {
  const n = num(v);
  if (n === null || n === 0) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  // Guard the county-DB sentinel values (1900-01-01, 1899-12-31 etc).
  if (iso <= '1900-01-02') return null;
  return iso;
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d > '1900-01-02' && d < '2100-01-01' ? d : null;
}

function dedupeSales(sales: SaleRecord[]): SaleRecord[] {
  const seen = new Set<string>();
  const out: SaleRecord[] = [];
  for (const s of sales) {
    // A row with neither a date nor a price carries no information — county
    // rolls emit these placeholders for never-transferred (e.g. federal) lots,
    // and surfacing one reads as "there was a $0 sale".
    if (!s.date && !s.price) continue;
    const k = `${s.date ?? ''}|${s.price ?? ''}|${s.unit ?? ''}|${s.document_number ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

// ── Washington, DC ─────────────────────────────────────────────────────────

const DC_BASE =
  'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/MapServer';

function dcQuery(layer: number, where: string, outFields: string, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({
    where,
    outFields,
    returnGeometry: 'false',
    f: 'json',
    ...extra,
  });
  return `${DC_BASE}/${layer}/query?${p.toString()}`;
}

interface EsriResp<T> {
  features?: Array<{ attributes: T }>;
  error?: { message?: string };
}

async function lookupDc(p: ParsedAddress, maxSales: number): Promise<PropertyResult> {
  const meta = COVERAGE.find((j) => j.slug === 'dc')!;
  const variants = streetVariants(p.street_tokens);
  const numPart = p.house_number ? `${q(p.house_number)} ` : '';

  const fetchParcels = async (vs: string[]) => {
    const clauses = vs.map((v) => `UPPER(PREMISEADD) LIKE '${numPart}${q(v)}%'`);
    const where = clauses.length ? clauses.join(' OR ') : `UPPER(PREMISEADD) LIKE '${numPart}%'`;
    const r = await getJson<EsriResp<Record<string, unknown>>>(
      dcQuery(
        53,
        where,
        'SSL,PREMISEADD,UNITNUMBER,OWNERNAME,OWNNAME2,USECODE,PROPTYPE,CLASSTYPE,LANDAREA,ASSESSMENT,PHASELAND,PHASEBUILD,NEWTOTAL,SALEPRICE,SALEDATE,ANNUALTAX,HSTDCODE,NBHDNAME,PRMS_WARD,EXTRACTDAT',
        { resultRecordCount: '25', orderByFields: 'PREMISEADD' },
      ),
      'DC Integrated Tax System (layer 53)',
    );
    if (r.error) throw new Error(`DC ITS: ${r.error.message ?? 'query error'}`);
    return r.features ?? [];
  };

  let feats = await fetchParcels(variants);
  if (!feats.length) {
    const loose = looseVariants(p.street_tokens);
    if (loose.length) feats = await fetchParcels(loose);
  }
  if (p.unit) {
    const u = p.unit.toUpperCase();
    const narrowed = feats.filter((f) => (str(f.attributes.UNITNUMBER) ?? '').toUpperCase() === u);
    if (narrowed.length) feats = narrowed;
  }
  if (!feats.length) return notFound('dc', p, meta, variants, numPart);

  const a = feats[0].attributes;
  const ssl = str(a.SSL);
  const proptype = str(a.PROPTYPE) ?? '';
  const isCondo = /CONDO/i.test(proptype);

  const sslWhere = `SSL = '${q(ssl ?? '')}'`;
  const [salesR, resR, condoR] = await Promise.all([
    settle(
      getJson<EsriResp<Record<string, unknown>>>(
        dcQuery(57, sslWhere, 'SSL,SALE_DATE,SALE_PRICE,QUALIFIED,SALE_CODE,SALE_CURR_OWNER', {
          resultRecordCount: String(Math.min(maxSales, 50)),
          orderByFields: 'SALE_DATE DESC',
        }),
        'DC property sales (layer 57)',
      ),
    ),
    settle(
      getJson<EsriResp<Record<string, unknown>>>(
        dcQuery(
          25,
          sslWhere,
          'SSL,BEDRM,BATHRM,HF_BATHRM,ROOMS,STORIES,AYB,EYB,YR_RMDL,GBA,LANDAREA,STYLE_D,STRUCT_D,GRADE_D,CNDTN_D,EXTWALL_D,NUM_UNITS,FIREPLACES,AC,HEAT_D',
          { resultRecordCount: '1' },
        ),
        'DC residential CAMA (layer 25)',
      ),
    ),
    settle(
      isCondo
        ? getJson<EsriResp<Record<string, unknown>>>(
            dcQuery(24, sslWhere, 'SSL,BEDRM,BATHRM,HF_BATHRM,ROOMS,AYB,EYB,YR_RMDL,LIVING_GBA,LANDAREA,FIREPLACES,AC,HEAT_D', {
              resultRecordCount: '1',
            }),
            'DC condominium CAMA (layer 24)',
          )
        : Promise.resolve({ features: [] } as EsriResp<Record<string, unknown>>),
    ),
  ]);

  const warnings: string[] = [];
  const sales: SaleRecord[] = [];
  if (salesR.ok) {
    for (const f of salesR.value.features ?? []) {
      const s = f.attributes;
      const price = num(s.SALE_PRICE);
      sales.push({
        date: esriDate(s.SALE_DATE),
        price,
        doc_type: str(s.SALE_CODE),
        qualified: str(s.QUALIFIED) === 'Q' ? 'qualified (arms-length)' : str(s.QUALIFIED) === 'U' ? 'unqualified (not arms-length)' : str(s.QUALIFIED),
        non_arms_length: str(s.QUALIFIED) === 'U' || !price,
      });
    }
  } else {
    warnings.push(`Sales table unavailable: ${salesR.error}`);
  }
  // The assessment record carries the most recent sale; fold it in if the sales
  // table missed it.
  const rollSaleDate = esriDate(a.SALEDATE);
  if (rollSaleDate && !sales.some((s) => s.date === rollSaleDate)) {
    sales.push({ date: rollSaleDate, price: num(a.SALEPRICE), doc_type: null });
  }

  const chars =
    (condoR.ok && condoR.value.features?.[0]?.attributes) ||
    (resR.ok && resR.value.features?.[0]?.attributes) ||
    null;

  const finalSales = dedupeSales(sales).slice(0, maxSales);
  return {
    covered: true,
    jurisdiction: 'dc',
    jurisdiction_name: meta.name,
    matched_address: str(a.PREMISEADD) ?? p.input,
    parcel_id: ssl,
    parcel_id_type: 'SSL (square-suffix-lot)',
    owner: str(a.OWNERNAME) ?? null,
    assessed_value: num(a.ASSESSMENT),
    assessed_land_value: num(a.PHASELAND),
    assessed_building_value: num(a.PHASEBUILD),
    land_use: proptype || null,
    building_class: str(a.CLASSTYPE) ? `tax class ${str(a.CLASSTYPE)}` : null,
    year_built: chars ? num(chars.AYB) : null,
    square_feet: chars ? num(chars.GBA) ?? num(chars.LIVING_GBA) : null,
    lot_square_feet: num(a.LANDAREA),
    bedrooms: chars ? num(chars.BEDRM) : null,
    bathrooms: chars ? num(chars.BATHRM) : null,
    half_bathrooms: chars ? num(chars.HF_BATHRM) : null,
    rooms: chars ? num(chars.ROOMS) : null,
    stories: chars ? num(chars.STORIES) : null,
    units: chars ? num(chars.NUM_UNITS) : null,
    neighborhood: str(a.NBHDNAME),
    extra: {
      secondary_owner: str(a.OWNNAME2),
      use_code: str(a.USECODE),
      annual_tax: num(a.ANNUALTAX),
      homestead: str(a.HSTDCODE),
      proposed_next_year_assessment: num(a.NEWTOTAL),
      ward: str(a.PRMS_WARD),
      unit_number: str(a.UNITNUMBER),
      effective_year_built: chars ? num(chars.EYB) : null,
      remodel_year: chars ? num(chars.YR_RMDL) : null,
      style: chars ? str(chars.STYLE_D) : null,
      structure: chars ? str(chars.STRUCT_D) : null,
      grade: chars ? str(chars.GRADE_D) : null,
      condition: chars ? str(chars.CNDTN_D) : null,
      exterior_wall: chars ? str(chars.EXTWALL_D) : null,
      heating: chars ? str(chars.HEAT_D) : null,
      air_conditioning: chars ? str(chars.AC) : null,
      fireplaces: chars ? num(chars.FIREPLACES) : null,
      assessment_as_of: esriDate(a.EXTRACTDAT),
    },
    sales: finalSales,
    sales_count: finalSales.length,
    last_sale: finalSales[0] ?? null,
    other_matches: feats.slice(1, 11).map((f) => ({
      address: str(f.attributes.PREMISEADD) ?? '',
      parcel_id: str(f.attributes.SSL),
      hint: str(f.attributes.PROPTYPE),
    })),
    match_count: feats.length,
    source_name: meta.source_name,
    source_url: `${DC_BASE}/53`,
    fields_available: { sales_price: true, owner: true, assessment: true, characteristics: !!chars },
    note:
      `Answered by ${meta.source_name}. Sale prices are as recorded; a "unqualified" flag or $0 price means a non-arms-length transfer.` +
      (chars ? '' : ' No CAMA characteristics record for this parcel (common for special-purpose, vacant, and some commercial lots), so bed/bath/year-built are unavailable.') +
      (feats.length > 1 ? ` ${feats.length} addresses matched — the first is detailed, the rest are listed in other_matches (DC addresses need a quadrant such as NW to be unique).` : ''),
    address_interpreted: interpreted(p, `city/region or quadrant → dc`),
    warnings: warnings.length ? warnings : undefined,
  };
}

// ── New York City ──────────────────────────────────────────────────────────

const NYC_ANNUAL = 'https://data.cityofnewyork.us/resource/w2pb-icbu.json';
const NYC_ROLLING = 'https://data.cityofnewyork.us/resource/usep-8jbt.json';
const NYC_ROLL = 'https://data.cityofnewyork.us/resource/8y4t-faws.json';
const NYC_BOROUGH: Record<string, string> = {
  MANHATTAN: '1', BRONX: '2', 'THE BRONX': '2', BROOKLYN: '3', QUEENS: '4', 'STATEN ISLAND': '5',
};
/** How far below the requested house number a parcel's range may start. */
const ROLL_HOUSENUM_WINDOW = 40;
const NYC_BOROUGH_NAME: Record<string, string> = {
  '1': 'Manhattan', '2': 'Bronx', '3': 'Brooklyn', '4': 'Queens', '5': 'Staten Island',
};

function soda(base: string, params: Record<string, string>): string {
  const p = new URLSearchParams(params);
  return `${base}?${p.toString()}`;
}

async function lookupNyc(p: ParsedAddress, maxSales: number): Promise<PropertyResult> {
  const meta = COVERAGE.find((j) => j.slug === 'nyc')!;
  const variants = streetVariants(p.street_tokens);
  const numPart = p.house_number ? `${q(p.house_number)} ` : '';
  const boroFilter = p.city && NYC_BOROUGH[p.city] ? ` AND borough='${NYC_BOROUGH[p.city]}'` : '';

  const salesSelect =
    'address,borough,block,lot,bbl,neighborhood,zip_code,sale_price,sale_date,' +
    'building_class_at_time_of,building_class_category,year_built,gross_square_feet,land_square_feet,' +
    'residential_units,commercial_units,total_units,apartment_number';

  const warnings: string[] = [];
  const fetchSales = async (vs: string[]) => {
    const like = vs.length
      ? vs.map((v) => `upper(address) like '${numPart}${q(v)}%'`).join(' OR ')
      : `upper(address) like '${numPart}%'`;
    const where = `(${like})${boroFilter}`;
    const [annualR, rollingR] = await Promise.all([
      settle(
        getJson<Array<Record<string, unknown>>>(
          soda(NYC_ANNUAL, { $where: where, $select: salesSelect, $order: 'sale_date DESC', $limit: '60' }),
          'NYC annualized sales (w2pb-icbu)',
        ),
      ),
      settle(
        getJson<Array<Record<string, unknown>>>(
          soda(NYC_ROLLING, {
            $where: where,
            $select:
              'address,borough,block,lot,neighborhood,zip_code,sale_price,sale_date,building_class_at_time_of,building_class_category,year_built,gross_square_feet,land_square_feet,residential_units,commercial_units,total_units',
            $order: 'sale_date DESC',
            $limit: '60',
          }),
          'NYC rolling sales (usep-8jbt)',
        ),
      ),
    ]);
    if (!annualR.ok) warnings.push(`Annualized sales file unavailable: ${annualR.error}`);
    if (!rollingR.ok) warnings.push(`Rolling sales file unavailable: ${rollingR.error}`);
    return [...(annualR.ok ? annualR.value : []), ...(rollingR.ok ? rollingR.value : [])];
  };

  let rows = await fetchSales(variants);
  let usedVariants = variants;
  if (!rows.length) {
    const loose = looseVariants(p.street_tokens);
    if (loose.length) {
      rows = await fetchSales(loose);
      if (rows.length) usedVariants = loose;
    }
  }

  // Resolve BBL. Prefer the sales rows; fall back to a direct roll query.
  let bbl = rows.map((r) => str(r.bbl)).find(Boolean) ?? null;
  if (!bbl && rows.length) {
    const r = rows[0];
    const b = str(r.borough), blk = str(r.block), lot = str(r.lot);
    if (b && blk && lot) bbl = `${b}${blk.padStart(5, '0')}${lot.padStart(4, '0')}`;
  }

  let rollRow: Record<string, unknown> | null = null;
  const rollSelect =
    'parid,boro,block,lot,owner,bldg_class,zoning,housenum_lo,housenum_hi,street_name,zip_code,' +
    'curmkttot,curmktland,curacttot,curactland,curtaxclass,yrbuilt,gross_sqft,land_area,units,' +
    'bld_story,lot_frt,lot_dep,num_bldgs,year,extracrdt';
  if (bbl) {
    const r = await settle(
      getJson<Array<Record<string, unknown>>>(
        soda(NYC_ROLL, { $where: `parid='${q(bbl)}'`, $select: rollSelect, $order: 'year DESC', $limit: '1' }),
        'NYC assessment roll (8y4t-faws)',
      ),
    );
    if (r.ok) rollRow = r.value[0] ?? null;
    else warnings.push(`Assessment roll unavailable: ${r.error}`);
  } else if (p.house_number && p.street_tokens.length) {
    // The roll normalizes street names differently ("EAST 6 STREET" vs the sales
    // file's "EAST 6TH STREET"), so OR the same variant set against street_name.
    const rollLike = [...usedVariants, ...looseVariants(p.street_tokens)]
      .map((v) => `upper(street_name) like '${q(v)}%'`)
      .join(' OR ');
    const boro = p.city && NYC_BOROUGH[p.city] ? ` AND boro='${NYC_BOROUGH[p.city]}'` : '';
    // The roll indexes parcels by house-number RANGE, not by street address:
    // the Empire State Building is housenum_lo 338 / housenum_hi 350, so an
    // equality test on "350" misses it — and it misses most large buildings the
    // same way (measured 2026-07-27, the whole reason "350 5th Ave" came back
    // empty). Socrata can't do the comparison for us: a `::number` cast on this
    // column 400s on the "1443A" style values that live elsewhere in it. So
    // pull a window of plausible range starts and contain-test here.
    const target = num(p.house_number.replace(/\D/g, ''));
    const los: string[] = [];
    if (target !== null) {
      for (let n = target; n >= Math.max(0, target - ROLL_HOUSENUM_WINDOW); n--) los.push(String(n));
    }
    const numFilter = los.length
      ? `housenum_lo in (${los.map((n) => `'${n}'`).join(',')})`
      : `housenum_lo='${q(p.house_number)}'`;
    const r = await settle(
      getJson<Array<Record<string, unknown>>>(
        soda(NYC_ROLL, {
          $where: `${numFilter} AND (${rollLike})${boro}`,
          $select: rollSelect,
          $order: 'year DESC',
          $limit: '200',
        }),
        'NYC assessment roll (8y4t-faws)',
      ),
    );
    // $order year DESC, so the first containing row is also the newest roll year.
    if (r.ok) {
      const contains = r.value.filter((row) => {
        const lo = num(row.housenum_lo);
        if (lo === null || target === null) return false;
        const hi = num(row.housenum_hi);
        if (hi === null) return lo === target;
        if (lo > target || hi < target) return false;
        // Odd and even numbers sit on OPPOSITE sides of a US street, so a range
        // whose ends share a parity enumerates only that parity: 349-353 is
        // 349/351/353 and does NOT contain 350. Without this, 350 5th Ave
        // resolved to the odd-side lot across the street from the Empire State
        // Building — both ranges span 350 numerically (2026-07-27).
        if (lo % 2 === hi % 2 && target % 2 !== lo % 2) return false;
        return true;
      });
      rollRow = contains.find((row) => num(row.housenum_lo) === target) ?? contains[0] ?? null;
    } else warnings.push(`Assessment roll unavailable: ${r.error}`);
  }

  if (!rows.length && !rollRow) {
    return notFound('nyc', p, meta, variants, numPart) as PropertyResult;
  }
  const matchCount = rows.length || (rollRow ? 1 : 0);

  const sales = dedupeSales(
    rows.map((r) => {
      const price = num(r.sale_price);
      return {
        date: isoDate(r.sale_date),
        price,
        unit: str(r.apartment_number) ?? unitFromNycAddress(str(r.address)),
        doc_type: str(r.building_class_at_time_of),
        non_arms_length: !price || price < 1000,
      } as SaleRecord;
    }),
  ).slice(0, maxSales);

  const primary = rows[0] ?? {};
  const boroCode = str(primary.borough) ?? str(rollRow?.boro) ?? null;
  // Show the parcel's full house-number range when it spans one, so a caller who
  // asked about 350 can see they were answered from the 338-350 lot rather than
  // reading "338 5 AVENUE" as us having matched the wrong building.
  const rollLo = rollRow ? str(rollRow.housenum_lo) : null;
  const rollHi = rollRow ? str(rollRow.housenum_hi) : null;
  const matchedAddress =
    str(primary.address) ??
    (rollRow
      ? `${rollLo ?? ''}${rollHi && rollHi !== rollLo ? `-${rollHi}` : ''} ${str(rollRow.street_name) ?? ''}`.trim()
      : p.input);

  // "350 5th Ave, New York" names no borough, and the same street number exists
  // on the same street name in several of them. We answer from rows[0], so say
  // out loud when that pick was arbitrary rather than letting one borough's
  // sale history pass for the address the caller meant.
  const boros = new Set(rows.map((r) => str(r.borough)).filter(Boolean) as string[]);
  if (!boroFilter && boros.size > 1) {
    warnings.push(
      `The address did not name a borough and matches exist in ${[...boros]
        .map((b) => NYC_BOROUGH_NAME[b] ?? b)
        .join(', ')}. Answered from ${
        boroCode ? NYC_BOROUGH_NAME[boroCode] ?? boroCode : 'the first match'
      } — re-ask with the borough (e.g. "Manhattan") to pin it down.`,
    );
  }

  const uniqAddrs = new Map<string, { address: string; parcel_id: string | null; hint?: string | null }>();
  for (const r of rows.slice(1)) {
    const plain = str(r.address);
    if (!plain) continue;
    const rBoro = str(r.borough);
    // Borough-qualified, because the same street number on the same street name
    // in two boroughs is two different buildings and must not dedupe together.
    const addr = `${plain}${rBoro && NYC_BOROUGH_NAME[rBoro] ? `, ${NYC_BOROUGH_NAME[rBoro]}` : ''}`;
    if (plain === matchedAddress && rBoro === boroCode) continue;
    if (!uniqAddrs.has(addr)) {
      uniqAddrs.set(addr, {
        address: addr,
        parcel_id: str(r.bbl),
        hint: `sold ${isoDate(r.sale_date) ?? '?'}${num(r.sale_price) ? ` for $${num(r.sale_price)!.toLocaleString('en-US')}` : ''}`,
      });
    }
  }

  return {
    covered: true,
    jurisdiction: 'nyc',
    jurisdiction_name: meta.name,
    matched_address:
      matchedAddress + (boroCode && NYC_BOROUGH_NAME[boroCode] ? `, ${NYC_BOROUGH_NAME[boroCode]}, NY` : ''),
    parcel_id: bbl ?? str(rollRow?.parid) ?? null,
    parcel_id_type: 'BBL (borough-block-lot)',
    owner: rollRow ? str(rollRow.owner) : null,
    market_value: rollRow ? num(rollRow.curmkttot) : null,
    assessed_value: rollRow ? num(rollRow.curacttot) : null,
    assessed_land_value: rollRow ? num(rollRow.curactland) : null,
    land_use: str(primary.building_class_category) ?? null,
    building_class: str(primary.building_class_at_time_of) ?? (rollRow ? str(rollRow.bldg_class) : null),
    year_built: num(primary.year_built) ?? (rollRow ? num(rollRow.yrbuilt) : null),
    square_feet: num(primary.gross_square_feet) ?? (rollRow ? num(rollRow.gross_sqft) : null),
    lot_square_feet: num(primary.land_square_feet) ?? (rollRow ? num(rollRow.land_area) : null),
    bedrooms: null,
    bathrooms: null,
    stories: rollRow ? num(rollRow.bld_story) : null,
    units: num(primary.total_units) ?? (rollRow ? num(rollRow.units) : null),
    zoning: rollRow ? str(rollRow.zoning) : null,
    neighborhood: str(primary.neighborhood) ?? null,
    extra: {
      borough: boroCode ? NYC_BOROUGH_NAME[boroCode] ?? boroCode : null,
      block: str(primary.block) ?? (rollRow ? str(rollRow.block) : null),
      lot: str(primary.lot) ?? (rollRow ? str(rollRow.lot) : null),
      zip: str(primary.zip_code) ?? (rollRow ? str(rollRow.zip_code) : null),
      residential_units: num(primary.residential_units),
      commercial_units: num(primary.commercial_units),
      market_land_value: rollRow ? num(rollRow.curmktland) : null,
      tax_class: rollRow ? str(rollRow.curtaxclass) : null,
      assessment_roll_year: rollRow ? str(rollRow.year) : null,
      assessment_as_of: rollRow ? isoDate(rollRow.extracrdt) : null,
      buildings_on_lot: rollRow ? num(rollRow.num_bldgs) : null,
    },
    sales,
    sales_count: sales.length,
    last_sale: sales[0] ?? null,
    other_matches: [...uniqAddrs.values()].slice(0, 10),
    match_count: matchCount,
    source_name: meta.source_name,
    source_url: NYC_ANNUAL,
    fields_available: { sales_price: true, owner: !!rollRow, assessment: !!rollRow, characteristics: true },
    note:
      'Answered by NYC Department of Finance. Sales cover 2016 to present (annualized citywide file plus the rolling last-12-months file). ' +
      'A $0 sale price is a non-arms-length transfer (deed correction, inheritance, related-party) and is reported as recorded, flagged non_arms_length. ' +
      'The DOF assessment roll does not publish bedroom or bathroom counts, so those are null for every NYC property. ' +
      'Condo and co-op sales share a building BBL, so multiple unit lines can appear for one street address — check the unit field and other_matches.',
    address_interpreted: interpreted(p, 'city/borough or ZIP → nyc'),
    warnings: warnings.length ? warnings : undefined,
  };
}

function unitFromNycAddress(addr: string | null): string | null {
  if (!addr) return null;
  const m = addr.match(/,\s*([A-Z0-9-]+)\s*$/i);
  return m ? m[1] : null;
}

// ── Philadelphia ───────────────────────────────────────────────────────────

const PHL_SQL = 'https://phl.carto.com/api/v2/sql';

function cartoUrl(sql: string): string {
  return `${PHL_SQL}?${new URLSearchParams({ q: sql }).toString()}`;
}

async function lookupPhiladelphia(p: ParsedAddress, maxSales: number): Promise<PropertyResult> {
  const meta = COVERAGE.find((j) => j.slug === 'philadelphia')!;
  const variants = streetVariants(p.street_tokens);
  const numPart = p.house_number ? `${q(p.house_number)} ` : '';

  interface CartoResp { rows?: Array<Record<string, unknown>>; error?: unknown }
  const warnings: string[] = [];

  const fetchPhl = async (vs: string[]) => {
    const opaLike = vs.length
      ? vs.map((v) => `location LIKE '${numPart}${q(v)}%'`).join(' OR ')
      : `location LIKE '${numPart}%'`;
    const rttLike = vs.length
      ? vs.map((v) => `street_address LIKE '${numPart}${q(v)}%'`).join(' OR ')
      : `street_address LIKE '${numPart}%'`;

    const opaSql =
      'SELECT parcel_number, location, unit, owner_1, owner_2, market_value, taxable_land, taxable_building, ' +
      'exempt_land, exempt_building, homestead_exemption, sale_price, sale_date, year_built, year_built_estimate, ' +
      'total_livable_area, total_area, number_of_bedrooms, number_of_bathrooms, number_of_rooms, number_stories, ' +
      'category_code_description, building_code_description, zoning, central_air, exterior_condition, ' +
      'interior_condition, quality_grade, garage_spaces, fireplaces, zip_code, geographic_ward, ' +
      'basements, general_construction, book_and_page, recording_date, assessment_date ' +
      `FROM opa_properties_public WHERE (${opaLike}) ORDER BY location LIMIT 25`;

    const rttSql =
      'SELECT document_id, document_type, display_date, street_address, grantors, grantees, ' +
      'total_consideration, cash_consideration, assessed_value, fair_market_value ' +
      `FROM rtt_summary WHERE (${rttLike}) ORDER BY display_date DESC LIMIT 120`;

    const [opaR, rttR] = await Promise.all([
      settle(getJson<CartoResp>(cartoUrl(opaSql), 'Philadelphia OPA assessments')),
      settle(getJson<CartoResp>(cartoUrl(rttSql), 'Philadelphia realty-transfer documents')),
    ]);
    if (!opaR.ok) warnings.push(`OPA assessment file unavailable: ${opaR.error}`);
    if (!rttR.ok) warnings.push(`Transfer-document file unavailable: ${rttR.error}`);
    return {
      opa: opaR.ok ? opaR.value.rows ?? [] : [],
      // rtt_summary carries every recorded instrument; only deeds are sales.
      rtt: (rttR.ok ? rttR.value.rows ?? [] : []).filter((r) => /^DEED/i.test(str(r.document_type) ?? '')),
    };
  };

  let got = await fetchPhl(variants);
  if (!got.opa.length && !got.rtt.length) {
    const loose = looseVariants(p.street_tokens);
    if (loose.length) got = await fetchPhl(loose);
  }

  let opaRows = got.opa;
  if (p.unit) {
    const u = p.unit.toUpperCase();
    const narrowed = opaRows.filter((r) => (str(r.unit) ?? '').toUpperCase() === u);
    if (narrowed.length) opaRows = narrowed;
  }
  const rttRows = got.rtt;

  if (!opaRows.length && !rttRows.length) {
    return notFound('philadelphia', p, meta, variants, numPart) as PropertyResult;
  }

  const a = opaRows[0] ?? {};
  const sales = dedupeSales(
    rttRows.map((r) => {
      const price = num(r.total_consideration) ?? num(r.cash_consideration);
      return {
        date: isoDate(r.display_date),
        price,
        doc_type: str(r.document_type),
        document_number: str(r.document_id),
        seller: str(r.grantors),
        buyer: str(r.grantees),
        non_arms_length: !price || price < 1000,
      } as SaleRecord;
    }),
  );
  // Fold in the assessment file's last-sale row when the deed file missed it.
  // The assessment file repeats the last sale; only fold it in when the deed
  // file has nothing on that date, otherwise it duplicates the deed row under a
  // different doc_type and reads as two separate sales.
  const opaSaleDate = isoDate(a.sale_date);
  if (opaSaleDate && !sales.some((s) => s.date === opaSaleDate)) {
    sales.push({ date: opaSaleDate, price: num(a.sale_price), doc_type: 'OPA last recorded sale' });
  }
  const finalSales = dedupeSales(sales).slice(0, maxSales);

  const taxableTotal = (num(a.taxable_land) ?? 0) + (num(a.taxable_building) ?? 0);
  return {
    covered: true,
    jurisdiction: 'philadelphia',
    jurisdiction_name: meta.name,
    matched_address:
      (str(a.location) ?? str(rttRows[0]?.street_address) ?? p.input) +
      (str(a.unit) ? ` #${str(a.unit)}` : '') + ', Philadelphia, PA',
    parcel_id: str(a.parcel_number),
    parcel_id_type: 'OPA account number',
    owner: [str(a.owner_1), str(a.owner_2)].filter(Boolean).join('; ') || str(rttRows[0]?.grantees) || null,
    market_value: num(a.market_value),
    assessed_value: taxableTotal || num(a.market_value),
    assessed_land_value: num(a.taxable_land),
    assessed_building_value: num(a.taxable_building),
    land_use: str(a.category_code_description),
    building_class: str(a.building_code_description),
    year_built: num(a.year_built),
    square_feet: num(a.total_livable_area),
    lot_square_feet: num(a.total_area),
    bedrooms: num(a.number_of_bedrooms),
    bathrooms: num(a.number_of_bathrooms),
    rooms: num(a.number_of_rooms),
    stories: num(a.number_stories),
    zoning: str(a.zoning),
    extra: {
      year_built_is_estimate: str(a.year_built_estimate) === 'Y',
      exempt_land: num(a.exempt_land),
      exempt_building: num(a.exempt_building),
      homestead_exemption: num(a.homestead_exemption),
      central_air: str(a.central_air),
      exterior_condition: str(a.exterior_condition),
      interior_condition: str(a.interior_condition),
      quality_grade: str(a.quality_grade),
      garage_spaces: num(a.garage_spaces),
      fireplaces: num(a.fireplaces),
      basement: str(a.basements),
      construction: str(a.general_construction),
      zip: str(a.zip_code),
      ward: str(a.geographic_ward),
      deed_book_and_page: str(a.book_and_page),
      deed_recording_date: isoDate(a.recording_date),
      assessment_as_of: isoDate(a.assessment_date),
      recorded_documents_matched: rttRows.length,
    },
    sales: finalSales,
    sales_count: finalSales.length,
    last_sale: finalSales[0] ?? null,
    other_matches: opaRows.slice(1, 11).map((r) => ({
      address: `${str(r.location) ?? ''}${str(r.unit) ? ` #${str(r.unit)}` : ''}`,
      parcel_id: str(r.parcel_number),
      hint: str(r.category_code_description),
    })),
    match_count: opaRows.length || rttRows.length,
    source_name: meta.source_name,
    source_url: 'https://phl.carto.com/api/v2/sql (opa_properties_public + rtt_summary)',
    fields_available: { sales_price: true, owner: !!opaRows.length, assessment: !!opaRows.length, characteristics: !!opaRows.length },
    note:
      'Answered by the City of Philadelphia. Sales history comes from the Realty Transfer Tax recorded-document file, so it lists every deed with the seller (grantor) and buyer (grantee) names and the stated consideration. ' +
      'Deed types other than sales (mortgages, satisfactions) are filtered out. A $0 or $1 consideration is an intra-family or nominal transfer, flagged non_arms_length. ' +
      'Assessed value here equals taxable land plus taxable building; market_value is the OPA certified market value.',
    address_interpreted: interpreted(p, 'city or ZIP → philadelphia'),
    warnings: warnings.length ? warnings : undefined,
  };
}

// ── Cook County, Illinois ──────────────────────────────────────────────────

const COOK_ADDRESSES = 'https://datacatalog.cookcountyil.gov/resource/3723-97qp.json';
const COOK_SALES = 'https://datacatalog.cookcountyil.gov/resource/wvhk-k5uv.json';
const COOK_VALUES = 'https://datacatalog.cookcountyil.gov/resource/uzyt-m557.json';
const COOK_CHARS = 'https://datacatalog.cookcountyil.gov/resource/x54s-btds.json';

async function lookupCook(p: ParsedAddress, maxSales: number): Promise<PropertyResult> {
  const meta = COVERAGE.find((j) => j.slug === 'cook')!;
  const variants = streetVariants(p.street_tokens);
  const numPart = p.house_number ? `${q(p.house_number)} ` : '';
  // "chicago" implies the city but Cook covers ~130 municipalities; only narrow
  // when the user actually named a suburb we recognise.
  const cityFilter =
    p.city && p.city !== 'COOK COUNTY' && p.city !== 'COOK COUNTY IL'
      ? ` AND upper(prop_address_city_name)='${q(p.city)}'`
      : '';

  const fetchAddrs = (vs: string[]) => {
    const like = vs.length
      ? vs.map((v) => `upper(prop_address_full) like '${numPart}${q(v)}%'`).join(' OR ')
      : `upper(prop_address_full) like '${numPart}%'`;
    return getJson<Array<Record<string, unknown>>>(
      soda(COOK_ADDRESSES, {
        $where: `(${like})${cityFilter}`,
        $select:
          'pin,year,prop_address_full,prop_address_city_name,prop_address_state,prop_address_zipcode_1,owner_address_name,mail_address_name',
        $order: 'year DESC',
        $limit: '40',
      }),
      'Cook County parcel addresses (3723-97qp)',
    );
  };

  let addrRows = await fetchAddrs(variants);
  if (!addrRows.length) {
    const loose = looseVariants(p.street_tokens);
    if (loose.length) addrRows = await fetchAddrs(loose);
  }

  // The address file is a yearly snapshot — keep the newest row per PIN.
  const byPin = new Map<string, Record<string, unknown>>();
  for (const r of addrRows) {
    const pin = str(r.pin);
    if (pin && !byPin.has(pin)) byPin.set(pin, r);
  }
  const pins = [...byPin.keys()];
  if (!pins.length) return notFound('cook', p, meta, variants, numPart) as PropertyResult;

  const pin = pins[0];
  const a = byPin.get(pin)!;

  const [salesR, valR, charR] = await Promise.all([
    settle(
      getJson<Array<Record<string, unknown>>>(
        soda(COOK_SALES, {
          $where: `pin='${q(pin)}'`,
          $select:
            'pin,sale_date,sale_price,doc_no,deed_type,mydec_deed_type,seller_name,buyer_name,is_multisale,num_parcels_sale,sale_filter_less_than_10k,sale_filter_deed_type,class',
          $order: 'sale_date DESC',
          $limit: String(Math.min(maxSales, 50)),
        }),
        'Cook County parcel sales (wvhk-k5uv)',
      ),
    ),
    settle(
      getJson<Array<Record<string, unknown>>>(
        soda(COOK_VALUES, {
          $where: `pin='${q(pin)}'`,
          $select:
            'pin,year,class,township_name,mailed_tot,mailed_land,mailed_bldg,certified_tot,certified_land,certified_bldg,board_tot',
          $order: 'year DESC',
          $limit: '1',
        }),
        'Cook County assessed values (uzyt-m557)',
      ),
    ),
    settle(
      getJson<Array<Record<string, unknown>>>(
        soda(COOK_CHARS, {
          $where: `pin='${q(pin)}'`,
          $select:
            'pin,year,char_yrblt,char_bldg_sf,char_land_sf,char_beds,char_fbath,char_hbath,char_rooms,char_type_resd,char_ext_wall,char_air,char_bsmt,char_gar1_size,char_porch,char_repair_cnd,char_use,class',
          $order: 'year DESC',
          $limit: '1',
        }),
        'Cook County improvement characteristics (x54s-btds)',
      ),
    ),
  ]);

  const warnings: string[] = [];
  if (!salesR.ok) warnings.push(`Sales file unavailable: ${salesR.error}`);
  if (!valR.ok) warnings.push(`Assessed-value file unavailable: ${valR.error}`);
  if (!charR.ok) warnings.push(`Characteristics file unavailable: ${charR.error}`);

  const v = valR.ok ? valR.value[0] ?? null : null;
  const c = charR.ok ? charR.value[0] ?? null : null;
  const sales = dedupeSales(
    (salesR.ok ? salesR.value : []).map((r) => {
      const price = num(r.sale_price);
      return {
        date: isoDate(r.sale_date),
        price,
        doc_type: str(r.mydec_deed_type) ?? str(r.deed_type),
        document_number: str(r.doc_no),
        seller: str(r.seller_name) === 'UNKNOWN' ? null : str(r.seller_name),
        buyer: str(r.buyer_name) === 'UNKNOWN' ? null : str(r.buyer_name),
        non_arms_length: r.sale_filter_less_than_10k === true || r.sale_filter_deed_type === true || !price,
      } as SaleRecord;
    }),
  ).slice(0, maxSales);

  const assessedTotal = v ? num(v.board_tot) ?? num(v.certified_tot) ?? num(v.mailed_tot) : null;
  return {
    covered: true,
    jurisdiction: 'cook',
    jurisdiction_name: meta.name,
    matched_address: [
      str(a.prop_address_full),
      str(a.prop_address_city_name),
      str(a.prop_address_state),
      str(a.prop_address_zipcode_1),
    ]
      .filter(Boolean)
      .join(', '),
    parcel_id: pin,
    parcel_id_type: 'PIN (property index number)',
    owner: str(a.owner_address_name) ?? str(a.mail_address_name) ?? sales[0]?.buyer ?? null,
    assessed_value: assessedTotal,
    assessed_land_value: v ? num(v.certified_land) ?? num(v.mailed_land) : null,
    assessed_building_value: v ? num(v.certified_bldg) ?? num(v.mailed_bldg) : null,
    market_value: assessedTotal !== null ? assessedTotal * 10 : null,
    land_use: c ? str(c.char_use) ?? str(c.char_type_resd) : null,
    building_class: str(v?.class) ?? str(c?.class) ?? null,
    year_built: c ? num(c.char_yrblt) : null,
    square_feet: c ? num(c.char_bldg_sf) : null,
    lot_square_feet: c ? num(c.char_land_sf) : null,
    bedrooms: c ? num(c.char_beds) : null,
    bathrooms: c ? num(c.char_fbath) : null,
    half_bathrooms: c ? num(c.char_hbath) : null,
    rooms: c ? num(c.char_rooms) : null,
    extra: {
      township: v ? str(v.township_name) : null,
      assessment_year: v ? str(v.year)?.replace(/\.0$/, '') : null,
      assessment_ratio_note:
        'Illinois assesses residential property at 10% of market value, so assessed_value is roughly one tenth of market value. market_value above is assessed_value x 10 — an approximation, not a certified figure.',
      residence_type: c ? str(c.char_type_resd) : null,
      exterior_wall: c ? str(c.char_ext_wall) : null,
      air_conditioning: c ? str(c.char_air) : null,
      basement: c ? str(c.char_bsmt) : null,
      garage_size: c ? str(c.char_gar1_size) : null,
      porch: c ? str(c.char_porch) : null,
      condition: c ? str(c.char_repair_cnd) : null,
      owner_name_source: 'taxpayer/owner name on the assessor parcel-address file (the tax-bill addressee)',
    },
    sales,
    sales_count: sales.length,
    last_sale: sales[0] ?? null,
    other_matches: pins.slice(1, 11).map((k) => {
      const r = byPin.get(k)!;
      return {
        address: [str(r.prop_address_full), str(r.prop_address_city_name)].filter(Boolean).join(', '),
        parcel_id: k,
        hint: str(r.owner_address_name),
      };
    }),
    match_count: pins.length,
    source_name: meta.source_name,
    source_url: COOK_SALES,
    fields_available: { sales_price: true, owner: true, assessment: !!v, characteristics: !!c },
    note:
      'Answered by the Cook County Assessor open-data portal (four joined files: parcel addresses, parcel sales, assessed values, improvement characteristics). ' +
      'Sales go back to 1971 and include the deed type plus seller and buyer names where the assessor captured them. ' +
      'IMPORTANT: assessed_value is the Illinois assessed value, about 10% of market value for residential property — do not read it as a market price. ' +
      'owner is the taxpayer of record from the parcel-address file, which is usually but not always the deed owner. ' +
      (c ? '' : 'No improvement-characteristics record for this PIN (the file covers single/multi-family residential only), so bed/bath/year-built are unavailable. '),
    address_interpreted: interpreted(p, 'city or ZIP → cook'),
    warnings: warnings.length ? warnings : undefined,
  };
}

// ── San Francisco ──────────────────────────────────────────────────────────

const SF_ROLL = 'https://data.sfgov.org/resource/wv5m-vpq2.json';

async function lookupSf(p: ParsedAddress, _maxSales: number): Promise<PropertyResult> {
  const meta = COVERAGE.find((j) => j.slug === 'sf')!;
  // SF's property_location is a fixed-width string: a 4-char prefix, the house
  // number ZERO-PADDED to 4, the street name padded to 20, a 2-char street type,
  // then a 4-char unit. So match on " <nnnn> <STREETNAME>" and ignore the type.
  const core = p.street_tokens.filter(
    (t, i) => !(i === p.street_tokens.length - 1 && STREET_TYPE_TOKENS.has(t)),
  );
  // The street type is dropped above, so the trailing "%" sits directly against
  // the last name token — and against a bare number that lets the wildcard eat
  // the rest of another street's name: "% 0001 2%" matched "0001 21ST AV" for
  // "1 Second Street" (measured 2026-07-27). SF always writes the ordinal
  // suffix ("21ST", "22ND", "25TH"), so the suffix-stripped forms are dead
  // weight here anyway and dropping them costs no recall.
  const nameVariants = streetVariants(core).filter((v) => !/(?:^|\s)\d+$/.test(v));
  const padded = p.house_number ? p.house_number.replace(/\D/g, '').padStart(4, '0') : null;
  // property_location is stored uppercase, so skip upper() — wrapping the column
  // in a function turns this into a full scan of ~3.9M roll rows and blows the
  // 10s budget. Pair it with a rolling roll-year floor for the same reason; the
  // floor is computed, never hardcoded, so it cannot go stale.
  const clauses = nameVariants.length
    ? nameVariants.map((v) =>
        padded
          ? `property_location like '% ${q(padded)} ${q(v)}%'`
          : `property_location like '%${q(v)}%'`,
      )
    : padded
      ? [`property_location like '% ${q(padded)} %'`]
      : [];
  if (!clauses.length) return notFound('sf', p, meta, nameVariants, '') as PropertyResult;

  const SF_SELECT =
    'closed_roll_year,property_location,parcel_number,block,lot,use_code,use_definition,' +
    'property_class_code_definition,year_property_built,number_of_bathrooms,number_of_bedrooms,' +
    'number_of_rooms,number_of_stories,number_of_units,zoning_code,construction_type,lot_depth,' +
    'lot_frontage,property_area,basement_area,lot_area,current_sales_date,assessed_land_value,' +
    'assessed_improvement_value,assessed_fixtures_value,assessed_personal_property_value,' +
    'homeowner_exemption_value,misc_exemption_value,assessor_neighborhood,supervisor_district';
  const yearFloor = String(new Date().getUTCFullYear() - 3);
  const match = `(${clauses.join(' OR ')})`;

  let rows = await getJson<Array<Record<string, unknown>>>(
    soda(SF_ROLL, {
      $where: `closed_roll_year >= '${yearFloor}' AND ${match}`,
      $select: SF_SELECT,
      $limit: '80',
    }),
    'SF secured property tax roll (wv5m-vpq2)',
  );
  if (!rows.length) {
    // Parcel may have dropped off recent rolls (merged, subdivided, exempted).
    rows = await getJson<Array<Record<string, unknown>>>(
      soda(SF_ROLL, { $where: match, $select: SF_SELECT, $limit: '80' }),
      'SF secured property tax roll (wv5m-vpq2, full history)',
    );
  }
  if (!rows.length) return notFound('sf', p, meta, nameVariants, '') as PropertyResult;

  // Keep the newest roll year per parcel (sorted here rather than with $order,
  // which forces the same expensive scan).
  rows.sort((x, y) => String(y.closed_roll_year ?? '').localeCompare(String(x.closed_roll_year ?? '')));
  const byParcel = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const k = str(r.parcel_number) ?? '';
    if (!byParcel.has(k)) byParcel.set(k, r);
  }
  const parcels = [...byParcel.values()];
  let a = parcels[0];
  if (p.unit) {
    const u = p.unit.toUpperCase().replace(/^0+/, '');
    const hit = parcels.find((r) => sfUnit(str(r.property_location)) === u);
    if (hit) a = hit;
  }

  const land = num(a.assessed_land_value) ?? 0;
  const impr = num(a.assessed_improvement_value) ?? 0;
  const fixtures = num(a.assessed_fixtures_value) ?? 0;
  const personal = num(a.assessed_personal_property_value) ?? 0;
  const saleDate = isoDate(a.current_sales_date);

  return {
    covered: true,
    jurisdiction: 'sf',
    jurisdiction_name: meta.name,
    matched_address: `${cleanSfLocation(str(a.property_location))}, San Francisco, CA`,
    parcel_id: str(a.parcel_number),
    parcel_id_type: 'APN (block-lot)',
    owner: null,
    assessed_value: land + impr + fixtures + personal,
    assessed_land_value: land || null,
    assessed_building_value: impr || null,
    land_use: str(a.use_definition),
    building_class: str(a.property_class_code_definition),
    year_built: num(a.year_property_built),
    square_feet: num(a.property_area),
    lot_square_feet: num(a.lot_area),
    bedrooms: num(a.number_of_bedrooms),
    bathrooms: num(a.number_of_bathrooms),
    rooms: num(a.number_of_rooms),
    stories: num(a.number_of_stories),
    units: num(a.number_of_units),
    zoning: str(a.zoning_code),
    neighborhood: str(a.assessor_neighborhood),
    extra: {
      roll_year: str(a.closed_roll_year),
      block: str(a.block),
      lot: str(a.lot),
      assessed_fixtures_value: fixtures || null,
      assessed_personal_property_value: personal || null,
      homeowner_exemption_value: num(a.homeowner_exemption_value),
      misc_exemption_value: num(a.misc_exemption_value),
      basement_area: num(a.basement_area),
      lot_depth: num(a.lot_depth),
      lot_frontage: num(a.lot_frontage),
      construction_type: str(a.construction_type),
      supervisor_district: str(a.supervisor_district),
    },
    sales: saleDate ? [{ date: saleDate, price: null, doc_type: 'most recent transfer (date only — SF publishes no price)' }] : [],
    sales_count: saleDate ? 1 : 0,
    last_sale: saleDate ? { date: saleDate, price: null, doc_type: 'most recent transfer (date only)' } : null,
    other_matches: parcels
      .filter((r) => r !== a)
      .slice(0, 10)
      .map((r) => ({
        address: cleanSfLocation(str(r.property_location)),
        parcel_id: str(r.parcel_number),
        hint: str(r.use_definition),
      })),
    match_count: parcels.length,
    source_name: meta.source_name,
    source_url: SF_ROLL,
    fields_available: { sales_price: false, owner: false, assessment: true, characteristics: true },
    note:
      'Answered by the SF Office of the Assessor-Recorder secured property tax roll. TWO FIELDS DO NOT EXIST IN THIS SOURCE: sale price and owner name. ' +
      'California counties do not publish transfer consideration or owner names in open data, so "how much did it sell for" and "who owns it" cannot be answered for San Francisco from here — ' +
      (saleDate
        ? `only the most recent transfer DATE (${saleDate}) is available. `
        : 'and this parcel has no recorded transfer date either. ') +
      'Do not substitute the assessed value for a sale price: under Proposition 13 the assessed value is the value at last transfer plus a capped annual inflation factor, which for a long-held property is far below market. ' +
      `Assessed figures are from roll year ${str(a.closed_roll_year) ?? 'unknown'}.`,
    address_interpreted: interpreted(p, 'city or ZIP → sf'),
  };
}

/**
 * SF's property_location is a 36-char fixed-width field, not a free-form
 * address: [0..3] prefix, [5..8] house number zero-padded to 4, [10..29] street
 * name padded to 20, [30..31] 2-char street type, [32..35] unit padded to 4.
 * Slice by position — a regex mis-splits when the type or unit block is blank.
 * "0000 1380 GREENWICH           ST0207" → "1380 GREENWICH ST #207".
 */
function sfUnit(loc: string | null): string | null {
  if (!loc || loc.length < 36) return null;
  const u = loc.slice(32, 36).trim().replace(/^0+/, '');
  return u === '' ? null : u;
}

function cleanSfLocation(loc: string | null): string {
  if (!loc) return '';
  if (loc.length < 36) return loc.replace(/\s+/g, ' ').trim();
  const house = loc.slice(5, 9).trim().replace(/^0+/, '') || loc.slice(5, 9).trim();
  const name = loc.slice(10, 30).trim();
  const type = loc.slice(30, 32).trim();
  const unit = sfUnit(loc);
  return `${house} ${name}${type ? ` ${type}` : ''}${unit ? ` #${unit}` : ''}`.trim();
}

// ── Not-found / not-covered shapes ─────────────────────────────────────────

function interpreted(p: ParsedAddress, basis: string) {
  return {
    house_number: p.house_number,
    street: p.street,
    unit: p.unit,
    city: p.city,
    state: p.state,
    zip: p.zip,
    inference_basis: basis,
  };
}

function notFound(
  slug: string,
  p: ParsedAddress,
  meta: JurisdictionMeta,
  variants: string[],
  numPart: string,
): PropertyResult {
  return {
    covered: true,
    jurisdiction: slug,
    jurisdiction_name: meta.name,
    matched_address: '',
    parcel_id: null,
    parcel_id_type: '',
    sales: [],
    sales_count: 0,
    last_sale: null,
    match_count: 0,
    source_name: meta.source_name,
    source_url: meta.source_url,
    fields_available: { sales_price: false, owner: false, assessment: false, characteristics: false },
    note:
      `${meta.name} IS covered, but no property matched this address there. The address was read as house number ` +
      `"${p.house_number ?? '(none)'}" and street "${p.street}"${p.unit ? ` unit "${p.unit}"` : ''}, and searched as: ` +
      `${variants.slice(0, 4).map((v) => `"${numPart}${v}"`).join(', ')}${variants.length > 4 ? ', …' : ''}. ` +
      'Common causes: a typo in the street name; a missing or wrong directional/quadrant (DC needs NW/NE/SW/SE, Chicago needs N/S/E/W); ' +
      'a house number that does not exist on that street; a newly subdivided or condo-converted parcel; or the address really being in a neighbouring jurisdiction. ' +
      'Retry with the full street type spelled out and the directional included, or call property_coverage to confirm the jurisdiction.',
    address_interpreted: interpreted(p, `queried ${slug}`),
  };
}

interface NotCovered {
  covered: false;
  requested_address: string;
  inferred_jurisdiction: string | null;
  inference_basis: string;
  address_interpreted: ReturnType<typeof interpreted>;
  supported_jurisdictions: Array<{ jurisdiction: string; name: string; sale_prices: boolean; owner: boolean }>;
  byok_alternatives: Array<{ pack: string; tool: string; auth_argument: '_apiKey'; answers: string }>;
  note: string;
}

function notCovered(p: ParsedAddress, inf: Inference): NotCovered {
  const where = [p.city, p.state, p.zip].filter(Boolean).join(' ');
  return {
    covered: false,
    requested_address: p.input,
    inferred_jurisdiction: null,
    inference_basis: inf.basis,
    address_interpreted: interpreted(p, inf.basis),
    supported_jurisdictions: COVERAGE.map((j) => ({
      jurisdiction: j.slug,
      name: j.name,
      sale_prices: j.slug !== 'sf',
      owner: j.slug !== 'sf',
    })),
    byok_alternatives: [
      {
        pack: 'attom',
        tool: 'attom_assessment / attom_avm / attom_sales_history',
        auth_argument: '_apiKey',
        answers: 'assessed value and property tax / estimated market value / past sale transactions',
      },
      {
        pack: 'realestateapi',
        tool: 'realestateapi_property_detail',
        auth_argument: '_apiKey',
        answers: 'estimated value, last sale, owner, and property characteristics',
      },
      {
        pack: 'rentcast',
        tool: 'get_property',
        auth_argument: '_apiKey',
        answers: 'nationwide property details and value fields where the vendor has coverage',
      },
      {
        pack: 'batchdata',
        tool: 'batchdata_property_lookup',
        auth_argument: '_apiKey',
        answers: 'nationwide property record lookup by address',
      },
    ],
    note:
      (where
        ? `"${where}" is not one of the jurisdictions this pack covers. `
        : 'The jurisdiction could not be determined from this address — no city, state, or ZIP was present. ') +
      'US property records are maintained county by county and there is no keyless national source, so coverage here is a specific list rather than the whole country. ' +
      `Currently covered: ${COVERAGE_SUMMARY}. ` +
      (where
        ? 'For this address, the county assessor or recorder of deeds for that county is the authoritative source; many publish a free online parcel search. '
        : 'Re-ask with the city and state (e.g. "123 Main St, Philadelphia PA") — or pass the jurisdiction argument explicitly. ') +
      'To query a commercial nationwide source through Pipeworx, call one of byok_alternatives and pass that vendor account key as `_apiKey`; Pipeworx does not currently provide a shared key for those packs. ' +
      'Do not present an answer as if this property were in the keyless dataset.',
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────────

type LookupFn = (p: ParsedAddress, maxSales: number) => Promise<PropertyResult>;

const LOOKUPS: Record<string, LookupFn> = {
  dc: lookupDc,
  nyc: lookupNyc,
  philadelphia: lookupPhiladelphia,
  cook: lookupCook,
  sf: lookupSf,
};

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = num(v);
  if (n === null) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

async function propertyLookup(args: Record<string, unknown>): Promise<unknown> {
  const address = str(args.address);
  if (!address) {
    return {
      error: 'address is required',
      hint: 'Pass a street address as free text, e.g. {"address":"1642 30th St NW, Washington DC"}. Call property_coverage to see which counties and cities are supported.',
      supported_jurisdictions: COVERAGE.map((j) => ({ jurisdiction: j.slug, name: j.name })),
    };
  }
  const maxSales = clampInt(args.max_sales, 20, 1, 50);
  const parsed = parseAddress(address);

  let slug = str(args.jurisdiction)?.toLowerCase() ?? null;
  let basis = 'jurisdiction supplied by caller';
  if (slug) {
    // Accept friendly synonyms for the slug too.
    if (!LOOKUPS[slug]) {
      const alias = COVERAGE.find((j) => j.aliases.includes(slug!));
      if (alias) slug = alias.slug;
    }
    if (!LOOKUPS[slug]) {
      return {
        error: `Unknown jurisdiction "${str(args.jurisdiction)}"`,
        supported_jurisdictions: COVERAGE.map((j) => ({ jurisdiction: j.slug, name: j.name })),
        hint: `Use one of: ${COVERED_SLUGS.join(', ')} — or omit jurisdiction and let it be inferred from the address text.`,
      };
    }
  } else {
    const inf = inferJurisdiction(parsed);
    slug = inf.slug;
    basis = inf.basis;
    if (!slug) return notCovered(parsed, inf);
  }

  try {
    const result = await LOOKUPS[slug](parsed, maxSales);
    if (result && typeof result === 'object' && 'address_interpreted' in result) {
      (result as PropertyResult).address_interpreted.inference_basis = basis;
    }
    return result;
  } catch (err) {
    const meta = COVERAGE.find((j) => j.slug === slug)!;
    return {
      covered: true,
      jurisdiction: slug,
      jurisdiction_name: meta.name,
      error: (err as Error).message,
      source_name: meta.source_name,
      source_url: meta.source_url,
      address_interpreted: interpreted(parsed, basis),
      note: `The ${meta.name} open-data portal did not answer. This is an upstream availability problem, not a statement about the property — retry shortly. Nothing about this address has been established either way.`,
    };
  }
}

function propertyCoverage(args: Record<string, unknown>): unknown {
  const want = str(args.jurisdiction)?.toLowerCase() ?? null;
  let list = COVERAGE;
  if (want) {
    const hit = COVERAGE.filter((j) => j.slug === want || j.aliases.includes(want));
    if (!hit.length) {
      return {
        error: `"${want}" is not a covered jurisdiction`,
        supported_jurisdictions: COVERAGE.map((j) => ({ jurisdiction: j.slug, name: j.name })),
        note:
          'US property records are county-maintained with no keyless national source, so this pack covers a specific list. ' +
          `Covered: ${COVERAGE_SUMMARY}. For anywhere else, the county assessor or recorder of deeds is the authoritative source.`,
      };
    }
    list = hit;
  }

  return {
    jurisdiction_count: COVERAGE.length,
    with_sale_prices: COVERAGE.filter((j) => j.slug !== 'sf').length,
    with_owner_names: COVERAGE.filter((j) => j.slug !== 'sf').length,
    scope_statement:
      'US property records are created and maintained per county, and no keyless national source exists. This pack covers the jurisdictions listed below and nothing else. ' +
      'property_lookup on an address outside this list returns covered:false rather than an empty or invented record.',
    keyless: true,
    auth_required: 'none — every source below is a public open-data endpoint with no API key',
    jurisdictions: list.map((j) => ({
      jurisdiction: j.slug,
      name: j.name,
      provides: {
        sales_history: j.sales_history,
        owner: j.owner,
        assessed_value: j.assessment,
        characteristics: j.characteristics,
      },
      has_sale_prices: j.slug !== 'sf',
      has_owner_names: j.slug !== 'sf',
      parcel_id_type:
        j.slug === 'dc' ? 'SSL (square-suffix-lot)'
        : j.slug === 'nyc' ? 'BBL (borough-block-lot)'
        : j.slug === 'philadelphia' ? 'OPA account number'
        : j.slug === 'cook' ? 'PIN (property index number)'
        : 'APN (block-lot)',
      data_vintage: j.vintage,
      update_cadence: j.cadence,
      caveats: j.caveats ?? null,
      source_name: j.source_name,
      source_url: j.source_url,
      example_address:
        j.slug === 'dc' ? '1642 30th St NW, Washington DC'
        : j.slug === 'nyc' ? '232 East 6th Street, Manhattan NY'
        : j.slug === 'philadelphia' ? '228 Spruce St, Philadelphia PA'
        : j.slug === 'cook' ? '3000 N Sheffield Ave, Chicago IL'
        : '450 Sutter St, San Francisco CA',
    })),
    not_covered_guidance:
      'For any other US county, the county assessor (assessed value, characteristics) and recorder of deeds or clerk (sales history) are authoritative; most run a free parcel search. ' +
      'Pipeworx also has address-level packs for the commercial aggregators (attom, regrid, batchdata, rentcast) but those need your own vendor API key. ' +
      'The zillow pack is market-level only (ZIP, metro, state) and cannot answer questions about a single address.',
  };
}

// ── Export ─────────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'property_lookup':
      return propertyLookup(args);
    case 'property_coverage':
      return propertyCoverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
