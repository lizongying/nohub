import test from 'node:test';
import assert from 'node:assert/strict';
import { listRepoVersions, resolveRepoVersion, parseLsRemote } from '../lib/git.mjs';

const SHA = (c) => c.repeat(40);

test('parseLsRemote：解析 ref 与默认分支', () => {
  const { refs, defaultBranch } = parseLsRemote(
    [
      `ref: refs/heads/main\tHEAD`,
      `${SHA('a')}\tHEAD`,
      `${SHA('a')}\trefs/heads/main`,
      `${SHA('b')}\trefs/tags/v0.4.27`,
      `${SHA('c')}\trefs/tags/v0.4.27^{}`,
      `${SHA('d')}\trefs/tags/v0.4.28`,
      `${SHA('e')}\trefs/tags/llvm-22.1.8-darwin-x64`,
    ].join('\n'),
  );

  assert.equal(defaultBranch, 'main');
  assert.equal(refs.get('refs/tags/v0.4.27'), SHA('b'));
  // peeled 行也在 refs 里
  assert.equal(refs.get('refs/tags/v0.4.27^{}'), SHA('c'));
});

test('listRepoVersions：返回全部语义化 tag，按语义化版本升序', () => {
  const refs = new Map([
    ['HEAD', SHA('a')],
    ['refs/heads/main', SHA('a')],
    ['refs/tags/v0.4.28', SHA('d')],
    ['refs/tags/v0.4.9', SHA('e')],
    ['refs/tags/v0.4.10', SHA('f')],
    ['refs/tags/v0.2.0', SHA('b')],
    ['refs/tags/llvm-22.1.8-darwin-x64', SHA('c')],
    ['refs/tags/v1.0.0-rc.1', SHA('1')],
    ['refs/tags/v1.0.0', SHA('2')],
  ]);

  const versions = listRepoVersions(refs);
  assert.deepEqual(
    versions.map((v) => v.version),
    ['v0.2.0', 'v0.4.9', 'v0.4.10', 'v0.4.28', 'v1.0.0-rc.1', 'v1.0.0'],
  );
  // 预发布版本低于同号的正式版本
  assert.equal(versions[versions.length - 1].version, 'v1.0.0');
  assert.equal(versions[versions.length - 1].commit, SHA('2'));
});

test('listRepoVersions：annotated tag 取 peeled commit', () => {
  const refs = new Map([
    ['refs/tags/v0.1.0', SHA('a')],
    ['refs/tags/v0.1.0^{}', SHA('b')],
  ]);
  const versions = listRepoVersions(refs);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].commit, SHA('b'));
  assert.equal(versions[0].ref, 'v0.1.0');
});

test('listRepoVersions：忽略非语义化 tag 与 peeled 行', () => {
  const refs = new Map([
    ['refs/tags/latest', SHA('a')],
    ['refs/tags/v0.4.28^{}', SHA('b')],
    ['refs/tags/v0.4.28', SHA('c')],
  ]);
  const versions = listRepoVersions(refs);
  assert.deepEqual(versions.map((v) => v.version), ['v0.4.28']);
});

test('resolveRepoVersion：取最新语义化 tag', () => {
  const refs = new Map([
    ['refs/heads/main', SHA('a')],
    ['refs/tags/v0.4.27', SHA('b')],
    ['refs/tags/v0.4.28', SHA('c')],
  ]);
  assert.deepEqual(resolveRepoVersion(refs, 'main'), {
    version: 'v0.4.28',
    commit: SHA('c'),
    tag: 'v0.4.28',
    ref: 'v0.4.28',
  });
});

test('resolveRepoVersion：无 tag 时退化为分支 HEAD 短 SHA', () => {
  const refs = new Map([
    ['HEAD', SHA('a')],
    ['refs/heads/main', SHA('a')],
  ]);
  assert.deepEqual(resolveRepoVersion(refs, 'main'), {
    version: SHA('a').slice(0, 7),
    commit: SHA('a'),
    tag: null,
    ref: 'main',
  });
});

test('resolveRepoVersion：既无 tag 也无 HEAD 时返回空', () => {
  assert.deepEqual(resolveRepoVersion(new Map(), 'main'), {
    version: null,
    commit: null,
    tag: null,
    ref: 'main',
  });
});
