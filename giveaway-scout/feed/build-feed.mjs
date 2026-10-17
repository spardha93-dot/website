#!/usr/bin/env node
// Builds giveaway-scout/data/giveaways.json from the RSS/Atom feeds in sources.json.
// Run by .github/workflows/giveaway-feed.yml on a schedule. No dependencies (Node 20+).
//
//   node giveaway-scout/feed/build-feed.mjs                 fetch live feeds
//   node giveaway-scout/feed/build-feed.mjs --fixtures DIR  read <DIR>/<n>.xml instead, skip page visits (testing)
//   node giveaway-scout/feed/build-feed.mjs --page URL      show what page enrichment finds for one URL

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "data", "giveaways.json");
const MAX_ITEMS = 400;
const MAX_AGE_DAYS = 21;        // drop undated giveaways first seen longer ago than this
const FETCH_TIMEOUT_MS = 20000;
const PAGE_TIMEOUT_MS = 12000;
const ENRICH_MAX_PER_RUN = 150;  // pages opened per run; the rest wait for the next run
const ENRICH_CONCURRENCY = 4;
const ENRICH_ATTEMPTS = 3;       // give up on a page after this many failed runs
const PAGE_MAX_BYTES = 2_000_000;

/* ------------------------------------------------------------------ */
/* Classification rules                                                */
/* ------------------------------------------------------------------ */

// Builds a case-insensitive, Unicode-aware whole-word matcher from "a|b|c" terms.
// A trailing * lets a term take any ending ("konzert*" matches "Konzerte", "Konzertkarten");
// a leading * lets it end a German compound ("*tickets" matches "Tagestickets").
// JS's own \b only understands ASCII, so it can't be used next to ä/ö/ü/ß.
export function words(list) {
  const src = list
    .replace(/([a-zäöüß])\*/gi, "$1\\p{L}*")          // "konzert*"  -> any ending
    .replace(/(^|\||\(\?:|\()\*/g, "$1\\p{L}*");        // "*tickets"  -> any beginning
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, "iu");
}
const mapWords = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, words(v)]));

// An item gets its best one or two categories, scored by matches (title counts double).
export const CATEGORIES = mapWords({
  household: "*haushalt*|*maschine|küche*|kaffeevollautomat*|kaffeemaschine*|espressomaschine*|staubsauger*|saugroboter*|thermomix|mixer|waschmaschine*|geschirr*|möbel*|deko*|garten*|gartenmöbel|grill|grills|gasgrill|bettwäsche|matratze*|airfryer|heißluftfritteuse*|kühlschrank*|pfanne*|kochtopf*|töpfe*|household|kitchen*|vacuum|dyson|kitchenaid|wohnzimmer|sofa|lampe*|haushaltsgerät*|küchenmaschine*",
  tech: "street fighter|nintendo switch|*spiel für|konsolenspiel*|pc-spiel*|steam|game|games|videospiel*|game-?keys?|*kopfhörer|*lautsprecher|smartphone*|handy|handys|iphone*|samsung|galaxy|laptop*|notebook*|tablet*|ipad*|kopfhörer*|headphones?|earbuds|airpods|kamera*|camera*|konsole*|playstation*|ps5|xbox|nintendo|smartwatch*|fernseher*|smart-?tv|oled|lautsprecher*|bluetooth-lautsprecher*|speaker*|gaming*|e-reader|kindle|drohne*|drone*|technik*|gadget*",
  music: "schlager*|*konzert*|chor|orchester*|musikverein*|oper|jazz*|rock|pop|music|album|alben|vinyl*|schallplatte*|plattenspieler*|signiert*|instrument*|gitarre*|guitar*|klavier*|band|bands|sänger*|sängerin|rapper*|konzert*|concert*|festival*|tour|tournee|musiker*",
  events: "kinotickets|*karten|kino|ball|maturaball|jubiläumskonzert|show|comedy*|kabarett*|*tickets|*ticket*|*konzert*|karten|freikarten|eintrittskarten|gästeliste*|konzert*|concert*|festival*|premiere*|vip|stadion*|bundesliga*|musical*|theater*|kino*|kinokarten|messe|show|shows|meet ?(?:&|and|und) ?greet|lesung*|comedy|veranstaltung*|event|events|spiel der|heimspiel*|open-air|openair",
  experiences: "*erlebnis*|*kurs|*workshop*|experience*|kochkurs*|kurs|kurse|workshop*|rundflug*|fallschirm*|wellness*|spa|tasting*|verkostung*|führung*|freizeitpark*|europa-park|phantasialand|therme*|escape-?room*|ballonfahrt*|safari*|abenteuer*|fahrtraining*|segeltörn*|tagesausflug*|ausflug*|zoo",
  stays: "*übernachtung*|*hotel|*hotels|hotel*|kurzurlaub*|wochenendtrip*|wochenende im|ferienwohnung*|ferienhaus*|nächte|auszeit*|resort*|hotelaufenthalt*|aufenthalt|stay|staycation|airbnb|camping*|glamping*|chalet*|wellnesshotel*|wellnesswochenende*",
  travel: "reise*|urlaub*|flug|flüge|kreuzfahrt*|cruise*|trip|trips|rundreise*|travel*|flights?|städtereise*|traumreise*|bahnfahrt*",
  beauty_fashion: "beauty*|kosmetik*|pflegeset*|hautpflege|haarpflege|parfum*|parfüm*|duft|make-?up|skincare|mode|modegutschein*|fashion|sneaker*|schuhe|kleidung|outfit*|handtasche*|schmuck*|armbanduhr*|uhr|uhren|sonnenbrille*",
  food_drink: "*gewürz*|gewürze|milka|*schokolade*|süßigkeit*|snack*|*tafeln|spirits|cocktail*|wein|weine|weinpaket*|bier|biere|gin|whisky|kaffee|kaffeebohnen|schokolade*|restaurant*|dinner*|abendessen|essen gehen|foodbox*|kochbox*|genuss*|lebensmittel*|feinkost*|food|drinks?|grillpaket*|brunch*|menü*|candle-?light*",
  family: "kinder*|baby*|spielzeug*|lego|playmobil|familie*|familien*|kids|toy|toys|kinderwagen*",
  cash_vouchers: "bargeld|*gutschein*|voucher*|gift ?cards?|geschenkkarte*|einkaufsgutschein*|cash|\\d[\\d.]*\\s?(?:€|euro)|paypal|geld",
  sport: "*lampe|stirnlampe*|handball*|eishockey*|basketball*|grizzlys|*trikot*|fahrrad*|e-bike*|ebike*|fitness*|sport*|outdoor*|trikot*|wandern|wanderung*|ski|skipass*|yoga|laufschuhe|fußball*",
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
  // Entering by email, not just an "E-Mail-Adresse" field in a form.
  email: "(?:e-?)?mail an|per (?:e-?)?mail|e-?mail mit (?:dem )?(?:betreff|stichwort|kennwort)|schick\\p{L}* (?:uns |eine |ihre |deine )*e-?mail|schreib\\p{L}* (?:uns |eine |einfach )*e-?mail|betreff",
  postcard: "postkarte*|postcard*|per post|einsenden",
  phone: "anrufen|ruf\\p{L}* (?:\\p{L}+ ){0,3}an|gewinnhotline|hotline|telefonisch|per sms|sms mit|whatsapp an|unter der (?:rufnummer|telefonnummer|nummer)",
  website: "formular*|teilnahmeformular*|website|webseite|online teilnehmen|hier teilnehmen|gleam|gewinnspielseite|enter (?:here|online|now)|landingpage|online-gewinnspiel",
});

// What you have to do (mostly relevant for social posts).
export const ACTIONS = mapWords({
  comment: "kommentier*|kommentar*|comment*",
  like: "like|likes|liken|liked|gefällt mir",
  // "folgende" (the following) is not a follow.
  follow: "folge|folgt|folgst|folgen sie|folgen|folgt uns|follow*|abonnier*|abonnent*|subscribe*",
  // Tagging people, not "mit * markierte Felder".
  tag: "(?:markier|verlink)\\p{L}* (?:\\p{L}+ ){0,3}(?:freund\\p{L}*|person\\p{L}*|jemand\\p{L}*|begleit\\p{L}*|liebsten|\\d)|tag(?:ge)? (?:a |\\d |your |deine? )?(?:friends?|freund*)|tag \\d",
  share: "teilen|teilt|share*|repost*|retweet*|story",
  answer: "beantworte*|gewinnfrage|frage|quiz*|answer*|lösungswort*|rätsel*",
  form: "formular*|registrier*|anmelden|sign ?up",
});

// Strong words are enough on their own; a bare "gewinnen" also needs a prize hint, since news uses it for
// sports and stocks ("Die Adler wollen gewinnen").
const GIVEAWAY_WORDS = words("gewinnspiel*|*gewinnspiel*|verlos*|*verlosung*|zu gewinnen|gewinnen sie|freikarten|preisausschreiben*|giveaway*|give-away*|sweepstake*");
const WEAK_GIVEAWAY_WORDS = words("gewinnen|gewinne|gewinnt|win");
const PRIZE_HINT = words("\\d+ ?x ?\\d*|tickets?|karten|mitmachen|teilnehmen|gutschein*|preis|preise|abos?");
// News items that mention giveaways without being one. Substring match, so it also catches compounds
// like "Gewinnspielbetrug".
const NOT_GIVEAWAY = /aktie|börse|dax-|umsatz|quartal|betrug|betrüger|abzocke|warnt|warnung|fake|scam|phishing|polizei|verbraucherzentrale|eurojackpot|lotto|lotterie|glücksspiel|abmahnung|gewinner stehen fest|gewinner wurden|winners? announced/iu;
const NOT_GIVEAWAY_WORDS = words("gericht|gerichts*|urteil*|gewann|gewannen|gewinner|gewinnerin*|mit gewinnen|kurs");
const REGION_TAG = /[{[(](?:us|usa|uk|ca|can|au|aus|nz|in|ph|us\s*\/\s*ca|us\s*&\s*ca)(?:\s*only)?[}\])]/i;
const NOT_GERMANY = words("\\d+ ?\\$|\\$ ?\\d+|usd|us only|usa only|u\\.s\\. only|us residents|uk only|uk residents|canada only|australia only|nur (?:in |für )?(?:österreich|der schweiz)|open to (?:us|uk|canadian|australian)");
// Local events in Austria/Switzerland (a Vienna concert is no use from Germany). A hotel stay there is fine.
const AT_CH_PLACES = words("österreich*|wien|wiener|graz|linz|salzburg|innsbruck|klagenfurt|kärnten|tirol|vorarlberg|steiermark|oberösterreich|niederösterreich|burgenland|schweiz|zürich|basel|bern|luzern");
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
    .replace(/\u00ad/g, "") // soft hyphens split words like "ge\u00adwin\u00adnen"
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
    const publisherUrl = attr(b, "source", "url");
    const cats = [...b.matchAll(/<category\b[^>]*?(?:term=["']([^"']+)["'][^>]*\/?>|>([\s\S]*?)<\/category>)/gi)]
      .map(m => stripHtml(m[1] || m[2] || ""));
    if (title && link) out.push({ title, link, summary, date, publisher, publisherUrl, cats });
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
    new RegExp(`${LEAD}[^\\d\\n]{0,25}?(\\d{1,2})\\.\\s?(\\d{1,2})\\.(\\d{2,4})?`, "i"),
    // 31. Oktober 2026 / 31 October
    new RegExp(`${LEAD}[^\\d\\n]{0,25}?(\\d{1,2})\\.?\\s(${MONTH_RE})\\.?(?:\\s(\\d{4}))?`, "i"),
    // October 31, 2026
    new RegExp(`${LEAD}[:\\s]*(${MONTH_RE})\\.?\\s(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s(\\d{4}))?`, "i"),
  ];
  let m;
  // Reddit-style "(9/30/2025)" or "{13/8/25}": month/day unless the first number can't be a month.
  if ((m = text.match(/[({[]\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*[)}\]]/))) {
    let a = +m[1], b = +m[2];
    const [mo, d] = a > 12 ? [b, a] : [a, b];
    return iso(fixYear(+m[3], mo, d, ref), mo, d);
  }
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
const hostOf = u => { try { return new URL(u).hostname; } catch { return ""; } };
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

  if (!source.trusted && !GIVEAWAY_WORDS.test(text) && !(WEAK_GIVEAWAY_WORDS.test(text) && PRIZE_HINT.test(text))) return null;
  if (NOT_GIVEAWAY.test(title) || NOT_GIVEAWAY_WORDS.test(title)) return null;
  if (NOT_GERMANY.test(text) || REGION_TAG.test(title)) return null;
  // Publishers on .at/.ch domains run giveaways for their own readers.
  if (/\.(at|ch)$/i.test(hostOf(raw.publisherUrl))) return null;

  const scored = Object.entries(CATEGORIES)
    .map(([k, re]) => [k, (title.match(new RegExp(re.source, re.flags + "g")) || []).length * 2 + (summary.match(new RegExp(re.source, re.flags + "g")) || []).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const categories = scored.slice(0, 2).map(([k]) => k);
  if (!categories.length) categories.push("other");

  if (categories.some(c => c === "events" || c === "experiences") && AT_CH_PLACES.test(text)) return null;

  const methodsFromFeed = Object.keys(METHODS).filter(k => METHODS[k].test(text));
  const methods = methodsFromFeed.length ? methodsFromFeed.slice() : [source.defaultMethod || "website"];
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
    methodsFromFeed,
    actions,
    eligibility,
  };
}

/* ------------------------------------------------------------------ */
/* Page enrichment: open each giveaway's page and read how to enter    */
/* ------------------------------------------------------------------ */

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
// Pages behind logins or bot walls; the feed text is all we get for these.
const NO_FETCH_HOSTS = /(^|\.)(instagram\.com|facebook\.com|x\.com|twitter\.com|tiktok\.com|reddit\.com|youtube\.com|youtu\.be)$/i;
const PARTICIPATION = words("gewinnspiel*|*gewinnspiel*|verlos*|*verlosung*|teilnahme*|teilnehmen|nehmen sie teil|nimm teil|mitmachen|einsendeschluss|teilnahmeschluss|zu gewinnen|giveaway*|kommentier*|markier*");
const ENDED = /(gewinnspiel|verlosung|aktion|teilnahme(?:zeitraum)?)\s+ist\s+(?:bereits\s+|leider\s+)*(beendet|abgelaufen|vorbei|geschlossen|abgeschlossen)|gewinner(?:innen)?\s+(?:wurden|wurde|stehen|sind)\s+(?:bereits\s+)?(ermittelt|gezogen|fest|benachrichtigt|informiert)|keine teilnahme mehr möglich/i;
const NOT_DE_RESIDENTS = /wohnsitz\s+in\s+(österreich|der schweiz)|nur\s+für\s+(personen|teilnehmer\w*)\s+(aus|mit wohnsitz in)\s+(österreich|der schweiz)/i;
const BLOCK_TAGS = /<\/?(?:p|div|li|ul|ol|h[1-6]|br|tr|td|section|article|blockquote|figure|figcaption|dd|dt)\b[^>]*>/gi;

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": "de-DE,de;q=0.9,en;q=0.6" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (type && !/html/i.test(type)) throw new Error(`not HTML (${type})`);
    const buf = new Uint8Array(await res.arrayBuffer()).slice(0, PAGE_MAX_BYTES);
    let charset = (type.match(/charset=["']?([\w-]+)/i) || [])[1];
    if (!charset) charset = (new TextDecoder("latin1").decode(buf.slice(0, 4096)).match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
    let html;
    try { html = new TextDecoder(charset || "utf-8").decode(buf); } catch { html = new TextDecoder().decode(buf); }
    return { html, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

// Google News RSS links point at news.google.com, not the article. Older ids embed the URL;
// newer ones ("AU_yqL…") have to be exchanged through Google's own decoding endpoint.
// Google refuses bursts, so its requests go one at a time with a pause in between.
// Once Google answers 429 it stays blocked for a while: stop asking and leave the rest for the next run.
let googleGate = Promise.resolve();
let googleBlocked = false;
const GOOGLE_MAX_PER_RUN = 80;
let googleCalls = 0;
function viaGoogle(fn) {
  const run = googleGate.then(async () => {
    if (googleBlocked || googleCalls >= GOOGLE_MAX_PER_RUN) throw Object.assign(new Error("Google rate limit, retry next run"), { later: true });
    googleCalls++;
    try {
      return await fn();
    } catch (err) {
      if (/HTTP 429/.test(err.message)) {
        googleBlocked = true;
        err.later = true;
      }
      throw err;
    }
  });
  googleGate = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, 1200)));
  return run;
}

export async function resolveGoogleNews(url) {
  const m = url.match(/news\.google\.com\/(?:rss\/)?articles\/([^?#]+)/);
  if (!m) return url;
  const id = m[1];
  try {
    const raw = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const direct = raw.match(/https?:\/\/[\x21-\x7e]+/);
    if (direct && !raw.includes("AU_yqL")) return direct[0];
  } catch {}
  return viaGoogle(() => decodeGoogleId(id));
}

async function decodeGoogleId(id) {
  const { html } = await fetchPage(`https://news.google.com/articles/${id}?hl=de&gl=DE&ceid=DE:de`);
  const sig = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sig || !ts) throw new Error("Google News: no signature");
  const payload = ["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "DE:de", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sig];
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", JSON.stringify(payload), null, "generic"]]]));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST", signal: ctrl.signal, body,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": BROWSER_UA },
    });
    if (!res.ok) throw new Error(`Google News: HTTP ${res.status}`);
    const text = await res.text();
    const outer = JSON.parse(text.split("\n\n")[1]);
    const decoded = JSON.parse(outer[0][2])[1];
    if (!/^https?:\/\//.test(decoded)) throw new Error("Google News: no URL");
    return decoded;
  } finally {
    clearTimeout(timer);
  }
}

// Pulls the participation instructions out of an article page. Share bars and "follow us" link lists
// are short fragments, so only blocks of real sentences are kept, and only those near giveaway words.
export function readGiveawayPage(html) {
  let body = html
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const scoped = body.match(/<article\b[\s\S]*<\/article>/i) || body.match(/<main\b[\s\S]*<\/main>/i);
  if (scoped) body = scoped[0];

  const hasForm = /<form\b(?![^>]*(?:search|suche|newsletter|login))[^>]*>[\s\S]*?<(?:input|textarea)\b(?![^>]*type=["']?(?:hidden|search|submit|button)\b)[\s\S]*?<\/form>/i.test(body);
  const mailto = /href=["']mailto:[^"']*(gewinn|verlos|teilnahme)/i.test(body);

  const deadlineLine = new RegExp(LEAD, "i");
  const blocks = body.split(BLOCK_TAGS).map(b => stripHtml(b))
    .filter(b => b.split(/\s+/).length >= 6 || (deadlineLine.test(b) && /\d/.test(b)));
  const text = blocks.join("\n");
  const keep = new Set();
  const re = new RegExp(PARTICIPATION.source, "giu");
  for (const m of text.matchAll(re)) {
    // Keep the block with the hit plus its neighbours.
    const idx = text.slice(0, m.index).split("\n").length - 1;
    for (let i = Math.max(0, idx - 1); i <= Math.min(blocks.length - 1, idx + 3); i++) keep.add(i);
  }
  const relevant = [...keep].sort((a, b) => a - b).map(i => blocks[i]).join("\n");
  return { text: relevant, hasForm, mailto, ended: ENDED.test(relevant) };
}

// Returns fields to merge into the item, { drop: reason } to discard it, or throws on fetch failure.
export async function enrich(item) {
  let url = item.url;
  if (/news\.google\.com/.test(url)) url = await resolveGoogleNews(url);
  const host = hostOf(url);
  if (/\.(at|ch)$/i.test(host)) return { drop: "Austrian/Swiss site" };
  if (NO_FETCH_HOSTS.test(host)) return { url };

  const { html, finalUrl } = await fetchPage(url);
  const page = readGiveawayPage(html);
  if (/\.(at|ch)$/i.test(hostOf(finalUrl))) return { drop: "Austrian/Swiss site" };
  if (page.ended) return { drop: "giveaway has ended" };
  if (NOT_GERMANY.test(page.text) || NOT_DE_RESIDENTS.test(page.text)) return { drop: "not open to Germany" };

  const found = Object.keys(METHODS).filter(k => METHODS[k].test(page.text));
  if (page.hasForm && !found.includes("website")) found.push("website");
  if (page.mailto && !found.includes("email")) found.push("email");
  const actions = Object.keys(ACTIONS).filter(k => ACTIONS[k].test(page.text));
  if (page.hasForm && !actions.includes("form")) actions.push("form");

  return {
    url: finalUrl,
    pageMethods: found,
    pageActions: actions,
    pageDeadline: findDeadline(page.text, new Date(item.published)),
  };
}

function applyEnrichment(item, e) {
  const out = { ...item, url: e.url || item.url, enriched: true };
  if (e.pageMethods?.length) {
    // The feed's "website" was only a fallback guess; trust what the page says.
    const fromFeed = item.methods.filter(m => m !== "website" || item.methodsFromFeed?.includes("website"));
    out.methods = [...new Set([...e.pageMethods, ...fromFeed])];
  }
  if (e.pageActions?.length) out.actions = [...new Set([...item.actions, ...e.pageActions])];
  if (!out.deadline && e.pageDeadline) out.deadline = e.pageDeadline;
  return out;
}

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; await fn(list[k], k); }
  }));
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
  if (args.includes("--page")) {
    const url = args[args.indexOf("--page") + 1];
    const resolved = /news\.google\.com/.test(url) ? await resolveGoogleNews(url) : url;
    const { html } = await fetchPage(resolved);
    console.log(resolved, "\n", readGiveawayPage(html), "\n", await enrich({ url: resolved, published: new Date().toISOString() }));
    return;
  }
  const sources = JSON.parse(await readFile(join(HERE, "sources.json"), "utf8"));
  const now = new Date();

  let previous = [];
  let droppedBefore = [];
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8"));
    previous = prev.items || [];
    droppedBefore = prev.dropped || [];
  } catch {}

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
  const dropped = new Set(droppedBefore);
  const seen = new Set();
  const prevById = new Map(previous.map(it => [it.id, it]));
  const unique = fresh
    .filter(it => !seen.has(it.id) && seen.add(it.id) && !dropped.has(it.id))
    .map(it => {
      // Already visited on an earlier run: reuse what we found.
      const old = prevById.get(it.id);
      if (old?.enriched) return { ...it, url: old.url, methods: old.methods, actions: old.actions, deadline: it.deadline || old.deadline, enriched: true };
      return { ...it, attempts: old?.attempts || 0 };
    });

  // Visit pages of giveaways we haven't read yet.
  if (!fixtures) {
    const queue = unique.filter(it => !it.enriched && it.attempts < ENRICH_ATTEMPTS)
      .sort((a, b) => /news\.google/.test(a.url) - /news\.google/.test(b.url))
      .slice(0, ENRICH_MAX_PER_RUN);
    const tally = { read: 0, dropped: 0, failed: 0, later: 0 };
    await pool(queue, ENRICH_CONCURRENCY, async it => {
      try {
        const e = await enrich(it);
        if (e.drop) { dropped.add(it.id); tally.dropped++; console.log(`  – dropped (${e.drop}): ${it.title.slice(0, 70)}`); return; }
        Object.assign(it, applyEnrichment(it, e));
        tally.read++;
      } catch (err) {
        if (err.later) { tally.later++; return; } // not this page's fault; try again next run
        it.attempts++;
        tally.failed++;
        console.log(`  ! ${String(err.message || err).slice(0, 60)}: ${it.url.slice(0, 80)}`);
      }
    });
    console.log(`Pages: ${tally.read} read, ${tally.dropped} dropped, ${tally.failed} failed, ${tally.later} left for next run (${queue.length} queued)`);
    status.push({ name: "Giveaway pages", ok: true, fetched: queue.length, kept: tally.read });
  }

  const items = merge(previous.filter(it => !dropped.has(it.id)), unique.filter(it => !dropped.has(it.id)), now)
    .map(({ methodsFromFeed, ...it }) => it);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: now.toISOString(), sources: status, items, dropped: [...dropped].slice(-2000) }, null, 1) + "\n");
  console.log(`Wrote ${items.length} giveaways to ${OUT}`);

  if (status.filter(s => s.name !== "Giveaway pages").every(s => !s.ok)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
