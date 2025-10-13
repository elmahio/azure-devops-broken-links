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

// Use newline-only splitting to support YAML block scalars (|) without breaking brace globs.
function splitGlobs(input?: string): string[] {
  if (!input) return [];
  return input.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function toRegexFromWildcard(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
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

  tl.warning(`Extracting links from ${file}`);

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
      tl.warning(`Cheerio parse failed for ${file}: ${String(e)}`);
    }
  }

  // Fallback regex: catch http(s) URLs in text
  const regex = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    // remove common trailing punctuation or escaped quotes
    let u = m[0].replace(/\\["']$/, "").replace(/[),.;:!?]+$/, "");
    links.push(u);
  }

  const abs = Array.from(new Set(links.filter(isAbsoluteHttp)));
  tl.warning(`  Found ${abs.length} absolute links`);
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
    tl.warning(`Checking: ${url}`);
    let res: AxiosResponse;
    try {
      res = await client.head(url);
    } catch {
      res = await client.get(url);
    }
    tl.warning(`  -> ${res.status}`);
    return { ok: allowed(res.status), status: res.status };
  } catch (e: any) {
    const code = e?.code || e?.response?.status || e?.message || "request_error";
    tl.warning(`  ERROR ${url}: ${code}`);
    return { ok: false, error: String(code) };
  }
}

async function main() {
  try {
    tl.warning("Starting BrokenLinksChecker");

    // Determine workspace root for globbing
    const repoRoot = tl.getVariable("Build.SourcesDirectory") || process.cwd();

    // Read inputs and support YAML multi-line lists
    const includeInput = tl.getInput("includeGlobs", false);
    let includeGlobs = splitGlobs(includeInput);
    if (includeGlobs.length === 0) {
      // Fallback without brace-globs to avoid comma pitfalls
      includeGlobs = [
        "**/*.html",
        "**/*.htm",
        "**/*.cshtml",
        "**/*.razor",
        "**/*.vue",
        "**/*.jsx",
        "**/*.tsx",
        "**/*.svelte",
        "**/*.md"
      ];
    }

    const excludeGlobs = splitGlobs(tl.getInput("excludeFileGlobs", false));
    const ignoreUrlPatterns = splitGlobs(tl.getInput("ignoreUrlPatterns", false));
    const failOnBroken = tl.getBoolInput("failOnBroken", false);
    const concurrency = Math.max(1, parseInt(tl.getInput("concurrency", false) || "16", 10));
    const timeoutMs = Math.max(1, parseInt(tl.getInput("timeoutMs", false) || "10000", 10));
    const allowedStatusSpec = tl.getInput("allowedStatus", false) || "200-299,301,302,307,308";

    tl.warning(`repoRoot: ${repoRoot}`);
    tl.warning(`includeGlobs(final): ${includeGlobs.join(" | ")}`);
    tl.warning(`excludeGlobs(final): ${excludeGlobs.join(" | ")}`);

    const ignoreUrlRegexes = ignoreUrlPatterns.map(toRegexFromWildcard);
    const allowed = buildAllowedStatusFn(allowedStatusSpec);
    const client = createHttpClient(timeoutMs);

    // Use repoRoot as cwd so ** globs resolve within source tree
    const files = await fg(includeGlobs, {
      cwd: repoRoot,
      dot: false,
      ignore: excludeGlobs,
      onlyFiles: true,
      followSymbolicLinks: true,
      absolute: true
    });
    tl.warning(`Files matched: ${files.length}`);

    // --- Collect references: URL -> set of files
    const urlToFiles = new Map<string, Set<string>>();

    for (const f of files) {
      tl.warning(`Reading: ${f}`);
      let content: string;
      try { content = fs.readFileSync(f, "utf8"); } catch (e) {
        tl.warning(`  Could not read file: ${String(e)}`);
        continue;
      }
      const links = extractLinks(f, content);
      for (const u of links) {
        if (ignoreUrlRegexes.some(r => r.test(u))) {
          tl.warning(`  Ignored: ${u}`);
          continue;
        }
        if (!urlToFiles.has(u)) urlToFiles.set(u, new Set<string>());
        urlToFiles.get(u)!.add(f);
      }
    }

    const uniqueUrls = Array.from(urlToFiles.keys());
    tl.warning(`Unique URLs to check: ${uniqueUrls.length}`);

    type CheckResult = { status?: number; error?: string };
    const brokenByUrl = new Map<string, CheckResult>();

    // --- Check each unique URL once
    let idx = 0;
    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= uniqueUrls.length) break;
        const url = uniqueUrls[i];
        const res = await checkUrl(client, url, allowed);
        if (!res.ok) brokenByUrl.set(url, { status: res.status, error: res.error });
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // --- Reporting: one entry per broken URL, listing all source files
    if (brokenByUrl.size > 0) {
      tl.warning(`Broken links: ${brokenByUrl.size}`);
      for (const [url, info] of brokenByUrl.entries()) {
        const filesRef = Array.from(urlToFiles.get(url) || []);
        const rels = filesRef.map(f => path.relative(process.cwd(), f) || f);
        const header = `${url} -> ${info.status ?? info.error ?? "unknown"}`;
        const list = rels.map(r => `  - ${r}`).join("\n");
        const msg = `${header}\nreferenced by:\n${list}`;
        if (failOnBroken) tl.error(msg); else tl.warning(msg);
      }
      if (failOnBroken) {
        tl.setResult(tl.TaskResult.Failed, `Found ${brokenByUrl.size} broken unique URL(s).`);
        return;
      }
    }

    tl.setResult(tl.TaskResult.Succeeded, `Checked ${uniqueUrls.length} unique URL(s). Broken: ${brokenByUrl.size}.`);
  } catch (err: any) {
    tl.error(`Task error: ${err?.stack || err}`);
    tl.setResult(tl.TaskResult.Failed, `Task error: ${err?.message || String(err)}`);
  }
}

main();