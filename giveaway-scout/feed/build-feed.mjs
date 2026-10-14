#!/usr/bin/env node
// Builds giveaway-scout/data/giveaways.json from the RSS/Atom feeds in sources.json.
// Run by .github/workflows/giveaway-feed.yml on a schedule. No dependencies (Node 20+).
//
//   node giveaway-scout/feed/build-feed.mjs                 fetch live feeds
//   node giveaway-scout/feed/build-feed.mjs --fixtures DIR  read <DIR>/<n>.xml instead (for testing)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "data", "giveaways.json");
const MAX_ITEMS = 400;
const MAX_AGE_DAYS = 21;        // drop undated giveaways first seen longer ago than this
const FETCH_TIMEOUT_MS = 20000;

/* ------------------------------------------------------------------ */
/* Classification rules                                                */
/* ------------------------------------------------------------------ */

// Builds a case-insensitive, Unicode-aware whole-word matcher from "a|b|c" terms.
// A trailing * lets a term take any ending ("konzert*" matches "Konzerte", "Konzertkarten");
// a leading * lets it end a German compound ("*tickets" matches "Tagestickets").
// JS's own \b only understands ASCII, so it can't be used next to ä/ö/ü/ß.
export function words(list) {
  const alts = list.split("|").map(t => t.trim()).filter(Boolean)
    .map(t => (t.startsWith("*") ? "\\p{L}*" + t.slice(1) : t))
    .map(t => (t.endsWith("*") ? t.slice(0, -1) + "\\p{L}*" : t));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}
const mapWords = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, words(v)]));

// An item gets its best one or two categories, scored by matches (title counts double).
export const CATEGORIES = mapWords({
  household: "*haushalt*|*maschine|küche*|kaffeevollautomat*|kaffeemaschine*|espressomaschine*|staubsauger*|saugroboter*|thermomix|mixer|waschmaschine*|geschirr*|möbel*|deko*|garten*|gartenmöbel|grill|grills|gasgrill|bettwäsche|matratze*|airfryer|heißluftfritteuse*|kühlschrank*|pfanne*|kochtopf*|töpfe*|household|kitchen*|vacuum|dyson|kitchenaid|wohnzimmer|sofa|lampe*|haushaltsgerät*|küchenmaschine*",
  tech: "steam|game|games|videospiel*|game-?keys?|*kopfhörer|*lautsprecher|smartphone*|handy|handys|iphone*|samsung|galaxy|laptop*|notebook*|tablet*|ipad*|kopfhörer*|headphones?|earbuds|airpods|kamera*|camera*|konsole*|playstation*|ps5|xbox|nintendo|smartwatch*|fernseher*|smart-?tv|oled|lautsprecher*|bluetooth-lautsprecher*|speaker*|gaming*|e-reader|kindle|drohne*|drone*|technik*|gadget*",
  music: "musik*|music|album|alben|vinyl*|schallplatte*|plattenspieler*|signiert*|instrument*|gitarre*|guitar*|klavier*|band|bands|sänger*|sängerin|rapper*|konzert*|concert*|festival*|tour|tournee|musiker*",
  events: "*ticket*|*konzert*|karten|freikarten|eintrittskarten|gästeliste*|konzert*|concert*|festival*|premiere*|vip|stadion*|bundesliga*|musical*|theater*|kino*|kinokarten|messe|show|shows|meet ?(?:&|and|und) ?greet|lesung*|comedy|veranstaltung*|event|events|spiel der|heimspiel*|open-air|openair",
  experiences: "*erlebnis*|*kurs|*workshop*|experience*|kochkurs*|kurs|kurse|workshop*|rundflug*|fallschirm*|wellness*|spa|tasting*|verkostung*|führung*|freizeitpark*|europa-park|phantasialand|therme*|escape-?room*|ballonfahrt*|safari*|abenteuer*|fahrtraining*|segeltörn*|tagesausflug*|ausflug*|zoo",
  stays: "*übernachtung*|*hotel|*hotels|hotel*|kurzurlaub*|wochenendtrip*|wochenende im|ferienwohnung*|ferienhaus*|nächte|auszeit*|resort*|hotelaufenthalt*|aufenthalt|stay|staycation|airbnb|camping*|glamping*|chalet*|wellnesshotel*|wellnesswochenende*",
  travel: "reise*|urlaub*|flug|flüge|kreuzfahrt*|cruise*|trip|trips|rundreise*|travel*|flights?|städtereise*|traumreise*|bahnfahrt*",
  beauty_fashion: "beauty*|kosmetik*|pflegeset*|hautpflege|haarpflege|parfum*|parfüm*|duft|make-?up|skincare|mode|modegutschein*|fashion|sneaker*|schuhe|kleidung|outfit*|handtasche*|schmuck*|armbanduhr*|uhr|uhren|sonnenbrille*",
  food_drink: "wein|weine|weinpaket*|bier|biere|gin|whisky|kaffee|kaffeebohnen|schokolade*|restaurant*|dinner*|abendessen|essen gehen|foodbox*|kochbox*|genuss*|lebensmittel*|feinkost*|food|drinks?|grillpaket*|brunch*|menü*|candle-?light*",
  family: "kinder*|baby*|spielzeug*|lego|playmobil|familie*|familien*|kids|toy|toys|kinderwagen*",
  cash_vouchers: "bargeld|*gutschein*|voucher*|gift ?cards?|geschenkkarte*|einkaufsgutschein*|cash|\\d[\\d.]*\\s?(?:€|euro)|paypal|geld",
  sport: "fahrrad*|e-bike*|ebike*|fitness*|sport*|outdoor*|trikot*|wandern|wanderung*|ski|skipass*|yoga|laufschuhe|fußball*",
  books: "buch|bücher*|hörbuch*|hörbücher|roman|romane|books?|dvd*|blu-?ray*|comic*|lesepaket*",
});

// How you enter. Detected from title + summary; falls back to the source's default.
export const METHODS = mapWords({
  instagram: "instagram*|insta|reel|reels",
  youtube: "youtube*|yt",
  x: "twitter|tweet*|retweet*|x\\.com|auf x",
  facebook: "facebook*|fb",
  tiktok: "tiktok*",
  reddit: "reddit",
  email: "e-?mail*|mail an|per mail|newsletter*",
  postcard: "postkarte*|postcard*|per post|einsenden",
  phone: "anrufen|anruf|hotline|telefon*|sms|whatsapp",
  website: "formular*|teilnahmeformular*|website|webseite|online teilnehmen|hier teilnehmen|gleam|gewinnspielseite|enter (?:here|online|now)|landingpage|online-gewinnspiel",
});

// What you have to do (mostly relevant for social posts).
export const ACTIONS = mapWords({
  comment: "kommentier*|kommentar*|comment*",
  like: "like|likes|liken|liked|gefällt mir",
  follow: "folg*|follow*|abonnier*|abo|subscribe*",
  tag: "markier*|verlink*|tag(?:ge)? (?:a |\\d |your |deine? )?(?:friends?|freund*)|tag \\d",
  share: "teilen|teilt|share*|repost*|retweet*|story",
  answer: "beantworte*|gewinnfrage|frage|quiz*|answer*|lösungswort*|rätsel*",
  form: "formular*|registrier*|anmelden|sign ?up",
});

const GIVEAWAY_WORDS = words("gewinnspiel*|verlos*|zu gewinnen|gewinnen sie|gewinnen|gewinne|gewinnt|giveaway*|give-away*|win|verlosung*|freikarten|preisausschreiben*|sweepstake*");
// News items that mention giveaways without being one. Substring match, so it also catches compounds
// like "Gewinnspielbetrug".
const NOT_GIVEAWAY = /betrug|betrüger|abzocke|warnt|warnung|fake|scam|phishing|polizei|verbraucherzentrale|eurojackpot|lotto|lotterie|glücksspiel|abmahnung|gewinner stehen fest|gewinner wurden|winners? announced/iu;
const NOT_GIVEAWAY_WORDS = words("gericht|gerichts*|urteil*");
const NOT_GERMANY = words("us only|usa only|u\\.s\\. only|us residents|uk only|uk residents|canada only|australia only|nur (?:in |für )?(?:österreich|der schweiz)|open to (?:us|uk|canadian|australian)");
const GERMANY = words("deutschland*|germany|wohnsitz in (?:deutschland|de)|bundesweit|de|eu-weit|eu only|europe|europa*");
const WORLDWIDE = words("worldwide|weltweit|international|ww");

/* ------------------------------------------------------------------ */
/* Feed parsing (minimal RSS 2.0 / Atom)                               */
/* ------------------------------------------------------------------ */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
export function stripHtml(s = "") {
  return decode(decode(s)) // descriptions are often HTML-escaped HTML
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : "";
}
function attr(block, name, attribute) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*/?>`, "i"));
  return m ? decode(m[1]) : "";
}

export function parseFeed(xml) {
  const out = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const isAtom = /^<entry/i.test(b);
    const title = stripHtml(tag(b, "title"));
    const link = isAtom ? (attr(b, "link", "href") || stripHtml(tag(b, "link"))) : stripHtml(tag(b, "link")) || stripHtml(tag(b, "guid"));
    const summary = stripHtml(tag(b, "description") || tag(b, "content:encoded") || tag(b, "summary") || tag(b, "content"));
    const date = stripHtml(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"));
    const publisher = stripHtml(tag(b, "source"));
    const cats = [...b.matchAll(/<category\b[^>]*?(?:term=["']([^"']+)["'][^>]*\/?>|>([\s\S]*?)<\/category>)/gi)]
      .map(m => stripHtml(m[1] || m[2] || ""));
    if (title && link) out.push({ title, link, summary, date, publisher, cats });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Deadline extraction                                                 */
/* ------------------------------------------------------------------ */

const MONTHS = {
  januar: 1, jan: 1, january: 1, februar: 2, feb: 2, february: 2, märz: 3, maerz: 3, mär: 3, march: 3, mar: 3,
  april: 4, apr: 4, mai: 5, may: 5, juni: 6, jun: 6, june: 6, juli: 7, jul: 7, july: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, october: 10, oct: 10, november: 11, nov: 11,
  dezember: 12, dez: 12, december: 12, dec: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const LEAD = "\\b(?:einsendeschluss|teilnahmeschluss|teilnahme bis|endet(?: am)?|läuft bis|bis zum|bis einschließlich|bis|ends?|ending|closes?|deadline|until)";

function iso(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function fixYear(y, m, d, ref) {
  if (y) return y < 100 ? 2000 + y : y;
  // No year given: pick the next occurrence on or after (ref - 60 days).
  const refY = ref.getUTCFullYear();
  const cand = new Date(Date.UTC(refY, m - 1, d));
  return cand < new Date(ref.getTime() - 60 * 864e5) ? refY + 1 : refY;
}

export function findDeadline(text, ref = new Date()) {
  const patterns = [
    // 31.10.2026 / 31.10.26 / 31.10.
    new RegExp(`${LEAD}[:\\s]*(?:dem |den |zum )?(\\d{1,2})\\.\\s?(\\d{1,2})\\.(\\d{2,4})?`, "i"),
    // 31. Oktober 2026 / 31 October
    new RegExp(`${LEAD}[:\\s]*(?:dem |den |zum )?(\\d{1,2})\\.?\\s(${MONTH_RE})\\.?(?:\\s(\\d{4}))?`, "i"),
    // October 31, 2026
    new RegExp(`${LEAD}[:\\s]*(${MONTH_RE})\\.?\\s(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s(\\d{4}))?`, "i"),
  ];
  let m;
  if ((m = text.match(patterns[0]))) {
    const d = +m[1], mo = +m[2];
    return iso(fixYear(m[3] ? +m[3] : 0, mo, d, ref), mo, d);
  }
  if ((m = text.match(patterns[1]))) {
    const d = +m[1], mo = MONTHS[m[2].toLowerCase()];
    return iso(fixYear(m[3] ? +m[3] : 0, mo, d, ref), mo, d);
  }
  if ((m = text.match(patterns[2]))) {
    const mo = MONTHS[m[1].toLowerCase()], d = +m[2];
    return iso(fixYear(m[3] ? +m[3] : 0, mo, d, ref), mo, d);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Normalising one feed item                                           */
/* ------------------------------------------------------------------ */

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return (h >>> 0).toString(36);
}
const normTitle = t => t.toLowerCase().replace(/[^a-z0-9äöüß]+/g, " ").trim();

export function classify(raw, source, now = new Date()) {
  // Google News appends " - Publisher" to titles.
  let title = raw.title;
  let publisher = raw.publisher;
  const dash = title.lastIndexOf(" - ");
  if (!publisher && /news\.google\./.test(source.url) && dash > 20) publisher = title.slice(dash + 3);
  if (/news\.google\./.test(source.url) && dash > 20) title = title.slice(0, dash);

  const summary = raw.summary.replace(publisher || "\u0000", "").trim().slice(0, 400);
  const text = `${title} ${summary} ${raw.cats.join(" ")}`;

  if (!source.trusted && !GIVEAWAY_WORDS.test(text)) return null;
  if (NOT_GIVEAWAY.test(title) || NOT_GIVEAWAY_WORDS.test(title)) return null;
  if (NOT_GERMANY.test(text)) return null;

  const scored = Object.entries(CATEGORIES)
    .map(([k, re]) => [k, (title.match(new RegExp(re.source, re.flags + "g")) || []).length * 2 + (summary.match(new RegExp(re.source, re.flags + "g")) || []).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const categories = scored.slice(0, 2).map(([k]) => k);
  if (!categories.length) categories.push("other");

  const methods = Object.keys(METHODS).filter(k => METHODS[k].test(text));
  if (!methods.length) methods.push(source.defaultMethod || "website");
  const actions = Object.keys(ACTIONS).filter(k => ACTIONS[k].test(text));

  let eligibility = source.region || "unknown";
  if (WORLDWIDE.test(text)) eligibility = "worldwide";
  else if (GERMANY.test(text)) eligibility = "DE";

  const published = raw.date && !isNaN(Date.parse(raw.date)) ? new Date(raw.date).toISOString() : now.toISOString();
  const deadline = findDeadline(text, new Date(published));

  return {
    id: hash(normTitle(title)),
    title,
    url: raw.link,
    source: source.name,
    publisher: publisher || "",
    summary,
    published,
    deadline,
    categories,
    methods,
    actions,
    eligibility,
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "GiveawayScout/1.0 (+https://github.com/spardha93-dot/website; personal RSS reader)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.7",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function merge(previous, fresh, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const byId = new Map();
  for (const it of previous) byId.set(it.id, it);
  for (const it of fresh) {
    const old = byId.get(it.id);
    byId.set(it.id, { ...it, firstSeen: old?.firstSeen || now.toISOString() });
  }
  const cutoff = now.getTime() - MAX_AGE_DAYS * 864e5;
  return [...byId.values()]
    .filter(it => (it.deadline ? it.deadline >= today : Date.parse(it.firstSeen || it.published) >= cutoff))
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, MAX_ITEMS);
}

async function main() {
  const args = process.argv.slice(2);
  const fixtures = args.includes("--fixtures") ? args[args.indexOf("--fixtures") + 1] : null;
  const sources = JSON.parse(await readFile(join(HERE, "sources.json"), "utf8"));
  const now = new Date();

  let previous = [];
  try { previous = JSON.parse(await readFile(OUT, "utf8")).items || []; } catch {}

  const status = [];
  const fresh = [];
  for (const [i, src] of sources.entries()) {
    try {
      const xml = fixtures ? await readFile(join(fixtures, `${i}.xml`), "utf8") : await fetchText(src.url);
      const raw = parseFeed(xml);
      const kept = raw.map(r => classify(r, src, now)).filter(Boolean);
      fresh.push(...kept);
      status.push({ name: src.name, ok: true, fetched: raw.length, kept: kept.length });
      console.log(`✓ ${src.name}: ${kept.length}/${raw.length}`);
    } catch (err) {
      status.push({ name: src.name, ok: false, error: String(err.message || err).slice(0, 120) });
      console.log(`✗ ${src.name}: ${err.message || err}`);
    }
  }

  // Same giveaway reported by several feeds: keep the first (sources are listed by preference).
  const seen = new Set();
  const unique = fresh.filter(it => !seen.has(it.id) && seen.add(it.id));
  const items = merge(previous, unique, now);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: now.toISOString(), sources: status, items }, null, 1) + "\n");
  console.log(`Wrote ${items.length} giveaways to ${OUT}`);

  if (status.every(s => !s.ok)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
