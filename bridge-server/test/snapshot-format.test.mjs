// snapshot-format.test.mjs — П1-5: сервер раскрывает свёрнутые диапазоны
// `[e12..e61] …` в refs (gated-классификация не должна слепнуть на свёртке).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshotRefs, classifyElement } from '../src/classifier.ts';

test('parseSnapshotRefs: диапазон [e12..e61] раскрывается поштучно', () => {
  const snap = [
    'url: http://x',
    'title: t',
    '[e12..e61] button "Купить" ×50',
  ].join('\n');
  const refs = parseSnapshotRefs(snap);
  assert.equal(refs.size, 50);
  assert.equal(refs.get('e12').text, 'Купить');
  assert.equal(refs.get('e61').role, 'button');
  // Классификатор видит gated-категорию и в середине диапазона.
  assert.equal(classifyElement(refs.get('e30')), 'pay');
});

test('parseSnapshotRefs: обычные строки не затронуты', () => {
  const snap = [
    '[e1] link "Войти" → /login',
    '[e2] textbox name=q placeholder="Поиск" value=""',
    '[e3..e4] broken range ignored text', // role не буквенный? нет: "broken" буквенный — раскроется
  ].join('\n');
  const refs = parseSnapshotRefs(snap);
  assert.equal(refs.get('e1').href, '/login');
  assert.equal(refs.get('e2').attrs.name, 'q');
  assert.equal(refs.get('e2').attrs.placeholder, 'Поиск');
  assert.ok(refs.has('e3') && refs.has('e4'));
});

// Д4: describe() (extension/src/snapshot.js) помечает type=submit/password —
// классификатор обязан увидеть gated-категорию по этим битам.
test('Д4: type=submit на кнопке → gated submit', () => {
  const refs = parseSnapshotRefs('[e5] button "Войти" type=submit');
  assert.equal(refs.get('e5').attrs.type, 'submit');
  assert.equal(classifyElement(refs.get('e5')), 'submit');
});

test('Д4: type=password → gated login, значение замаскировано', () => {
  const refs = parseSnapshotRefs(
    '[e7] textbox name=pwd type=password placeholder="Пароль" value="***"'
  );
  const meta = refs.get('e7');
  assert.equal(meta.attrs.type, 'password');
  assert.equal(classifyElement(meta), 'login');
  assert.equal(meta.attrs.value, '***');
  assert.ok(!JSON.stringify(meta).includes('s3cret'));
});
