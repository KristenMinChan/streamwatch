/**
 * streamwatch — detect that a recording has finished publishing, and prepare
 * everything needed to republish it somewhere else.
 *
 * PUBLIC SNAPSHOT — taken 2026-10-14.
 * This is not the deployed file. The logic is the logic that runs in
 * production; every configured value below has been replaced by a placeholder.
 * See README.md ("Status") for why it is a snapshot rather than the source of
 * deployment, and METHOD.md for why each decision is the way it is.
 *
 * Readiness is judged by "does this item have complete content right now",
 * never by "which series is it" and never by "livestream or manual upload".
 * The series only decides which tag goes in the email.
 *
 * No time watermark. Reason, measured 2026-09-06:
 * for a scheduled livestream the feed's `published` freezes at the moment the
 * stream was *created* and never updates when it airs, so an item created on
 * one day and aired two days later sits permanently behind any watermark.
 * `updated` does move, but it also moves when a human edits the description
 * weeks later, which would re-send. So: read all 15 feed entries every run and
 * de-duplicate on a list of handled videoIds.
 * videos.list costs 1 quota unit whether you ask for 1 id or 50, so there is
 * nothing to save by asking for fewer.
 */

// ───────────────────────────────────────────────
// Configuration — everything you need to change is here
// ───────────────────────────────────────────────
const CONFIG = {
  channelId:      'UC_PUT_YOUR_CHANNEL_ID_HERE',   // from the channel URL
  mailTo:         'you@example.org',               // where packages are sent
  defaultSpeaker: 'Default Speaker',               // used when the description omits it; always flagged
  settleHours:    2,      // wait this long after actualEndTime, so the publisher can finish the description
  staleDays:      6,      // on the weekly check, alert if no recurring item in this many days
  minDescChars:   200,    // warn if the description is shorter than this
  notifiedKeep:   60,     // how many handled ids to retain (the feed returns 15, so 60 is ample)
  localOffsetHours: -5,   // your local offset, used to work out which event day a stream belongs to
  timeZone:       'America/Chicago',
  reportWeekday:  '1',    // ISO weekday the staleness check runs on (1 = Monday)
};

// Manual re-send: paste a video URL or id here, save, then run sendManual
const MANUAL_VIDEO = '';

// Title patterns. These decide only WHICH TAG goes in the email — never
// whether to notify. See METHOD.md §4: keywords are for labelling, structure
// is for gating. Replace with the naming your own publisher actually uses.
const RECURRING_RE = /\b(weekly\s*service|weekly\s*message)\b/i;
const SPECIAL_RE   = /\b(conference|retreat|camp|convention)\b/i;

// A prefix your publisher puts on every title, stripped before normalizing.
const PREFIX_RE = /^\s*ORGNAME\s*(?:Weekly\s*(?:Service|Message))?\s*[:：]\s*/i;

// Whatever word your publisher writes before the speaker's name in the
// description. One line of agreement with that person replaces an inference
// engine — METHOD.md §6.
// Note the capture stops at whitespace, which suits names written without
// spaces. If yours have spaces, widen it to [^|\uFF5C\n]+ and trim.
const SPEAKER_RE = /(?:Speaker|Presenter)\s*[:：]\s*([^\s|｜\n]+)/i;

// Tag values as your destination system spells them.
const TAGS = {
  recurring: 'Weekly Message',
  special:   'Special Event',
  unknown:   '? choose manually',
};

// Field labels and paths in your destination system, used to build the email.
const CMS = {
  path:        'Content → Articles → New',
  url:         'https://cms.example.org/#/content/article-create',
  siteUrl:     'https://www.example.org/messages',
  channelUrl:  'https://www.youtube.com/@your-channel/streams',
  coverMin:    '1196x672',
  fieldTag:    'TAG',
  fieldDate:   'DATE',
  fieldTitle:  'TITLE',
  fieldSpeaker:'SPEAKER',
  fieldVideo:  'EXTERNAL VIDEO LINK',
  fieldCover:  'COVER IMAGE',
  fieldBody:   'BODY',
  leaveBlank:  'Other fields: audio / video / document, duration, summary, location, time -> leave blank',
  defaults:    '              section -> default   status -> DRAFT   featured -> no',
};

const PROP_NOTIFIED  = 'notified';     // handled videoIds, newest first
const PROP_LAST_SEEN = 'lastRecurring';// when a recurring item was last packaged (ISO string)


// ───────────────────────────────────────────────
// Entry point: bind this to a time-driven trigger
// ───────────────────────────────────────────────
function checkForNewVideo() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const feed = fetchFeed_();                       // the 15 newest, per the feed
  let notified = loadNotified_();

  // First run: mark everything currently on the channel as handled, send nothing
  if (notified === null) {
    saveNotified_(feed.map(e => e.videoId));
    props.setProperty(PROP_LAST_SEEN, now.toISOString());
    MailApp.sendEmail(CONFIG.mailTo, '[streamwatch] setup complete',
      'The watcher is live.\n\nThe ' + feed.length + ' items currently on the channel have been\n' +
      'marked as handled, so you will only hear about new ones.\nThis message appears once.');
    Logger.log('first run, marked ' + feed.length + ' as handled');
    return;
  }

  // Look at all of them every time — videos.list costs 1 unit for 1 id or 50
  const todo = feed.map(e => e.videoId).filter(id => notified.indexOf(id) < 0);
  if (todo.length === 0) {
    Logger.log('nothing unhandled');
    maybeStaleAlert_();
    return;
  }

  const details = fetchDetails_(todo);

  // Oldest first, so emails arrive in an intuitive order
  const ordered = todo.slice().reverse();
  for (const id of ordered) {
    const d = details[id];
    if (!d) { Logger.log('not retrievable (private or deleted), skipping: ' + id); continue; }

    const r = readiness_(d, now);
    if (r.ready) {
      sendPackage_(d, r.ended, []);
      notified = markNotified_(notified, id);
    } else {
      // Not finished: do nothing at all. The next run sees it again, so there
      // is no extra state to keep.
      Logger.log('not ready (' + r.reason + '), will look again: ' + d.snippet.title);
    }
  }

  maybeStaleAlert_();
}


// ───────────────────────────────────────────────
// Readiness, judged from structure — METHOD.md §4
// ───────────────────────────────────────────────
function readiness_(d, now) {
  const lsd = d.liveStreamingDetails;

  if (!lsd) {
    return { ready: true, ended: null, reason: 'manual upload' };
  }
  if (!lsd.actualEndTime) {
    return { ready: false, ended: null,
             reason: lsd.actualStartTime ? 'live right now' : 'scheduled, not started' };
  }
  const ended = new Date(lsd.actualEndTime);
  if ((now - ended) / 3600000 < CONFIG.settleHours) {
    return { ready: false, ended: ended, reason: 'just ended, settling' };
  }
  return { ready: true, ended: ended, reason: 'livestream archive' };
}

/** The title picks the tag. It affects the email's contents, never whether to send. */
function kindOf_(title) {
  if (RECURRING_RE.test(title)) return { tag: TAGS.recurring, label: 'recurring', isRecurring: true };
  if (SPECIAL_RE.test(title))   return { tag: TAGS.special,   label: 'special',   isRecurring: false };
  return { tag: TAGS.unknown, label: 'item', isRecurring: false };
}


// ───────────────────────────────────────────────
// The handled list — this replaced a time watermark
//
// Keyed on videoId rather than time, because a scheduled livestream's
// `published` freezes when the stream is created and never updates when it
// airs, so anything bounded by time will miss it silently. METHOD.md §4.
// ───────────────────────────────────────────────

/** Returns an array; returns null if never initialized (that is how a first run is detected) */
function loadNotified_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_NOTIFIED);
  if (raw === null || raw === undefined) return null;
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}

function saveNotified_(list) {
  PropertiesService.getScriptProperties()
    .setProperty(PROP_NOTIFIED, JSON.stringify(list.slice(0, CONFIG.notifiedKeep)));
}

/** Record this one as handled; newest first, drop anything past the cap */
function markNotified_(list, id) {
  const next = [id].concat(list.filter(x => x !== id));
  saveNotified_(next);
  return next;
}


// ───────────────────────────────────────────────
// Manual override — METHOD.md §7. Anything the rules missed goes through here.
// ───────────────────────────────────────────────
function sendManual() {
  if (!MANUAL_VIDEO) {
    throw new Error('Put a video URL or id in MANUAL_VIDEO at the top of this file, save, then run again.');
  }
  const id = videoIdFrom_(MANUAL_VIDEO);
  const d = fetchDetails_([id])[id];
  if (!d) throw new Error('Cannot retrieve this video: ' + id + ' (private, or the id is wrong)');

  const r = readiness_(d, new Date());
  const extra = r.ready ? [] : ['This item is ' + r.reason + '; its content may be incomplete.'];
  sendPackage_(d, r.ended, extra);
  markNotified_(loadNotified_() || [], id);      // so the next scheduled run does not send it again
  Logger.log('manual send complete: ' + d.snippet.title);
}

function videoIdFrom_(s) {
  const m = String(s).match(/(?:v=|\/live\/|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  const raw = String(s).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  throw new Error('Cannot find a video id in: ' + s);
}


// ───────────────────────────────────────────────
// Fetching
// ───────────────────────────────────────────────

/** Channel RSS. Free, no API quota, returns the 15 newest. */
function fetchFeed_() {
  const url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CONFIG.channelId;
  const xml = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (xml.getResponseCode() !== 200) {
    throw new Error('cannot read the channel feed, HTTP ' + xml.getResponseCode());
  }
  const root = XmlService.parse(xml.getContentText()).getRootElement();
  const atom = XmlService.getNamespace('http://www.w3.org/2005/Atom');
  const yt   = XmlService.getNamespace('yt', 'http://www.youtube.com/xml/schemas/2015');

  return root.getChildren('entry', atom).map(e => ({
    videoId:   e.getChildText('videoId', yt),
    published: new Date(e.getChildText('published', atom)),
  })).filter(e => e.videoId);
}

/** videos.list — up to 50 ids per call, 1 quota unit. Never use search.list. */
function fetchDetails_(ids) {
  const key = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  if (!key) throw new Error('YOUTUBE_API_KEY is not set (Project Settings -> Script Properties)');

  const url = 'https://www.googleapis.com/youtube/v3/videos'
            + '?part=snippet,liveStreamingDetails'
            + '&id=' + ids.join(',')
            + '&key=' + key;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('YouTube API returned ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const map = {};
  JSON.parse(res.getContentText()).items.forEach(i => { map[i.id] = i; });
  return map;
}


// ───────────────────────────────────────────────
// Title normalization: strip the prefix, put the CJK run first, keep ft. last
//
// Titles here arrive as a mix of two scripts in an inconsistent order. The
// destination wants one consistent order. This is mechanical, so it is
// automated; which order is "right" is an editorial decision, so it was made
// once, by a human, and encoded here.
// ───────────────────────────────────────────────

// Write the ranges as \u escapes. Do NOT paste the literal characters into the
// character class: U+3000 (ideographic space) looks exactly like a blank in an
// editor, and one copy-paste through something that normalizes whitespace turns
// it into U+0020. The range then starts at U+0020, every Latin letter tests as
// CJK, and the reordering breaks silently with no error anywhere.
//   3400-9FFF  CJK Unified Ideographs (incl. Extension A)
//   F900-FAFF  CJK Compatibility Ideographs
//   3000-303F  CJK Symbols and Punctuation
function isCJK_(s)   { return /[㐀-鿿豈-﫿　-〿]/.test(s); }
function isLatin_(s) { return /[A-Za-z]/.test(s); }

function normalizeTitle_(raw) {
  const notes = [];

  let body = raw.replace(PREFIX_RE, '').trim();
  if (body === raw.trim()) notes.push('title prefix not recognized, left as-is');

  let suffix = '';
  const ft = body.match(/\s(ft\.?|feat\.?|w\/)\s.*$/i);
  if (ft) { suffix = body.slice(ft.index).trim(); body = body.slice(0, ft.index).trim(); }

  const runs = [];
  body.split(/\s+/).filter(Boolean).forEach(tok => {
    const k = isCJK_(tok) ? 'cjk' : (isLatin_(tok) ? 'latin' : 'neutral');
    const last = runs[runs.length - 1];
    if (last && (k === 'neutral' || k === last.k)) last.toks.push(tok);
    else if (last && last.k === 'neutral') { last.k = k; last.toks.push(tok); }
    else runs.push({ k: k, toks: [tok] });
  });

  const cjk   = runs.filter(r => r.k === 'cjk').map(r => r.toks.join(' '));
  const latin = runs.filter(r => r.k === 'latin').map(r => r.toks.join(' '));

  let out = body;
  if (cjk.length && latin.length) {
    out = cjk.concat(latin).join(' ');
    if (out !== body) notes.push('moved the CJK run to the front');
  } else if (!cjk.length) {
    notes.push('no CJK run found, not reordered');
  }

  if (suffix) out += ' ' + suffix;
  return { title: out.replace(/\s+/g, ' ').trim(), notes: notes };
}

/** Use the speaker named in the description if there is one — METHOD.md §6 */
function speakerFrom_(desc) {
  const m = desc.match(SPEAKER_RE);
  return m ? { name: m[1].trim(), fromDesc: true }
           : { name: CONFIG.defaultSpeaker, fromDesc: false };
}

/** Work out which event day a stream that ended at this time belongs to */
function eventDayOf_(ended) {
  const local = new Date(ended.getTime() + CONFIG.localOffsetHours * 3600000);
  const back = (local.getUTCDay() + 7) % 7;
  local.setUTCDate(local.getUTCDate() - back);
  return Utilities.formatDate(local, 'UTC', 'yyyy-MM-dd');
}


// ───────────────────────────────────────────────
// Build the package and send it
//
// The output is a draft for a human to paste. This function never writes to
// the destination system — METHOD.md §5.
// ───────────────────────────────────────────────
function sendPackage_(d, ended, extraNotes) {
  const s = d.snippet;
  const desc = (s.description || '').trim();
  const kind = kindOf_(s.title);
  const norm = normalizeTitle_(s.title);
  const sp = speakerFrom_(desc);

  // With a real end time, derive the event day; without one, fall back to the
  // upload date and say out loud that it is a fallback.
  let dateStr, dateNote = '';
  if (ended) {
    dateStr = eventDayOf_(ended);
  } else {
    dateStr = Utilities.formatDate(new Date(s.publishedAt), CONFIG.timeZone, 'yyyy-MM-dd');
    dateNote = '   <- upload date, not necessarily the event date; check it';
  }

  const warn = (extraNotes || []).slice();
  if (kind.tag === TAGS.unknown) {
    warn.push('The title does not match any known pattern; pick the tag yourself.');
  }
  if (desc.length < CONFIG.minDescChars) {
    warn.push('The description is only ' + desc.length + ' characters and may be unfinished. Check the source before publishing.');
  }
  if (!sp.fromDesc) {
    warn.push('No speaker in the description; used the default "' + CONFIG.defaultSpeaker + '". Confirm it.');
  }
  if (!ended) {
    warn.push('Not a livestream archive, so the date was derived from the upload date. Replace it with the real event date.');
  }
  // "prefix not recognized" only means anything for the recurring series;
  // one-off items never carry that prefix, so it is not a warning for them.
  norm.notes.forEach(n => {
    if (n === 'title prefix not recognized, left as-is' && !kind.isRecurring) return;
    warn.push(n);
  });

  const thumbs = s.thumbnails || {};
  let cover;
  if (thumbs.maxres) {
    cover = thumbs.maxres.url;
  } else {
    cover = (thumbs.standard || thumbs.high || {}).url || '';
    warn.push('No high-resolution thumbnail, so this may be smaller than the ' + CMS.coverMin + ' the destination wants. Ask the publisher for the original.');
  }

  const tail = desc ? desc.split('\n').slice(-2).join('\n') : '(empty)';

  const lines = [];
  lines.push(kind.label + '   ' + dateStr
             + (ended ? '   stream ended ' + Utilities.formatDate(ended, CONFIG.timeZone, 'MM/dd HH:mm')
                      : '   (manual upload, not a livestream archive)'));
  lines.push('');
  if (warn.length) {
    lines.push('/!\\ CHECK');
    warn.forEach(w => lines.push('   - ' + w));
    lines.push('');
  }
  lines.push('Description is ' + desc.length + ' characters, ending:');
  lines.push('   ' + tail.replace(/\n/g, '\n   '));
  lines.push('');
  lines.push('----------------------------------------');
  lines.push('Paste into: ' + CMS.path);
  lines.push('----------------------------------------');
  lines.push('');
  lines.push('[' + CMS.fieldTag + '] ' + kind.tag);
  lines.push('');
  lines.push('[' + CMS.fieldDate + '] ' + dateStr + dateNote);
  lines.push('');
  lines.push('[' + CMS.fieldTitle + ']');
  lines.push(norm.title);
  lines.push('');
  lines.push('[' + CMS.fieldSpeaker + '] ' + sp.name + (sp.fromDesc ? '' : '   <- default, confirm'));
  lines.push('');
  lines.push('[' + CMS.fieldVideo + ']');
  lines.push('https://www.youtube.com/embed/' + d.id);
  lines.push('');
  lines.push('[' + CMS.fieldCover + '] download -> save as ' + dateStr + '.jpg -> upload');
  lines.push(cover);
  lines.push('');
  lines.push('[' + CMS.fieldBody + '] copy the whole block below');
  lines.push('');
  lines.push(desc);
  lines.push('');
  lines.push('----------------------------------------');
  lines.push(CMS.leaveBlank);
  lines.push(CMS.defaults);
  lines.push('');
  lines.push('video   https://www.youtube.com/watch?v=' + d.id);
  lines.push('cms     ' + CMS.url);
  lines.push('site    ' + CMS.siteUrl);

  MailApp.sendEmail(CONFIG.mailTo,
    (warn.length ? '/!\\ ' : '') + '[' + kind.label + '] ' + dateStr + ' ' + norm.title.slice(0, 40),
    lines.join('\n'));

  // Only advance this for the recurring series. Advancing it for any item at
  // all would make the staleness check below meaningless — METHOD.md §7.
  if (kind.isRecurring) {
    PropertiesService.getScriptProperties()
      .setProperty(PROP_LAST_SEEN, new Date().toISOString());
  }
  Logger.log('sent (' + kind.label + '): ' + norm.title);
}


// ───────────────────────────────────────────────
// Nothing showed up when something was expected -> say so — METHOD.md §7
//
// Keyed on "when was a RECURRING item last packaged", not on a general
// watermark: any unrelated upload would push a general watermark forward and
// hide the gap.
// ───────────────────────────────────────────────
function maybeStaleAlert_() {
  const now = new Date();
  if (Utilities.formatDate(now, CONFIG.timeZone, 'u') !== CONFIG.reportWeekday) return;

  const last = PropertiesService.getScriptProperties().getProperty(PROP_LAST_SEEN);
  if (!last) return;

  const days = (now - new Date(last)) / 86400000;
  if (days < CONFIG.staleDays) return;

  MailApp.sendEmail(CONFIG.mailTo, '/!\\ [streamwatch] nothing detected this cycle',
    'No recurring item has been detected for ' + Math.floor(days) + ' days.\n' +
    'The event was yesterday and nothing has appeared, which usually means\n' +
    'something is wrong.\n\n' +
    'Possible causes:\n' +
    '  - there was no event, or it was not streamed\n' +
    '  - the publisher has not uploaded yet\n' +
    '  - the title format changed and the pattern no longer matches\n' +
    '  - the watcher itself is broken\n\n' +
    'Check the channel: ' + CMS.channelUrl + '\n' +
    'If the item is there, put its URL in MANUAL_VIDEO and run sendManual.');
}


// ───────────────────────────────────────────────
// Small manual tools
// ───────────────────────────────────────────────

/** Current state: when a recurring item was last packaged, and what has been handled */
function showState() {
  const p = PropertiesService.getScriptProperties();
  Logger.log('last recurring item: ' + (p.getProperty(PROP_LAST_SEEN) || '(not set)'));
  const notified = loadNotified_();
  if (notified === null) { Logger.log('handled list: not initialized (next run will be a first run)'); return; }
  Logger.log('handled: ' + notified.length + ' (newest first, cap ' + CONFIG.notifiedKeep + ')');
  notified.slice(0, 10).forEach((id, i) => Logger.log('   ' + (i + 1) + '. ' + id));
}

/** Drop MANUAL_VIDEO from the handled list so the next run sends it again */
function forgetManualVideo() {
  if (!MANUAL_VIDEO) throw new Error('Put a video URL or id in MANUAL_VIDEO first.');
  const id = videoIdFrom_(MANUAL_VIDEO);
  const notified = loadNotified_() || [];
  saveNotified_(notified.filter(x => x !== id));
  Logger.log('removed ' + id + ' from the handled list; the next run will send it again');
}

/** Forget everything. The next run is treated as a first run: re-mark, send nothing. */
function resetNotified() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_NOTIFIED);
  Logger.log('reset. The next run re-marks what is there and sends nothing.');
}
