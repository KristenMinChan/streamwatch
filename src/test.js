// Offline tests for the pure logic in Code.gs. Runs under node, touches no network.
//   node test.js
//
// Every fixture below is synthetic. Nothing here came from a real channel.
const fs = require('fs');

global.Utilities = {
  formatDate(d, tz, fmt) {
    if (fmt === 'yyyy-MM-dd') return d.toISOString().slice(0, 10);
    if (fmt === 'u') return String(((d.getUTCDay() + 6) % 7) + 1);
    return d.toISOString();
  },
};
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) };
global.MailApp = { sendEmail: () => {} };
global.Logger = { log: () => {} };
global.UrlFetchApp = {};
global.XmlService = {};

const src = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
eval(src.replace(/^const /gm, 'var '));

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label);
  if (!ok) { console.log('       got  ' + JSON.stringify(got)); console.log('       want ' + JSON.stringify(want)); }
}

console.log('\ntitle normalization');
check('latin first -> CJK run moved to the front',
  normalizeTitle_('ORGNAME Weekly Message: Opening Remarks and Introduction 開場致詞與介紹').title,
  '開場致詞與介紹 Opening Remarks and Introduction');
check('CJK already first -> untouched, ft. stays last',
  normalizeTitle_('ORGNAME Weekly Message: 第二場主題分享 Second Topic Session ft. Guest').title,
  '第二場主題分享 Second Topic Session ft. Guest');
check('CJK with full-width punctuation',
  normalizeTitle_('ORGNAME Weekly Message: 主題三－延伸討論？ Topic Three, Extended Discussion?').title,
  '主題三－延伸討論？ Topic Three, Extended Discussion?');
check('latin first -> swapped',
  normalizeTitle_('ORGNAME Weekly Message: Clear Water Runs Deep 靜水流深').title,
  '靜水流深 Clear Water Runs Deep');
check('full-width colon in the prefix is stripped too',
  normalizeTitle_('ORGNAME Weekly Message：Alignment and Focus').title, 'Alignment and Focus');
// A one-off title carries no prefix and is already in the wanted order.
check('one-off title (CJK already first) -> untouched',
  normalizeTitle_('2026 秋季特別聚會 Autumn Gathering - Session 1').title,
  '2026 秋季特別聚會 Autumn Gathering - Session 1');
check('latin-only title -> says it did not reorder',
  normalizeTitle_('ORGNAME Weekly Message: Alignment and Focus').notes,
  ['no CJK run found, not reordered']);

console.log('\nCJK detection (the character class that can break silently)');
check('a Latin word is not CJK', isCJK_('Growing'), false);
check('a CJK word is CJK', isCJK_('開場'), true);
check('an ideographic space is CJK', isCJK_('　'), true);
check('a normal space is not CJK', isCJK_(' '), false);

console.log('\ntagging (decides what goes in the email, not whether to send)');
check('recurring pattern -> recurring tag',
  kindOf_('ORGNAME Weekly Message: 開場致詞').tag, TAGS.recurring);
check('conference -> special tag',
  kindOf_('2026 秋季特別聚會 Autumn Gathering Conference - Session 1').tag, TAGS.special);
check('retreat -> special tag', kindOf_('Annual Retreat Day 2').tag, TAGS.special);
check('camp -> special tag', kindOf_('Summer Camp Session 3').tag, TAGS.special);
check('unrecognized -> ask the human',
  kindOf_('Choir Rehearsal Clips').tag, TAGS.unknown);
check('recurring wins over special when both match',
  kindOf_('ORGNAME Weekly Message: the first one after the conference').tag, TAGS.recurring);

console.log('\nreadiness, judged from structure');
const NOW = new Date('2026-09-05T23:00:00Z');
check('no liveStreamingDetails -> ready',
  readiness_({ liveStreamingDetails: undefined }, NOW).ready, true);
check('scheduled, not started -> wait',
  readiness_({ liveStreamingDetails: { scheduledStartTime: '2026-09-06T15:00:00Z' } }, NOW),
  { ready: false, ended: null, reason: 'scheduled, not started' });
check('live right now -> wait',
  readiness_({ liveStreamingDetails: { actualStartTime: '2026-09-05T22:00:00Z' } }, NOW).reason, 'live right now');
check('ended less than settleHours ago -> wait',
  readiness_({ liveStreamingDetails: { actualEndTime: '2026-09-05T22:00:00Z' } }, NOW).ready, false);
check('ended more than settleHours ago -> ready',
  readiness_({ liveStreamingDetails: { actualEndTime: '2026-09-05T19:00:00Z' } }, NOW).ready, true);

console.log('\nspeaker parsing');
check('speaker named in the description', speakerFrom_('Speaker: Avery|other text').name, 'Avery');
check('full-width colon', speakerFrom_('Presenter：Morgan\nnext line').name, 'Morgan');
check('capture stops at whitespace (names with spaces need a wider pattern)',
  speakerFrom_('Speaker: Avery Lee').name, 'Avery');
check('absent -> default, and the caller is told',
  speakerFrom_('Opening music, nobody named'), { name: CONFIG.defaultSpeaker, fromDesc: false });

console.log('\nevent day derived from the end timestamp');
check('ended midday on the event day', eventDayOf_(new Date('2026-08-16T17:20:00Z')), '2026-08-16');
check('ended after local midnight', eventDayOf_(new Date('2026-08-17T02:00:00Z')), '2026-08-16');
check('a Saturday item rolls back to its week', eventDayOf_(new Date('2026-09-05T20:00:00Z')), '2026-08-30');

console.log('\nvideo id parsing (used by sendManual)');
['https://www.youtube.com/watch?v=AbC123_dEf-&t=1s',
 'https://youtu.be/AbC123_dEf-',
 'https://www.youtube.com/live/AbC123_dEf-?si=xyz',
 'https://www.youtube.com/embed/AbC123_dEf-',
 'AbC123_dEf-'].forEach(u => check(u.slice(0, 46), videoIdFrom_(u), 'AbC123_dEf-'));

console.log('\nhandled list');
(function () {
  const list = ['c', 'b', 'a'];
  const after = ['d'].concat(list.filter(x => x !== 'd'));
  check('newest goes first', after, ['d', 'c', 'b', 'a']);
  const again = ['b'].concat(after.filter(x => x !== 'b'));
  check('a repeat moves to the front, never duplicates', again, ['b', 'd', 'c', 'a']);
  const long = Array.from({ length: 70 }, (_, i) => 'v' + i);
  check('capped at notifiedKeep', long.slice(0, CONFIG.notifiedKeep).length, CONFIG.notifiedKeep);
})();

console.log('\nwhy a time watermark missed an item (reproduced from the real incident)');
(function () {
  // A stream created two days before it aired. Its `published` never moved.
  const late = { published: new Date('2026-09-04T22:46:48Z'), updated: new Date('2026-09-06T18:08:43Z') };
  const watermark = new Date('2026-09-05T18:24:49Z');   // set from a later item's `published`
  check('published is behind the watermark -> the old design never saw it',
    late.published > watermark, false);
  check('it did not actually air until the 6th -> an id list catches it',
    late.updated > watermark, true);
})();

console.log('\n' + (fail ? fail + ' FAILED (' + pass + ' passed)' : 'all ' + pass + ' passed') + '\n');
process.exit(fail ? 1 : 0);
