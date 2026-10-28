// macOS local bridge release: prepare -> seal -> switch -> verify.
// Every invocation supplies the same --dir, --state, --origin, --service and --plist.
// Preparation builds/tests away from live dist. Switch retains both artifacts;
// rollback changes code only, never restores older authorization or runtime state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
/** Existing credentials/deadlines/legacy scope must remain byte-for-byte
 * equivalent. Only the additive, validated stable-scope migration is ignored. */
export function grantFingerprint(row) {
  const { securityScope, ...session } = row.session;
  if (securityScope !== undefined && !/^v2:[a-f0-9]{64}$/.test(securityScope)) throw Error('Invalid IDE scope migration');
  return hash(JSON.stringify({ ...row, session }));
}
export function treeHash(root) {
  const rows = [];
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file), key = path.posix.join(prefix, name);
      if (stat.isSymbolicLink()) throw Error('Artifact contains a symlink');
      if (stat.isDirectory()) walk(file, key); else rows.push([key, hash(fs.readFileSync(file))]);
    }
  }
  walk(root); return hash(JSON.stringify(rows));
}
export function testCounts(log) {
  const get = name => Number(log.match(new RegExp(`ℹ ${name} (\\d+)`))?.[1]);
  const tests = get('tests'), passed = get('pass'), skipped = get('skipped');
  if (!(tests > 0) || passed + skipped !== tests || get('fail') !== 0 || get('cancelled') !== 0) throw Error('Full regression did not pass');
  return { tests, passed, skipped };
}
export function assertReleaseDirectory(dir, repo, state) {
  const within = (child, parent) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  for (const protectedPath of [repo, state]) if (within(dir, protectedPath) || within(protectedPath, dir)) throw Error('Release directory overlaps source or state');
}
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withReleaseOwnership(state, action) {
  const file = path.join(state, 'release.lock');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error(`Another release owns the release lock: ${file}. If its process crashed, verify that owner has exited before removing the stale lock.`);
    throw error;
  }
  let identity;
  try {
    identity = fs.fstatSync(fd);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
    return await action();
  } finally {
    try {
      if (identity) {
        const current = fs.lstatSync(file);
        if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(file);
      }
    } finally { fs.closeSync(fd); }
  }
}

/** Fail closed against old runtimes. Only the running owner can atomically
 * freeze submissions and certify that its private native work is idle. */
export async function claimRuntimeRelease(origin, expectedPid, request = fetch) {
  const read = await request(new URL('/api/request-context', origin), { signal: AbortSignal.timeout(5000) });
  if (!read.ok) throw Error('Cannot acquire runtime release admission; service was not stopped');
  const { requestToken } = await read.json();
  if (typeof requestToken !== 'string' || !requestToken) throw Error('Invalid runtime request context');
  const id = crypto.randomUUID();
  const post = async (route, token = requestToken, body = { id }) => {
    const response = await request(new URL(`/api/release/${route}`, origin), { method: 'POST',
      headers: { Origin: origin.origin, 'Content-Type': 'application/json', 'X-Codex-Im-Gateway-Token': token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error(`Runtime release admission HTTP ${response.status}; service was not stopped. Busy or unsupported runtimes cannot be forced through.`);
    return response.json();
  };
  const cancel = async () => { await post('cancel'); };
  try {
    const lease = await post('prepare');
    if (lease.id !== id || lease.pid !== expectedPid || lease.prepared !== true) throw Error('Runtime release owner/PID changed; service was not stopped');
    return { id, cancel, finish: newPid => finishRuntimeRelease(origin, id, newPid, request) };
  } catch (error) {
    // A lost HTTP acknowledgement may still have installed our gate. An exact
    // owner cancellation cannot clear another release's lease.
    try { await cancel(); } catch { /* Preserve the original fail-closed reason. */ }
    throw error;
  }
}

export async function finishRuntimeRelease(origin, id, newPid, request = fetch) {
  const response = await request(new URL('/api/request-context', origin), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('Replacement runtime request context unavailable; release admission remains closed');
  const context = await response.json();
  const post = async (route, body) => {
    const response = await request(new URL(`/api/release/${route}`, origin), { method: 'POST',
      headers: { Origin: origin.origin, 'Content-Type': 'application/json', 'X-Codex-Im-Gateway-Token': context.requestToken },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error(`Replacement release admission HTTP ${response.status}`);
    return response.json();
  };
  const status = await post('status', {});
  if (status.pid !== newPid || status.prepared && status.id !== id) throw Error('Replacement runtime release owner/PID changed; admission was not reopened');
  if (!status.prepared) return; // Idempotent verify after a successful reopening.
  const result = await post('cancel', { id });
  if (result.released !== true) throw Error('Replacement runtime did not reopen release admission');
}

export function assertRollbackAdmission(state, id) {
  const row = JSON.parse(fs.readFileSync(path.join(state, 'release-admission.json'), 'utf8'));
  if (row.version !== 1 || row.id !== id || Object.keys(row).sort().join(',') !== 'id,version')
    throw Error('Rollback admission is no longer held; replacement was not stopped');
}

export async function main(argv) {
  const [action, ...flags] = argv, options = {};
  if (!['prepare', 'seal', 'switch', 'verify'].includes(action) || flags.length % 2) throw Error('Usage: release-local.mjs prepare|seal|switch|verify --dir PATH --state PATH --origin URL --service LABEL --plist PATH');
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i].replace(/^--/, ''); if (!['dir', 'state', 'origin', 'service', 'plist'].includes(key) || options[key]) throw Error('Invalid release option'); options[key] = flags[i + 1];
  }
  if (['dir', 'state', 'origin', 'service', 'plist'].some(key => !options[key])) throw Error('Missing release option');
  const repo = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url))), state = fs.realpathSync(options.state);
  let dir = path.resolve(options.dir);
  assertReleaseDirectory(dir, repo, state);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); dir = fs.realpathSync(dir); assertReleaseDirectory(dir, repo, state);
  const origin = new URL(options.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password) throw Error('Release health origin must be local loopback HTTP');
  if (!/^gui\/\d+\/[\w.-]+$/.test(options.service)) throw Error('Invalid launchd service');
  // Keep ownership across every awaited preflight, switch, verification and
  // rollback. Separate release directories still target the same live service.
  return withReleaseOwnership(state, async () => {
  const live = path.join(repo, 'dist'), staged = path.join(dir, 'dist'), backup = path.join(dir, 'dist-previous'), manifest = path.join(dir, 'manifest.json');
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const sourceHash = () => hash(git(['ls-files', '-z']).split('\0').filter(Boolean).map(file => `${file}\0${hash(fs.readFileSync(path.join(repo, file)))}`).join('\n'));
  const clean = () => {
    git(['diff', '--exit-code', 'HEAD', '--', '.']);
    if (git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').some(file => file && path.basename(file) !== '.DS_Store')) throw Error('Untracked release inputs must be committed first');
  };
  const pid = () => Number(execFileSync('/bin/launchctl', ['print', options.service], { encoding: 'utf8' }).match(/^\s*pid = (\d+)\s*$/m)?.[1]);
  const api = async route => { const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(5000) }); if (!response.ok) throw Error(`Readiness HTTP ${response.status}`); return response.json(); };
  const grants = () => {
    const root = path.join(state, 'ide'); if (!fs.existsSync(root)) return {};
    return Object.fromEntries(fs.readdirSync(root).filter(name => /^authorization(?:-.*)?\.json$/.test(name)).sort().map(name => [name,
      JSON.parse(fs.readFileSync(path.join(root, name))).sessions.filter(row => row.session.expiresAt > Date.now()).map(row => ({ fingerprint: grantFingerprint(row), expiresAt: row.session.expiresAt }))]));
  };
  const permissions = () => Object.fromEntries(fs.readdirSync(path.join(state, 'runtime'), { withFileTypes: true }).filter(item => item.isDirectory()
    && fs.existsSync(path.join(state, 'runtime', item.name, 'state.json'))).sort((a, b) => a.name.localeCompare(b.name)).map(item => {
      const s = JSON.parse(fs.readFileSync(path.join(state, 'runtime', item.name, 'state.json')));
      return [item.name, hash(JSON.stringify({ active: s.activeSessionIds, qa: s.activeQaSessionIds, paired: s.pairedSenderIds, roles: s.conversationRoles, detached: s.detachedSessionSenders }))];
    }));
  const health = async () => {
    const [accounts, ide, sessions] = await Promise.all([api('/api/accounts'), api('/api/ide'), api('/api/sessions')]);
    return { accounts: accounts.accounts.map(a => ({ id: a.accountId, status: a.status, connection: a.connection?.state })),
      ideRunning: ide.running, ttlDays: ide.authorization.sessionTtlDays, authorizationError: Boolean(ide.authorization.error),
      endpoints: ide.endpoints.map(e => ({ key: JSON.stringify([e.hostId, e.publicOrigin, e.shared === true, e.localDirect === true]), state: e.state })).sort((a, b) => a.key.localeCompare(b.key)),
      edges: sessions.sessions.map(s => [s.accountId, s.id, s.senderId, s.binding?.hostId ?? s.hostId ?? 'local', s.threadId ?? null, s.binding?.bound === true])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  };
  const dead = async processId => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { try { process.kill(processId, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; } await delay(250); }
    throw Error('Old process is still alive; running artifacts were not replaced');
  };
  const verify = async m => {
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'before.json')));
    let current, build, ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        [current, build] = await Promise.all([health(), api('/api/build')]);
        ready = build.build?.commit === m.commit && build.build?.sourceHash === m.source
          && !current.authorizationError && current.ideRunning === before.health.ideRunning && current.ttlDays === before.health.ttlDays
          && current.endpoints.length === before.health.endpoints.length && current.endpoints.every((e, index) => e.state === 'ready' && e.key === before.health.endpoints[index].key)
          && before.health.accounts.filter(a => a.status === 'running').every(a => current.accounts.some(b => a.id === b.id && b.status === 'running' && (!a.connection || a.connection === b.connection)));
        if (ready) break;
      } catch { /* bounded readiness polling, never native task mutation */ }
      await delay(500);
    }
    if (!ready) throw Error('New service failed readiness or build identity');
    let retained = 0; const after = grants();
    for (const [name, rows] of Object.entries(before.grants)) for (const row of rows) {
      if (row.expiresAt <= Date.now()) continue;
      if (!after[name]?.some(r => r.fingerprint === row.fingerprint)) throw Error('Existing browser grant changed'); retained++;
    }
    if (JSON.stringify(permissions()) !== JSON.stringify(before.permissions) || JSON.stringify(current.edges) !== JSON.stringify(before.health.edges)) throw Error('Access permissions or exact binding edges changed');
    const currentPid = pid(); if (!Number.isSafeInteger(currentPid) || currentPid <= 1 || currentPid === m.previousPid || treeHash(live) !== m.compiled) throw Error('New process/artifact not confirmed');
    const result = { commit: m.commit, pid: currentPid, retainedGrants: retained, ttlDays: current.ttlDays, endpoints: current.endpoints.length, tests: m.tests };
    save(path.join(dir, 'verified.json'), result); return result;
  };
  const runLog = (name, bin, args) => { const fd = fs.openSync(path.join(dir, name), 'w', 0o600); try { execFileSync(bin, args, { cwd: repo, stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); } };
  if (action === 'prepare') {
    clean(); const commit = git(['rev-parse', 'HEAD']), source = sourceHash();
    if (fs.existsSync(manifest)) { const previous = JSON.parse(fs.readFileSync(manifest)); if (previous.commit !== commit || previous.source !== source) throw Error('Use a new release directory for changed source'); if (['prepared', 'sealed', 'verified'].includes(previous.status)) { console.log(JSON.stringify({ status: previous.status, commit })); return; } }
    const previousPid = pid(); if (!Number.isSafeInteger(previousPid) || previousPid <= 1) throw Error('Managed Gateway is not running');
    save(manifest, { status: 'preparing', commit, source });
    runLog('typecheck.log', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
    runLog('tests.log', process.execPath, ['--test', '--import', 'tsx', '--test-reporter=spec', '--test-timeout=120000', ...fs.readdirSync(path.join(repo, 'test')).filter(name => name.endsWith('.test.ts')).map(name => 'test/' + name)]);
    const tests = testCounts(fs.readFileSync(path.join(dir, 'tests.log'), 'utf8'));
    runLog('build.log', process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--outDir', staged]);
    fs.cpSync(path.join(repo, 'src/web'), path.join(staged, 'web'), { recursive: true });
    fs.mkdirSync(path.join(staged, 'web/vendor'), { recursive: true });
    for (const [file, target] of [['lucide/dist/umd/lucide.min.js', 'lucide.min.js'], ['marked/lib/marked.umd.js', 'marked.umd.js'], ['dompurify/dist/purify.min.js', 'purify.min.js']]) fs.copyFileSync(path.join(repo, 'node_modules', file), path.join(staged, 'web/vendor', target));
    fs.chmodSync(path.join(staged, 'server/index.js'), 0o755);
    save(path.join(staged, 'build-info.json'), { commit, sourceHash: source, builtAt: new Date().toISOString() });
    if (!fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
    save(path.join(dir, 'package.json'), { type: 'module', private: true });
    clean(); if (sourceHash() !== source) throw Error('Source changed during preparation');
    const m = { status: 'prepared', commit, source, tests, testLog: hash(fs.readFileSync(path.join(dir, 'tests.log'))), previousPid,
      previous: treeHash(live), compiled: treeHash(staged) }; save(manifest, m); console.log(JSON.stringify(m)); return;
  }
  const m = JSON.parse(fs.readFileSync(manifest));
  if (action === 'seal') {
    clean(); if (!['prepared', 'sealed'].includes(m.status) || sourceHash() !== m.source || treeHash(staged) !== m.compiled
      || hash(fs.readFileSync(path.join(dir, 'tests.log'))) !== m.testLog || git(['rev-parse', 'HEAD']) !== m.commit) throw Error('Prepared inputs changed');
    testCounts(fs.readFileSync(path.join(dir, 'tests.log'), 'utf8'));
    if (git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0] !== m.commit) throw Error('origin/main differs from release');
    m.status = 'sealed'; save(manifest, m); console.log(JSON.stringify({ sealed: true, commit: m.commit })); return;
  }
  const verifyAndReopen = async () => { const result = await verify(m); if (m.releaseOwner) await finishRuntimeRelease(origin, m.releaseOwner, result.pid); return result; };
  if (action === 'verify') { if (m.status !== 'verified') throw Error('Release has not completed cutover'); console.log(JSON.stringify(await verifyAndReopen())); return; }
  if (m.status === 'verified') { console.log(JSON.stringify(await verifyAndReopen())); return; }
  clean(); if (m.status !== 'sealed' || sourceHash() !== m.source || pid() !== m.previousPid || treeHash(live) !== m.previous || treeHash(staged) !== m.compiled || fs.existsSync(backup)) throw Error('Cutover preconditions changed');
  const releaseGate = await claimRuntimeRelease(origin, m.previousPid);
  m.releaseOwner = releaseGate.id;
  let stopped = false, oldDead = false, installed = false;
  try {
    const before = { health: await health(), grants: grants(), permissions: permissions() };
    if (before.health.authorizationError || before.health.ideRunning && before.health.endpoints.some(e => e.state !== 'ready')) throw Error('Existing Gateway is not ready for cutover');
    save(path.join(dir, 'before.json'), before);
    m.status = 'switching'; save(manifest, m);
    execFileSync('/bin/launchctl', ['bootout', options.service]); stopped = true; await dead(m.previousPid); oldDead = true;
    fs.renameSync(live, backup); try { fs.renameSync(staged, live); } catch (error) { fs.renameSync(backup, live); throw error; } installed = true;
    execFileSync('/bin/launchctl', ['bootstrap', options.service.split('/').slice(0, 2).join('/'), options.plist]);
    const result = await verify(m);
    // Commit verification before reopening. Subsequent failures must never kill
    // a replacement which has already accepted new work.
    m.status = 'verified'; save(manifest, m);
    await releaseGate.finish(result.pid);
    console.log(JSON.stringify(result));
  } catch (error) {
    if (m.status === 'verified') throw error;
    if (installed) {
      // If an operator already reopened traffic, readiness failure is no
      // longer permission to kill the replacement's newly accepted tasks.
      assertRollbackAdmission(state, m.releaseOwner);
      let failedPid; try { failedPid = pid(); } catch {}
      try { execFileSync('/bin/launchctl', ['bootout', options.service]); } catch {}
      if (failedPid) await dead(failedPid);
      fs.renameSync(live, path.join(dir, 'dist-failed')); fs.renameSync(backup, live);
    }
    if (stopped && oldDead) execFileSync('/bin/launchctl', ['bootstrap', options.service.split('/').slice(0, 2).join('/'), options.plist]);
    m.status = installed ? 'rolled-back' : 'switch-failed'; save(manifest, m); throw error;
  } finally {
    if (!oldDead) await releaseGate.cancel();
  }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2));
