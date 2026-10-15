'use strict';
// Fetches read-only GitHub evidence. Credentials never leave memory or appear in reports.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { sha, digest, sourceEvidence, verify } = require('./acceptance-evidence');
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
async function main() {
  const args = process.argv.slice(2),
    ids = args.slice(0, 5),
    nativeId = args[5];
  if (![5, 6].includes(args.length) || !args.every((id) => /^\d+$/.test(id)))
    throw Error(
      'Expected regression, policy, split, XMUX, mixed and optional native lifecycle run IDs.',
    );
  const remote = git('remote', 'get-url', 'origin').trim();
  assert.match(remote, /github\.com[/:]maz-1\/js2ray(?:\.git)?$/);
  const credential = process.env.GITHUB_TOKEN
    ? undefined
    : execFileSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
        windowsHide: true,
      });
  const token =
    process.env.GITHUB_TOKEN ??
    credential
      ?.split('\n')
      .find((line) => line.startsWith('password='))
      ?.slice(9);
  if (!token) throw Error('Missing GitHub credential.');
  async function api(endpoint, mode = 'json') {
    for (let attempt = 0; attempt < 4; attempt++)
      try {
        const r = await fetch('https://api.github.com/repos/maz-1/js2ray/' + endpoint, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(45000),
        });
        if (!r.ok) {
          await r.body?.cancel();
          throw Error('GitHub HTTP ' + r.status);
        }
        return mode === 'json'
          ? await r.json()
          : mode === 'text'
            ? await r.text()
            : Buffer.from(await r.arrayBuffer());
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
  }
  const runs = await Promise.all(ids.map((id) => api(`actions/runs/${id}`)));
  for (const run of runs) {
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'success');
  }
  const jobs = await Promise.all(ids.map((id) => api(`actions/runs/${id}/jobs?per_page=100`)));
  for (const data of jobs) {
    assert.equal(data.jobs.length, 3);
    for (const job of data.jobs) assert.equal(job.conclusion, 'success');
  }
  fs.mkdirSync('test-results', { recursive: true });
  const source = sourceEvidence();
  for (const run of runs)
    for (const [file, value] of Object.entries(source.sources))
      assert.equal(
        sha(git('show', `${run.head_sha}:${file}`).replace(/\r\n/g, '\n')),
        value,
        `${file}: source mismatch`,
      );
  const regressionJobs = await Promise.all(
    jobs[0].jobs.map(async (job) => {
      for (const name of [
        'Run npm run check',
        'Run npm run check:types',
        'Run npm run format:check',
        'Run npm run check:config',
        'Run unit tests (serial files)',
        'Run npm run test:tools',
        'Run npm run test:interop',
        'Run npm run test:package',
        'Record HTTP3 runtime capability (informational)',
      ])
        assert.ok(
          job.steps.some((step) => step.name === name && step.conclusion === 'success'),
          name,
        );
      const log = await api(`actions/jobs/${job.id}/logs`, 'text');
      fs.writeFileSync(`test-results/p20-job-${job.id}.log`, log);
      const counts = (field) =>
        [...log.matchAll(new RegExp('(?:ℹ|#) ' + field + ' (\\d+)\\s*(?=\\r?\\n|$)', 'g'))].map(
          (match) => Number(match[1]),
        );
      const tests = counts('tests');
      assert.equal(tests.length, 2);
      assert.ok(tests[0] >= 372 && tests[1] >= 228);
      assert.deepEqual(counts('pass'), tests);
      for (const field of ['fail', 'cancelled', 'skipped']) assert.deepEqual(counts(field), [0, 0]);
      const packed =
        /\{"ok":true,"version":"4\.0\.0-dev\.0","packageFiles":(\d+),"nativeRuntimeAssets":0\}/.exec(
          log,
        );
      assert.ok(packed);
      return {
        id: job.id,
        name: job.name,
        url: job.html_url,
        conclusion: job.conclusion,
        unit: { tests: tests[0], pass: tests[0], fail: 0, cancelled: 0, skipped: 0 },
        interoperability: { tests: tests[1], pass: tests[1], fail: 0, cancelled: 0, skipped: 0 },
        package: { files: Number(packed[1]), nativeRuntimeAssets: 0 },
      };
    }),
  );
  async function load(index) {
    const kind = ['policy', 'xhttp-split', 'xmux', 'transport'][index - 1],
      run = runs[index],
      data = await api(`actions/runs/${run.id}/artifacts?per_page=100`);
    assert.equal(data.artifacts.length, 3);
    const outputs = [];
    for (const artifact of data.artifacts) {
      assert.equal(artifact.expired, false);
      const bytes = await api(`actions/artifacts/${artifact.id}/zip`, 'bytes');
      if (artifact.digest) assert.equal('sha256:' + sha(bytes), artifact.digest);
      const directory = fs.mkdtempSync(path.resolve('test-results/p20-extract-')),
        zip = path.join(directory, 'artifact.zip'),
        out = path.join(directory, 'out');
      fs.writeFileSync(zip, bytes);
      fs.mkdirSync(out);
      const names = execFileSync('tar', ['-tf', zip], { encoding: 'utf8', windowsHide: true })
        .trim()
        .split(/\r?\n/);
      assert.deepEqual(names, [`${kind}-stability.json`]);
      execFileSync('tar', ['-xf', zip, '-C', out], { windowsHide: true });
      const raw = fs.readFileSync(path.join(out, `${kind}-stability.json`)),
        record = JSON.parse(raw);
      verify(record);
      assert.equal(record.commit, run.head_sha);
      assert.equal(record.node, 'v24.20.0');
      assert.equal(record.arch, 'x64');
      assert.ok(['win32', 'linux', 'darwin'].includes(record.platform));
      assert.ok(record.rotations >= 29);
      assert.ok(record.iterations > 0);
      assert.equal(record.dependenciesSha256, source.dependenciesSha256);
      assert.equal(record.packageSha256, source.packageSha256);
      const harness = kind === 'xhttp-split' ? 'xmux' : kind;
      assert.equal(record.harnessSha256, digest(`scripts/${harness}-stability.js`));
      assert.equal(
        record.closed.length,
        { policy: 8, 'xhttp-split': 16, xmux: 12, transport: 18 }[kind],
      );
      if (kind === 'policy') {
        assert.equal(record.phase, 'P20');
        assert.equal(record.faults, record.rotations * 4);
        assert.ok(record.dnsChecks > 0 && record.udpChecks > 0 && record.churn > 0);
      }
      if (kind === 'xhttp-split') {
        assert.equal(record.proxyFaults, record.rotations * 8);
        assert.equal(record.closedProxyProcesses.length, 4);
        assert.equal(record.proxyHarnessSha256, digest('test/fixtures/xhttp-proxy.js'));
      }
      if (kind === 'transport') assert.equal(record.coverFaults, record.rotations);
      if (kind === 'xmux' || kind === 'xhttp-split') {
        assert.ok(record.poolCounters.retired > 0);
        assert.equal(record.poolCounters.failures, 0);
      }
      const filename = `docs/acceptance/p20-${kind}-stability-${record.platform}-2026-10-16.json`;
      fs.writeFileSync(filename, raw);
      const runner =
          record.platform === 'win32'
            ? 'windows'
            : record.platform === 'darwin'
              ? 'macos'
              : 'ubuntu',
        job = jobs[index].jobs.find((job) => job.name.includes(runner));
      assert.ok(job);
      outputs.push({
        platform: record.platform,
        id: job.id,
        url: job.html_url,
        artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest },
        raw: filename,
        rawSha256: sha(raw),
        elapsedMs: record.elapsedMs,
        iterations: record.iterations,
        bytes: record.bytes,
        rotations: record.rotations,
        churn: record.churn,
        faults: record.faults,
        udpChecks: record.udpChecks,
        dnsChecks: record.dnsChecks,
        proxyFaults: record.proxyFaults,
        coverFaults: record.coverFaults,
        peak: record.peak,
        closed: true,
      });
    }
    assert.deepEqual(outputs.map((item) => item.platform).sort(), ['darwin', 'linux', 'win32']);
    return {
      id: run.id,
      url: run.html_url,
      commit: run.head_sha,
      conclusion: run.conclusion,
      jobs: outputs,
    };
  }
  const [policy, split, xmux, transport] = await Promise.all([load(1), load(2), load(3), load(4)]);
  let nativeLifecycle;
  if (nativeId) {
    const run = await api(`actions/runs/${nativeId}`),
      data = await api(`actions/runs/${nativeId}/jobs?per_page=100`),
      artifacts = await api(`actions/runs/${nativeId}/artifacts?per_page=100`);
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'success');
    assert.equal(data.jobs.length, 1);
    assert.equal(artifacts.artifacts.length, 1);
    const job = data.jobs[0];
    assert.equal(job.conclusion, 'success');
    for (const [file, value] of Object.entries(source.sources))
      assert.equal(sha(git('show', `${run.head_sha}:${file}`).replace(/\r\n/g, '\n')), value);
    for (const file of ['test/xmux.test.js', '.github/workflows/http2-native-diagnostics.yml'])
      assert.equal(
        digest(file),
        sha(git('show', `${run.head_sha}:${file}`).replace(/\r\n/g, '\n')),
      );
    const log = await api(`actions/jobs/${job.id}/logs`, 'text');
    fs.writeFileSync(`test-results/p20-native-${job.id}.log`, log);
    for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
      const counts = [
        ...log.matchAll(new RegExp('# ' + field + ' (\\d+)\\s*(?=\\r?\\n|$)', 'g')),
      ].map((match) => Number(match[1]));
      assert.deepEqual(counts, Array(13).fill(['tests', 'pass'].includes(field) ? 41 : 0));
    }
    assert.match(log, /ERROR SUMMARY: 0 errors from 0 contexts/);
    const artifact = artifacts.artifacts[0];
    assert.equal(artifact.expired, false);
    assert.equal(artifact.name, 'http2-native-diagnostics');
    nativeLifecycle = {
      id: run.id,
      url: run.html_url,
      commit: run.head_sha,
      conclusion: run.conclusion,
      job: { id: job.id, url: job.html_url },
      artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest },
      logSha256: sha(log),
      sourceSha256: source.sourceSha256,
      testSha256: digest('test/xmux.test.js'),
      workflowSha256: digest('.github/workflows/http2-native-diagnostics.yml'),
      normalWorkerRuns: 12,
      testsPerRun: 41,
      nativeMemoryErrors: 0,
    };
  }
  const harnessFiles = [
    'scripts/acceptance-evidence.js',
    'scripts/policy-stability.js',
    'scripts/transport-stability.js',
    'scripts/xmux-stability.js',
    'scripts/xhttp-split-stability.js',
    'scripts/install-reference-proxies.js',
    'test/helpers.js',
    'test/interop/helpers.js',
    'test/fixtures/dns-server.js',
    'test/fixtures/xhttp-proxy.js',
    'test/fixtures/caddy.js',
    'test/fixtures/reference-proxies.json',
    'test/fixtures/vision.js',
    'test/fixtures/reality.js',
    'test/fixtures/tls/cert.pem',
    'test/fixtures/tls/key.pem',
    'test/fixtures/reference-platforms.json',
    'test/fixtures/reference-cores.json',
    'test/fixtures/policy-references.json',
    'package-lock.json',
    'package.json',
  ];
  for (const file of harnessFiles)
    for (const run of runs)
      assert.equal(
        digest(file),
        sha(git('show', `${run.head_sha}:${file}`).replace(/\r\n/g, '\n')),
        file,
      );
  let privacy = { performed: false };
  if (fs.existsSync('v2ray-config.json')) {
    const report = JSON.parse(
      execFileSync(process.execPath, ['scripts/check-private.js', 'v2ray-config.json'], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
    assert.equal(report.ok, true);
    privacy = {
      performed: true,
      filesChecked: report.filesChecked,
      historyBlobsChecked: report.historyBlobsChecked,
      matches: 0,
    };
  }
  const result = {
    phase: 'P20',
    date: '2026-10-16',
    node: '24.20.0',
    ...source,
    harnessSources: Object.fromEntries(harnessFiles.map((file) => [file, digest(file)])),
    references: require('../test/fixtures/reference-cores.json'),
    regression: {
      id: runs[0].id,
      url: runs[0].html_url,
      commit: runs[0].head_sha,
      conclusion: runs[0].conclusion,
      jobs: regressionJobs,
    },
    policyStability: policy,
    splitStability: split,
    xmuxStability: xmux,
    transportStability: transport,
    ...(nativeLifecycle ? { nativeLifecycle } : {}),
    privacy,
  };
  fs.writeFileSync('docs/acceptance/p20-2026-10-16.json', JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(
    JSON.stringify({
      ok: true,
      sourceFiles: Object.keys(source.sources).length,
      sourceSha256: source.sourceSha256,
      runs: ids,
      rawArtifacts: 12,
    }) + '\n',
  );
}
main().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
