// CI pipelines (GitLab, Bitbucket, GitHub Actions) of the repos open in your spaces: prod, preprod and each space's branch.
// One mod, three roles: the status bar button (props.button), the popup it opens, and a docked panel.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { spaces, panes, exec, readTextFile, writeTextFile, appHome, theme, settings, window, notify, nextCommand, shared, setShared, openOverlay, closeOverlay, props } from "herdr";
import { BUSY, PROVIDERS, parseRemote, buildRows } from "./providers.js";

const MOD = "mods/pipelines";
const DATA = "pipelines.data", SCOPE = "pipelines.scope", NOTIFY = "pipelines.notify", POPUP = "pipelines.popup", ANCHOR = "pipelines.anchor", OWNER = "pipelines.button";
const CONFIG = () => `${appHome()}/${MOD}/settings.json`;
const IDLE_MS = 60000, BUSY_MS = 15000, ENV_MS = 300000, LEASE_MS = 60000;
// The popup can't be resized once open, so one height fits every view and filter; the content scrolls.
const POPUP_WIDTH = 380, POPUP_HEIGHT = 520, FADE = 12;

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function spaceFolder(space) {
  const tabs = new Set(space.tabs.map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.terminal && p.cwd)?.cwd || space.folder || null;
}

function look(status, t) {
  switch (status) {
    case "success": return { color: t.ansi2, label: "passed" };
    case "failed": return { color: t.ansi1, label: "failed" };
    case "running": return { color: t.ansi4, label: "running", spin: true };
    case "manual": return { color: t.ansi5, label: "manual" };
    case "canceled": case "skipped": return { color: t.dim, label: status };
    case undefined: case null: return { color: t.dim, label: "no pipeline" };
    default: return { color: t.ansi3, label: status.replace(/_/g, " ") };
  }
}

// URLs come from CI config: only open web links, and never through `cmd`, which would run `&…` in them.
function openUrl(url) {
  if (!/^https?:\/\//i.test(url ?? "")) return;
  const p = window().platform;
  const [cmd, args] = p === "macos" ? ["open", [url]] : p === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  exec(cmd, args).catch(() => {});
}

// `busy` on a pipeline: GitHub shows a commit's worst run, which can fail while another still runs.
const running = (pipeline) => Boolean(pipeline) && (BUSY.has(pipeline.status) || Boolean(pipeline.busy));

const data = () => shared(DATA) ?? { projects: [], missing: [], at: 0 };
const scope = () => shared(SCOPE) === "space" ? "space" : "all";
// Project ids whose pipeline toasts are on; every project starts off.
const notified = () => shared(NOTIFY) ?? [];

function visible(only = scope()) {
  const active = spaces().find((s) => s.active)?.id;
  const list = (data().projects ?? []).filter((p) => p.error !== "token" && (only === "all" || p.spaces.includes(active)));
  return list.map((p) => ({ ...p, active: p.spaces.includes(active) })).sort((a, b) => Number(b.active) - Number(a.active));
}

export default class Pipelines extends View {
  init(_initial, cx) {
    const own = props() ?? {};
    this.role = own.button ? "button" : own.popup ? "popup" : "panel";
    this.envTokens = null;
    this.tick(cx);
    cx.timer.every(BUSY_MS, (cx) => this.tick(cx));
    // After a reload the old copy still answers one command; only the newest button acts.
    if (this.role === "button") { this.owner = `${Date.now()}-${Math.random()}`; setShared(OWNER, this.owner); }
    if (this.role === "popup") setShared(POPUP, own.overlay);
    if (this.role === "popup" && own.view === "tokens") this.openTokens(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        cx.notify();
        if (this.role === "button" && shared(OWNER) !== this.owner) return;
        if (c === "refresh") this.refresh(cx, true);
        if (c === "open" && this.role === "button") this.togglePopup();
        if (c === "tokens" && this.role === "button") { if (shared(POPUP)) this.togglePopup(); this.togglePopup("tokens"); }
      }
    });
  }

  async close() {
    if (this.role === "popup" && shared(POPUP) === props()?.overlay) setShared(POPUP, null);
    // A copy closed mid-refresh hands its lease back instead of blocking the others for a minute.
    if (this.busy) setShared(DATA, { ...data(), refreshing: null });
  }

  // Not the live cwd: a `cd` would refetch everything. A terminal moved to another repo shows at the next tick.
  key() {
    return JSON.stringify(spaces().map((s) => [s.id, s.machine, s.folder, s.branch]));
  }

  tick(cx) {
    const d = data(), busy = (d.projects ?? []).some((p) => p.offline || p.rows.some((r) => running(r.p)));
    if (Date.now() - (d.at ?? 0) >= (busy ? BUSY_MS : IDLE_MS)) this.refresh(cx);
  }

  // Every copy may refresh; `refreshing` in the shared data is the lease that keeps it to one at a time.
  // `forced` is "wanted" until a refresh takes it, then "running": every copy gets the refresh
  // command, and only a request made while no forced refresh runs needs another pass.
  refresh(cx, force = false) {
    if (force && data().forced !== "running") setShared(DATA, { ...data(), forced: "wanted" });
    const before = data();
    if (before.refreshing && Date.now() - before.refreshing < LEASE_MS) return;
    this.busy = true;
    const key = this.key();
    setShared(DATA, { ...before, refreshing: Date.now(), forced: before.forced ? "running" : false });
    cx.spawn(async (cx) => {
      let next = before;
      try { next = await this.collect(before); }
      catch (e) { console.log(`pipelines: ${e}`); }
      finally {
        this.busy = false;
        const again = data().forced === "wanted";
        setShared(DATA, { ...next, key, at: Date.now(), refreshing: null, forced: again && "wanted" });
        cx.notify();
        if (again) this.refresh(cx);
      }
    });
  }

  // GITLAB_TOKEN goes to GITLAB_HOST (gitlab.com by default) only, never to whatever host a remote names.
  async readEnvTokens() {
    const r = await exec("sh", ["-c", 'printf "%s\\n%s\\n%s\\n%s" "${GITLAB_HOST:-gitlab.com}" "${GITLAB_TOKEN:-$GITLAB_PRIVATE_TOKEN}" "$BITBUCKET_TOKEN" "${GH_TOKEN:-$GITHUB_TOKEN}"']).catch(() => null);
    const [glHost = "", gl = "", bb = "", gh = ""] = (r?.stdout ?? "").split("\n").map((s) => s.trim());
    const tokens = {};
    if (gl) tokens[glHost.replace(/^https?:\/\//, "").replace(/\/.*$/, "")] = { name: "GITLAB_TOKEN", token: gl };
    if (bb) tokens["bitbucket.org"] = { name: "BITBUCKET_TOKEN", token: bb };
    if (gh) tokens["github.com"] = { name: "GITHUB_TOKEN", token: gh };
    else {
      const cli = await exec("gh", ["auth", "token", "--hostname", "github.com"]).catch(() => null);
      if (cli?.code === 0 && cli.stdout.trim()) tokens["github.com"] = { name: "gh auth", token: cli.stdout.trim() };
    }
    return tokens;
  }

  async collect(before) {
    const text = await readTextFile(CONFIG()).catch(() => null);
    let config = null, configError = null;
    try { config = text ? JSON.parse(text) : null; } catch (e) { configError = `${CONFIG()}: ${e.message}`; }
    if (text !== null && !this.locked) { this.locked = true; await exec("chmod", ["600", CONFIG()]).catch(() => {}); }
    this.envTokens ??= await this.readEnvTokens();
    const projects = await this.findProjects();
    const missing = new Map(), envCache = { old: before.forced ? {} : before.envCache ?? {}, next: {} };
    await Promise.all(projects.map((p) => this.fill(p, config, missing, envCache, before.projects?.find((b) => b.id === p.id))));
    for (const p of projects) this.announce(p, before.projects?.find((b) => b.id === p.id));
    const saved = Object.keys(config?.tokens ?? {}).filter((h) => config.tokens[h]);
    const env = Object.fromEntries(Object.entries(this.envTokens).map(([host, v]) => [host, v.name]));
    return { projects, missing: [...missing.values()], configError, saved, env, envCache: envCache.next };
  }

  async findProjects() {
    const found = await Promise.all(spaces().map(async (space) => {
      const cwd = spaceFolder(space), on = space.machine;
      const r = cwd ? await exec("git", ["remote", "get-url", "origin"], { cwd, on }).catch(() => null) : null;
      const remote = r?.code === 0 ? parseRemote(r.stdout) : null;
      if (!remote) return { space };
      const git = (args) => exec("git", args, { cwd, on }).then((x) => x.code === 0 ? x.stdout.trim() : null, () => null);
      // `origin/HEAD` names the default branch locally, with no token permission (GitLab's needs Project: Read).
      const [root, head] = await Promise.all([git(["rev-parse", "--show-toplevel"]), git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])]);
      return { space, remote, root, defaultBranch: head?.replace(/^origin\//, "") || null };
    }));
    const byId = new Map();
    for (const { space, remote, root, defaultBranch } of found) {
      if (!remote) continue;
      const id = `${remote.host}/${remote.path}`;
      if (!byId.has(id)) byId.set(id, { id, ...remote, machine: space.machine, root, defaultBranch, spaces: [], branches: [] });
      const project = byId.get(id);
      project.spaces.push(space.id);
      if (space.branch && !project.branches.includes(space.branch)) project.branches.push(space.branch);
    }
    return [...byId.values()];
  }

  // `envCache.old` is the last refresh's environments by project id (empty when forced), `next` this one's.
  async fill(project, config, missing, envCache, prev) {
    const provider = PROVIDERS[project.kind];
    project.web = provider.web(project);
    project.rows = [];
    project.offline = false;
    const token = config?.tokens?.[project.host] || this.envTokens[project.host]?.token;
    if (!token) { project.error = "token"; missing.set(project.host, { host: project.host, kind: project.kind }); return; }
    const cached = envCache.old[project.id];
    if (cached) envCache.next[project.id] = cached;
    let envs = cached && Date.now() - cached.at < ENV_MS ? cached.envs : null;
    if (!envs) {
      try {
        envs = await provider.envs(project, token);
        // No environment declared: the repo's default branch, from the clone, else from the host.
        if (!envs.length) {
          const ref = project.defaultBranch || await provider.defaultBranch(project, token).catch((e) => { if (e.offline) throw e; return null; });
          if (ref) envs = [{ env: "default", tier: "other", ref, url: null }];
        }
        envCache.next[project.id] = { at: Date.now(), envs };
      } catch (e) {
        if (e.offline) return this.offline(project, prev, e);
        if (e.status === 403) project.note = e.message;
        envs = cached?.envs ?? [];
      }
    }
    project.rows = buildRows(envs, project.branches);
    try {
      await Promise.all(project.rows.map(async (r) => { r.p = await provider.latest(project, r.ref, token); }));
      project.error = null;
    } catch (e) {
      if (e.offline) return this.offline(project, prev, e);
      project.error = e.message;
    }
  }

  // Unreachable host (asleep, Wi-Fi not back yet): keep the last results and retry at the busy pace.
  offline(project, prev, e) {
    project.offline = true;
    project.note = prev?.note ?? null;
    project.rows = prev?.rows?.length ? prev.rows : [];
    project.error = project.rows.length ? null : e.message;
  }

  announce(project, before) {
    if (!notified().includes(project.id)) return;
    for (const row of project.rows) {
      const was = before?.rows?.find((r) => r.role === row.role && r.ref === row.ref)?.p, now = row.p;
      if (!was || !now || was.id !== now.id) continue;
      if (!running(was) || running(now) || !["failed", "success"].includes(now.status)) continue;
      notify({
        title: `${row.role} pipeline ${now.status === "failed" ? "failed" : "passed"}`,
        body: `${project.path} · ${row.ref}`,
        level: now.status === "failed" ? "error" : "success",
        timeout: now.status === "failed" ? 0 : 6000,
      });
    }
  }

  // The button's window bounds, kept so a key can open the popup above it too.
  remember(b) {
    if (!b) return;
    const next = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
    if (JSON.stringify(next) !== JSON.stringify(shared(ANCHOR))) setShared(ANCHOR, next);
  }

  togglePopup(view = "list") {
    const open = shared(POPUP);
    if (open) { closeOverlay(open); setShared(POPUP, null); return; }
    const b = shared(ANCHOR), at = b ? { x: Math.max(8, b.x + b.width - POPUP_WIDTH - 6), y: Math.max(8, b.y - POPUP_HEIGHT - 6) } : undefined;
    setShared(POPUP, openOverlay({ mod: "pipelines", kind: "popup", width: POPUP_WIDTH, height: POPUP_HEIGHT, at, props: { popup: true, view } }));
  }

  iconButton(id, icon, url, t) {
    const slot = div().id(id).w(22).h(22).flex_none().flex().items_center().justify_center().rounded(5);
    if (!url) return slot;
    return slot.cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); openUrl(url); })
      .child(svg(`${MOD}/${icon}`).size(13));
  }

  row(project, r, t, mono) {
    const s = look(r.p?.status, t), key = `${project.id}-${r.ref}`;
    return h_flex().id(`row-${key}`).h(30).flex_none().pl(10).pr(4).gap(6).items_center().rounded(7).hover((st) => st.bg(t.hover))
      .child(div().w(14).h(14).flex_none().flex().items_center().justify_center()
        .child(s.spin ? svg(`${MOD}/spinner.svg`).size(12).text_color(s.color).spin(900) : div().w(8).h(8).rounded(4).bg(s.color)))
      .child(div().w(72).flex_none().truncate().text_size(11).text_color(r.branch ? t.dim : t.muted).child(r.role))
      .child(div().id(`branch-${key}`).flex_1().min_w(0).truncate().font_family(mono).text_size(12).cursor_pointer()
        .hover((st) => st.underline()).on_click((_e, cx) => { cx.stop_propagation(); openUrl(PROVIDERS[project.kind].branch(project, r.ref)); })
        .child(r.ref))
      .child(div().flex_none().text_size(11).text_color(s.color).child(s.label))
      .child(div().w(26).flex_none().text_right().text_size(11).text_color(t.dim).child(r.p ? ago(r.p.updated_at) : ""))
      .child(h_flex().flex_none().gap(2)
        .child(this.iconButton(`pipeline-${key}`, PROVIDERS[project.kind].icon, r.p?.web_url, t))
        .child(this.iconButton(`site-${key}`, "globe.svg", r.url, t)));
  }

  card(project, t, mono) {
    const error = project.error;
    return v_flex().id(`card-${project.id}`).flex_none().p(4).gap(1).rounded(9).border_1()
      .border_color(project.active ? t.accent : t.border).bg(t.surface)
      .child(h_flex().id(`head-${project.id}`).h(30).pl(10).pr(4).gap(8).items_center().cursor_pointer().rounded(7)
        .hover((s) => s.bg(t.hover)).on_click(() => openUrl(project.web))
        .child(svg(`${MOD}/${PROVIDERS[project.kind].icon}`).size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(project.path.split("/").pop()))
        .child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(project.path.split("/").slice(0, -1).join("/")))
        .child(this.notifyButton(project, t)))
      .when(project.offline && !error, (e) => e.child(div().px(10).py(4).text_size(11).text_color(t.dim).child(`Can't reach ${project.host}, showing the last results`)))
      .when(Boolean(project.note) && !error, (e) => e.child(div().px(10).py(4).text_size(11).text_color(t.ansi3).child(project.note)))
      .when(Boolean(error), (e) => e.child(div().px(10).py(4).text_size(11).text_color(t.ansi1).child(error)))
      .when(!error, (e) => e.children(project.rows.map((r) => this.row(project, r, t, mono))));
  }

  notifyButton(project, t) {
    const on = notified().includes(project.id);
    return div().id(`notify-${project.id}`).w(22).h(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(on ? t.foreground : t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .tooltip(on ? "Notifications on: click to turn them off" : "Notify me when a pipeline here ends")
      .on_click((_e, cx) => { cx.stop_propagation(); setShared(NOTIFY, on ? notified().filter((id) => id !== project.id) : [...notified(), project.id]); })
      .child(svg(`${MOD}/${on ? "bell.svg" : "bell-off.svg"}`).size(13));
  }

  textButton(id, label, t, primary, onClick, enabled = true) {
    return div().id(id).h(28).px(12).flex().flex_none().items_center().rounded(7).text_size(12)
      .bg(primary && enabled ? t.solid : t.raised).text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim)
      .when(enabled, (e) => e.cursor_pointer().on_click(onClick)).child(label);
  }

  hosts() {
    const d = data(), map = new Map();
    for (const p of d.projects ?? []) map.set(p.host, p.kind);
    for (const h of d.saved ?? []) if (!map.has(h)) map.set(h, h === "github.com" ? "github" : h === "bitbucket.org" ? "bitbucket" : "gitlab");
    for (const [host, kind] of [["github.com", "github"], ["bitbucket.org", "bitbucket"]]) if (!map.has(host)) map.set(host, kind);
    return [...map].map(([host, kind]) => ({ host, kind }));
  }

  // Inputs start empty: a saved token is never read back into the UI.
  openTokens(cx, focus) {
    const saved = data().saved ?? [];
    this.fields = this.hosts().map(({ host, kind }) => {
      const has = saved.includes(host);
      const token = InputState.new({ placeholder: has ? "Saved: type a new one to replace it" : kind === "gitlab" ? "glpat-…" : kind === "github" ? "github_pat_…" : "Access token, or API token" });
      token.set_masked(true);
      token.on("submit", (_e, cx) => this.saveTokens(cx));
      const email = kind === "bitbucket" ? InputState.new({ placeholder: "Email, only with an Atlassian API token" }) : null;
      email?.on("submit", (_e, cx) => this.saveTokens(cx));
      return { host, kind, saved: has, token, email };
    });
    this.view = "tokens"; this.note = null;
    (this.fields.find((f) => f.host === focus) ?? this.fields.find((f) => !f.saved))?.token.focus();
    cx.notify();
  }

  async editConfig(change) {
    const path = CONFIG(), text = await readTextFile(path).catch(() => null);
    let config = {};
    if (text) {
      try { config = JSON.parse(text); }
      catch { throw new Error("settings.json isn't valid JSON: fix it before saving tokens"); }
    }
    change(config);
    setShared(DATA, { ...data(), at: 0, refreshing: null });
    await writeTextFile(path, JSON.stringify(config, null, 2) + "\n", text);
    await exec("chmod", ["600", path]).catch(() => {});
  }

  saveTokens(cx) {
    if (this.saving) return;
    const fields = this.fields ?? [];
    const lone = fields.find((f) => f.email?.value().trim() && !f.token.value().trim());
    if (lone) { this.note = `Type the ${lone.host} token that goes with the email`; cx.notify(); return; }
    const changes = fields.filter((f) => f.token.value().trim());
    if (!changes.length) { this.view = "list"; cx.notify(); return; }
    this.saving = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        await this.editConfig((c) => {
          c.tokens = c.tokens ?? {};
          for (const f of changes) {
            const token = f.token.value().trim(), email = f.email?.value().trim();
            c.tokens[f.host] = email ? { email, token } : token;
          }
        });
        // No refresh here: the write reloads the mod and would kill it, leaving its lease behind.
        // The data is already marked stale, so the reloaded copies refresh at once.
        this.view = "list";
      } catch (e) { this.note = String(e?.message ?? e); }
      finally { this.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  removeToken(host, cx) {
    cx.spawn(async (cx) => {
      try {
        await this.editConfig((c) => { if (c.tokens) delete c.tokens[host]; });
        this.view = "list";
      } catch (e) { this.note = String(e?.message ?? e); }
      cx.notify();
    });
  }

  field(id, state, t) {
    return div().id(id).h(32).px(10).flex().flex_none().items_center().rounded(8).border_1().border_color(t.input).bg(t.background).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).w_full().h_full().text_size(12).text_color(t.foreground));
  }

  tokenCard(f, t, env) {
    const [label, color] = f.saved ? ["Saved", t.ansi2] : env[f.host] ? [`From ${env[f.host]}`, t.muted] : ["No token", t.ansi3];
    return v_flex().id(`token-${f.host}`).flex_none().p(12).gap(8).rounded(9).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(svg(`${MOD}/${PROVIDERS[f.kind].icon}`).size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(f.host))
        .child(div().flex_none().text_size(11).text_color(color).child(label))
        .when(f.saved, (e) => e.child(div().id(`remove-${f.host}`).flex_none().text_size(11).text_color(t.dim).cursor_pointer()
          .hover((st) => st.text_color(t.ansi1)).on_click((_e, cx) => this.removeToken(f.host, cx)).child("Remove"))))
      .child(div().text_size(11).text_color(t.muted).child(`${PROVIDERS[f.kind].help}.`))
      .child(this.field(`input-${f.host}`, f.token, t))
      .when(Boolean(f.email), (e) => e.child(this.field(`email-${f.host}`, f.email, t)));
  }

  tokensView(t) {
    const env = data().env ?? {};
    return v_flex().id("tokens").size_full().overflow_y_scrollbar().py(FADE).pl(8).pr(14).gap(8)
      .child(div().px(4).text_size(11).text_color(t.dim).child("Saved in the mod's settings.json, readable by you only. A saved token is never shown again."))
      .children(this.fields.map((f) => this.tokenCard(f, t, env)))
      .when(Boolean(this.note), (e) => e.child(div().px(4).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().gap(8).justify_end()
        .child(this.textButton("tokens-cancel", "Cancel", t, false, (_e, cx) => { this.view = "list"; cx.notify(); }))
        .child(this.textButton("tokens-save", this.saving ? "Saving…" : "Save", t, true, (_e, cx) => this.saveTokens(cx), !this.saving)));
  }

  toggle(t) {
    const chip = (value, label) => div().id(`scope-${value}`).px(7).h(20).flex().items_center().rounded(4).text_size(11)
      .when(scope() === value, (e) => e.bg(t.selected).text_color(t.foreground))
      .when(scope() !== value, (e) => e.text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)))
      .on_click(() => setShared(SCOPE, value)).child(label);
    return h_flex().flex_none().p(2).gap(2).rounded(6).border_1().border_color(t.border).child(chip("space", "Space")).child(chip("all", "All"));
  }

  headerButton(id, icon, t, onClick, spin = false, on = false) {
    return div().id(id).w(24).h(24).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick)
      .child(spin ? svg(`${MOD}/spinner.svg`).size(13).spin(900) : svg(`${MOD}/${icon}`).size(14));
  }

  panel(t) {
    const d = data(), mono = settings().font_family ?? "JetBrains Mono", list = visible(), popup = this.role === "popup";
    const tokens = this.view === "tokens", noToken = !list.length && (d.missing ?? []).length > 0;
    return v_flex().id("pipelines").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .when(!popup, (e) => e.rounded(10).border_1().border_color(t.border))
      .when(popup, (e) => e.w(POPUP_WIDTH).h(POPUP_HEIGHT))
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child(tokens ? "Tokens" : "Pipelines"))
        .when(!tokens, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(`${list.length} repo${list.length === 1 ? "" : "s"}`)))
        .child(div().flex_1())
        .when(!tokens, (e) => e.child(this.toggle(t))
          .child(this.headerButton("refresh", "refresh.svg", t, (_e, cx) => this.refresh(cx, true), Boolean(d.refreshing))))
        .child(this.headerButton("tokens", "key.svg", t, (_e, cx) => { if (tokens) { this.view = "list"; cx.notify(); } else this.openTokens(cx); }, false, tokens))
        .when(popup, (e) => e.child(this.headerButton("close", "close.svg", t, () => { setShared(POPUP, null); closeOverlay(props().overlay); }))))
      .when(Boolean(d.configError), (e) => e.child(div().px(14).py(6).text_size(11).text_color(t.ansi1).child(d.configError)))
      .child(v_flex().flex_1().min_h(0).relative()
      .when(tokens, (e) => e.child(this.tokensView(t)))
      .when(!tokens, (e) => e.child(v_flex().id("pipelines-list").size_full().overflow_y_scrollbar().py(FADE).pl(8).pr(14).gap(8)
        .children(list.map((p) => this.card(p, t, mono)))
        .when(noToken, (e) => e.child(v_flex().p(8).gap(10).items_start()
          .child(div().text_color(t.dim).child("Add a GitLab, Bitbucket or GitHub token to see your pipelines."))
          .child(this.textButton("add-token", "Add token", t, true, (_e, cx) => this.openTokens(cx)))))
        .when(!list.length && !noToken, (e) => e.child(div().p(8).text_color(t.dim)
          .child(d.at ? (scope() === "space" ? "No CI repo in this space" : "No GitLab, Bitbucket or GitHub repo in your spaces") : "Looking for repos…")))))
        .child(this.fade(t, "top")).child(this.fade(t, "bottom")));
  }

  // Cards scrolled under an edge fade into the background instead of meeting a border. Element
  // backgrounds take no gradient here, so the fade is bands of falling opacity. Drawn after the
  // scroller so it sits over it; the scroll padding keeps it clear of the cards at rest.
  fade(t, edge) {
    const base = t.background.slice(0, 7), steps = ["f2", "d9", "b3", "80", "4d", "1a"];
    const bands = steps.map((a) => div().h(FADE / steps.length).flex_none().bg(`${base}${a}`));
    const el = v_flex().absolute().left(0).right(14).h(FADE).children(edge === "top" ? bands : bands.reverse());
    return edge === "top" ? el.top(0) : el.bottom(0);
  }

  button(t) {
    const rows = visible("space").flatMap((p) => p.rows ?? []);
    const failed = rows.filter((r) => r.p?.status === "failed").length, busy = rows.filter((r) => BUSY.has(r.p?.status)).length;
    const color = failed ? t.ansi1 : t.muted;
    return h_flex().id("pipelines-button").size_full().px(12).gap(6).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.8).text_color(color).cursor_pointer().hover((s) => s.text_color(failed ? t.ansi1 : t.foreground))
      .on_mouse_move((e) => this.remember(e.bounds))
      .on_mouse_down("left", (e) => { this.remember(e.bounds); this.togglePopup(); })
      .child(!failed && busy
        ? svg(`${MOD}/spinner.svg`).size(12).text_color(t.ansi4).spin(900)
        : failed ? svg(`${MOD}/pipeline.svg`).size(13) : image(`${MOD}/pipe.svg`).size(13))
      .child(failed ? `${failed} failed` : busy ? `${busy} running` : "Pipelines");
  }

  render(cx) {
    if (this.key() !== data().key) this.refresh(cx);
    const t = theme();
    return this.role === "button" ? this.button(t) : this.panel(t);
  }
}
