#!/usr/bin/env node
// n8n Move Check (free, MIT) - READ-ONLY report of what moving an npm/npx n8n install to Docker involves before n8n 3.0.
// Run as the user that runs n8n (or with sudo):   node move-check.js            (writes move-report.json into the current folder)
// Never prints or saves a secret: environment VALUES, the encryption key and credential data stay inside this process;
// the key appears only as a 12-character fingerprint. It changes nothing: no service is stopped or restarted.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process"), crypto = require("crypto");

const VERSION = "1.0.2";
const SAFE_ENV_SHOWN = new Set(["N8N_PORT", "N8N_HOST", "N8N_PROTOCOL", "WEBHOOK_URL", "GENERIC_TIMEZONE", "TZ", "DB_TYPE",
  "DB_POSTGRESDB_HOST", "DB_POSTGRESDB_PORT", "DB_POSTGRESDB_DATABASE", "N8N_USER_FOLDER", "EXECUTIONS_MODE",
  "N8N_RUNNERS_ENABLED", "N8N_BINARY_DATA_MODE"]);                     // non-secret settings: value shown
// n8n 3.0 removals: node types present in n8n 2.41.5 but NOT in the n8n v3 RC image (v3-rc-20261005, diff of
// dist/types/nodes.json, 2026-10-05; matches docs.n8n.io/changelog/v30-breaking-changes). AI Transform: migrated to Code.
const REMOVED_NODES = {
  "@n8n/n8n-nodes-langchain.code": "LangChain Code\n",
  "@n8n/n8n-nodes-langchain.documentBinaryInputLoader": "Binary Input Loader\n",
  "@n8n/n8n-nodes-langchain.documentGithubLoader": "GitHub Document Loader\n",
  "@n8n/n8n-nodes-langchain.documentJsonInputLoader": "JSON Input Loader\n",
  "@n8n/n8n-nodes-langchain.lmOpenAi": "OpenAI Model\n",
  "@n8n/n8n-nodes-langchain.manualChatTrigger": "Manual Chat Trigger\n",
  "@n8n/n8n-nodes-langchain.memoryChatRetriever": "Chat Messages Retriever\n",
  "@n8n/n8n-nodes-langchain.memoryMotorhead": "Motorhead", "@n8n/n8n-nodes-langchain.memoryZep": "Zep\n",
  "@n8n/n8n-nodes-langchain.openAiAssistant": "OpenAI Assistant\n",
  "@n8n/n8n-nodes-langchain.toolHttpRequest": "HTTP Request Tool\n",
  "@n8n/n8n-nodes-langchain.toolSerpApi": "SerpApi (Google Search)\n",
  "@n8n/n8n-nodes-langchain.vectorStoreInMemoryInsert": "In Memory Vector Store Insert\n",
  "@n8n/n8n-nodes-langchain.vectorStoreInMemoryLoad": "In Memory Vector Store Load\n",
  "@n8n/n8n-nodes-langchain.vectorStorePineconeInsert": "Pinecone: Insert\n",
  "@n8n/n8n-nodes-langchain.vectorStorePineconeLoad": "Pinecone: Load\n",
  "@n8n/n8n-nodes-langchain.vectorStoreSupabaseInsert": "Supabase: Insert\n",
  "@n8n/n8n-nodes-langchain.vectorStoreSupabaseLoad": "Supabase: Load\n",
  "@n8n/n8n-nodes-langchain.vectorStoreZep": "Zep Vector Store\n",
  "@n8n/n8n-nodes-langchain.vectorStoreZepInsert": "Zep Vector Store: Insert\n",
  "@n8n/n8n-nodes-langchain.vectorStoreZepLoad": "Zep Vector Store: Load", "n8n-nodes-base.cron": "Cron\n",
  "n8n-nodes-base.function": "Function", "n8n-nodes-base.functionItem": "Function Item\n",
  "n8n-nodes-base.htmlExtract": "HTML Extract", "n8n-nodes-base.iCal": "iCalendar\n",
  "n8n-nodes-base.interval": "Interval", "n8n-nodes-base.itemLists": "Item Lists\n",
  "n8n-nodes-base.moveBinaryData": "Convert to/from binary data", "n8n-nodes-base.openAi": "OpenAI\n",
  "n8n-nodes-base.orbit": "Orbit", "n8n-nodes-base.readBinaryFile": "Read Binary File\n",
  "n8n-nodes-base.readBinaryFiles": "Read Binary Files", "n8n-nodes-base.readPDF": "Read PDF\n",
  "n8n-nodes-base.workflowTrigger": "Workflow Trigger", "n8n-nodes-base.writeBinaryFile": "Write Binary File"
};
const FILE_NODES = new Set(["n8n-nodes-base.readWriteFile", "n8n-nodes-base.readBinaryFile", "n8n-nodes-base.readBinaryFiles", "n8n-nodes-base.writeBinaryFile"]);

const items = [];   // {area, verdict: OK|DECIDE|BLOCKER|INFO, text}
const add = (area, verdict, text, extra = {}) => items.push({ area, verdict, text, ...extra });   // extra: dirs / unresolved (host items)
const sh = (cmd, args, opts = {}) => { try { return cp.execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000, ...opts }); } catch { return null; } };
const fp = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

// ---------- 1. how does n8n run? ----------
function n8nProcesses() {
  const out = sh("ps", ["-eo", "pid=,user=,args="]) || "";
  return out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, user, args]) => ({ pid: +pid, user, args }))
    .filter((p) => /(^|[\/\s])n8n(\s|$)|\/n8n\/bin\/n8n|n8n@/.test(p.args) && !/move-check/.test(p.args) && !/\bgrep\b/.test(p.args));
}
function readEnv(pid) {
  try {
    return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  } catch { return null; }
}
function managerOf(pid) {
  let cg = ""; try { cg = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"); } catch {}
  const unit = (cg.match(/\/([^\/\n]+\.service)\b/) || [])[1];
  if (unit && !/^(user@|session-|pm2-)/.test(unit)) return { kind: "systemd", unit };   // pm2 startup runs under pm2-<user>.service
  let ppid = pid;
  for (let i = 0; i < 6; i++) {
    let st = ""; try { st = fs.readFileSync(`/proc/${ppid}/status`, "utf8"); } catch { break; }
    ppid = +((st.match(/PPid:\s+(\d+)/) || [])[1] || 0); if (!ppid) break;
    let a = ""; try { a = fs.readFileSync(`/proc/${ppid}/cmdline`, "utf8").replace(/\0/g, " "); } catch {}
    if (/PM2|pm2/.test(a)) return { kind: "pm2" };
  }
  return { kind: "manual" };
}
const isNpx = (args) => /_npx\/|\bnpx\b|npm exec/.test(args);

const procs = n8nProcesses().filter((p) => !/\bnpm exec\b|\bnpx\b/.test(p.args) || /node/.test(p.args));
const main = procs.find((p) => /node/.test(p.args) || /\/n8n\/bin\/n8n/.test(p.args)) || procs[0];
let env = null, how = null, bin = null;
if (main) {
  env = readEnv(main.pid);
  how = managerOf(main.pid);
  const npx = /_npx|npm-cache|npx/.test(main.args);
  bin = (main.args.match(/(\S*\/(?:n8n\/bin|\.bin)\/n8n)(?=\s|$)/) || [])[1] || null;
  add("run", "INFO", `n8n is running (pid ${main.pid}, user ${main.user}), started by ${how.kind}${how.unit ? " (" + how.unit + ")" : ""}${npx ? ", via npx" : ""}`);
  if (!env) add("run", "DECIDE", `cannot read the environment of pid ${main.pid} - run this check as ${main.user} or with sudo for a complete report`);
} else {
  add("run", "DECIDE", "n8n is not running right now - start it the usual way and run this check again (the report then sees its real settings)");
}
const globalBin = (sh("sh", ["-c", "command -v n8n"]) || "").trim();
bin = bin || globalBin || null;
const nodeArgs = bin && bin.endsWith("/n8n") && fs.existsSync(bin) ? [bin] : null;
const n8nVersion = nodeArgs ? (sh(process.execPath, [...nodeArgs, "--version"], { env: { ...process.env, ...(env || {}) } }) || "").trim().split("\n").pop() : "";
add("version", n8nVersion ? "INFO" : "DECIDE", n8nVersion ? `n8n ${n8nVersion} on Node ${process.versions.node} - the Docker move should use EXACTLY n8n ${n8nVersion} first, upgrade to 3.0 later`
  : "could not run 'n8n --version' (is this the user that runs n8n?)");
// Node version the installed n8n requires (its own package.json "engines") vs the Node that runs this check
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fs.realpathSync(bin)), "..", "package.json"), "utf8"));
  const need = (pkg.engines && pkg.engines.node) || "";
  const min = (need.match(/>=\s*(\d+)/) || [])[1];
  if (min && +process.versions.node.split(".")[0] < +min) add("version", "BLOCKER", `n8n ${pkg.version} needs Node ${need}, this Node is ${process.versions.node} - 'n8n start' will refuse to run (the Docker image brings the right Node)`);
  else if (need) add("version", "OK", `Node ${process.versions.node} satisfies n8n's requirement (${need})`);
} catch {}
if (how && how.kind === "manual") add("run", "DECIDE", `started ${main && isNpx(main.args) ? "with npx" : "by hand"} - nothing restarts it automatically; for a move with automatic rollback run it under systemd or pm2 first (Move Kit Pro requires that)`);
if (how && how.kind === "pm2") add("run", "DECIDE", "pm2: after the move, 'pm2 stop' (not delete) the old n8n so rollback stays one command");
if (how && how.kind === "systemd") add("run", "DECIDE", `systemd: after the move, stop (not disable) ${how.unit} until the Docker one is verified`);

// ---------- 2. settings (names only, a few non-secret values) ----------
const E = env || process.env;
const n8nVars = Object.keys(E).filter((k) => /^(N8N_|DB_|EXECUTIONS_|QUEUE_|NODES_|NODE_FUNCTION_ALLOW_|CREDENTIALS_|EXTERNAL_|WORKFLOWS_|CODE_|OTEL_|WEBHOOK_URL$|GENERIC_TIMEZONE$|TZ$)/.test(k)).sort();
// a URL is shown as scheme://host[:port]/ only (user:password@, path and query can carry secrets)
const noUserinfo = (v) => { const m = String(v).match(/^([a-z][a-z0-9+.-]*:\/\/)(?:[^\/@\s]*@)?([^\/?#\s]+)/i); return m ? `${m[1]}${/@/.test(String(v).split("/")[2] || "") ? "***@" : ""}${m[2]}/...` : String(v); };
add("env", "INFO", `${n8nVars.length} n8n settings in its environment: ${n8nVars.map((k) => SAFE_ENV_SHOWN.has(k) ? `${k}=${noUserinfo(E[k])}` : k).join(", ") || "none"}`);
if ((E.EXECUTIONS_MODE || "") === "queue") add("env", "BLOCKER", "queue mode (workers): not covered by this kit - move it by hand with n8n's docs");
// n8n 3.0 settings changes (docs.n8n.io/changelog/v30-breaking-changes, checked 2026-10-05) - names/values only
const V3_REMOVED = { N8N_PRE_EXECUTE_ERROR_CREATES_EXECUTION: "removed - delete it", N8N_MIGRATE_FS_STORAGE_PATH: "removed - delete it",
  OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS: "removed (queue mode always sends manual runs to workers)", N8N_DB_PING_TIMEOUT: "removed - use DB_PING_TIMEOUT_MS" };
for (const [k, why] of Object.entries(V3_REMOVED)) if (E[k] !== undefined) add("n8n 3.0", "DECIDE", `${k} is ${why} in 3.0`);
if (E.N8N_BINARY_DATA_STORAGE_PATH !== undefined) add("n8n 3.0", "INFO", "N8N_BINARY_DATA_STORAGE_PATH is deprecated - n8n says use N8N_STORAGE_PATH (set it to the same folder)");
if ((E.N8N_DEFAULT_BINARY_DATA_MODE || "") === "default") add("n8n 3.0", "BLOCKER", "N8N_DEFAULT_BINARY_DATA_MODE=default is removed in 3.0 - switch to filesystem (or s3/azure/database) first");
if (E.N8N_RUNNERS_TASK_TIMEOUT === undefined) add("n8n 3.0", "INFO", "Code node task timeout drops from 300 s to 60 s in 3.0 (n8n v3.0 breaking-changes page) - set N8N_RUNNERS_TASK_TIMEOUT if a Code step runs longer than a minute");

const home = main ? (sh("getent", ["passwd", main.user]) || "").split(":")[5] || os.homedir() : os.homedir();
const userFolder = E.N8N_USER_FOLDER ? path.join(E.N8N_USER_FOLDER, ".n8n") : path.join(home, ".n8n");
add("data", fs.existsSync(userFolder) ? "INFO" : "DECIDE", fs.existsSync(userFolder) ? `user folder: ${userFolder}` : `user folder ${userFolder} not found`);
// n8n 2.x file access: N8N_RESTRICT_FILE_ACCESS_TO, default "~/.n8n-files" - OUTSIDE the user folder, so it does not move with it
if (E.N8N_RESTRICT_FILE_ACCESS_TO === undefined) {
  const d = path.join(home, ".n8n-files");
  if (fs.existsSync(d)) add("data", "DECIDE", `n8n's file folder ${d} (default for Read/Write Files) is OUTSIDE the user folder - copy it too and mount it at the same path, or workflows that read/write there break`);
} else if (E.N8N_RESTRICT_FILE_ACCESS_TO !== "") {
  add("data", "DECIDE", `file access limited to: ${E.N8N_RESTRICT_FILE_ACCESS_TO} - mount these folders into the container at the same path ("~" means /home/node inside the container: write it out)`);
}
if (E.NODES_EXCLUDE !== undefined) add("env", "INFO", "NODES_EXCLUDE is set (in n8n 2.x it is how Execute Command / Local File Trigger get enabled) - it must go into the Docker .env too");
const pwd = main ? (sh("getent", ["passwd", main.user]) || "").split(":") : [];
if (pwd.length > 3 && +pwd[2] !== 1000) add("run", "DECIDE", `n8n runs as ${main.user} (uid ${pwd[2]}); the official image runs as uid 1000 - run the container as ${pwd[2]}:${pwd[3]} (and give it a writable home) so host folders keep the same rights`);

// ---------- 3. encryption key ----------
let key = E.N8N_ENCRYPTION_KEY || "";
let keySrc = key ? "the environment (N8N_ENCRYPTION_KEY)" : "";
try { if (!key) { key = JSON.parse(fs.readFileSync(path.join(userFolder, "config"), "utf8")).encryptionKey || ""; keySrc = key ? `${userFolder}/config` : ""; } } catch {}
if (key) add("key", "DECIDE", `encryption key found in ${keySrc} (fingerprint ${fp(key)}). The Docker n8n MUST get exactly this key - without it no credential can be decrypted. Save it in your password manager now.`);
else add("key", "BLOCKER", "no encryption key found (no N8N_ENCRYPTION_KEY, no config file readable) - do NOT move until you have it");

// ---------- 4. database ----------
const dbType = (E.DB_TYPE || "sqlite").toLowerCase();
if (dbType.startsWith("postgres")) add("db", "DECIDE", `Postgres ${E.DB_POSTGRESDB_HOST || "localhost"}/${E.DB_POSTGRESDB_DATABASE || "n8n"}: if it is "localhost", the container must reach the host's Postgres (host.docker.internal / host network) - the move plan sets this`);
else {
  const db = path.join(userFolder, "database.sqlite"); let size = 0; try { size = fs.statSync(db).size; } catch {}
  add("db", size ? "INFO" : "DECIDE", size ? `SQLite ${db} (${(size / 1048576).toFixed(1)} MB) - copied with the user folder` : `SQLite database not found at ${db}`);
}

// ---------- 5. workflows + credentials (exported to a private temp dir, read, deleted) ----------
let workflows = [], creds = [];
if (nodeArgs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-move-check-")); fs.chmodSync(tmp, 0o700);
  const run = (what, file) => sh(process.execPath, [...nodeArgs, what, "--all", `--output=${path.join(tmp, file)}`], { env: { ...process.env, ...(env || {}) }, timeout: 180000 });
  try {
    run("export:workflow", "w.json"); run("export:credentials", "c.json");           // credentials stay ENCRYPTED
    try { workflows = JSON.parse(fs.readFileSync(path.join(tmp, "w.json"), "utf8")); } catch {}
    try { creds = JSON.parse(fs.readFileSync(path.join(tmp, "c.json"), "utf8")).map((c) => ({ id: c.id, type: c.type })); } catch {}
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
add("export", workflows.length ? "INFO" : "DECIDE", workflows.length || creds.length ? `${workflows.length} workflows (${workflows.filter((w) => w.active).length} active), ${creds.length} credentials`
  : "could not export workflows (run as the n8n user, with n8n installed as found above)");

// ---------- 6. what moves with extra work ----------
const byType = {};
for (const w of workflows) for (const n of w.nodes || []) (byType[n.type] = byType[n.type] || []).push({ wf: w.name, n });
if (byType["n8n-nodes-base.aiTransform"]) add("n8n 3.0", "INFO", `AI Transform nodes are converted to Code nodes by 3.0 - check them after the upgrade: ${[...new Set(byType["n8n-nodes-base.aiTransform"].map((x) => x.wf))].join(", ")}`);
for (const [t, label] of Object.entries(REMOVED_NODES)) if (byType[t]) add("n8n 3.0", "BLOCKER", `${label} node is removed in 3.0 - used in: ${[...new Set(byType[t].map((x) => x.wf))].join(", ")} (replace it before upgrading; the move itself is fine)`);
const exprHits = workflows.filter((w) => JSON.stringify(w.nodes || []).match(/\$getPairedItem\(|\$evaluateExpression\(/));
if (exprHits.length) add("n8n 3.0", "BLOCKER", `$getPairedItem()/$evaluateExpression() are removed in 3.0 - used in: ${exprHits.map((w) => w.name).join(", ")}`);
if (byType["n8n-nodes-base.executeCommand"]) {
  const cmds = [...new Set(byType["n8n-nodes-base.executeCommand"].map((x) => String(x.n.parameters?.command || "").trim().split(/\s+/)[0]).filter(Boolean))];
  add("host", "DECIDE", `Execute Command runs INSIDE the container after the move. Commands used: ${cmds.join(", ") || "(expressions)"} - each must exist in the image (or a small custom image) and any host files must be mounted`);
  // absolute host paths INSIDE the commands (cat /srv/orders/in.csv ...) - system folders exist in the container anyway
  const SYS = /^\/(usr|bin|sbin|lib|lib64|etc|dev|proc|sys|tmp|run|var\/run)(\/|$)/;
  // a path with a shell variable ($TENANT, ${X}, `cmd`) can only be mounted from the folder BEFORE the variable
  const cpaths = new Set(), cdirs = new Set(), unresolved = new Set();
  for (const x of byType["n8n-nodes-base.executeCommand"]) for (const m of String(x.n.parameters?.command || "").matchAll(/(?:^|[\s"'=:(<>|;&,])(\/[\w.@+\-\/${}`]+)/g)) {
    const pth = m[1]; if (SYS.test(pth) || pth === "/") continue;
    cpaths.add(pth);
    const segs = pth.split("/"); const iv = segs.findIndex((sg) => /[$`{}]/.test(sg));
    if (iv === -1) cdirs.add(path.dirname(pth));
    else { const pre = segs.slice(0, iv).join("/"); if (pre && pre !== "/" && !SYS.test(pre + "/")) cdirs.add(pre); else unresolved.add(pth); }
  }
  if (cpaths.size) add("host", "DECIDE", `host paths used in Execute Command: ${[...cpaths].slice(0, 15).join(", ")} - these folders must be mounted into the container` +
    (unresolved.size ? `; CANNOT tell the folder for: ${[...unresolved].slice(0, 5).join(", ")} (variable right after /) - mount it yourself` : ""),
    { dirs: [...cdirs], unresolved: [...unresolved] });
}
const filePaths = [];
for (const t of FILE_NODES) for (const x of byType[t] || []) { const p = x.n.parameters?.fileSelector || x.n.parameters?.filePath || x.n.parameters?.fileName; if (p) filePaths.push(String(p)); }
if (filePaths.length) add("host", "DECIDE", `files read/written on the host: ${[...new Set(filePaths)].slice(0, 15).join(", ")} - these folders must be mounted into the container`,
  { dirs: [...new Set(filePaths.filter((x) => x.startsWith("/") && !/[$`{}]/.test(x)).map((x) => path.dirname(x)))] });
const community = Object.keys(byType).filter((t) => !/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./.test(t));
let installed = []; try { installed = Object.keys(JSON.parse(fs.readFileSync(path.join(userFolder, "nodes", "package.json"), "utf8")).dependencies || {}); } catch {}
if (installed.length || community.length) add("nodes", "DECIDE", `community nodes installed: ${installed.join(", ") || "none"}; used: ${[...new Set(community.map((t) => t.split(".")[0]))].join(", ") || "none"} - they move with the user folder; n8n 3.0 disables UNVERIFIED community packages by default (check each one's status in n8n)`);

if (installed.length && E.N8N_UNVERIFIED_PACKAGES_ENABLED === undefined) add("n8n 3.0", "DECIDE", `N8N_UNVERIFIED_PACKAGES_ENABLED changes from true to false in 3.0 (n8n v3.0 breaking-changes page) - check whether ${installed.join(", ")} ${installed.length > 1 ? "are" : "is"} verified in n8n; set N8N_UNVERIFIED_PACKAGES_ENABLED=true in the Docker env only if you need an unverified one`);
const nm = path.join(userFolder, "nodes", "node_modules"), native = new Set();
const walkN = (d, pkg, depth) => { if (depth > 8) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch {}
  for (const e of es) if (e.isDirectory()) walkN(path.join(d, e.name), pkg, depth + 1); else if (e.name.endsWith(".node")) native.add(pkg); };
let top = []; try { top = fs.readdirSync(nm, { withFileTypes: true }); } catch {}
for (const e of top) if (e.isDirectory()) { let names = [e.name]; if (e.name.startsWith("@")) { try { names = fs.readdirSync(path.join(nm, e.name)).map((x) => `${e.name}/${x}`); } catch { names = []; } }
  for (const n of names) walkN(path.join(nm, n), n, 0); }
if (native.size) add("nodes", "BLOCKER", `community package(s) with native code: ${[...native].join(", ")} - built for this system, they do not run in the official image (Alpine). Reinstall them inside Docker from n8n's settings after the move, or move by hand`);
if (E.N8N_BINARY_DATA_STORAGE_PATH && !path.resolve(E.N8N_BINARY_DATA_STORAGE_PATH).startsWith(userFolder + "/"))
  add("data", "DECIDE", `binary data is stored in ${E.N8N_BINARY_DATA_STORAGE_PATH} (outside the user folder) - copy it too and mount it at the same path`);

// ---------- 7. room + Docker ----------
const df = (sh("df", ["-Pk", path.dirname(userFolder)]) || "").split("\n")[1]?.split(/\s+/);
let used = 0; try { used = +((sh("du", ["-sk", userFolder]) || "0").split(/\s+/)[0]); } catch {}
if (df) add("disk", +df[3] > used * 2 + 512000 ? "OK" : "BLOCKER", `user folder ${(used / 1024).toFixed(0)} MB, free ${(+df[3] / 1024).toFixed(0)} MB (the move needs a full copy + a backup)`);
const dock = (sh("docker", ["--version"]) || "").trim();
add("docker", dock ? "OK" : "DECIDE", dock || "Docker is not installed yet (Docker Engine + compose plugin needed for the move)");

// ---------- report ----------
const order = { BLOCKER: 0, DECIDE: 1, OK: 2, INFO: 3 };
items.sort((a, b) => order[a.verdict] - order[b.verdict]);
console.log(`n8n Move Check ${VERSION} - read-only; nothing was changed\n`);
for (const i of items) console.log(`${i.verdict.padEnd(7)} [${i.area}] ${i.text}`);
const blockers = items.filter((i) => i.verdict === "BLOCKER").length, decide = items.filter((i) => i.verdict === "DECIDE").length;
console.log(`\n${blockers} blocker(s), ${decide} decision(s). Report saved to move-report.json (no secrets inside).`);
fs.writeFileSync("move-report.json", JSON.stringify({ tool: "n8n-move-check", version: VERSION, at: new Date().toISOString(),
  n8n: n8nVersion || null, manager: how, key_fingerprint: key ? fp(key) : null, workflows: workflows.length, credentials: creds.length, items }, null, 1), { mode: 0o600 });
try { fs.chmodSync("move-report.json", 0o600); } catch {}
