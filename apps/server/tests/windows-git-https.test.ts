import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { childEnvironment } from '../src/runtime/program-launch.js';
import { DatabaseSync } from 'node:sqlite';
import { GitPublishService } from '../src/application/git-publish-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { INBOX_MIGRATION, SqliteInboxRepository } from '../src/storage/sqlite-inbox-repository.js';
const runGit = promisify(execFile);

async function httpsGit(root: string, authorization?: string) {
  const git = (cwd: string, ...args: string[]) => execFileSync('git.exe', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const gitCore = git(root, '--exec-path');
  const openssl = resolve(gitCore, '..', '..', 'bin', 'openssl.exe');
  const key = join(root, 'key.pem'), certificate = join(root, 'certificate.pem');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', '-q', remote);
  git(remote, 'config', 'http.receivepack', 'true');
  const server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    if (authorization && request.headers.authorization !== authorization) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Multivac test"' }); response.end(); return;
    }
    const target = new URL(request.url ?? '/', 'https://127.0.0.1');
    const backend = spawn('git.exe', ['http-backend'], {
      env: { ...childEnvironment(process.env, 'win32'), GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: target.pathname, QUERY_STRING: target.search.slice(1), REQUEST_METHOD: request.method ?? 'GET',
        CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: request.headers['content-length'] ?? '',
        GIT_PROTOCOL: request.headers['git-protocol'] ?? '', REMOTE_USER: 'fixture' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    request.pipe(backend.stdin);
    backend.stdout.on('data', chunk => chunks.push(chunk));
    backend.stderr.on('data', chunk => errors.push(chunk));
    backend.once('close', code => {
      if (code !== 0) { response.writeHead(500); response.end(Buffer.concat(errors)); return; }
      const output = Buffer.concat(chunks);
      const separator = output.indexOf('\r\n\r\n');
      if (separator < 0) { response.writeHead(500); response.end('Git CGI headers missing'); return; }
      let status = 200;
      for (const line of output.subarray(0, separator).toString('utf8').split('\r\n')) {
        const match = /^([^:]+):\s*(.*)$/u.exec(line);
        if (!match) continue;
        if (match[1]!.toLowerCase() === 'status') status = Number(match[2]!.slice(0, 3));
        else response.setHeader(match[1]!, match[2]!);
      }
      response.writeHead(status);
      response.end(output.subarray(separator + 4));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { git, certificate, remote, url: `https://127.0.0.1:${port}/remote.git`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('Windows 本机 HTTPS Git 可使用受信自签证书发布新分支', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-git-https-'));
  const fixture = await httpsGit(root);
  try {
    const work = join(root, 'work');
    fixture.git(root, 'init', '-q', work);
    await writeFile(join(work, 'result.txt'), '固定交付');
    fixture.git(work, 'add', '.');
    fixture.git(work, '-c', 'user.name=验收', '-c', 'user.email=test@example.invalid', 'commit', '-qm', '固定交付');
    const commit = fixture.git(work, 'rev-parse', 'HEAD');
    await runGit('git.exe', ['-c', `http.sslCAInfo=${fixture.certificate}`, 'push', fixture.url, `${commit}:refs/heads/windows-acceptance`], { cwd: work, timeout: 15_000 });
    const { stdout } = await runGit('git.exe', ['-c', `http.sslCAInfo=${fixture.certificate}`, 'ls-remote', '--refs', fixture.url, 'refs/heads/windows-acceptance'], { cwd: work, timeout: 15_000 });
    assert.match(stdout, new RegExp(`^${commit}\\s`));
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test('Windows 本机 HTTPS 发布经过申请、拒绝、批准、固定版本及未知结果核对', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-publish-https-'));
  const fixture = await httpsGit(root, `Basic ${Buffer.from('fixture:local-test-only').toString('base64')}`);
  const db = new DatabaseSync(':memory:'); db.exec(INBOX_MIGRATION);
  const repository = new SqliteInboxRepository(db);
  try {
    const work = join(root, 'work'), home = join(root, 'git-home'), credentials = join(home, 'credentials');
    await mkdir(home);
    await writeFile(credentials, `https://fixture:local-test-only@127.0.0.1:${new URL(fixture.url).port}\n`);
    await writeFile(join(home, '.gitconfig'), `[http]\n\tsslBackend = openssl\n\tsslCAInfo = ${fixture.certificate.replaceAll('\\', '/')}\n`);
    fixture.git(root, 'init', '-q', work);
    await writeFile(join(work, 'result.txt'), '固定交付');
    fixture.git(work, 'add', '.');
    fixture.git(work, '-c', 'user.name=验收', '-c', 'user.email=test@example.invalid', 'commit', '-qm', '固定交付');
    fixture.git(work, 'remote', 'add', 'origin', fixture.url);
    const source = () => ({ directory: work, taskId: null, canPublish: true });
    const environment = { ...process.env, HOME: home, USERPROFILE: home };
    const events = new WorkbenchEvents();
    const helper = `store --file=${credentials.replaceAll('\\', '/')}`;
    await runGit('git.exe', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'ls-remote', fixture.url], {
      cwd: work, env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }, timeout: 15_000,
    });
    const service = new GitPublishService(repository, events, source, false, 'win32', environment, helper);
    const denied = await service.propose('s', 'denied', { remote: 'origin', branch: 'denied' });
    assert.equal(denied.status, 'pending');
    assert.equal((await service.decide(denied.id, { commandId: 'deny', revision: denied.revision, decision: 'deny' })).status, 'denied');
    const proposal = await service.propose('s', 'publish', { remote: 'origin', branch: 'deliver' });
    const decision = { commandId: 'approve', revision: proposal.revision, decision: 'once' as const };
    const published = await service.decide(proposal.id, decision);
    assert.equal(published.status, 'succeeded', published.result);
    assert.equal((await service.decide(proposal.id, decision)).status, 'succeeded');
    const existing = await service.propose('s', 'existing', { remote: 'origin', branch: 'deliver' });
    assert.equal((await service.decide(existing.id, { ...decision, commandId: 'existing', revision: existing.revision })).status, 'invalidated');
    const stale = await service.propose('s', 'stale', { remote: 'origin', branch: 'stale' });
    await writeFile(join(work, 'result.txt'), '新的本地版本');
    fixture.git(work, 'add', '.');
    fixture.git(work, '-c', 'user.name=验收', '-c', 'user.email=test@example.invalid', 'commit', '-qm', '新版本');
    assert.equal((await service.decide(stale.id, { ...decision, revision: stale.revision })).status, 'invalidated');
    repository.saveOperation({ ...published, status: 'executing' });
    const restarted = new GitPublishService(repository, events, source, false, 'win32', environment, helper);
    assert.equal(restarted.get(published.id).status, 'unknown');
    assert.equal((await restarted.reconcile(published.id)).status, 'succeeded');
  } finally { db.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
