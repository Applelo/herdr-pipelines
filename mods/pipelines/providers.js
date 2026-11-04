import { readTextFile } from "herdr";

export const BUSY = new Set(["running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"]);

export function parseRemote(url) {
  const u = url.trim();
  const m = /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(u)
    ?? /^(?:ssh:\/\/)?[^@\s/]+@([^:/\s]+)(?::\d+(?=\/))?[:/](.+?)(?:\.git)?\/?$/.exec(u);
  if (!m || m[1] === "codeberg.org") return null;
  const kind = m[1] === "github.com" ? "github" : m[1] === "bitbucket.org" ? "bitbucket" : "gitlab";
  return { kind, host: m[1], path: m[2].replace(/^\/+/, "") };
}

function base64(text) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? abc[n & 63] : "=");
  }
  return out;
}

async function call(url, headers, host) {
  let res;
  try { res = await fetch(url, { headers: { ...headers, Accept: "application/json" } }); }
  catch { throw Object.assign(new Error(`Cannot reach ${host}`), { offline: true }); }
  const fail = (message) => Object.assign(new Error(message), { status: res.status });
  if (res.status === 401) throw fail("The token was refused (401)");
  if (res.status === 429 || (res.status === 403 && /rate limit/i.test(await res.text().catch(() => "")))) throw fail(`${host} rate limit reached, retrying later`);
  if (res.status === 403 || res.status === 404) throw fail(`No access to this repo (${res.status})`);
  if (!res.ok) throw fail(`${host} answered ${res.status}`);
  return res.json();
}

const RANK = { production: 0, staging: 1, testing: 2, development: 3, other: 4 };
const MAX_ENVS = 6;
export const byTier = (a, b) => (RANK[a.tier] ?? 5) - (RANK[b.tier] ?? 5) || a.env.localeCompare(b.env);

// One row per branch: the highest-tier environment deploying it (envs come sorted by tier), then the
// build of each branch the repo's spaces are on that no environment row shows.
export function buildRows(envs, branches = []) {
  const rows = [];
  for (const e of envs) if (!rows.some((r) => r.ref === e.ref)) rows.push({ role: e.env, ref: e.ref, env: e.env, url: e.url ?? null });
  for (const ref of branches) if (!rows.some((r) => r.ref === ref)) rows.push({ role: "branch", ref, env: null, url: null, branch: true });
  return rows;
}


const encodeRef = (ref) => ref.split("/").map(encodeURIComponent).join("/");

export const gitlab = {
  icon: "gitlab.svg",
  web: (p) => `https://${p.host}/${p.path}/-/pipelines`,
  branch: (p, ref) => `https://${p.host}/${p.path}/-/tree/${encodeRef(ref)}`,
  help: "A fine-grained personal access token with Project read access to Pipeline, Environment and Deployment (or a legacy one with read_api)",
  // `permission`: the fine-grained token permission the call needs, named in the 403 message.
  async api(p, path, token, permission) {
    try { return await call(`https://${p.host}/api/v4/projects/${encodeURIComponent(p.path)}${path}`, { "PRIVATE-TOKEN": token }, p.host); }
    catch (e) {
      if (e.status === 403 && permission && !/rate limit/.test(e.message)) e.message = `The token can't read ${permission.toLowerCase()}s here: give it ${permission}: Read on this project`;
      throw e;
    }
  },
  async defaultBranch(p, token) {
    return (await this.api(p, "", token)).default_branch;
  },
  async latest(p, ref, token) {
    const x = (await this.api(p, `/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`, token, "Pipeline"))[0];
    return x ? { id: String(x.id), status: x.status, web_url: x.web_url, updated_at: x.updated_at } : null;
  },
  // Every available environment but review apps (`review/<branch>`), each with the branch of its
  // latest successful deployment; environments never deployed are left out.
  async envs(p, token) {
    const list = (await this.api(p, "/environments?states=available&per_page=100", token, "Environment")).filter((e) => !e.name.includes("/"));
    const found = await Promise.all(list.slice(0, 20).map(async (e) => {
      const d = (await this.api(p, `/deployments?environment=${encodeURIComponent(e.name)}&status=success&order_by=id&sort=desc&per_page=1`, token, "Deployment")
        .catch((err) => { if (err.status === 403) throw err; return []; }))[0];
      return d && { env: e.name, tier: e.tier, ref: d.ref, url: e.external_url || d.environment?.external_url || null, id: d.id };
    }));
    // An old environment left available beside its replacement (prod and production, same tier and
    // branch) shows once: the one deployed last.
    const latest = new Map();
    for (const f of found.filter(Boolean)) {
      const key = `${f.tier}@${f.ref}`;
      if (!latest.has(key) || f.id > latest.get(key).id) latest.set(key, f);
    }
    return [...latest.values()].sort(byTier).slice(0, MAX_ENVS);
  },
};

function bitbucketState(s) {
  const result = s?.result?.name, stage = s?.stage?.name;
  switch (s?.name) {
    case "COMPLETED":
      return result === "SUCCESSFUL" ? "success" : result === "FAILED" || result === "ERROR" ? "failed" : result === "STOPPED" || result === "EXPIRED" ? "canceled" : (result ?? "completed").toLowerCase();
    case "IN_PROGRESS": return stage === "PAUSED" || stage === "HALTED" ? "manual" : "running";
    case "PENDING": case "PARSING": return "pending";
    default: return (s?.name ?? "unknown").toLowerCase();
  }
}

const envTier = (name) => /pre-?prod|stag|recette|uat|qa/i.test(name) ? "staging" : /prod/i.test(name) ? "production" : /test/i.test(name) ? "testing" : /dev/i.test(name) ? "development" : "other";

// `pipelines: branches: <branch>: ... deployment: <env>` in bitbucket-pipelines.yml, through anchors
// (`- step: *deploy`) too. Glob branch keys are skipped: they name no single branch.
export function bitbucketDeployments(yaml) {
  const lines = yaml.split(/\r?\n/), indent = (l) => l.length - l.trimStart().length;
  const blank = (l) => !l.trim() || l.trim().startsWith("#");
  const blockEnd = (i) => { let j = i + 1; while (j < lines.length && (blank(lines[j]) || indent(lines[j]) > indent(lines[i]))) j++; return j; };
  const deploymentsIn = (from, to) => {
    const out = [];
    for (let j = from; j < to; j++) {
      const m = /deployment:\s*['"]?([\w.-]+)/.exec(lines[j]);
      if (m) out.push(m[1]);
      const ref = /\*([\w-]+)/.exec(lines[j]);
      if (ref && anchors[ref[1]]) out.push(...anchors[ref[1]]);
    }
    return out;
  };
  const anchors = {};
  lines.forEach((l, i) => { const a = /&([\w-]+)/.exec(l); if (a) anchors[a[1]] = deploymentsIn(i + 1, blockEnd(i)).concat(/deployment:\s*['"]?([\w.-]+)/.exec(l)?.[1] ?? []); });
  const found = [];
  const b = lines.findIndex((l) => /^\s*branches:\s*$/.test(l));
  if (b < 0) return found;
  const end = blockEnd(b);
  let child = null;
  for (let i = b + 1; i < end; i++) {
    if (blank(lines[i])) continue;
    child ??= indent(lines[i]);
    if (indent(lines[i]) !== child) continue;
    const key = /^\s*['"]?([^'":]+?)['"]?\s*:/.exec(lines[i])?.[1];
    if (!key || /[*?{},[\]]/.test(key)) continue;
    for (const env of deploymentsIn(i + 1, blockEnd(i)))
      if (!found.some((f) => f.env === env)) found.push({ env, tier: envTier(env), ref: key, url: null });
  }
  return found.sort(byTier).slice(0, MAX_ENVS);
}

export const bitbucket = {
  icon: "bitbucket.svg",
  web: (p) => `https://bitbucket.org/${p.path}/pipelines`,
  branch: (p, ref) => `https://bitbucket.org/${p.path}/branch/${encodeRef(ref)}`,
  help: "A repository or workspace access token with the pipeline read scope, or an Atlassian API token with your email",
  headers: (token) => typeof token === "object"
    ? { Authorization: `Basic ${base64(`${token.email ?? token.user}:${token.token}`)}` }
    : { Authorization: `Bearer ${token}` },
  async latest(p, ref, token) {
    const repo = p.path.split("/").map(encodeURIComponent).join("/");
    const page = await call(`https://api.bitbucket.org/2.0/repositories/${repo}/pipelines?target.branch=${encodeURIComponent(ref)}&sort=-created_on&pagelen=1`, this.headers(token), "api.bitbucket.org");
    const x = page.values?.[0];
    return x ? { id: x.uuid, status: bitbucketState(x.state), web_url: `https://bitbucket.org/${p.path}/pipelines/results/${x.build_number}`, updated_at: x.completed_on || x.created_on } : null;
  },
  async defaultBranch(p, token) {
    const repo = p.path.split("/").map(encodeURIComponent).join("/");
    return (await call(`https://api.bitbucket.org/2.0/repositories/${repo}`, this.headers(token), "api.bitbucket.org")).mainbranch?.name;
  },
  async envs(p) {
    const yaml = p.root ? await readTextFile(`${p.root}/bitbucket-pipelines.yml`, { on: p.machine }).catch(() => null) : null;
    return yaml ? bitbucketDeployments(yaml) : [];
  },
};

// A push starts one run per workflow: the commit's status is its worst run.
const WORST = ["failed", "running", "manual", "pending", "canceled", "success", "skipped"];

export function githubState(run) {
  switch (run.status) {
    case "completed": break;
    case "in_progress": return "running";
    case "waiting": return "manual";
    default: return "pending";
  }
  switch (run.conclusion) {
    case "success": case "neutral": return "success";
    case "failure": case "timed_out": case "startup_failure": return "failed";
    case "cancelled": case "stale": return "canceled";
    case "action_required": return "manual";
    default: return run.conclusion ?? "completed";
  }
}

export function githubLatest(runs) {
  const sha = runs[0]?.head_sha;
  if (!sha) return null;
  const mine = runs.filter((r) => r.head_sha === sha).map((r) => ({ r, status: githubState(r) }));
  const rank = (s) => WORST.includes(s) ? WORST.indexOf(s) : 3;
  const worst = mine.reduce((a, b) => rank(b.status) < rank(a.status) ? b : a);
  const updated = mine.map(({ r }) => r.updated_at).sort().pop();
  return { id: sha, status: worst.status, busy: mine.some(({ status }) => BUSY.has(status)), web_url: worst.r.html_url, updated_at: updated };
}

export const github = {
  icon: "github.svg",
  web: (p) => `https://github.com/${p.path}/actions`,
  branch: (p, ref) => `https://github.com/${p.path}/tree/${encodeRef(ref)}`,
  help: "A fine-grained personal access token with read access to Actions and Deployments (or a classic one with the repo scope)",
  async api(p, path, token, permission) {
    const repo = p.path.split("/").map(encodeURIComponent).join("/");
    const headers = { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "herdr-pipelines" };
    try { return await call(`https://api.github.com/repos/${repo}${path}`, headers, "api.github.com"); }
    catch (e) {
      if (e.status === 403 && permission && !/rate limit/.test(e.message)) e.message = `The token can't read ${permission.toLowerCase()} here: give it ${permission}: Read on this repo`;
      throw e;
    }
  },
  async defaultBranch(p, token) {
    return (await this.api(p, "", token)).default_branch;
  },
  async latest(p, ref, token) {
    const page = await this.api(p, `/actions/runs?branch=${encodeURIComponent(ref)}&per_page=20`, token, "Actions");
    return githubLatest(page.workflow_runs ?? []);
  },
  // The latest deployment of each environment, newest first from the API. Transient ones (previews)
  // and deployments of a bare commit name no branch, so they're left out.
  async envs(p, token) {
    const list = await this.api(p, "/deployments?per_page=100", token, "Deployments");
    const latest = new Map();
    for (const d of list) {
      if (latest.has(d.environment) || d.transient_environment || /^[0-9a-f]{40}$/.test(d.ref)) continue;
      latest.set(d.environment, { env: d.environment, tier: d.production_environment ? "production" : envTier(d.environment), ref: d.ref, id: d.id });
    }
    const envs = [...latest.values()].sort(byTier).slice(0, MAX_ENVS);
    return Promise.all(envs.map(async ({ id, ...e }) => {
      const s = (await this.api(p, `/deployments/${id}/statuses?per_page=1`, token).catch(() => []))[0];
      return { ...e, url: s?.environment_url || null };
    }));
  },
};

export const PROVIDERS = { gitlab, bitbucket, github };
