import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNoml, stringifyNoml } from '../lib/noml.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('解析 examples/ 下的四份清单', () => {
  for (const rel of [
    'examples/workspace.noml',
    'examples/package.noml',
    'examples/latest.noml',
    'examples/repos/github.com/lizongying.noml',
  ]) {
    const doc = parseNoml(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.ok(doc !== null && doc !== undefined, `${rel} 应可解析`);
  }
});

test('解析：字符串转义、nil、数字、嵌套、尾随逗号', () => {
  const doc = parseNoml(`{
  a: 'x\\'y\\\\z\\n\\t\\r'
  b: nil
  c: -1.5e3
  d: [1, 2.5, true, false, nil,]
  e: { f: 'g' }
}`);
  assert.equal(doc.a, "x'y\\z\n\t\r");
  assert.equal(doc.b, null);
  assert.equal(doc.c, -1500);
  assert.deepEqual(doc.d, [1, 2.5, true, false, null]);
  assert.deepEqual(doc.e, { f: 'g' });
});

test('解析：行注释、块注释、注解', () => {
  const doc = parseNoml(`{
  ; 行注释
  a: 'v' ; 尾随注释
  ;; 块注释开始
  这行不是 noml，只是注释
  ;;
  #{key = 'value', n = 1}
  b: 2
  c: 'ann-tail' #{x = 'y'}
}`);
  assert.deepEqual(doc, { a: 'v', b: 2, c: 'ann-tail' });
});

test('解析：顶层数组、字符串键、空集合', () => {
  const doc = parseNoml(`[
  'nolang',
  {
    name: 'notools'
    branch: 'dev'
  },
]`);
  assert.equal(doc.length, 2);
  assert.equal(doc[0], 'nolang');
  assert.equal(doc[1].name, 'notools');
  assert.deepEqual(parseNoml('[]'), []);
  assert.deepEqual(parseNoml('{}'), {});
});

test('拒绝 null 与非法值', () => {
  assert.throws(() => parseNoml('{ a: null }'));
  assert.throws(() => parseNoml('{ a: \'unclosed }'));
  assert.throws(() => parseNoml('{ a: 1 } trailing'));
});

test('格式化与 no fmt 风格一致', () => {
  const text = stringifyNoml([
    'glossary:v0.4.28@github.com/lizongying/nolang',
    'nogit:v0.1.35@github.com/lizongying/notools',
  ]);
  assert.equal(
    text,
    `[
  'glossary:v0.4.28@github.com/lizongying/nolang',
  'nogit:v0.1.35@github.com/lizongying/notools',
]`,
  );

  assert.equal(
    stringifyNoml({ version: 'v0.4.28', commit: 'abc1234' }),
    `{
  version: 'v0.4.28'
  commit: 'abc1234'
}`,
  );

  assert.equal(stringifyNoml({ a: [], b: {} }), `{
  a: []
  b: {}
}`);
  assert.equal(stringifyNoml({ 'github.com/o/r': { x: 'y' } }), `{
  'github.com/o/r': {
    x: 'y'
  }
}`);

  // 数组嵌套在对象里、对象嵌套在数组里，缩进规则与 no fmt 一致（每层 2 空格）
  assert.equal(
    stringifyNoml({ nested: { list: ['one', 'two'], deep: { k: 'v' } }, objs: [{ a: '1' }] }),
    `{
  nested: {
    list: [
      'one',
      'two',
    ]
    deep: {
      k: 'v'
    }
  }
  objs: [
    {
      a: '1'
    },
  ]
}`,
  );
});

test('round-trip：parse → stringify → parse 结果一致', () => {
  const src = fs.readFileSync(path.join(ROOT, 'examples/package.noml'), 'utf8');
  const once = parseNoml(src);
  const text = stringifyNoml(once);
  assert.deepEqual(parseNoml(text), once);
});
