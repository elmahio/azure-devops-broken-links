// --- Node16 polyfill: add Web Streams globals if any lib expects them
try {
  const sw = require("stream/web");
  // @ts-ignore
  if (!global.ReadableStream && sw?.ReadableStream) global.ReadableStream = sw.ReadableStream;
  // @ts-ignore
  if (!global.WritableStream && sw?.WritableStream) global.WritableStream = sw.WritableStream;
  // @ts-ignore
  if (!global.TransformStream && sw?.TransformStream) global.TransformStream = sw.TransformStream;
} catch {}

// --- Imports
import * as tl from "azure-pipelines-task-lib/task";
import fg from "fast-glob";
import axios, { AxiosInstance, AxiosResponse } from "axios";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import * as http from "http";
import * as https from "https";

type Broken = { file: string; url: string; status?: number; error?: string };

function splitList(v?: string): string[] {
  if (!v) return [];
  return v
    .split(/\r?\n|,/)
    .map(s => s.trim())
    .filter(Boolean);
}

function toRegexFromWildcard(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^\\s\"'<>]*");
  return new RegExp("^" + esc + "$", "i");
}

function isAbsoluteHttp(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

function extractLinks(file: string, content: string): string[] {
  const ext = path.extname(file).toLowerCase();
  const links: string[] = [];

  tl.info(`Extracting links from ${file}`);

  // DOM parse for typical HTML-like files
  if (/\.(html?|cshtml|razor|vue|svelte)$/.test(ext)) {
    try {
      const $ = cheerio.load(content, { xmlMode: false });
      const attrs = ["href", "src", "content", "data-href", "data-src"];
      $("*").each((_, el) => {
        for (const a of attrs) {
          const v = ($(el).attr(a) || "").trim();
          if (v) links.push(v);
        }
      });
    } catch (e) {
      tl.info(`Cheerio parse failed for ${file}: ${String(e)}`);
    }
  }

  // Fallback regex: catch http(s) URLs in text
  const regex = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    let u = m[0].replace(/[),.;:!?]+$/, "");
    links.push(u);
  }

  const abs = Array.from(new Set(links.filter(isAbsoluteHttp)));
  tl.info(`  Found ${abs.length} absolute links`);
  return abs;
}

function buildAllowedStatusFn(spec: string): (n: number) => boolean {
  const parts = spec.split(",").map(s => s.trim()).filter(Boolean);
  const ranges: Array<[number, number]> = [];
  for (const p of parts) {
    const m = /^(\d{3})-(\d{3})$/.exec(p);
    if (m) { ranges.push([+m[1], +m[2]]); continue; }
    const s = /^(\d{3})$/.exec(p);
    if (s) { ranges.push([+s[1], +s[1]]); }
  }
  if (ranges.length === 0) ranges.push([200, 299]);
  return (n: number) => ranges.some(([a, b]) => n >= a && n <= b);
}

function createHttpClient(timeoutMs: number): AxiosInstance {
  return axios.create({
    timeout: timeoutMs,
    maxRedirects: 10,
    validateStatus: () => true,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
    headers: { "User-Agent": "BrokenLinksChecker/1.0" }
  });
}

async function checkUrl(
  client: AxiosInstance,
  url: string,
  allowed: (n: number) => boolean
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    tl.info(`Checking: ${url}`);
    let res: AxiosResponse;
    try {
      res = await client.head(url);
    } catch {
      res = await client.get(url);
    }
    tl.info(`  -> ${res.status}`);
    return { ok: allowed(res.status), status: res.status };
  } catch (e: any) {
    const code = e?.code || e?.response?.status || e?.message || "request_error";
    tl.info(`  ERROR ${url}: ${code}`);
    return { ok: false, error: String(code) };
  }
}

async function main() {
  try {
    tl.info("Starting BrokenLinksChecker");

    const includeGlobs = splitList(tl.getInput("includeGlobs", false)) || ["**/*.{html,htm,cshtml,razor,vue,jsx,tsx,svelte,md}"];
    const excludeGlobs = splitList(tl.getInput("excludeFileGlobs", false));
    const ignoreUrlPatterns = splitList(tl.getInput("ignoreUrlPatterns", false));
    const failOnBroken = tl.getBoolInput("failOnBroken", false);
    const concurrency = Math.max(1, parseInt(tl.getInput("concurrency", false) || "16", 10));
    const timeoutMs = Math.max(1, parseInt(tl.getInput("timeoutMs", false) || "10000", 10));
    const allowedStatusSpec = tl.getInput("allowedStatus", false) || "200-299,301,302,307,308";

    tl.info(`includeGlobs: ${includeGlobs.join(", ")}`);
    tl.info(`excludeGlobs: ${excludeGlobs.join(", ")}`);

    const ignoreUrlRegexes = ignoreUrlPatterns.map(toRegexFromWildcard);
    const allowed = buildAllowedStatusFn(allowedStatusSpec);
    const client = createHttpClient(timeoutMs);

    const files = await fg(includeGlobs, { dot: false, ignore: excludeGlobs, onlyFiles: true, followSymbolicLinks: true });
    tl.info(`Files matched: ${files.length}`);

    const allLinks: Array<{ file: string; url: string }> = [];

    for (const f of files) {
      tl.info(`Reading: ${f}`);
      let content: string;
      try { content = fs.readFileSync(f, "utf8"); } catch (e) {
        tl.info(`  Could not read file: ${String(e)}`);
        continue;
      }
      const links = extractLinks(f, content);
      for (const u of links) {
        if (ignoreUrlRegexes.some(r => r.test(u))) {
          tl.info(`  Ignored: ${u}`);
          continue;
        }
        allLinks.push({ file: f, url: u });
      }
    }

    const tasks = Array.from(new Map(allLinks.map(x => [`${x.file}>>${x.url}`, x])).values());
    tl.info(`Total unique links: ${tasks.length}`);

    const broken: Broken[] = [];
    let idx = 0;

    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= tasks.length) break;
        const { file, url } = tasks[i];
        const res = await checkUrl(client, url, allowed);
        if (!res.ok) {
          broken.push({ file, url, status: res.status, error: res.error });
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (broken.length > 0) {
      tl.info(`Broken links: ${broken.length}`);
      for (const b of broken) {
        const rel = path.relative(process.cwd(), b.file) || b.file;
        const msg = `${rel}: ${b.url} -> ${b.status ?? b.error ?? "unknown"}`;
        if (failOnBroken) tl.error(msg); else tl.warning(msg);
      }
      if (failOnBroken) {
        tl.setResult(tl.TaskResult.Failed, `Found ${broken.length} broken link(s).`);
        return;
      }
    }

    tl.setResult(tl.TaskResult.Succeeded, `Checked ${tasks.length} link(s). Broken: ${broken.length}.`);
  } catch (err: any) {
    tl.error(`Task error: ${err?.stack || err}`);
    tl.setResult(tl.TaskResult.Failed, `Task error: ${err?.message || String(err)}`);
  }
}

main();