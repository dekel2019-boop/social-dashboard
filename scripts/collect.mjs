// Collects today's TikTok + Facebook stats and upserts them into data/history.json.
// Secrets come from environment variables only: APIFY_TOKEN, FB_PAGE_ID, FB_PAGE_TOKEN.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const FILE = fileURLToPath(new URL('../data/history.json', import.meta.url));
const TIKTOK_USER = process.env.TIKTOK_USER || 'tiny_hamlazot';
const { APIFY_TOKEN, FB_PAGE_ID, FB_PAGE_TOKEN } = process.env;
const GRAPH = 'https://graph.facebook.com/v21.0';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

const num = (v) => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? n : null;
};
const sum = (arr, pick) => arr.reduce((s, x) => s + (num(pick(x)) ?? 0), 0);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

async function getJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = body?.error?.message || body?.error?.type || text;
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${String(detail).slice(0, 200)}`);
  }
  return body;
}

async function collectTikTok() {
  const items = await getJson(
    'https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items?timeout=240',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${APIFY_TOKEN}` },
      body: JSON.stringify({
        profiles: [TIKTOK_USER],
        resultsPerPage: 100,
        profileScrapeSections: ['videos'],
        profileSorting: 'latest',
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
      }),
      signal: AbortSignal.timeout(280000),
    },
  );
  const vids = (Array.isArray(items) ? items : []).filter((x) => x && x.authorMeta);
  if (!vids.length) throw new Error('Apify returned no TikTok data');
  const m = vids[0].authorMeta;
  return clean({
    followers: num(m.fans),
    following: num(m.following),
    likes: num(m.heart),
    videos: num(m.video) ?? vids.length,
    views: sum(vids, (x) => x.playCount),
    comments: sum(vids, (x) => x.commentCount),
    shares: sum(vids, (x) => x.shareCount),
    saves: sum(vids, (x) => x.collectCount),
  });
}

async function collectFacebook() {
  const headers = { Authorization: `Bearer ${FB_PAGE_TOKEN}` };
  const page = await getJson(`${GRAPH}/${FB_PAGE_ID}?fields=name,followers_count,fan_count`, { headers });
  const out = { followers: num(page.followers_count), fans: num(page.fan_count) };

  // Daily insights are best effort: Meta renames/retires metrics, so a failure here only drops that metric.
  const metrics = {
    reach: 'page_total_media_view_unique',
    views: 'page_media_view',
    engagement: 'page_post_engagements',
  };
  for (const [key, metric] of Object.entries(metrics)) {
    try {
      const r = await getJson(`${GRAPH}/${FB_PAGE_ID}/insights?metric=${metric}&period=day`, { headers });
      const values = (r?.data?.[0]?.values ?? []).map((v) => num(v.value)).filter((v) => v !== null);
      if (values.length) out[key] = values[values.length - 1];
    } catch (e) {
      console.warn(`facebook insight ${metric} skipped: ${e.message}`);
    }
  }

  try {
    const p = await getJson(
      `${GRAPH}/${FB_PAGE_ID}/published_posts?fields=reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares&limit=25`,
      { headers },
    );
    const posts = p?.data ?? [];
    out.posts = posts.length;
    out.post_reactions = sum(posts, (x) => x.reactions?.summary?.total_count);
    out.post_comments = sum(posts, (x) => x.comments?.summary?.total_count);
    out.post_shares = sum(posts, (x) => x.shares?.count);
  } catch (e) {
    console.warn(`facebook posts skipped: ${e.message}`);
  }
  return clean(out);
}

const history = JSON.parse(await readFile(FILE, 'utf8').catch(() => '[]'));
let record = history.find((r) => r.date === today);
const isNew = !record;
if (isNew) record = { date: today };

const jobs = [
  ['tiktok', APIFY_TOKEN, collectTikTok],
  ['facebook', FB_PAGE_ID && FB_PAGE_TOKEN, collectFacebook],
];
let failed = false;
for (const [name, enabled, collect] of jobs) {
  if (!enabled) {
    console.log(`Skipping ${name}: secret not set`);
    continue;
  }
  try {
    record[name] = { ...(await collect()), updated_at: new Date().toISOString() };
    console.log(`${name}: ok`);
  } catch (e) {
    failed = true;
    console.error(`${name} failed: ${e.message}`);
  }
}

if (isNew && Object.keys(record).length > 1) history.push(record);
history.sort((a, b) => a.date.localeCompare(b.date));
await mkdir(dirname(FILE), { recursive: true });
await writeFile(FILE, JSON.stringify(history, null, 1) + '\n');
if (failed) process.exitCode = 1;
