import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemote, buildRows, bitbucketDeployments, bitbucket, gitlab, github, githubLatest } from "../mods/pipelines/providers.js";

test("parseRemote reads ssh, https and ssh:// remotes", () => {
  assert.deepEqual(parseRemote("git@gitlab.example.com:group/sub/repo.git\n"), { kind: "gitlab", host: "gitlab.example.com", path: "group/sub/repo" });
  assert.deepEqual(parseRemote("https://u@bitbucket.org/ws/repo.git"), { kind: "bitbucket", host: "bitbucket.org", path: "ws/repo" });
  assert.deepEqual(parseRemote("ssh://git@git.co:2222/a/b.git"), { kind: "gitlab", host: "git.co", path: "a/b" });
});

test("parseRemote reads GitHub remotes and skips Codeberg", () => {
  assert.deepEqual(parseRemote("git@github.com:a/b.git"), { kind: "github", host: "github.com", path: "a/b" });
  assert.deepEqual(parseRemote("https://github.com/a/b"), { kind: "github", host: "github.com", path: "a/b" });
  assert.equal(parseRemote("https://codeberg.org/a/b"), null);
});

test("buildRows hard-codes no branch, and adds the spaces' branches not shown yet", () => {
  assert.deepEqual(buildRows([], ["develop", "feat/x"]).map((r) => [r.role, r.ref]), [["branch", "develop"], ["branch", "feat/x"]]);
  const fallback = [{ env: "default", ref: "develop" }];
  assert.deepEqual(buildRows(fallback, ["develop", "feat/x"]).map((r) => [r.role, r.ref]), [["default", "develop"], ["branch", "feat/x"]]);
  const shared = [{ env: "production", ref: "master" }, { env: "staging", ref: "develop" }, { env: "dev", ref: "develop" }];
  assert.deepEqual(buildRows(shared, ["develop"]).map((r) => [r.role, r.ref]), [["production", "master"], ["staging", "develop"]]);
  const envs = [{ env: "production", ref: "main", url: "https://x.io" }];
  assert.deepEqual(buildRows(envs, ["main"]).map((r) => [r.role, r.ref, r.url]), [["production", "main", "https://x.io"]]);
});

test("bitbucketDeployments follows anchors and skips glob branches", () => {
  const yaml = `definitions:
  steps:
    - step: &deploy-prod
        deployment: production
        script:
          - curl "https://x.io/hook?a=1&b=2"
pipelines:
  branches:
    master:
      - step: *deploy-prod
    develop:
      - step:
          deployment: recette
          script:
            - rm -rf dist/* && echo ok
      - step:
          deployment: dev
    'release/*':
      - step:
          deployment: preprod
`;
  assert.deepEqual(bitbucketDeployments(yaml).map((e) => [e.env, e.tier, e.ref]), [
    ["production", "production", "master"],
    ["recette", "staging", "develop"],
    ["dev", "development", "develop"],
  ]);
});

test("bitbucket uses Basic auth with an email, Bearer without", () => {
  assert.equal(bitbucket.headers("tok").Authorization, "Bearer tok");
  assert.equal(bitbucket.headers({ email: "é@x.io", token: "t" }).Authorization, `Basic ${Buffer.from("é@x.io:t").toString("base64")}`);
});

test("branch links open the branch on its host", () => {
  assert.equal(gitlab.branch({ host: "gitlab.example.com", path: "g/repo" }, "feat/a b"), "https://gitlab.example.com/g/repo/-/tree/feat/a%20b");
  assert.equal(bitbucket.branch({ host: "bitbucket.org", path: "ws/repo" }, "release/1.0"), "https://bitbucket.org/ws/repo/branch/release/1.0");
  assert.equal(github.branch({ host: "github.com", path: "o/repo" }, "feat/x"), "https://github.com/o/repo/tree/feat/x");
});

test("githubLatest shows the worst run of the newest commit", () => {
  const run = (head_sha, status, conclusion, n) => ({ head_sha, status, conclusion, html_url: `u${n}`, updated_at: `2026-01-0${n}T00:00:00Z` });
  assert.equal(githubLatest([]), null);
  assert.deepEqual(githubLatest([run("b", "completed", "success", 3), run("b", "completed", "failure", 2), run("a", "in_progress", null, 1)]),
    { id: "b", status: "failed", busy: false, web_url: "u2", updated_at: "2026-01-03T00:00:00Z" });
  assert.equal(githubLatest([run("b", "completed", "success", 2), run("b", "queued", null, 1)]).status, "pending");
  assert.equal(githubLatest([run("b", "completed", "skipped", 2), run("b", "completed", "success", 1)]).status, "success");
  assert.equal(githubLatest([run("b", "waiting", null, 1)]).status, "manual");
  const failing = githubLatest([run("b", "completed", "failure", 2), run("b", "in_progress", null, 1)]);
  assert.equal(failing.status, "failed");
  assert.equal(failing.busy, true);
});

test("github envs keep each environment's latest branch deployment", async (t) => {
  const deployments = [
    { id: 4, environment: "preview", ref: "feat/x", transient_environment: true },
    { id: 3, environment: "production", ref: "main", production_environment: true },
    { id: 2, environment: "staging", ref: "develop" },
    { id: 1, environment: "production", ref: "old" },
    { id: 0, environment: "github-pages", ref: "0123456789abcdef0123456789abcdef01234567" },
  ];
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    assert.equal(opts.headers.Authorization, "Bearer tok");
    const body = url.endsWith("/deployments?per_page=100") ? deployments
      : url.includes("/deployments/3/") ? [{ environment_url: "https://x.io" }] : [];
    return { status: 200, ok: true, json: async () => body };
  });
  assert.deepEqual(await github.envs({ host: "github.com", path: "o/r" }, "tok"), [
    { env: "production", tier: "production", ref: "main", url: "https://x.io" },
    { env: "staging", tier: "staging", ref: "develop", url: null },
  ]);
});

test("each host reads its default branch", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const body = url === "https://gitlab.example.com/api/v4/projects/g%2Fr" ? { default_branch: "develop" }
      : url === "https://api.bitbucket.org/2.0/repositories/ws/r" ? { mainbranch: { name: "master" } }
      : url === "https://api.github.com/repos/o/r" ? { default_branch: "main" } : null;
    return { status: 200, ok: true, json: async () => body };
  });
  assert.equal(await gitlab.defaultBranch({ host: "gitlab.example.com", path: "g/r" }, "tok"), "develop");
  assert.equal(await bitbucket.defaultBranch({ host: "bitbucket.org", path: "ws/r" }, "tok"), "master");
  assert.equal(await github.defaultBranch({ host: "github.com", path: "o/r" }, "tok"), "main");
});

test("a rate-limited GitLab 403 isn't reported as a missing permission", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ status: 403, ok: false, text: async () => "Rate limit exceeded" }));
  await assert.rejects(gitlab.latest({ host: "gitlab.example.com", path: "g/r" }, "main", "tok"), /rate limit reached/);
});
