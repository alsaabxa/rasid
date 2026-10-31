'use strict';
// قياس القراءات: الاستطلاع القديم (fixtures/polling-sync.js) مقابل المستمع الجديد، على الخادم المُحاكى نفسه.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FakeServer } = require('./helpers/fake-firestore');
const { createDevice } = require('./helpers/load-app');

const POLLING = fs.readFileSync(path.join(__dirname, 'fixtures', 'polling-sync.js'), 'utf8');
const HOUR = 60 * 60 * 1000;
const SCHOOL = { students: 500, classes: 20, attendance: 200 };   // ≈ 720 مستندًا

async function scenario(old) {
  const server = new FakeServer();
  server.seedSchool('S1', SCHOOL);
  const writer = createDevice(server, 'W', 'S1');                         // جهاز يحرّر
  const idle = createDevice(server, 'I', 'S1', { extraFixture: old ? POLLING : '' }); // جهاز مفتوح فقط
  await writer.login(); await idle.login();
  server.resetCounters();
  const loginReads = {};
  // ساعة واحدة: W يحفظ 12 تعديلًا (مرة كل 5 دقائق)، I مفتوح يراقب
  for (let i = 0; i < 12; i++) {
    await writer.edit(st => { st.students[i].name = 'تعديل ' + i; });
    await idle.clock.advance(5 * 60 * 1000);
    await writer.clock.advance(0);
  }
  return { server, idle, reads: server.reads.I || 0, queries: server.queries.I || 0 };
}

test('قراءات جهاز مفتوح ساعة كاملة مع 12 تعديلًا من جهاز آخر: الجديد أقل بكثير', async () => {
  const oldRun = await scenario(true);
  const newRun = await scenario(false);
  console.log(`\n  مدرسة ≈ 720 مستندًا، ساعة واحدة، 12 تعديلًا من جهاز آخر:`);
  console.log(`  الاستطلاع القديم: ${oldRun.reads} قراءة (${oldRun.queries} استعلام)`);
  console.log(`  المستمع الجديد : ${newRun.reads} قراءة (${newRun.queries} استعلام)`);
  console.log(`  النسبة: ${(oldRun.reads / Math.max(1, newRun.reads)).toFixed(0)}× أقل\n`);
  assert.ok(newRun.reads <= 12 * 3 + 12, `الجديد ≈ مستند السجل + appMeta لكل تعديل (+ عدّاد الرسائل): ${newRun.reads}`);
  assert.ok(oldRun.reads > newRun.reads * 20, `القديم أكثر بكثير: ${oldRun.reads} مقابل ${newRun.reads}`);
  // وصلت التعديلات الـ12 فعلًا في الحالتين
  for (const r of [oldRun, newRun]) assert.equal(r.idle.store.students[11].name, 'تعديل 11');
});

test('جهاز خامل ساعة بلا أي تعديل: صفر قراءات من private', async () => {
  const server = new FakeServer(); server.seedSchool('S1', SCHOOL);
  const d = createDevice(server, 'I', 'S1'); await d.login();
  server.resetCounters();
  await d.clock.advance(HOUR);
  const priv = server.log.filter(x => x.device === 'I' && x.path.includes('/private') && x.op !== 'listen');
  assert.equal(priv.length, 0);
  assert.ok((server.reads.I || 0) <= 12 + 1, 'فقط عدّاد الرسائل (≈ مرة كل 5 دقائق)');
});

test('تعديل واحد على مدرسة 720 مستندًا: يقرأ الجهاز الآخر مستندين لا المجموعة كلها', async () => {
  const server = new FakeServer(); server.seedSchool('S1', SCHOOL);
  const w = createDevice(server, 'W', 'S1'), i = createDevice(server, 'I', 'S1');
  await w.login(); await i.login();
  server.resetCounters();
  await w.edit(st => { st.students[7].name = 'واحد'; });
  assert.equal(server.reads.I || 0, 2, 'سجل الطالبة + appMeta');
  assert.equal(i.store.students[7].name, 'واحد');
});

test('الاتصال الأولي: قراءة كل المستندات مرة واحدة فقط', async () => {
  const server = new FakeServer(); server.seedSchool('S1', SCHOOL);
  const d = createDevice(server, 'I', 'S1');
  await d.login();
  const total = 20 + 500 + 200 + 1;
  // سحب أولي (get) ثم اشتراك: التكلفة الأولية ≤ 2× حجم المدرسة (مرة للسحب ومرة للقطة الأولى)
  assert.ok((server.reads.I || 0) <= total * 2 + 5, `قراءات الدخول: ${server.reads.I}`);
  assert.equal(d.store.students.length, 500);
});

test('عدّاد الرسائل: 12 استعلامًا في الساعة بدل 180', async () => {
  for (const [old, expected] of [[false, 12], [true, 180]]) {
    const server = new FakeServer(); server.seedSchool('S1', { students: 1, classes: 1 });
    const d = createDevice(server, 'I', 'S1', { extraFixture: old ? POLLING : '' });
    await d.login();
    server.resetCounters();
    await d.clock.advance(HOUR);
    const msgQueries = server.log.filter(x => x.device === 'I' && x.path.endsWith('/messages')).length;
    assert.ok(Math.abs(msgQueries - expected) <= 1, `${old ? 'القديم' : 'الجديد'}: ${msgQueries} (المتوقع ≈ ${expected})`);
  }
});
