import * as tl from "azure-pipelines-task-lib/task";
import fg from "fast-glob";
import micromatch from "micromatch";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";

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
    } catch {
      // fallback to regex below
    }
  }

  const regex = /https?:\/\/[^\s"'<>)]+/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) links.push(m[0]);

  return Array.from(new Set(links.filter(isAbsoluteHttp)));
}

async function checkUrl(
  url: string,
  timeoutMs: number,
  allowed: (n: number) => boolean
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const client = axios.create({ maxRedirects: 10, timeout: timeoutMs, validateStatus: () => true });
  try {
    let res = await client.head(url);
    if (res.status === 405 || res.status === 501) {
      res = await client.get(url);
    }
    return { ok: allowed(res.status), status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.code || e?.message || "request_error" };
  }
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
  return (n: number) => ranges.some(([a, b]) => n >= a && n <= b);
}

async function main() {
  try {
    const includeGlobs = splitList(tl.getInput("includeGlobs", false)) || ["**/*.{html,htm,cshtml,razor,vue,jsx,tsx,svelte,md}"];
    const excludeGlobs = splitList(tl.getInput("excludeFileGlobs", false));
    const ignoreUrlPatterns = splitList(tl.getInput("ignoreUrlPatterns", false));
    const failOnBroken = tl.getBoolInput("failOnBroken", false);
    const concurrency = parseInt(tl.getInput("concurrency", false) || "16", 10);
    const timeoutMs = parseInt(tl.getInput("timeoutMs", false) || "10000", 10);
    const allowedStatusSpec = tl.getInput("allowedStatus", false) || "200-299,301,302,307,308";

    const ignoreUrlRegexes = ignoreUrlPatterns.map(toRegexFromWildcard);
    const allowed = buildAllowedStatusFn(allowedStatusSpec);

    const files = await fg(includeGlobs, { dot: false, ignore: excludeGlobs, onlyFiles: true, followSymbolicLinks: true });
    tl.debug(`Files matched: ${files.length}`);

    const allLinks: Array<{ file: string; url: string }> = [];

    for (const f of files) {
      let content: string;
      try { content = fs.readFileSync(f, "utf8"); } catch { continue; }
      const links = extractLinks(f, content);
      for (const u of links) {
        if (ignoreUrlRegexes.some(r => r.test(u))) continue;
        allLinks.push({ file: f, url: u });
      }
    }

    const tasks = Array.from(new Map(allLinks.map(x => [`${x.file}>>${x.url}`, x])).values());

    tl.debug(`Links to check: ${tasks.length}`);

    const broken: Broken[] = [];
    let idx = 0;

    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= tasks.length) break;
        const { file, url } = tasks[i];
        const res = await checkUrl(url, timeoutMs, allowed);
        if (!res.ok) {
          broken.push({ file, url, status: res.status, error: res.error });
        }
      }
    }

    const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
    await Promise.all(workers);

    if (broken.length > 0) {
      for (const b of broken) {
        const msg = `${b.file}: ${b.url} -> ${b.status ?? b.error ?? "unknown"}`;
        if (failOnBroken) tl.error(msg); else tl.warning(msg);
      }
      tl.debug(`Broken count: ${broken.length}`);
      if (failOnBroken) {
        tl.setResult(tl.TaskResult.Failed, `Found ${broken.length} broken link(s).`);
        return;
      }
    }

    tl.setResult(tl.TaskResult.Succeeded, `Checked ${tasks.length} link(s). Broken: ${broken.length}.`);
  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, `Task error: ${err?.message || String(err)}`);
  }
}

main();
