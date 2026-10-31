// Native M1 acceptance infrastructure. Never launches the habitual application.
// Fixtures and release are separate runs; no model credential is inherited.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
function requireInside(root, candidate, label) {
  const resolved = path.resolve(candidate);
  if (!inside(root, resolved)) throw Error(`${label} must be inside the dedicated test root`);
  return resolved;
}
function noLinks(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('Linked/reparse test path rejected');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function verifyPreparedRoot(argument, mode) {
  if (process.platform !== 'win32') throw Error('Run with Windows Node 22.12+');
  const root = path.resolve(argument);
  requireInside(path.resolve(os.tmpdir()), root, 'Prepared root');
  noLinks(root);
  const manifest = readJson(path.join(root, 'm1-native-manifest.json'));
  if (manifest.milestone !== 'M1' || manifest.mode !== mode || path.resolve(manifest.windowsRoot) !== root
    || !/^com\.jarvis\.desktop\.m1-[a-z0-9-]+$/i.test(manifest.identifier)) throw Error('Invalid M1 identity or mode');
  const dataRoot = requireInside(root, manifest.dataRoot, 'Data root');
  const profile = requireInside(root, manifest.profile, 'WebView profile');
  if (dataRoot === profile || inside(dataRoot, profile) || inside(profile, dataRoot)) throw Error('Data and profile must be separate');
  for (const folder of [dataRoot, profile]) {
    noLinks(folder);
    if (fs.existsSync(folder)) throw Error('Use fresh data and profile directories; prior state is preserved');
  }
  if (!manifest.files || !Object.keys(manifest.files).length) throw Error('Verified source manifest required');
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = requireInside(root, path.join(root, relative), 'Source file');
    noLinks(file);
    if (!/^[a-f0-9]{64}$/i.test(expected) || digest(file) !== expected.toLowerCase()) throw Error('Prepared file hash mismatch: ' + relative);
  }
  function checkDirectory(directory) {
    noLinks(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      noLinks(file);
      if (entry.isDirectory()) checkDirectory(file);
      else if (!Object.hasOwn(manifest.files, path.relative(root, file).split(path.sep).join('/'))) throw Error('Unverified source or asset in prepared tree');
    }
  }
  for (const directory of ['src-tauri/src', 'intelligence', 'dist']) checkDirectory(path.join(root, directory));
  if (!Object.hasOwn(manifest.files, 'src-tauri/tauri.conf.json')) throw Error('Config must be covered by source manifest');
  const config = readJson(path.join(root, 'src-tauri/tauri.conf.json'));
  if (config.identifier !== manifest.identifier || config.build.devUrl
    || path.resolve(config.app.appDirectoriesOverride) !== dataRoot
    || config.app.windows.length !== 2 || config.app.windows.some(w => path.resolve(w.dataDirectory) !== profile)
    || !['dashboard', 'assistant'].every(label => config.app.windows.some(w => w.label === label))) throw Error('Tauri isolation mismatch');
  if (!Array.isArray(manifest.testBoundaries) || (mode === 'release' && manifest.testBoundaries.length)) throw Error('Test substitution boundaries required');
  const executable = requireInside(root, path.resolve(root, manifest.executable), 'Executable');
  noLinks(executable);
  if (!/^[a-f0-9]{64}$/i.test(manifest.executableSha256) || digest(executable) !== manifest.executableSha256.toLowerCase()) throw Error('Executable hash mismatch');
  const output = path.join(root, 'evidence');
  if (fs.existsSync(output)) throw Error('Evidence destination must be new; prior attempts are preserved');
  return { root, manifest, dataRoot, profile, executable, output, mode };
}

function isolatedEnvironment(profile, port) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(GEMINI|API_KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && !/^WEBVIEW2_/i.test(name)));
  env.WEBVIEW2_USER_DATA_FOLDER = profile;
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
  return env;
}

export class NativeConversationRun {
  constructor(prepared, port) {
    Object.assign(this, prepared);
    this.port = port;
    this.clients = [];
    this.report = { milestone: 'M1', mode: this.mode, startedAt: new Date().toISOString(),
      executableSha256: this.manifest.executableSha256, testBoundaries: this.manifest.testBoundaries,
      remoteSemanticValidation: false, realGeminiCalls: 0, forcedTerminationUsed: false, inputFocusMode: 'Activate the actual native target window before CDP pointer input',
      checks: [], scenariosComplete: false, normalExit: false };
  }
  persist() { fs.writeFileSync(path.join(this.output, 'result.json'), JSON.stringify(this.report, null, 2)); }
  check(name, passed, details) {
    this.report.checks.push({ name, passed: !!passed, ...(details === undefined ? {} : { details }) });
    this.persist();
    if (!passed) throw Error(name);
  }
  async until(fn, label, limit = 20000) {
    const end = Date.now() + limit;
    while (Date.now() < end) {
      if (this.app && this.app.exitCode !== null) throw Error('Test application exited while waiting: ' + label);
      const value = await fn();
      if (value) return value;
      await sleep(100);
    }
    throw Error('Native wait timed out: ' + label);
  }
  async pages() {
    try { return await (await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(1000) })).json(); }
    catch { return []; }
  }
  async launch() {
    fs.mkdirSync(this.output);
    this.persist();
    let portUsed = false;
    try { await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1000) }); portUsed = true; } catch {}
    this.check('Dedicated WebView debugging port unused', !portUsed);
    this.app = spawn(this.executable, [], { cwd: this.root, env: isolatedEnvironment(this.profile, this.port), stdio: 'ignore' });
    this.exited = once(this.app, 'exit');
    this.exited.catch(() => {});
    const target = await this.until(async () => (await this.pages()).find(p => p.type === 'page'
      && !p.url.includes('assistant') && /tauri|localhost/.test(p.url)), 'dashboard target');
    this.dashboard = await this.connect(target.webSocketDebuggerUrl);
    await this.until(() => this.dashboard.eval(`!!document.querySelector('#jarvis-command')`), 'dashboard input');
    await this.invoke(this.dashboard, 'window_action', { label: 'assistant', visible: true });
    const assistant = await this.until(async () => (await this.pages()).find(p => p.type === 'page' && p.url.includes('assistant')), 'assistant target');
    this.assistant = await this.connect(assistant.webSocketDebuggerUrl);
    await this.until(() => this.assistant.eval(`!!document.querySelector('#assistant-command')`), 'assistant input');
  }
  async connect(url) {
    const ws = new WebSocket(url);
    await once(ws, 'open');
    let sequence = 0;
    const pending = new Map();
    const rejectPending = () => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('WebView disconnected')); } pending.clear(); };
    ws.addEventListener('close', rejectPending);
    ws.addEventListener('message', event => {
      const result = JSON.parse(event.data);
      const job = pending.get(result.id);
      if (!job) return;
      pending.delete(result.id); clearTimeout(job.timer);
      result.error ? job.reject(Error('CDP failed: ' + job.method)) : job.resolve(result.result);
    });
    const client = {
      send(method, params = {}) {
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
          pending.set(id, { resolve, reject, timer, method });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      async eval(expression) {
        const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw Error(result.result?.description ?? result.exceptionDetails.text);
        return result.result.value;
      },
      close() { ws.close(); rejectPending(); },
    };
    this.clients.push(client);
    return client;
  }
  invoke(client, command, args = {}) {
    return client.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  }
  rejected(client, command, args = {}) {
    return client.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(()=>({rejected:false}),e=>({rejected:true,error:String(e)}))`);
  }
  async fill(client, selector, value) {
    await client.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`);
  }
  async pointer(client, expression) {
    // CDP input does not activate a different native WebView window. Focus the
    // actual target window first, as a user does, without forwarding its IPC.
    await this.invoke(client, 'window_action', { label: client === this.assistant ? 'assistant' : 'dashboard', visible: true });
    await client.eval(`new Promise(resolve=>{const e=${expression};if(!e||e.disabled)throw Error('Unavailable control');e.scrollIntoView({block:'center',behavior:'instant'});requestAnimationFrame(()=>requestAnimationFrame(resolve));})`);
    const point = await client.eval(`(()=>{const e=${expression};const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Covered control');return {x,y}})()`);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async capture(client, name) {
    if (!/^[a-z0-9-]+$/.test(name)) throw Error('Invalid capture name');
    const result = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(this.output, name + '.png'), Buffer.from(result.data, 'base64'));
  }
  snapshot() { return this.invoke(this.dashboard, 'conversation_snapshot'); }
  tasks() { return this.invoke(this.dashboard, 'list_tasks'); }
  fixtureStatus() { return this.invoke(this.dashboard, 'fixture_status'); }
  async button(client, text) {
    await this.pointer(client, `[...document.querySelectorAll('button')].find(e=>{const copy=e.cloneNode(true);copy.querySelectorAll('[aria-hidden=true]').forEach(x=>x.remove());return copy.textContent.trim()===${JSON.stringify(text)}})`);
  }
  async buttonIn(client, scope, text) {
    await this.pointer(client, `[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(e=>e.textContent.trim()===${JSON.stringify(text)})`);
  }
  async key(client, key, code, modifiers = 0) {
    await this.invoke(client, 'window_action', { label: client === this.assistant ? 'assistant' : 'dashboard', visible: true });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, modifiers,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers });
  }
  async armDeliveryFailure(client, operation) {
    // The fixture delegates to the real Rust handler first. Only its subsequent
    // IPC response delivery is held/rejected; Tauri's protected globals stay intact.
    await this.invoke(client, 'fixture_arm_delivery', { operation });
  }
  deliveryStatus(client = this.dashboard) { return this.invoke(client, 'fixture_delivery_status'); }
  async rejectHeldDelivery(client) {
    await this.invoke(client, 'fixture_reject_delivery');
    await this.waitSettled(client);
    return this.deliveryStatus(client);
  }
  async openChat(client) {
    if (!await client.eval(`!!document.querySelector('.shared-conversation')`)) await this.button(client, 'Conversa');
    await this.until(() => client.eval(`!!document.querySelector('.shared-conversation')`), 'conversation panel');
  }
  async waitSettled(client = this.dashboard) {
    await this.until(async () => ['idle', 'awaiting_approval'].includes((await this.snapshot()).status), 'terminal conversation state');
    await this.until(() => client.eval(`document.querySelector('#jarvis-command,#assistant-command')?.closest('form')?.getAttribute('aria-busy')==='false'`), 'form settled');
  }
  async submit(client, text, wait = true) {
    const selector = client === this.assistant ? '#assistant-command' : '#jarvis-command';
    await this.fill(client, selector, text);
    await this.until(() => client.eval(`!document.querySelector(${JSON.stringify(selector)})?.closest('form')?.querySelector('button[type=submit]')?.disabled`), 'send button enabled');
    await client.eval(`document.querySelector(${JSON.stringify(selector)}).closest('form').requestSubmit()`);
    await this.until(() => client.eval(`document.querySelector(${JSON.stringify(selector)}).value===''`), 'input accepted');
    if (wait) await this.waitSettled(client);
  }
  async decide(client, apply = true) {
    await this.openChat(client);
    const beforeRevision = (await this.snapshot()).revision;
    await this.pointer(client, `document.querySelector('.conversation-approval button:${apply ? 'first' : 'last'}-child')`);
    await this.until(async () => (await this.snapshot()).revision > beforeRevision, 'approval turn accepted');
    await this.waitSettled(client);
  }
  async clear(client = this.dashboard) {
    await this.openChat(client);
    await this.pointer(client, `document.querySelector('.shared-conversation button[aria-label="Limpar conversa"]')`);
    await this.until(async () => { const s = await this.snapshot(); return !s.messages.length && s.context === null && s.status === 'idle'; }, 'global clear');
  }
  async sharedHistory(name) {
    const snapshot = await this.snapshot();
    for (const client of [this.dashboard, this.assistant]) {
      await this.openChat(client);
      await this.until(async () => JSON.stringify(await client.eval(`[...document.querySelectorAll('.conversation-log .intelligence-message')].map(e=>e.textContent)`))
        === JSON.stringify(snapshot.messages.map(message => message.text)), 'shared rendered history');
    }
    this.check(name, true, { revision: snapshot.revision, messages: snapshot.messages.length, generation: snapshot.generation });
  }
  async currentToken(client) {
    const owner = client === this.assistant ? 'assistant' : 'dashboard';
    const observed = await this.fixtureStatus();
    const token = observed.lastTokens?.[owner];
    const snapshot = await this.snapshot();
    if (typeof token !== 'string' || !token.length || snapshot.activeOwner !== owner
      || !['processing', 'executing'].includes(snapshot.status)
      || snapshot.messages.at(-1)?.id !== token + ':user') throw Error('Missing verified active fixture token for ' + owner);
    return token;
  }
  async reload(client) {
    const marker = crypto.randomUUID();
    await client.eval(`window.__m1ReloadMarker=${JSON.stringify(marker)}`);
    await client.send('Page.reload', { ignoreCache: true });
    const selector = client === this.assistant ? '#assistant-command' : '#jarvis-command';
    await this.until(() => client.eval(`window.__m1ReloadMarker!==${JSON.stringify(marker)}&&!!document.querySelector(${JSON.stringify(selector)})`), 'reloaded input in new document');
  }
  async processInventory() {
    // Query machine state, return only identities scoped to this root or its app.
    // Command lines and unrelated process information never enter evidence.
    const rootLiteral = this.root.replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop';$root='${rootLiteral}';$all=@(Get-CimInstance Win32_Process);$ids=New-Object 'System.Collections.Generic.HashSet[int]';[void]$ids.Add(${this.app?.pid ?? 0});do{$added=$false;foreach($row in $all){if($ids.Contains([int]$row.ParentProcessId)-and !$ids.Contains([int]$row.ProcessId)){[void]$ids.Add([int]$row.ProcessId);$added=$true}}}while($added);$rows=@();foreach($row in $all){$scoped=($row.ExecutablePath -and $row.ExecutablePath.StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase))-or($row.CommandLine -and $row.CommandLine.Contains($root));if(($ids.Contains([int]$row.ProcessId)-or $scoped)-and $row.ProcessId -ne ${process.pid}){$p=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue;if($p){$rows+=@{pid=$p.Id;created=$p.StartTime.ToUniversalTime().ToString('o');name=$p.ProcessName}}}};ConvertTo-Json -InputObject @($rows) -Compress`;
    return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30000 }, (error, stdout) => {
        if (error) return reject(Error('Scoped process inventory failed'));
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); } catch { reject(Error('Invalid scoped process inventory')); }
      }));
  }
  async normalExit() {
    const before = await this.processInventory();
    this.report.beforeExit = before;
    this.persist();
    await this.pointer(this.dashboard, `document.querySelector('.desktop-menu summary')`);
    await this.pointer(this.dashboard, `document.querySelector('.desktop-menu button.exit')`).catch(error => {
      if (this.app.exitCode === null) throw error;
    });
    await Promise.race([this.exited, sleep(10000).then(() => { if (this.app.exitCode === null) throw Error('Normal UI exit timed out'); })]);
    const end = Date.now() + 10000;
    let after;
    do { after = await this.processInventory(); if (!after.length) break; await sleep(300); } while (Date.now() < end);
    this.report.afterExit = after;
    this.report.survivingOriginalIdentities = after.filter(current => before.some(previous =>
      current.pid === previous.pid && current.created === previous.created));
    this.report.exitCode = this.app.exitCode;
    this.report.normalExit = this.app.exitCode === 0 && after.length === 0;
    this.check('Real UI exit leaves no scoped application processes', this.report.normalExit);
  }
  async closeAfterFailure(error) {
    this.report.error = String(error);
    this.report.scenariosComplete = false;
    this.report.cleanupViaIpc = false;
    if (this.app?.exitCode === null && this.dashboard) {
      await this.capture(this.dashboard, 'failure').catch(() => {});
      if (this.assistant) await this.capture(this.assistant, 'failure-assistant').catch(() => {});
      this.report.failureTrace = {};
      for (const [label, client] of [['dashboard', this.dashboard], ['assistant', this.assistant]]) {
        if (client) this.report.failureTrace[label] = await client.eval(`({feedback:document.querySelector('#command-feedback,#assistant-command-feedback')?.textContent,busy:document.querySelector('#jarvis-command,#assistant-command')?.closest('form')?.getAttribute('aria-busy')})`).catch(() => null);
      }
      if (this.mode === 'fixture') {
        const fixture = await this.fixtureStatus().catch(() => null);
        this.report.failureFixture = fixture ? { beginAttempts: fixture.beginAttempts, lastTokens: fixture.lastTokens, delivery: await this.deliveryStatus().catch(() => null) } : null;
      }
      await this.invoke(this.dashboard, 'quit').then(() => { this.report.cleanupViaIpc = true; }).catch(() => {});
      await Promise.race([this.exited, sleep(10000)]);
    }
    this.report.remainingProcessIds = this.app ? await this.processInventory().catch(() => null) : [];
    this.persist();
  }
  closeClients() { this.clients.forEach(client => client.close()); }
}

async function fixtureScenarios(run) {
  const d = run.dashboard, a = run.assistant;
  const guard = readJson(path.join(run.root, 'isolation-runtime.json'));
  run.check('Fixture isolation guard ran before TaskStore without credential', guard.guardPassed && guard.taskStoreNotYetInitialized
    && !guard.geminiCredentialPresent && guard.identifier === run.manifest.identifier
    && path.resolve(guard.database) === path.join(run.dataRoot, 'tasks.sqlite3'));
  run.check('Fresh isolated SQLite starts empty', (await run.tasks()).tasks.length === 0);
  await run.openChat(d); await run.openChat(a);

  await run.submit(d, 'Crie Tarefa M1 A.');
  let s = await run.snapshot();
  const proposal = s.messages.at(-1)?.approval?.id;
  run.check('Creation is a concrete proposal owned by Central and causes zero writes', s.status === 'awaiting_approval'
    && s.approvalOwner === 'dashboard' && !!proposal && (await run.tasks()).tasks.length === 0);
  await run.sharedHistory('Both windows render the same pending proposal');
  run.check('Foreign approval controls are disabled', await a.eval(`[...document.querySelectorAll('.conversation-approval button')].length===2&&[...document.querySelectorAll('.conversation-approval button')].every(e=>e.disabled)`));
  for (const kind of ['approve', 'cancel']) {
    const rejected = await run.rejected(a, 'conversation_begin', { requestId: `foreign-${kind}`, expectedRevision: s.revision, action: { kind, proposalId: proposal } });
    run.check(`Foreign ${kind} is rejected without consuming origin proposal`, rejected.rejected && (await run.snapshot()).approvalOwner === 'dashboard');
  }
  const foreignText = await run.rejected(a, 'conversation_begin', { requestId: 'foreign-text-confirm', expectedRevision: s.revision,
    action: { kind: 'send', text: 'confirmo excluir 1' } });
  run.check('Foreign textual approval cannot inherit origin authority', foreignText.rejected && (await run.tasks()).tasks.length === 0);
  await run.invoke(d, 'fixture_close');
  run.check('Native close hides owner without writing or losing proposal', !await run.invoke(d, 'get_visible')
    && await run.invoke(a, 'get_visible') && (await run.snapshot()).messages.at(-1)?.approval?.id === proposal && (await run.tasks()).tasks.length === 0);
  await run.invoke(a, 'window_action', { label: 'dashboard', visible: true });
  const interpretations = (await run.fixtureStatus()).interpretations;
  await run.decide(d);
  let tasks = await run.tasks();
  const created = tasks.tasks.find(task => task.title === 'Tarefa M1 A');
  run.check('Origin approval creates one task without another interpretation', !!created && tasks.tasks.length === 1
    && (await run.fixtureStatus()).interpretations === interpretations);
  run.check('Consumed proposal cannot be approved again', (await run.rejected(d, 'approve_operation', { proposalId: proposal })).rejected);

  await run.submit(a, 'Altere a anterior para prioridade alta.');
  s = await run.snapshot();
  run.check('Cross-window prior-task context resolves the same ID and new origin', s.approvalOwner === 'assistant'
    && (await run.fixtureStatus()).requests.at(-1)?.previousTask === true
    && s.messages.at(-1)?.text.includes('alta') && (await run.tasks()).tasks[0].priority === 'normal');
  await run.sharedHistory('Cross-window edit review is identical');
  const beforeEdit = (await run.tasks()).revision;
  await run.decide(a);
  run.check('Cross-window edit preserves task identity and writes once', (await run.tasks()).revision === beforeEdit + 1
    && (await run.tasks()).tasks[0].id === created.id && (await run.tasks()).tasks[0].priority === 'high');
  await run.submit(d, 'Exclua a anterior.');
  run.check('Destructive operation still requires specific owner confirmation', (await run.snapshot()).approvalOwner === 'dashboard'
    && await d.eval(`document.querySelector('.conversation-approval button:first-child')?.textContent==='Confirmar exclusão'`)
    && (await run.tasks()).tasks.length === 1);
  await run.decide(d, false);
  run.check('Explicit cancel preserves task and removes proposal globally', (await run.tasks()).tasks.length === 1
    && !(await run.snapshot()).messages.some(message => message.approval));

  await adversarialAuthorizationScenarios(run);

  // A real permission review must remain usable at the native minimum, not
  // merely render a nonempty log in a large or demonstration-only viewport.
  await run.clear();
  await run.invoke(a, 'fixture_resize', { width: 280, height: 360 });
  await run.until(() => a.eval(`innerWidth===280&&innerHeight===360`), 'minimum floating review viewport');
  const beforeCompact = await run.tasks();
  await run.submit(a, 'Crie Tarefa M1 cancelamento.');
  const compactReview = await run.snapshot();
  run.check('Minimum floating review shows the exact effect and retains origin authority', compactReview.approvalOwner === 'assistant'
    && compactReview.messages.at(-1)?.text.includes('Tarefa M1 cancelamento')
    && compactReview.messages.at(-1)?.text.includes('Estado inicial: pendente')
    && JSON.stringify(await run.tasks()) === JSON.stringify(beforeCompact));
  await a.eval(`document.querySelector('.conversation-log').scrollTop=0;true`);
  await run.capture(a, 'floating-minimum-review-summary');
  await run.pointer(a, `document.querySelector('#assistant-command')`);
  for (const [label, child] of [['cancel', 'last'], ['apply', 'first']]) {
    await run.key(a, 'Tab', 9, 8);
    const visible = await a.eval(`(()=>{const e=document.querySelector('.conversation-approval button:${child}-child'),r=e.getBoundingClientRect(),log=document.querySelector('.conversation-log').getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return document.activeElement===e&&!e.disabled&&x>=log.left&&x<=log.right&&y>=log.top&&y<=log.bottom&&y<innerHeight&&e.contains(document.elementFromPoint(x,y))})()`);
    run.check('Minimum floating permission control is keyboard reachable and exposed: ' + label, visible);
    await run.capture(a, 'floating-minimum-review-' + label);
  }
  await run.decide(a, false);
  run.check('Minimum floating cancellation uses real v1 and preserves SQLite', !(await run.snapshot()).messages.some(message => message.approval)
    && (await run.snapshot()).messages.at(-1)?.text.includes('proposta foi cancelada')
    && JSON.stringify(await run.tasks()) === JSON.stringify(beforeCompact));
  await run.invoke(a, 'fixture_resize', { width: 360, height: 420 });

  // A valid local database can exceed the serialized session cap. The review
  // must retain its constant-size baseline rather than embed all descriptions.
  await run.clear();
  const beforeLarge = await run.tasks();
  const description = 'M1 sintético '.repeat(500).slice(0, 5000);
  for (let index = 0; index < 110; index++) {
    await run.invoke(d, 'save_task', { id: null, input: { title: `M1 grande ${index}`, description, priority: 'normal', project: '', dueDate: null, dueTime: null } });
  }
  const large = await run.tasks();
  run.check('Valid synthetic task database exceeds the session context limit', Buffer.byteLength(JSON.stringify(large)) > 512 * 1024);
  await run.submit(d, 'Crie Tarefa M1 grande.');
  const largeReview = await run.snapshot();
  const contextBytes = Buffer.byteLength(JSON.stringify(largeReview.context));
  run.check('Large database still produces a synchronized compact review', !!largeReview.messages.at(-1)?.approval
    && largeReview.context?.tasks?.staged?.snapshot?.taskCount === large.tasks.length
    && /^[a-f0-9]{64}$/.test(largeReview.context?.tasks?.staged?.snapshot?.othersDigest)
    && contextBytes < 512 * 1024, { contextBytes, databaseRows: large.tasks.length });
  await run.sharedHistory('Large-database review is shared without copying descriptions into the session');
  await run.decide(d);
  const afterLarge = await run.tasks();
  run.check('Large-database approval writes once and leaves all existing rows intact', afterLarge.tasks.length === beforeLarge.tasks.length + 111
    && afterLarge.revision === large.revision + 1
    && large.tasks.every(old => JSON.stringify(afterLarge.tasks.find(row => row.id === old.id)) === JSON.stringify(old))
    && (await run.snapshot()).messages.at(-1)?.text.includes('Tarefa M1 grande'));

  // Native races use IPC from the actual two WebViews, so owner is supplied by
  // Tauri rather than a caller-controlled argument.
  await run.clear();
  s = await run.snapshot();
  const action = { kind: 'demo', text: 'Turno nativo sintético M1' };
  const contenders = [
    { client: d, id: 'native-race-dashboard' }, { client: a, id: 'native-race-assistant' },
  ];
  const race = await Promise.allSettled(contenders.map(candidate => run.invoke(candidate.client, 'conversation_begin', {
    requestId: candidate.id, expectedRevision: s.revision, action,
  })));
  run.check('Two simultaneous windows admit exactly one turn', race.filter(result => result.status === 'fulfilled').length === 1);
  const index = race.findIndex(result => result.status === 'fulfilled');
  const winner = contenders[index], turn = race[index].value;
  const replay = await run.invoke(winner.client, 'conversation_begin', { requestId: winner.id, expectedRevision: s.revision, action });
  run.check('Request replay returns the same token without another user message', replay.replayed && replay.token === turn.token
    && replay.snapshot.messages.length === 1);
  run.check('Same request ID with different content is rejected', (await run.rejected(winner.client, 'conversation_begin', {
    requestId: winner.id, expectedRevision: s.revision, action: { ...action, text: 'Conteúdo diferente' },
  })).rejected);
  run.check('Foreign token cannot execute an effect', (await run.rejected(contenders[1 - index].client, 'conversation_effect', {
    token: turn.token, operation: 'list_tasks', args: {},
  })).rejected);
  await run.invoke(winner.client, 'conversation_effect', { token: turn.token, operation: 'open_browser_search', args: { query: 'termo sintético M1' } });
  run.check('Duplicate effect is refused in the same accepted turn', (await run.rejected(winner.client, 'conversation_effect', {
    token: turn.token, operation: 'open_browser_search', args: { query: 'termo sintético M1' },
  })).rejected);
  await run.invoke(winner.client, 'conversation_finish', { token: turn.token, context: null, result: { text: 'Turno sintético concluído.' } });
  const terminal = await run.snapshot();
  const terminalReplay = await run.invoke(winner.client, 'conversation_begin', { requestId: winner.id, expectedRevision: s.revision, action });
  run.check('Completed receipt replay does not rerun the turn', terminalReplay.replayed && (await run.snapshot()).revision === terminal.revision);
  run.check('Completed token cannot finish again', (await run.rejected(winner.client, 'conversation_finish', {
    token: turn.token, context: null, result: { text: 'Resposta duplicada indevida.' },
  })).rejected);
  await run.sharedHistory('Direct native concurrency results synchronize to both UIs');

  await run.clear();
  await run.submit(d, 'Como está o tempo em Belo Horizonte?');
  run.check('Weather fixture produces a factual temporary city', (await run.snapshot()).context?.city?.place?.name === 'Belo Horizonte');
  await run.submit(a, 'Pesquise passeios nessa cidade.');
  run.check('City context crosses windows without expanding tool authority', (await run.fixtureStatus()).requests.at(-1)?.cityContext === 'Belo Horizonte (synthetic)'
    && (await run.snapshot()).messages.at(-1)?.text.includes('Google'));
  await run.sharedHistory('Weather and city-linked search share history');
  await run.capture(a, 'compact-cross-window-context');

  await run.clear(a);
  const beforeLate = await run.tasks();
  let counts = await run.fixtureStatus();
  await run.submit(d, 'Crie Tarefa M1 atrasada.', false);
  await run.until(async () => (await run.fixtureStatus()).delayedStarted > counts.delayedStarted, 'interpretation barrier');
  const lateToken = await run.currentToken(d);
  run.check('Blocked interpretation exposes real processing in both windows', (await run.snapshot()).status === 'processing');
  await run.openChat(a);
  await run.until(() => a.eval(`document.querySelector('[data-conversation-status]')?.dataset.conversationStatus==='processing'`), 'foreign processing status');
  await run.clear(a);
  await run.invoke(a, 'fixture_release');
  await run.waitSettled(d);
  run.check('Clear revokes delayed interpretation without resurrection or writes', !(await run.snapshot()).messages.length
    && (await run.snapshot()).context === null && JSON.stringify(await run.tasks()) === JSON.stringify(beforeLate));
  run.check('Revoked token cannot publish a late response', (await run.rejected(d, 'conversation_finish', {
    token: lateToken, context: null, result: { text: 'Resposta atrasada indevida.' },
  })).rejected);

  // A reload detaches the owner JS reducer while Rust retains the session.
  counts = await run.fixtureStatus();
  await run.submit(d, 'Crie Tarefa M1 atrasada.', false);
  await run.until(async () => (await run.fixtureStatus()).delayedStarted > counts.delayedStarted, 'reload interpretation barrier');
  const orphanToken = await run.currentToken(d);
  const beforeReloadInterpretations = (await run.fixtureStatus()).interpretations;
  await run.reload(d);
  await run.until(async () => (await run.snapshot()).status === 'idle', 'orphaned interpretation interrupted on attach');
  await run.invoke(a, 'fixture_release');
  run.check('Reload during interpretation neither reruns nor writes', (await run.fixtureStatus()).interpretations === beforeReloadInterpretations
    && JSON.stringify(await run.tasks()) === JSON.stringify(beforeLate));
  run.check('Orphaned interpretation cannot finish after reload', (await run.rejected(d, 'conversation_finish', {
    token: orphanToken, context: null, result: { text: 'Resposta órfã indevida.' },
  })).rejected);

  await run.clear();
  counts = await run.fixtureStatus();
  await run.submit(d, 'Como está o tempo em Belo Horizonte durante a espera M1?', false);
  await run.until(async () => (await run.fixtureStatus()).executingStarted > counts.executingStarted, 'execution barrier');
  const executingToken = await run.currentToken(d);
  s = await run.snapshot();
  run.check('External execution exposes real executing state', s.status === 'executing' && s.activeOwner === 'dashboard');
  await run.openChat(a);
  await run.until(() => a.eval(`document.querySelector('[data-conversation-status]')?.dataset.conversationStatus==='executing'`), 'shared executing status');
  run.check('Clear is refused while an admitted execution runs', (await run.rejected(a, 'conversation_clear', { expectedRevision: s.revision })).rejected);
  await run.capture(a, 'shared-executing');
  await run.reload(d);
  await run.invoke(a, 'fixture_release');
  await run.until(async () => (await run.snapshot()).status === 'idle', 'orphaned execution settles without deadlock');
  const afterOrphan = await run.snapshot();
  run.check('Reload during execution records interruption without a success claim or retry', afterOrphan.context === null
    && !afterOrphan.messages.at(-1)?.text.includes('25,5')
    && (await run.fixtureStatus()).interpretations === counts.interpretations + 1
    && JSON.stringify(await run.tasks()) === JSON.stringify(beforeLate));
  run.check('Orphaned execution token cannot publish a late response', (await run.rejected(d, 'conversation_finish', {
    token: executingToken, context: null, result: { text: 'Êxito não verificado indevido.' },
  })).rejected);
  await run.sharedHistory('Reload recovery is visible in both windows');

  await run.clear();
  await run.openChat(d);
  await run.pointer(d, `document.querySelector('.conversation-meta input[type=checkbox]')`);
  await run.until(async () => !(await run.snapshot()).intelligenceEnabled, 'demo mode selected');
  const beforeDemo = (await run.fixtureStatus()).interpretations;
  await run.submit(a, 'Olá JARVIS');
  run.check('Demo turn preserves selected mode and makes no interpretation', !(await run.snapshot()).intelligenceEnabled
    && (await run.fixtureStatus()).interpretations === beforeDemo);
  await run.openChat(d);
  await run.pointer(d, `document.querySelector('.conversation-meta input[type=checkbox]')`);
  await run.until(async () => (await run.snapshot()).intelligenceEnabled, 'intelligence mode restored');
  run.check('Explicit mode restoration synchronizes to floating window', await a.eval(`document.querySelector('.conversation-meta input')?.checked===true`));

  for (const [client, width, height, name] of [[a, 280, 360, 'floating-minimum'], [a, 360, 420, 'floating-default'], [d, 360, 480, 'central-minimum'], [d, 1080, 740, 'central-default']]) {
    await run.invoke(client, 'fixture_resize', { width, height });
    await run.openChat(client);
    await run.until(() => client.eval(`innerWidth===${width}&&innerHeight===${height}`), 'native resized viewport');
    const layout = await client.eval(`(()=>{const input=document.querySelector('#jarvis-command,#assistant-command'),r=input.getBoundingClientRect(),log=document.querySelector('.conversation-log'),l=log.getBoundingClientRect();return {inputVisible:r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,logVisible:l.height>0&&l.width>0,horizontalOverflow:document.documentElement.scrollWidth>innerWidth}})()`);
    run.check('Native compact conversation layout: ' + name, layout.inputVisible && layout.logVisible && !layout.horizontalOverflow, layout);
    await run.capture(client, name);
  }
  run.check('Fixture made zero real Gemini calls', (await run.fixtureStatus()).realGeminiCalls === 0);
  run.report.scenariosComplete = true;
  run.persist();
}

async function adversarialAuthorizationScenarios(run) {
  const d = run.dashboard, a = run.assistant;
  await run.clear();
  await run.submit(d, 'Crie Tarefa M1 revisão.');
  let s = await run.snapshot();
  const staleProposal = s.messages.at(-1)?.approval?.id;
  const manual = { title: 'Alteração manual concorrente M1', description: '', priority: 'normal', project: '', dueDate: null, dueTime: null };
  await run.invoke(a, 'save_task', { id: null, input: manual });
  const afterManual = await run.tasks();
  await run.decide(d);
  run.check('M1-09 stale task revision rejects reviewed proposal without another write', !!staleProposal
    && JSON.stringify(await run.tasks()) === JSON.stringify(afterManual)
    && !(await run.tasks()).tasks.some(task => task.title === 'Tarefa M1 revisão')
    && (await run.snapshot()).messages.at(-1)?.text.includes('aprovação foi consumida'));
  run.check('M1-09 stale proposal is consumed rather than reopened', (await run.rejected(d, 'approve_operation', { proposalId: staleProposal })).rejected
    && !(await run.snapshot()).messages.some(message => message.approval));

  await run.clear();
  await run.submit(d, 'Crie Tarefa M1 concorrente.');
  s = await run.snapshot();
  const concurrentProposal = s.messages.at(-1)?.approval?.id;
  const beforeConcurrent = await run.tasks();
  const approvals = await Promise.allSettled(['one', 'two'].map(suffix => run.invoke(d, 'conversation_begin', {
    requestId: 'concurrent-native-approval-' + suffix, expectedRevision: s.revision,
    action: { kind: 'approve', proposalId: concurrentProposal },
  })));
  run.check('M1-10 simultaneous origin approvals admit exactly one native turn', approvals.filter(result => result.status === 'fulfilled').length === 1);
  const accepted = approvals.find(result => result.status === 'fulfilled').value;
  const saved = await run.invoke(d, 'conversation_effect', { token: accepted.token, operation: 'approve_operation', args: { proposalId: concurrentProposal } });
  run.check('M1-10 accepted approval executes real Authorization v1 exactly once', saved.revision === beforeConcurrent.revision + 1
    && saved.tasks.filter(task => task.title === 'Tarefa M1 concorrente').length === 1);
  run.check('M1-10 duplicate approval effect cannot execute twice', (await run.rejected(d, 'conversation_effect', {
    token: accepted.token, operation: 'approve_operation', args: { proposalId: concurrentProposal },
  })).rejected && (await run.tasks()).revision === saved.revision);
  await run.invoke(d, 'conversation_finish', { token: accepted.token, context: null,
    result: { text: 'Criação sintética concorrente confirmada pelo retorno real de tarefas.' } });
  run.check('M1-10 consumed concurrent proposal rejects further approval', (await run.rejected(d, 'approve_operation', { proposalId: concurrentProposal })).rejected);

  await run.clear();
  await run.submit(d, 'Crie Tarefa M1 cancelamento.');
  const cancelledProposal = (await run.snapshot()).messages.at(-1)?.approval?.id;
  const beforeCancel = await run.tasks();
  const cancelInterpretations = (await run.fixtureStatus()).interpretations;
  await run.armDeliveryFailure(d, 'cancel_operation');
  await run.pointer(d, `document.querySelector('.conversation-approval button:last-child')`);
  await run.until(async () => { const fault = await run.deliveryStatus(d); return fault.held && fault.backendSucceeded; }, 'cancel delivery held after real backend completion');
  run.check('M1-11 delayed cancel delivery does not claim confirmed cancellation', !(await run.snapshot()).messages.at(-1)?.text.includes('proposta foi cancelada')
    && JSON.stringify(await run.tasks()) === JSON.stringify(beforeCancel));
  const cancelFault = await run.rejectHeldDelivery(d);
  run.check('M1-11 lost cancel delivery reports uncertainty without retry', cancelFault.hits === 1 && cancelFault.backendSucceeded && cancelFault.released
    && (await run.snapshot()).messages.at(-1)?.text.includes('não consegui confirmar o cancelamento')
    && JSON.stringify(await run.tasks()) === JSON.stringify(beforeCancel)
    && (await run.fixtureStatus()).interpretations === cancelInterpretations);
  run.check('M1-11 cancellation stays consumed globally after delivery failure', !(await run.snapshot()).messages.some(message => message.approval)
    && (await run.rejected(d, 'approve_operation', { proposalId: cancelledProposal })).rejected);
  await run.sharedHistory('M1-11 cancellation uncertainty synchronizes across windows');

  await run.clear();
  await run.submit(d, 'Crie Tarefa M1 retorno perdido.');
  const lostProposal = (await run.snapshot()).messages.at(-1)?.approval?.id;
  const beforeCommit = await run.tasks();
  const commitInterpretations = (await run.fixtureStatus()).interpretations;
  await run.armDeliveryFailure(d, 'approve_operation');
  await run.pointer(d, `document.querySelector('.conversation-approval button:first-child')`);
  await run.until(async () => { const fault = await run.deliveryStatus(d); return fault.held && fault.backendSucceeded; }, 'approval delivery held after real commit');
  const committed = await run.tasks();
  run.check('M1-12 real SQLite commit precedes simulated frontend response loss', committed.revision === beforeCommit.revision + 1
    && committed.tasks.filter(task => task.title === 'Tarefa M1 retorno perdido').length === 1
    && (await run.snapshot()).status === 'processing');
  const commitFault = await run.rejectHeldDelivery(d);
  run.check('M1-12 lost post-commit delivery reports uncertainty and performs no retry', commitFault.hits === 1 && commitFault.backendSucceeded && commitFault.released
    && (await run.snapshot()).messages.at(-1)?.text.includes('Não consegui confirmar a operação')
    && JSON.stringify(await run.tasks()) === JSON.stringify(committed)
    && (await run.fixtureStatus()).interpretations === commitInterpretations);
  run.check('M1-12 committed approval remains consumed after delivery failure', !(await run.snapshot()).messages.some(message => message.approval)
    && (await run.rejected(d, 'approve_operation', { proposalId: lostProposal })).rejected);
  await run.sharedHistory('M1-12 post-commit uncertainty synchronizes across windows');

  await run.clear();
  await run.submit(d, 'Crie Tarefa M1 sugestão para amanhã.');
  await run.decide(d);
  s = await run.snapshot();
  let suggested = (await run.tasks()).tasks.find(task => task.title === 'Tarefa M1 sugestão');
  run.check('M1-17 confirmed task offers a real near-deadline priority suggestion', !!suggested?.dueDate
    && suggested.priority === 'normal' && s.context?.tasks?.suggestion?.id === suggested.id && s.authorityOwner === 'dashboard');
  await run.openChat(a);
  const beforeForeign = await run.tasks();
  const beforeForeignRevision = s.revision;
  const foreignBeginCount = (await run.fixtureStatus()).beginAttempts;
  await run.fill(a, '#assistant-command', 'Pode ser');
  await a.eval(`document.querySelector('#assistant-command').closest('form').requestSubmit()`);
  await run.until(() => a.eval(`document.querySelector('#assistant-command').value==='Pode ser'&&document.body.textContent.includes('origem')`), 'foreign suggestion acceptance refused with input retained');
  run.check('M1-17 foreign natural-language acceptance preserves origin suggestion and makes no write', JSON.stringify(await run.tasks()) === JSON.stringify(beforeForeign)
    && (await run.snapshot()).revision === beforeForeignRevision
    && (await run.snapshot()).authorityOwner === 'dashboard'
    && (await run.fixtureStatus()).beginAttempts === foreignBeginCount);
  await run.fill(a, '#assistant-command', '');
  const beforeSuggestionCalls = (await run.fixtureStatus()).interpretations;
  await run.submit(d, 'Pode ser');
  suggested = (await run.tasks()).tasks.find(task => task.id === suggested.id);
  run.check('M1-17 origin suggestion acceptance writes once without another model interpretation', suggested.priority === 'high'
    && (await run.tasks()).revision === beforeForeign.revision + 1
    && (await run.fixtureStatus()).interpretations === beforeSuggestionCalls);
  const beforeUndo = await run.tasks();
  await run.submit(a, 'Na verdade deixe como estava');
  s = await run.snapshot();
  run.check('M1-17 cross-window undo presents a new concrete approval at its origin', s.approvalOwner === 'assistant'
    && !!s.messages.at(-1)?.approval && s.messages.at(-1)?.text.includes('normal')
    && JSON.stringify(await run.tasks()) === JSON.stringify(beforeUndo));
  await run.decide(a);
  run.check('M1-17 approved cross-window undo restores prior value exactly once', (await run.tasks()).revision === beforeUndo.revision + 1
    && (await run.tasks()).tasks.find(task => task.id === suggested.id)?.priority === 'normal'
    && (await run.fixtureStatus()).interpretations === beforeSuggestionCalls);
}

async function releaseScenarios(run) {
  const d = run.dashboard, a = run.assistant;
  await run.openChat(d); await run.openChat(a);
  run.check('Release has no fixture IPC hooks', (await run.rejected(d, 'fixture_status')).rejected);
  run.check('Release starts against empty synthetic storage', (await run.tasks()).tasks.length === 0);
  await run.submit(a, 'Crie uma tarefa sintética sem credencial M1.');
  const missingKey = await run.snapshot();
  run.check('Release missing Gemini key returns honest local failure without write', missingKey.status === 'idle'
    && missingKey.messages.at(-1)?.text.includes('GEMINI_API_KEY') && (await run.tasks()).tasks.length === 0);
  await run.sharedHistory('Release real missing-key error is shared across native windows');
  await run.capture(d, 'release-shared-missing-key');
  const before = await run.snapshot();
  await run.invoke(d, 'window_action', { label: 'dashboard', visible: false });
  await run.invoke(a, 'window_action', { label: 'assistant', visible: false });
  run.check('Both release windows hide while session survives', !await run.invoke(d, 'get_visible') && !await run.invoke(a, 'get_visible')
    && (await run.snapshot()).revision === before.revision);
  await run.invoke(d, 'window_action', { label: 'dashboard', visible: true });
  await run.invoke(d, 'window_action', { label: 'assistant', visible: true });
  await run.sharedHistory('Release window restoration retains exact canonical session');
  for (const client of [d, a]) {
    const selector = client === a ? '#assistant-command' : '#jarvis-command';
    await run.fill(client, selector, 'Texto sintético de foco M1');
    await run.until(() => client.eval(`!document.querySelector(${JSON.stringify(selector)}).closest('form').querySelector('button[type=submit]').disabled`), 'keyboard send control enabled');
    await run.pointer(client, `document.querySelector(${JSON.stringify(selector)})`);
    await run.key(client, 'Tab', 9);
    run.check('Release keyboard Tab reaches enabled send control: ' + (client === a ? 'assistant' : 'dashboard'), await client.eval(`document.activeElement===document.querySelector(${JSON.stringify(selector)}).closest('form').querySelector('button[type=submit]')`));
    await run.fill(client, selector, '');
  }
  await releaseManualTaskScenarios(run);
  run.report.scenariosComplete = true;
  run.persist();
}

async function releaseManualTaskScenarios(run) {
  const d = run.dashboard, a = run.assistant;
  const title = 'Tarefa manual sintética M1';
  await run.buttonIn(d, '.command-toolbar', 'Tarefas');
  await run.buttonIn(d, '.task-tools', '+ Nova tarefa');
  await run.until(() => d.eval(`document.activeElement?.name==='title'`), 'manual creation title focus');
  run.check('Release manual creation focuses title and forbids empty submit', await d.eval(`document.activeElement?.name==='title'&&document.querySelector('.task-form button[type=submit]').disabled`));
  await run.fill(d, '.task-form [name=title]', title);
  await run.key(d, 'Enter', 13);
  await run.until(() => d.eval(`!document.querySelector('.task-form')`), 'manual create with keyboard Enter');
  let task = (await run.tasks()).tasks.find(row => row.title === title);
  run.check('Release real TaskPanel keyboard submission persists expected defaults', !!task && task.priority === 'normal'
    && task.description === '' && task.project === '' && task.dueDate === null && !task.completed);
  run.check('Release successful form restores new-task focus', await d.eval(`document.activeElement?.textContent==='+ Nova tarefa'`));

  await run.buttonIn(d, '.task-list', 'Editar');
  await run.fill(d, '.task-form [name=title]', title + ' editada');
  await run.fill(d, '.task-form [name=description]', 'Descrição sintética M1\nSegunda linha');
  await run.fill(d, '.task-form [name=priority]', 'high');
  await run.fill(d, '.task-form [name=project]', 'Projeto sintético M1');
  await run.fill(d, '.task-form [name=dueDate]', '2030-02-28');
  await run.fill(d, '.task-form [name=dueTime]', '19:00');
  await run.buttonIn(d, '.task-form', 'Salvar alterações');
  await run.until(() => d.eval(`!document.querySelector('.task-form')`), 'manual edited task saved');
  task = (await run.tasks()).tasks.find(row => row.id === task.id);
  run.check('Release TaskPanel edit preserves ID and all supported fields', task.title === title + ' editada'
    && task.priority === 'high' && task.project === 'Projeto sintético M1' && task.description.includes('\n')
    && task.dueDate === '2030-02-28' && task.dueTime === '19:00');
  await run.capture(d, 'release-task-edit');

  if (await a.eval(`!!document.querySelector('.shared-conversation')`)) {
    await run.pointer(a, `document.querySelector('.shared-conversation button[aria-label="Fechar conversa"]')`);
    await run.until(() => a.eval(`!document.querySelector('.shared-conversation')`), 'close conversation before manual tasks');
  }
  await run.buttonIn(a, '.assistant-task-controls', 'Tarefas');
  await run.until(() => a.eval(`document.querySelector('.task-list')?.textContent.includes(${JSON.stringify(title)})`), 'floating TaskPanel receives real edit');
  run.check('Release both TaskPanels show the same persisted task', (await run.invoke(a, 'list_tasks')).revision === (await run.tasks()).revision);
  await run.buttonIn(d, '.task-list', 'Concluir');
  await run.until(async () => (await run.tasks()).tasks.find(row => row.id === task.id)?.completed, 'manual completion persisted');
  await run.until(() => a.eval(`!document.querySelector('.task-list')?.textContent.includes(${JSON.stringify(title)})`), 'floating pending filter updates');
  run.check('Release TaskPanel completion updates the other window', (await run.invoke(a, 'list_tasks')).tasks.find(row => row.id === task.id)?.completed === true);
  await run.fill(a, 'select[aria-label="Filtrar tarefas"]', 'completed');
  await run.until(() => a.eval(`document.querySelector('.task-list')?.textContent.includes(${JSON.stringify(title)})`), 'completed task filter');
  await run.buttonIn(a, '.task-list', 'Reabrir');
  await run.until(async () => !(await run.tasks()).tasks.find(row => row.id === task.id)?.completed, 'manual reopen persisted');
  await run.until(() => d.eval(`document.querySelector('.task-list')?.textContent.includes(${JSON.stringify(title)})`), 'Central pending filter updates');
  run.check('Release floating TaskPanel reopen updates Central', !(await run.tasks()).tasks.find(row => row.id === task.id)?.completed);
  await run.fill(a, 'select[aria-label="Filtrar tarefas"]', 'all');
  await run.until(() => a.eval(`document.querySelector('.task-list')?.textContent.includes(${JSON.stringify(title)})`), 'all task filter');

  await run.buttonIn(a, '.task-list', 'Excluir');
  run.check('Release TaskPanel delete requires concrete confirmation before mutation', await a.eval(`!!document.querySelector('.task-confirm')`)
    && (await run.tasks()).tasks.some(row => row.id === task.id));
  await run.key(a, 'Escape', 27);
  run.check('Release Escape cancels delete and returns focus without writing', !await a.eval(`!!document.querySelector('.task-confirm')`)
    && await a.eval(`document.activeElement?.textContent==='Excluir'`) && (await run.tasks()).tasks.some(row => row.id === task.id));
  await run.buttonIn(a, '.task-list', 'Excluir');
  await run.buttonIn(a, '.task-confirm', 'Manter tarefa');
  run.check('Release explicit keep-task control preserves data', (await run.tasks()).tasks.some(row => row.id === task.id));
  await run.buttonIn(a, '.task-list', 'Excluir');
  await run.buttonIn(a, '.task-confirm', 'Confirmar exclusão');
  await run.until(async () => !(await run.tasks()).tasks.some(row => row.id === task.id), 'confirmed TaskPanel delete');
  run.check('Release confirmed TaskPanel deletion removes only synthetic task', (await run.tasks()).tasks.length === 0);

  await run.buttonIn(a, '.task-tools', '+ Nova tarefa');
  await run.fill(a, '.task-form [name=title]', 'Rascunho sintético não salvo M1');
  await run.key(a, 'Escape', 27);
  run.check('Release Escape first cancels task form without closing panel or saving', await a.eval(`!!document.querySelector('.task-panel')&&!document.querySelector('.task-form')&&document.activeElement?.textContent==='+ Nova tarefa'`)
    && (await run.tasks()).tasks.length === 0);
  await run.key(a, 'Escape', 27);
  await run.until(() => a.eval(`!document.querySelector('.task-panel')`), 'floating task context closed');
  await run.until(() => a.eval(`document.activeElement?.textContent==='Tarefas'`), 'floating origin focus restored after animation frame');
  run.check('Release second Escape returns focus to floating tasks control', await a.eval(`document.activeElement?.textContent==='Tarefas'`));
  // A completed row can disappear while focused, leaving BODY active.
  // Navigate with actual Tab input into the Central before testing its scoped Escape.
  for (let step = 0; step < 24 && !await d.eval(`!!document.activeElement?.closest('.command-center')`); step++) {
    await run.key(d, 'Tab', 9);
  }
  run.check('Release keyboard navigation reaches Central before scoped Escape', await d.eval(`!!document.activeElement?.closest('.command-center')`));
  await run.key(d, 'Escape', 27);
  await run.until(() => d.eval(`!document.querySelector('.task-panel')`), 'Central task context closed');
  run.check('Release closing task panel restores Central core and origin focus', await d.eval(`!document.querySelector('.command-core-region').hidden&&document.activeElement?.textContent==='Tarefas'`));
}

async function main() {
  const [fixtureRoot, releaseRoot] = process.argv.slice(2);
  if (!fixtureRoot || !releaseRoot) throw Error('Usage: node scripts/validate-conversation-windows.mjs <fixtureRoot> <releaseRoot>');
  const preparations = [verifyPreparedRoot(fixtureRoot, 'fixture'), verifyPreparedRoot(releaseRoot, 'release')];
  if (preparations[0].root === preparations[1].root || inside(preparations[0].root, preparations[1].root)
    || inside(preparations[1].root, preparations[0].root)) throw Error('Fixture and release roots must be separate');
  for (const [index, prepared] of preparations.entries()) {
    const run = new NativeConversationRun(prepared, 9284 + index);
    try {
      await run.launch();
      if (prepared.mode === 'fixture') await fixtureScenarios(run); else await releaseScenarios(run);
      await run.normalExit();
      run.report.finishedAt = new Date().toISOString();
      run.report.passed = run.report.scenariosComplete && run.report.normalExit && run.report.checks.every(check => check.passed);
      run.persist();
      console.log(JSON.stringify({ mode: prepared.mode, passed: run.report.passed, checks: run.report.checks.length }));
    } catch (error) {
      await run.closeAfterFailure(error);
      throw error;
    } finally { run.closeClients(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
