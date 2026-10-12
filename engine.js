/* ManaFlow web engine: everything the PC server did, running inside the browser.
   Library lives in this browser (IndexedDB). Music is read straight from folders you pick
   (File System Access API in Chrome/Edge). Nothing is uploaded anywhere. */
'use strict';
const MF = (() => {
  const VERSION = '3.0 Web';
  const AUDIO_EXT = new Set(['mp3','flac','wav','aiff','aif','m4a','aac','ogg','opus','wma','mp4','alac']);
  const CUE_COLORS = ['#e8264c','#ff8c1a','#f5d327','#3ee08f','#35dcff','#3d7bff','#b46bff','#ff5ec4'];
  const canPick = 'showDirectoryPicker' in window;

  // ---------------- storage (IndexedDB key/value)
  let dbp = null;
  function idb() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('manaflow', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function kvGet(k) { const d = await idb(); return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  async function kvSet(k, v) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }

  const DEF_SETTINGS = { show_serato: '0', bpm_double: '1', bpm_lo: '85', bpm_hi: '89', cue_need: '8', cue_names: 'Intro,Mix in,Build,Drop,Break,Drop 2,Outro,Mix out' };
  let L = { nextId: 1, tracks: [], playlists: [], roots: [], settings: { ...DEF_SETTINGS }, rb_last_import: '', dups_checked: '' };
  const byId = new Map();
  const handles = new Map();     // rootId -> FileSystemDirectoryHandle
  const fileCache = new Map();   // trackId -> File (for webkitdirectory fallback and speed)
  const perm = new Map();        // rootId -> 'granted' | 'prompt' | 'denied'
  let saveT = null;
  function save() { clearTimeout(saveT); saveT = setTimeout(() => kvSet('lib', L).catch(() => {}), 400); }
  function reindex() { byId.clear(); L.tracks.forEach(t => byId.set(t.id, t)); }

  async function init() {
    try {
      const v = await kvGet('lib');
      if (v) { L = Object.assign(L, v); L.settings = Object.assign({ ...DEF_SETTINGS }, v.settings || {}); }
    } catch (e) { /* private window: library lives in memory only */ }
    reindex();
    for (const r of L.roots) {
      try {
        const h = await kvGet('h:' + r.id);
        if (h) { handles.set(r.id, h); perm.set(r.id, await h.queryPermission({ mode: 'read' })); }
        else perm.set(r.id, 'gone');
      } catch (e) { perm.set(r.id, 'gone'); }
    }
  }

  // ---------------- helpers
  const now = () => new Date().toISOString().slice(0, 19);
  const base = p => String(p || '').replace(/\\/g, '/').split('/').pop();
  const extOf = p => (base(p).split('.').pop() || '').toLowerCase();
  function fnameSuggest(name) {
    let stem = base(name).replace(/\.[^.]+$/, '').replace(/^\s*\d{1,3}\s*[-_.]\s*/, '').trim();
    const i = stem.indexOf(' - ');
    return i > 0 ? [stem.slice(0, i).trim(), stem.slice(i + 3).trim()] : ['', stem];
  }
  function category(t) {
    const p = (t.loc || t.rel || '').toLowerCase();
    if (/sample|loop|one ?shot|splice/.test(p)) return 'Samples/Loops';
    if (t.duration > 1200) return 'DJ Mix/Long Recording';
    return 'Music';
  }
  function linked(t) { return !!((t.root && t.rel && handles.has(t.root)) || fileCache.has(t.id)); }
  function hot(t) {
    const out = {};
    for (const [s, v] of Object.entries(t.rbHot || {})) out[s] = { slot: +s, pos_sec: v[0], color: v[1] || '', name: v[2] || '', source: 'rekordbox' };
    for (const [s, v] of Object.entries(t.mfHot || {})) { if (v === null) delete out[s]; else out[s] = { slot: +s, pos_sec: v[0], color: v[1] || CUE_COLORS[s], name: '', source: 'manaflow' }; }
    return Object.values(out).filter(h => h.slot >= 0 && h.slot < 8).sort((a, b) => a.slot - b.slot);
  }
  function status(t) { const n = hot(t).length, need = Math.max(1, Math.min(8, parseInt(L.settings.cue_need) || 8)); return !t.bpm ? 'Needs Analysis' : n >= need ? 'Ready' : n ? 'Some Cues' : 'No Cues'; }
  function driveOf(t) {
    if (t.root) { const r = L.roots.find(x => x.id === t.root); if (r) return r.name; }
    const m = /^([A-Za-z]):/.exec(t.loc || ''); return m ? m[1].toUpperCase() : '—';
  }
  function bpmRule() { return [L.settings.bpm_double === '1', parseFloat(L.settings.bpm_lo) || 85, parseFloat(L.settings.bpm_hi) || 89]; }
  function applyBpm(t) {
    const [on, lo, hi] = bpmRule();
    if (t.bpm_auto === -1) return;
    if (t.bpm_raw == null) t.bpm_raw = t.bpm;
    if (t.bpm_raw == null) return;
    if (on && t.bpm_raw >= lo && t.bpm_raw < hi) { t.bpm = Math.round(t.bpm_raw * 200) / 100; t.bpm_auto = 1; }
    else { t.bpm = t.bpm_raw; t.bpm_auto = 0; }
  }
  const inPl = () => { const s = new Set(); L.playlists.forEach(p => (p.tracks || []).forEach(i => s.add(i))); return s; };

  // ---------------- files
  async function fileFor(t) {
    if (fileCache.has(t.id)) return fileCache.get(t.id);
    const h = handles.get(t.root); if (!h || !t.rel) return null;
    if (perm.get(t.root) !== 'granted') return null;
    let d = h; const parts = t.rel.split('/');
    try {
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
      return await (await d.getFileHandle(parts[parts.length - 1])).getFile();
    } catch (e) { return null; }
  }
  async function* walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.') || name.startsWith('$')) continue;
      if (h.kind === 'directory') yield* walk(h, prefix + name + '/');
      else yield [prefix + name, h];
    }
  }

  // ---------------- jobs (same shape the screen expects)
  const J = { running: false, phase: 'idle', found: 0, new: 0, changed: 0, skipped: 0, system_listed: 0, missing: 0, probed: 0, probe_total: 0, errors: 0, current: '', finished_at: '' };
  let stop = false;
  function startJob(fn) {
    if (J.running) return false;
    Object.assign(J, { running: true, phase: 'starting', found: 0, new: 0, changed: 0, skipped: 0, missing: 0, probed: 0, probe_total: 0, errors: 0, current: '' });
    stop = false;
    (async () => { try { await fn(); J.phase = 'done'; } catch (e) { J.phase = 'error: ' + e.message; } finally { J.running = false; J.finished_at = now(); save(); } })();
    return true;
  }

  function linkIndex() {
    const idx = new Map();
    for (const t of L.tracks) if (!t.root && t.loc) { const k = base(t.loc).toLowerCase(); (idx.get(k) || idx.set(k, []).get(k)).push(t); }
    return idx;
  }
  async function scanRoot(r, files) {
    J.phase = 'listing files';
    const idx = linkIndex();
    const known = new Map(L.tracks.filter(t => t.root === r.id).map(t => [t.rel.toLowerCase(), t]));
    const iter = files ? files.map(f => [f.webkitRelativePath.split('/').slice(1).join('/'), f]) : walk(handles.get(r.id), '');
    for await (const [rel, h] of iter) {
      if (stop) return;
      if (!AUDIO_EXT.has(extOf(rel))) continue;
      J.found++; J.current = rel;
      let f; try { f = h.getFile ? await h.getFile() : h; } catch (e) { J.errors++; continue; }
      const k = rel.toLowerCase();
      let t = known.get(k);
      if (t) {
        if (t.size === f.size && Math.abs((t.mtime || 0) - f.lastModified) < 1000) { J.skipped++; if (files) fileCache.set(t.id, f); continue; }
        t.size = f.size; t.mtime = f.lastModified; t.needs_probe = 1; J.changed++;
      } else {
        const cands = (idx.get(base(rel).toLowerCase()) || []).filter(x => !x.root);
        const suffix = ('/' + r.name + '/' + rel).toLowerCase();
        t = cands.find(x => x.loc.replace(/\\/g, '/').toLowerCase().endsWith(suffix))
          || cands.find(x => x.loc.replace(/\\/g, '/').toLowerCase().endsWith('/' + k))
          || (cands.length === 1 ? cands[0] : cands.find(x => x.size === f.size));
        if (t) { t.root = r.id; t.rel = rel; t.size = f.size; t.mtime = f.lastModified; t.needs_probe = 1; J.changed++; }
        else {
          const [a, ti] = fnameSuggest(rel);
          t = { id: L.nextId++, name: base(rel), ext: extOf(rel), root: r.id, rel, size: f.size, mtime: f.lastModified, title: ti, artist: a,
                genre: '', added: now().slice(0, 10), needs_probe: 1, rbHot: {}, mfHot: {}, mem: [] };
          L.tracks.push(t); byId.set(t.id, t); J.new++;
        }
      }
      if (files) fileCache.set(t.id, f);
      if (J.found % 200 === 0) save();
    }
  }
  async function scanAll() {
    for (const r of L.roots) if (perm.get(r.id) === 'granted') await scanRoot(r);
    if (!stop) await probeAll();
  }

  // ---------------- tags (ID3v2) + length
  function syncsafe(b, o) { return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3]; }
  function dec(bytes, enc) {
    try {
      if (enc === 0) return new TextDecoder('latin1').decode(bytes);
      if (enc === 1) return new TextDecoder('utf-16').decode(bytes);
      if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { return ''; }
  }
  async function id3(file, wantArt) {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;
    const ver = head[3], size = syncsafe(head, 6);
    const b = new Uint8Array(await file.slice(10, 10 + Math.min(size, 8e6)).arrayBuffer());
    const out = {}; let o = 0;
    while (o + 10 <= b.length) {
      const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const len = ver === 4 ? syncsafe(b, o + 4) : (b[o + 4] << 24 | b[o + 5] << 16 | b[o + 6] << 8 | b[o + 7]) >>> 0;
      const body = b.subarray(o + 10, o + 10 + len); o += 10 + len;
      if (id === 'APIC') {
        if (!wantArt) { out.hasArt = true; continue; }
        const enc = body[0]; let i = 1; while (i < body.length && body[i] !== 0) i++;
        const mime = dec(body.subarray(1, i), 0) || 'image/jpeg'; i += 2; // skip null + picture type
        if (enc === 1 || enc === 2) { while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2; i += 2; }
        else { while (i < body.length && body[i] !== 0) i++; i++; }
        out.art = new Blob([body.subarray(i)], { type: mime.includes('/') ? mime : 'image/' + mime.toLowerCase() });
      } else if (id[0] === 'T') {
        const v = dec(body.subarray(1), body[0]).replace(/\0+$/, '').trim();
        out[id] = v;
      }
    }
    return out;
  }
  function audioLen(file) {
    return new Promise(res => {
      const a = new Audio(); const u = URL.createObjectURL(file); let done = false;
      const fin = v => { if (done) return; done = true; URL.revokeObjectURL(u); res(v); };
      a.preload = 'metadata'; a.onloadedmetadata = () => fin(isFinite(a.duration) ? a.duration : null); a.onerror = () => fin(null);
      setTimeout(() => fin(null), 8000); a.src = u;
    });
  }
  async function probe(t) {
    const f = await fileFor(t); if (!f) return;
    const tags = t.ext === 'mp3' ? await id3(f).catch(() => null) : null;
    if (tags) {
      if (tags.TIT2 && t.title_src !== 'Manual' && t.title_src !== 'rekordbox') t.title = tags.TIT2;
      if (tags.TPE1 && t.artist_src !== 'Manual' && t.artist_src !== 'rekordbox') t.artist = tags.TPE1;
      if (tags.TALB) t.album = tags.TALB;
      if (tags.TCON && !t.genre) t.genre = tags.TCON.replace(/^\((\d+)\)$/, '$1');
      if (tags.TBPM && !t.bpm_raw && parseFloat(tags.TBPM)) { t.bpm_raw = parseFloat(tags.TBPM); t.bpm_auto = 0; t.bpm = t.bpm_raw; applyBpm(t); }
      if (tags.TKEY && !t.key) t.key = tags.TKEY;
      const y = parseInt(tags.TDRC || tags.TYER); if (y && !t.year) t.year = y;
    }
    const d = await audioLen(f); if (d) t.duration = d;
    t.needs_probe = 0;
  }
  async function probeAll(ids) {
    J.phase = 'analyzing';
    const list = L.tracks.filter(t => t.needs_probe && (!ids || ids.includes(t.id)) && linked(t));
    J.probe_total = list.length;
    for (const t of list) { if (stop) break; J.current = t.rel || t.name; await probe(t); J.probed++; if (J.probed % 25 === 0) save(); }
  }

  // ---------------- waveform + art
  const waveCache = new Map(), artCache = new Map();
  let actx = null;
  async function waveform(id, bars) {
    const key = id + ':' + bars; if (waveCache.has(key)) return waveCache.get(key);
    const t = byId.get(id); const f = t && await fileFor(t); if (!f) throw new Error('no file');
    actx = actx || new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
    const buf = await actx.decodeAudioData(await f.arrayBuffer());
    const ch = buf.getChannelData(0), n = ch.length, step = Math.max(1, Math.floor(n / bars));
    const peaks = [], tone = [];
    for (let i = 0; i < bars; i++) {
      let pk = 0, e = 0, d = 0, prev = ch[i * step] || 0;
      for (let k = i * step; k < Math.min(n, (i + 1) * step); k += 8) { const v = ch[k]; const a = v < 0 ? -v : v; if (a > pk) pk = a; e += a; d += Math.abs(v - prev); prev = v; }
      peaks.push(Math.round(pk * 1000) / 1000); tone.push(e ? Math.min(1, d / e / 1.2) : 0);
    }
    const w = { peaks, tone, duration: buf.duration };
    if (!t.duration) { t.duration = buf.duration; save(); }
    waveCache.set(key, w); return w;
  }
  async function artURL(id) {
    if (artCache.has(id)) return artCache.get(id);
    const t = byId.get(id); let url = null;
    try { const f = t && t.ext === 'mp3' && await fileFor(t); if (f) { const tg = await id3(f, true); if (tg && tg.art && tg.art.size > 200) url = URL.createObjectURL(tg.art); } } catch (e) {}
    artCache.set(id, url); return url;
  }
  async function audioURL(id) { const t = byId.get(id); const f = t && await fileFor(t); return f ? URL.createObjectURL(f) : null; }

  // ---------------- rekordbox import
  function locToPath(loc) {
    let p = decodeURIComponent(String(loc || '').replace(/^file:\/\/localhost/, '').replace(/^file:\/\//, ''));
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  }
  async function importRekordbox(file) {
    const txt = await file.text();
    const doc = new DOMParser().parseFromString(txt, 'application/xml');
    const col = doc.querySelector('COLLECTION');
    if (!col) throw new Error('This does not look like a rekordbox collection XML.');
    const byLoc = new Map(L.tracks.filter(t => t.loc).map(t => [t.loc.toLowerCase(), t]));
    const idmap = {}; const st = { tracks: 0, matched: 0, added: 0, missing_files: 0, hot_cues: 0, playlists: 0 };
    for (const el of col.querySelectorAll(':scope > TRACK')) {
      st.tracks++;
      const loc = locToPath(el.getAttribute('Location'));
      let t = byLoc.get(loc.toLowerCase());
      if (!t) {
        const [a, ti] = fnameSuggest(loc);
        t = { id: L.nextId++, name: base(loc), ext: extOf(loc), loc, root: null, rel: null, size: +el.getAttribute('Size') || 0,
              title: ti, artist: a, genre: '', added: el.getAttribute('DateAdded') || now().slice(0, 10), rbHot: {}, mfHot: {}, mem: [] };
        L.tracks.push(t); byId.set(t.id, t); byLoc.set(loc.toLowerCase(), t); st.added++;
      } else st.matched++;
      const g = k => el.getAttribute(k) || '';
      if (g('Name') && t.title_src !== 'Manual') { t.title = g('Name'); t.title_src = 'rekordbox'; }
      if (g('Artist') && t.artist_src !== 'Manual') { t.artist = g('Artist'); t.artist_src = 'rekordbox'; }
      if (g('Genre')) t.genre = g('Genre');
      if (g('Tonality')) t.key = g('Tonality');
      if (g('Comments') && !t.comments) t.comments = g('Comments');
      if (+g('Year')) t.year = +g('Year');
      if (+g('TotalTime') && !t.duration) t.duration = +g('TotalTime');
      const bpm = parseFloat(g('AverageBpm'));
      if (bpm) { t.bpm_raw = bpm; t.bpm_auto = 0; t.bpm = bpm; applyBpm(t); }
      t.rbHot = {}; t.mem = [];
      for (const pm of el.querySelectorAll('POSITION_MARK')) {
        const num = parseInt(pm.getAttribute('Num') ?? '-1'), pos = parseFloat(pm.getAttribute('Start') || '0');
        const r = pm.getAttribute('Red'), gg = pm.getAttribute('Green'), b = pm.getAttribute('Blue');
        const color = r != null ? '#' + [r, gg, b].map(x => (+x).toString(16).padStart(2, '0')).join('') : '';
        if (num >= 0) { t.rbHot[num] = [pos, color, pm.getAttribute('Name') || '']; st.hot_cues++; }
        else t.mem.push([pos, pm.getAttribute('Name') || '']);
      }
      t.rb_id = g('TrackID'); idmap[t.rb_id] = t.id;
    }
    L.playlists = L.playlists.filter(p => p.source !== 'rekordbox');
    let pid = Math.max(0, ...L.playlists.map(p => p.id)) + 1;
    const walkNodes = (node, parent) => {
      [...node.children].filter(c => c.tagName === 'NODE').forEach((n, pos) => {
        const folder = n.getAttribute('Type') === '0';
        const p = { id: pid++, name: n.getAttribute('Name'), parent_id: parent, is_folder: folder ? 1 : 0, position: pos, source: 'rekordbox', tracks: [] };
        L.playlists.push(p);
        if (folder) walkNodes(n, p.id);
        else { st.playlists++; p.tracks = [...n.children].filter(c => c.tagName === 'TRACK').map(c => idmap[c.getAttribute('Key')]).filter(Boolean); }
      });
    };
    const pls = doc.querySelector('PLAYLISTS');
    if (pls) { const top = [...pls.children].find(c => c.tagName === 'NODE'); walkNodes(top && top.getAttribute('Name') === 'ROOT' ? top : pls, null); }
    st.missing_files = L.tracks.filter(t => !linked(t)).length;
    L.rb_last_import = now(); save();
    return st;
  }

  // ---------------- queries
  const VIEWS = {
    all: () => true, music: t => category(t) === 'Music', hascues: t => hot(t).length > 0, needs: t => !t.bpm,
    notinpl: (t, ip) => !ip.has(t.id), mixes: t => t.duration > 1200, samples: t => category(t) === 'Samples/Loops' || (t.duration && t.duration < 60),
    missing: t => !linked(t), dups: t => !!t.dup && linked(t)
  };
  const VIEW_NAMES = [['all', 'All Audio'], ['music', 'Music Tracks'], ['hascues', 'Has Hot Cues'], ['needs', 'Needs Analysis'], ['notinpl', 'Not in a Playlist'],
    ['mixes', 'DJ Mixes'], ['samples', 'Samples & Loops'], ['missing', 'Not Linked Yet'], ['dups', 'Duplicates']];
  const camel = k => { const n = parseInt(k); return isNaN(n) ? null : n * 2 + (/b$/i.test(k) ? 1 : 0); };
  const SORTS = {
    title: t => (t.title || '').toLowerCase(), artist: t => (t.artist || '').toLowerCase() + '\u0001' + (t.title || '').toLowerCase(),
    bpm: t => t.bpm || null, key: t => camel(t.key), genre: t => (t.genre || '').toLowerCase() || null, length: t => t.duration || null,
    rc: t => hot(t).length, added: t => t.added || null
  };
  function row(t) {
    return { id: t.id, title: t.title || t.name, artist: t.artist || '', bpm: t.bpm || null, key: t.key || '', genre: t.genre || '', ext: t.ext, duration: t.duration || null,
      rc: hot(t).length, sc: null, added: t.added, drive: driveOf(t), category: category(t), missing: linked(t) ? 0 : 1, is_system: 0,
      bpm_auto: t.bpm_auto || 0, bpm_raw: t.bpm_raw, dup: t.dup || null, status: status(t) };
  }
  function query(qs) {
    let list;
    if (qs.ids) { const s = new Set(qs.ids.split(',').map(Number)); list = L.tracks.filter(t => s.has(t.id)); }
    else if (qs.pl) { const p = L.playlists.find(x => x.id == qs.pl); list = p ? p.tracks.map(i => byId.get(i)).filter(Boolean) : []; }
    else { const ip = inPl(); const f = VIEWS[qs.view] || VIEWS.all; list = L.tracks.filter(t => f(t, ip)); }
    const off = new Set((qs.drives_off || '').split(',').filter(Boolean));
    if (off.size) list = list.filter(t => !off.has(driveOf(t)));
    for (const k of ['genre', 'mood', 'subgenre']) if (qs[k]) list = list.filter(t => (t[k] || '') === qs[k]);
    if (qs.era) list = list.filter(t => qs.era === 'Unknown' ? !t.year : (t.year && Math.floor(t.year / 10) * 10 + 's' === qs.era));
    if (qs.q) for (const w of qs.q.toLowerCase().split(/\s+/).filter(Boolean)) list = list.filter(t => ((t.title || '') + ' ' + (t.artist || '') + ' ' + (t.genre || '') + ' ' + (t.name || '')).toLowerCase().includes(w));
    if (qs.status && qs.status !== 'All') list = list.filter(t => status(t) === qs.status);
    const key = qs.sort && SORTS[qs.sort];
    if (key) {
      const d = qs.desc === '1' ? -1 : 1;
      list = list.map(t => [key(t), t]).sort((a, b) => (a[0] == null) - (b[0] == null) || (a[0] < b[0] ? -d : a[0] > b[0] ? d : 0)).map(x => x[1]);
    } else if (!qs.pl) list = list.slice().sort((a, b) => SORTS.artist(a) < SORTS.artist(b) ? -1 : 1);
    return list;
  }

  function summary() {
    const ip = inPl();
    const views = VIEW_NAMES.map(([id, name]) => ({ id, name, count: L.tracks.filter(t => VIEWS[id](t, ip)).length }));
    const cnt = (fn) => { const m = new Map(); L.tracks.forEach(t => { const v = fn(t); if (v) m.set(v, (m.get(v) || 0) + 1); }); return [...m].map(([v, n]) => ({ v, n })); };
    const drives = cnt(driveOf).map(x => ({ drive: x.v, n: x.n })).sort((a, b) => a.drive < b.drive ? -1 : 1);
    const types = cnt(t => (t.ext || '').toUpperCase()).map(x => ({ ext: x.v, n: x.n })).sort((a, b) => b.n - a.n);
    const ready = {}; L.tracks.forEach(t => { const s = status(t); ready[s] = (ready[s] || 0) + 1; });
    const playlists = L.playlists.map(p => ({ id: p.id, name: p.name, parent_id: p.parent_id, is_folder: p.is_folder, source: p.source, n: (p.tracks || []).length,
      notready: (p.tracks || []).filter(i => { const t = byId.get(i); return t && status(t) !== 'Ready'; }).length }));
    const roots = L.roots.map(r => ({ id: r.id, path: r.name, enabled: 1, n: L.tracks.filter(t => t.root === r.id).length, perm: perm.get(r.id) || 'gone' }));
    const top = (fn, lim) => cnt(fn).sort((a, b) => b.n - a.n).slice(0, lim);
    return { app: 'ManaFlow', version: VERSION, web: true, views, drives, types, ready, playlists, roots, job: { ...J }, ffprobe: true, ffmpeg: true,
      rb_last_import: L.rb_last_import, settings: { ...L.settings, inbox_mode: 'later', analyze_sys: '0' }, inbox_new: 0, db: 'This browser', is_windows: false,
      browse: { genre: top(t => t.genre, 60), subgenre: top(t => t.subgenre, 60), mood: top(t => t.mood, 60),
        era: cnt(t => t.year ? Math.floor(t.year / 10) * 10 + 's' : 'Unknown').sort((a, b) => a.v < b.v ? 1 : -1) },
      dups_checked: L.dups_checked, usb: usbPending ? [{ root: 'usb', label: usbPending.label, n: usbPending.diffs.length }] : [],
      canPick, needsReconnect: L.roots.some(r => perm.get(r.id) === 'prompt'), exports: 'Your Downloads folder' };
  }
  function detail(id) {
    const t = byId.get(id); if (!t) return null;
    const r = row(t);
    return { ...t, ...r, catalog_title: r.title, catalog_artist: r.artist, musical_key: t.key || '', release_year: t.year || null,
      path: t.loc || (t.rel ? (driveOf(t) + '/' + t.rel) : t.name), hot: hot(t),
      cues: (t.mem || []).map(m => ({ source: 'rekordbox', kind: 'memory', slot: -1, pos_sec: m[0], name: m[1] })),
      playlists: L.playlists.filter(p => (p.tracks || []).includes(id)).map(p => p.name), bitrate: null, sample_rate: null };
  }

  // ---------------- duplicates
  async function findDups() {
    J.phase = 'finding duplicates';
    L.tracks.forEach(t => { delete t.dup; });
    const groups = new Map();
    for (const t of L.tracks) if (linked(t) && t.size) { const k = t.ext + ':' + t.size; (groups.get(k) || groups.set(k, []).get(k)).push(t); }
    const cands = [...groups.values()].filter(g => g.length > 1);
    J.probe_total = cands.reduce((a, g) => a + g.length, 0);
    for (const g of cands) {
      const hs = new Map();
      for (const t of g) {
        if (stop) return;
        J.current = t.rel || t.name;
        try { const f = await fileFor(t); const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
          (hs.get(h) || hs.set(h, []).get(h)).push(t); } catch (e) { J.errors++; }
        J.probed++;
      }
      for (const [h, ts] of hs) if (ts.length > 1) ts.forEach(t => t.dup = h.slice(0, 16));
    }
    L.dups_checked = now();
  }

  // ---------------- exports
  function download(name, data, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  const xa = s => '"' + String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') + '"';
  function exportRekordbox(qs) {
    const list = qs.ids || qs.pl ? query(qs) : L.tracks; const ids = new Set(list.map(t => t.id));
    const loc = t => { let p = (t.loc || (driveOf(t) + '/' + (t.rel || t.name))).replace(/\\/g, '/'); if (!p.startsWith('/')) p = '/' + p;
      return 'file://localhost' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F'); };
    const tr = list.map(t => {
      const marks = hot(t).map(h => { const c = (h.color || '').replace('#', ''); const rgb = c.length === 6 ? ` Red="${parseInt(c.slice(0, 2), 16)}" Green="${parseInt(c.slice(2, 4), 16)}" Blue="${parseInt(c.slice(4, 6), 16)}"` : '';
        return `<POSITION_MARK Name=${xa(h.name)} Type="0" Start="${(+h.pos_sec).toFixed(3)}" Num="${h.slot}"${rgb}/>`; })
        .concat((t.mem || []).map(m => `<POSITION_MARK Name=${xa(m[1])} Type="0" Start="${(+m[0]).toFixed(3)}" Num="-1"/>`)).join('');
      const a = `TrackID="${t.id}" Name=${xa(t.title || t.name)} Artist=${xa(t.artist)} Genre=${xa(t.genre)} Kind=${xa((t.ext || '').toUpperCase() + ' File')} Size="${t.size || 0}" TotalTime="${Math.round(t.duration || 0)}" AverageBpm="${(t.bpm || 0).toFixed(2)}" Tonality=${xa(t.key)} Comments=${xa(t.comments)}${t.year ? ` Year="${t.year}"` : ''} Location=${xa(loc(t))}`;
      return marks ? `<TRACK ${a}>${marks}</TRACK>` : `<TRACK ${a}/>`;
    });
    const node = pid => L.playlists.filter(p => (p.parent_id ?? null) === pid).sort((a, b) => a.position - b.position).map(p => p.is_folder
      ? (k => `<NODE Type="0" Name=${xa(p.name)} Count="${k.length}">${k.join('')}</NODE>`)(node(p.id))
      : (k => `<NODE Name=${xa(p.name)} Type="1" KeyType="0" Entries="${k.length}">${k.map(i => `<TRACK Key="${i}"/>`).join('')}</NODE>`)((p.tracks || []).filter(i => ids.has(i))));
    const kids = node(null);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="ManaFlow" Version="${VERSION}" Company="Mana Industries"/><COLLECTION Entries="${tr.length}">\n${tr.join('\n')}\n</COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Type="0" Name="ManaFlow" Count="${kids.length}">${kids.join('')}</NODE></NODE></PLAYLISTS></DJ_PLAYLISTS>\n`;
    download('ManaFlow-rekordbox.xml', xml, 'application/xml');
  }
  function exportCSV(qs) {
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [['Title', 'Artist', 'BPM', 'Key', 'Genre', 'Length (s)', 'Format', 'Hot cues', 'Status', 'Location', 'Path'].map(q).join(',')];
    for (const t of query(qs)) lines.push([t.title || t.name, t.artist, t.bpm || '', t.key, t.genre, Math.round(t.duration || 0), (t.ext || '').toUpperCase(), hot(t).length,
      linked(t) ? status(t) : 'Not linked', driveOf(t), t.loc || t.rel || t.name].map(q).join(','));
    download('ManaFlow-report.csv', '﻿' + lines.join('\r\n'), 'text/csv');
  }
  const stag = (name, data) => { const n = new TextEncoder().encode(name); const out = new Uint8Array(8 + data.length); out.set(n, 0); new DataView(out.buffer).setUint32(4, data.length); out.set(data, 8); return out; };
  const u16 = s => { const b = new Uint8Array(s.length * 2); const v = new DataView(b.buffer); for (let i = 0; i < s.length; i++) v.setUint16(i * 2, s.charCodeAt(i)); return b; };
  const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0); const o = new Uint8Array(n); let i = 0; a.forEach(x => { o.set(x, i); i += x.length; }); return o; };
  function crate(paths) {
    const parts = [stag('vrsn', u16('1.0/Serato ScratchLive Crate')), stag('osrt', cat(stag('tvcn', u16('song')), stag('brev', new Uint8Array([0]))))];
    for (const c of ['song', 'artist', 'bpm', 'key', 'length']) parts.push(stag('ovct', cat(stag('tvcn', u16(c)), stag('tvcw', u16('0')))));
    for (const p of paths) parts.push(stag('otrk', stag('ptrk', u16(p))));
    return cat(...parts);
  }
  async function exportSerato() {
    const byDrive = new Map();
    for (const p of L.playlists.filter(p => !p.is_folder)) {
      for (const i of p.tracks || []) {
        const t = byId.get(i); if (!t || !t.loc) continue;
        const m = /^([A-Za-z]):[\\/](.*)$/.exec(t.loc); if (!m) continue;
        const d = m[1].toUpperCase(); const mp = byDrive.get(d) || byDrive.set(d, new Map()).get(d);
        (mp.get(p.name) || mp.set(p.name, []).get(p.name)).push(m[2].replace(/\\/g, '/'));
      }
    }
    return byDrive;
  }
  async function writeCrates(dirHandle, plMap) {
    let sub; try { sub = dirHandle.name.toLowerCase() === 'subcrates' ? dirHandle : await dirHandle.getDirectoryHandle('Subcrates', { create: true }); } catch (e) { throw new Error('Could not open the Subcrates folder there.'); }
    let n = 0;
    for (const [name, paths] of plMap) {
      const safe = name.replace(/[\\/:*?"<>|%]/g, '_').trim() || 'Playlist';
      const fh = await sub.getFileHandle(`ManaFlow%%${safe}.crate`, { create: true });
      const w = await fh.createWritable(); await w.write(crate(paths)); await w.close(); n++;
    }
    return n;
  }
  function downloadCrates(plMap, drive) {
    for (const [name, paths] of plMap) download(`ManaFlow%%${name.replace(/[\\/:*?"<>|%]/g, '_')}.crate`, crate(paths), 'application/octet-stream');
  }

  // ---------------- USB cue sync (pick the USB stick's folder)
  let usbPending = null;
  function parseAnlz(buf) {
    const b = new DataView(buf); const u8 = new Uint8Array(buf);
    if (u8.length < 28 || String.fromCharCode(...u8.subarray(0, 4)) !== 'PMAI') return null;
    const out = { path: null, hot: null }; let pos = b.getUint32(4);
    while (pos + 12 <= u8.length) {
      const fc = String.fromCharCode(...u8.subarray(pos, pos + 4)), lh = b.getUint32(pos + 4), lt = b.getUint32(pos + 8);
      if (lt < 12 || pos + lt > u8.length) break;
      if (fc === 'PPTH') { const n = b.getUint32(pos + 12); out.path = new TextDecoder('utf-16be').decode(u8.subarray(pos + 16, pos + 16 + n)).replace(/\0+$/, ''); }
      else if ((fc === 'PCOB' || fc === 'PCO2') && b.getUint32(pos + 12) === 1) {
        const h = {}; let e = pos + lh;
        while (e + 12 <= pos + lt) {
          const ef = String.fromCharCode(...u8.subarray(e, e + 4)), el = b.getUint32(e + 8); if (el < 12) break;
          const hc = b.getUint32(e + 12);
          if (ef === 'PCPT' && hc > 0) h[hc - 1] = b.getUint32(e + 0x20) / 1000;
          if (ef === 'PCP2' && hc > 0) h[hc - 1] = b.getUint32(e + 0x14) / 1000;
          e += el;
        }
        if (fc === 'PCO2' || out.hot === null) out.hot = h;
      }
      pos += lt;
    }
    return out;
  }
  async function usbScan(root) {
    let anlz; try { anlz = await (await root.getDirectoryHandle('PIONEER')).getDirectoryHandle('USBANLZ'); }
    catch (e) { throw new Error('That folder has no PIONEER\\USBANLZ inside. Pick the top of the USB stick.'); }
    const found = new Map();
    for await (const [rel, h] of walk(anlz, '')) {
      if (!/ANLZ.*\.(DAT|EXT)$/i.test(rel)) continue;
      const a = parseAnlz(await (await h.getFile()).arrayBuffer()); if (!a || !a.path || !a.hot) continue;
      const ext = /\.EXT$/i.test(rel); const cur = found.get(a.path);
      if (!cur || ext) found.set(a.path, { hot: a.hot, ext });
    }
    const byName = new Map(); L.tracks.forEach(t => { const k = (t.name || base(t.loc || t.rel)).toLowerCase(); (byName.get(k) || byName.set(k, []).get(k)).push(t); });
    const diffs = [];
    for (const [p, info] of found) {
      const c = byName.get(base(p).toLowerCase()) || []; if (c.length !== 1) continue;
      const t = c[0]; const lib = {}; hot(t).forEach(h => lib[h.slot] = h.pos_sec);
      const usb = {}; for (const [k, v] of Object.entries(info.hot)) if (+k >= 0 && +k < 8) usb[+k] = v;
      const ch = [];
      for (let s = 0; s < 8; s++) { const a = lib[s], b = usb[s]; const L8 = 'ABCDEFGH'[s];
        if (a == null && b != null) ch.push(`${L8} added at ${Math.floor(b / 60)}:${String(Math.floor(b % 60)).padStart(2, '0')}`);
        else if (a != null && b == null) ch.push(`${L8} removed`);
        else if (a != null && Math.abs(a - b) > 0.05) ch.push(`${L8} moved ${(b - a > 0 ? '+' : '')}${(b - a).toFixed(1)}s`); }
      if (ch.length) diffs.push({ id: t.id, title: t.title || t.name, artist: t.artist || '', changes: ch, usb, lib });
    }
    usbPending = diffs.length ? { root: 'usb', label: '"' + root.name + '"', diffs } : null;
    return diffs.length;
  }
  function usbApply(ids) {
    if (!usbPending) throw new Error('No USB changes waiting.');
    let n = 0;
    for (const d of usbPending.diffs) {
      if (ids.size && !ids.has(d.id)) continue;
      const t = byId.get(d.id); t.mfHot = t.mfHot || {};
      for (let s = 0; s < 8; s++) { const a = d.lib[s], b = d.usb[s];
        if (b != null && (a == null || Math.abs(a - b) > 0.05)) t.mfHot[s] = [b, CUE_COLORS[s]];
        else if (a != null && b == null) t.mfHot[s] = null; }
      n++;
    }
    usbPending = null; save(); return { ok: true, n };
  }


  // ---------------- Analyze: BPM + key detection (estimates)
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
    }
  }
  const CAMELOT_MAJ = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];  // C C# D D# E F F# G G# A A# B
  const CAMELOT_MIN = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
  const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KMIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function corr(a, b) { const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12; let n = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); }
  function detectBpm(x, sr) {
    // Onset strength = spectral flux (rise in each frequency band), so steady tones and pads don't hide the drums.
    const N = 512, hop = 128, frames = Math.floor((x.length - N) / hop); if (frames < 300) return null;
    const re = new Float64Array(N), im = new Float64Array(N), prev = new Float64Array(N / 2), env = new Float32Array(frames);
    const hann = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    for (let f = 0; f < frames; f++) {
      const o = f * hop; for (let i = 0; i < N; i++) { re[i] = x[o + i] * hann[i]; im[i] = 0; } fft(re, im);
      let flux = 0; for (let k = 1; k < N / 2; k++) { const m = Math.log(1 + 100 * Math.hypot(re[k], im[k])); const d = m - prev[k]; if (d > 0) flux += d; prev[k] = m; }
      env[f] = flux;
    }
    // remove slow trend
    const w = 32, sm = new Float32Array(frames); let acc = 0;
    for (let i = 0; i < frames; i++) { acc += env[i]; if (i >= w) acc -= env[i - w]; sm[i] = acc / Math.min(i + 1, w); }
    for (let i = 0; i < frames; i++) env[i] = Math.max(0, env[i] - sm[i]);
    const fps = sr / hop, lo = Math.floor(fps * 60 / 185), hi = Math.ceil(fps * 60 / 68);
    const r = new Float32Array(hi * 2 + 3);
    for (let L = lo >> 1; L <= hi * 2 + 1 && L < frames; L++) { let s = 0; for (let i = 0; i + L < frames; i++) s += env[i] * env[i + L]; r[L] = s / (frames - L); }
    let best = -1, bl = lo;
    for (let L = lo; L <= hi; L++) { const sc = r[L] + 0.5 * (r[2 * L] || 0) + 0.25 * (r[Math.round(L / 2)] || 0); if (sc > best) { best = sc; bl = L; } }
    const y0 = r[bl - 1] || 0, y1 = r[bl], y2 = r[bl + 1] || 0, den = y0 - 2 * y1 + y2; const off = den ? 0.5 * (y0 - y2) / den : 0;
    const bpm = 60 * fps / (bl + Math.max(-0.5, Math.min(0.5, off)));
    return Math.abs(bpm - Math.round(bpm)) < 0.35 ? Math.round(bpm) : Math.round(bpm * 10) / 10;
  }
  function detectKey(x, sr) {
    const N = 4096, hop = 4096, chroma = new Float64Array(12), re = new Float64Array(N), im = new Float64Array(N);
    const hann = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    const binPc = new Int8Array(N / 2).fill(-1);
    for (let b = 1; b < N / 2; b++) { const f = b * sr / N; if (f < 60 || f > 2200) continue; binPc[b] = ((Math.round(12 * Math.log2(f / 440)) + 9) % 12 + 12) % 12; }
    for (let o = 0; o + N <= x.length; o += hop) {
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * hann[i]; im[i] = 0; } fft(re, im);
      for (let b = 1; b < N / 2; b++) if (binPc[b] >= 0) chroma[binPc[b]] += Math.sqrt(Math.hypot(re[b], im[b]));
    }
    let best = -2, key = null;
    for (let k = 0; k < 12; k++) {
      const rot = i => chroma[(i + k) % 12];
      const c = Array.from({ length: 12 }, (_, i) => rot(i));
      const cM = corr(c, KMAJ), cm = corr(c, KMIN);
      if (cM > best) { best = cM; key = CAMELOT_MAJ[k]; } if (cm > best) { best = cm; key = CAMELOT_MIN[k]; }
    }
    return key;
  }
  let actx2 = null;
  async function analyzeTrack(t, overwrite) {
    const f = await fileFor(t); if (!f) return false;
    actx2 = actx2 || new OfflineAudioContext(1, 1, 11025);
    const buf = await actx2.decodeAudioData(await f.arrayBuffer());
    const all = buf.getChannelData(0), sr = buf.sampleRate;
    const mid = Math.floor(all.length / 2), half = Math.min(all.length / 2, sr * 60);
    const seg = all.subarray(Math.max(0, mid - half), Math.min(all.length, mid + half));
    if (!t.duration) t.duration = buf.duration;
    if (overwrite || !t.bpm) { const b = detectBpm(seg, sr); if (b) { t.bpm_raw = b; t.bpm_auto = 0; t.bpm = b; t.bpm_src = 'ManaFlow'; applyBpm(t); } }
    if (overwrite || !t.key) { const k = detectKey(seg, sr); if (k) { t.key = k; t.key_src = 'ManaFlow'; } }
    return true;
  }
  async function analyzeAll(ids, overwrite) {
    J.phase = 'analyzing';
    const list = L.tracks.filter(t => linked(t) && (ids ? ids.includes(t.id) : (overwrite || !t.bpm || !t.key)));
    J.probe_total = list.length;
    for (const t of list) { if (stop) break; J.current = t.title || t.name; try { await analyzeTrack(t, overwrite); } catch (e) { J.errors++; } J.probed++; if (J.probed % 10 === 0) save(); }
  }

  // ---------------- Convert: WAV (built in) and MP3 (LAME encoder loaded on demand)
  function wavBytes(buf) {
    const ch = Math.min(2, buf.numberOfChannels), sr = buf.sampleRate, n = buf.length;
    const out = new DataView(new ArrayBuffer(44 + n * ch * 2)); const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
    out.setUint16(22, ch, true); out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
    w(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const data = [...Array(ch)].map((_, c) => buf.getChannelData(c)); let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2; }
    return new Uint8Array(out.buffer);
  }
  let lameP = null;
  function loadLame() {
    if (window.lamejs) return Promise.resolve();
    return lameP = lameP || new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
      s.onload = res; s.onerror = () => rej(new Error('Could not load the MP3 encoder (needs internet once).')); document.head.appendChild(s); });
  }
  async function mp3Bytes(buf, kbps) {
    await loadLame();
    const ch = Math.min(2, buf.numberOfChannels), enc = new lamejs.Mp3Encoder(ch, buf.sampleRate, kbps);
    const toI16 = a => { const o = new Int16Array(a.length); for (let i = 0; i < a.length; i++) { const v = Math.max(-1, Math.min(1, a[i])); o[i] = v < 0 ? v * 32768 : v * 32767; } return o; };
    const l = toI16(buf.getChannelData(0)), r = ch > 1 ? toI16(buf.getChannelData(1)) : null, parts = [];
    for (let i = 0; i < l.length; i += 1152) { const m = r ? enc.encodeBuffer(l.subarray(i, i + 1152), r.subarray(i, i + 1152)) : enc.encodeBuffer(l.subarray(i, i + 1152)); if (m.length) parts.push(new Uint8Array(m)); if (i % (1152 * 400) === 0) await new Promise(z => setTimeout(z)); }
    const end = enc.flush(); if (end.length) parts.push(new Uint8Array(end));
    return cat(...parts);
  }
  async function convert(ids, fmt, kbps, outDir) {
    J.phase = 'converting'; J.probe_total = ids.length; let ctx = null;
    for (const id of ids) {
      if (stop) break; const t = byId.get(id); J.current = t ? (t.title || t.name) : ''; const f = t && await fileFor(t);
      if (!f) { J.errors++; J.probed++; continue; }
      try {
        ctx = ctx || new OfflineAudioContext(2, 1, 44100);
        const buf = await ctx.decodeAudioData(await f.arrayBuffer());
        const bytes = fmt === 'mp3' ? await mp3Bytes(buf, kbps) : wavBytes(buf);
        const name = base(t.name || t.rel || t.loc).replace(/\.[^.]+$/, '') + '.' + fmt;
        if (outDir) { const fh = await outDir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(bytes); await w.close(); }
        else download(name, bytes, fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav');
      } catch (e) { J.errors++; }
      J.probed++;
    }
  }

  // ---------------- backup / restore
  function backup() { download('ManaFlow-library-backup.json', JSON.stringify({ manaflow: VERSION, saved: now(), library: L }), 'application/json'); }
  async function restore(file) {
    const j = JSON.parse(await file.text()); if (!j.library || !Array.isArray(j.library.tracks)) throw new Error('That is not a ManaFlow backup file.');
    L = Object.assign({ nextId: 1, tracks: [], playlists: [], roots: [], settings: { ...DEF_SETTINGS } }, j.library); reindex(); await kvSet('lib', L); return L.tracks.length;
  }

  // ---------------- folders
  async function addFolder() {
    if (!canPick) throw new Error('This browser can\'t open folders. Use Chrome or Edge on your PC.');
    const h = await window.showDirectoryPicker({ id: 'manaflow-music', mode: 'read' });
    let r = L.roots.find(x => x.name === h.name);
    if (!r) { r = { id: 'r' + Date.now(), name: h.name }; L.roots.push(r); }
    handles.set(r.id, h); perm.set(r.id, 'granted');
    await kvSet('h:' + r.id, h).catch(() => {}); save();
    startJob(async () => { await scanRoot(r); if (!stop) await probeAll(); });
    return r;
  }
  async function addFolderFiles(files) {   // fallback: <input webkitdirectory>
    const name = files[0] ? files[0].webkitRelativePath.split('/')[0] : 'Folder';
    let r = L.roots.find(x => x.name === name); if (!r) { r = { id: 'r' + Date.now(), name }; L.roots.push(r); }
    perm.set(r.id, 'granted');
    startJob(async () => { await scanRoot(r, [...files]); if (!stop) await probeAll(); });
  }
  function addFiles(files) {   // phones: pick individual music files; they link by file name for this visit
    const list = [...files].filter(f => AUDIO_EXT.has(extOf(f.name)));
    startJob(async () => {
      J.phase = 'listing files';
      const byName = new Map(); L.tracks.forEach(t => { const k = (t.name || base(t.loc || t.rel || '')).toLowerCase(); (byName.get(k) || byName.set(k, []).get(k)).push(t); });
      for (const f of list) {
        J.found++; J.current = f.name;
        const c = byName.get(f.name.toLowerCase()) || [];
        let t = c.length === 1 ? c[0] : c.find(x => x.size === f.size);
        if (!t) { const [a, ti] = fnameSuggest(f.name); t = { id: L.nextId++, name: f.name, ext: extOf(f.name), root: null, rel: null, size: f.size, title: ti, artist: a, genre: '', added: now().slice(0, 10), needs_probe: 1, rbHot: {}, mfHot: {}, mem: [] }; L.tracks.push(t); byId.set(t.id, t); J.new++; }
        else J.changed++;
        fileCache.set(t.id, f);
      }
      save(); await probeAll(list.length ? null : []);
    });
  }
  async function reconnect() {
    let ok = 0;
    for (const r of L.roots) { const h = handles.get(r.id); if (!h) continue;
      try { const p = await h.requestPermission({ mode: 'read' }); perm.set(r.id, p); if (p === 'granted') ok++; } catch (e) {} }
    return ok;
  }

  // ---------------- router: same addresses the PC server answered
  async function handle(method, path, body) {
    const u = new URL(path, location.href); const qs = Object.fromEntries(u.searchParams); const p = u.pathname.replace(/^.*\/api\//, '/api/');
    const data = body && typeof body === 'string' ? JSON.parse(body) : (body || {});
    let m;
    if (method === 'GET') {
      if (p === '/api/summary') return summary();
      if (p === '/api/tracks') { const all = query(qs); const off = +qs.offset || 0, lim = Math.min(+qs.limit || 200, 50000); return { total: all.length, rows: all.slice(off, off + lim).map(row) }; }
      if ((m = /^\/api\/track\/(\d+)$/.exec(p))) { const d = detail(+m[1]); if (!d) throw new Error('not found'); return d; }
      if ((m = /^\/api\/waveform\/(\d+)$/.exec(p))) return waveform(+m[1], +qs.bars || 120);
      if (p === '/api/job') return { ...J };
      if (p === '/api/usb') return usbPending ? [usbPending] : [];
      throw new Error('not found');
    }
    if (p === '/api/import/rekordbox') return importRekordbox(body);
    if (p === '/api/settings') {
      for (const [k, v] of Object.entries(data)) if (k in DEF_SETTINGS) L.settings[k] = String(v);
      if (['bpm_double', 'bpm_lo', 'bpm_hi'].some(k => k in data)) L.tracks.forEach(applyBpm);
      save(); return { ok: true };
    }
    if (p === '/api/roots') {
      if (data.remove) { const r = L.roots.find(x => x.name === data.remove || x.id === data.remove); if (r) { L.roots = L.roots.filter(x => x !== r); handles.delete(r.id); L.tracks.forEach(t => { if (t.root === r.id) { if (t.loc) { t.root = null; t.rel = null; } } }); L.tracks = L.tracks.filter(t => t.root !== r.id); reindex(); save(); } }
      return { ok: true };
    }
    if (p === '/api/scan') return { started: startJob(scanAll) };
    if (p === '/api/analyze') return { started: startJob(() => probeAll()) };
    if (p === '/api/stop') { stop = true; return { ok: true }; }
    if (p === '/api/dups') return { started: startJob(findDups) };
    if (p === '/api/detect') return { started: startJob(() => analyzeAll(data.ids ? data.ids.map(Number) : null, !!data.overwrite)) };
    if ((m = /^\/api\/cue\/(\d+)$/.exec(p))) {
      const t = byId.get(+m[1]); const s = +data.slot; if (!(s >= 0 && s < 8)) throw new Error('Hot cue slot must be A-H');
      t.mfHot = t.mfHot || {}; t.mfHot[s] = data.pos == null ? null : [Math.round(data.pos * 1000) / 1000, CUE_COLORS[s]]; save(); return detail(t.id);
    }
    if (p === '/api/bpm') { const t = byId.get(+data.id); if (t.bpm) { t.bpm_raw = t.bpm_raw ?? t.bpm; t.bpm = Math.round(t.bpm * (data.op === 'x2' ? 2 : .5) * 100) / 100; t.bpm_auto = -1; save(); } return detail(t.id); }
    if (p === '/api/bulk' || (m = /^\/api\/track\/(\d+)$/.exec(p))) {
      const ids = m ? [+m[1]] : (data.ids || []).map(Number); const f = m ? data : (data.fields || {});
      for (const id of ids) { const t = byId.get(id); if (!t) continue;
        for (const [k, v] of Object.entries(f)) { if (!m && String(v).trim() === '') continue;
          const key = { title: 'title', artist: 'artist', genre: 'genre', subgenre: 'subgenre', mood: 'mood', musical_key: 'key', comments: 'comments', bpm: 'bpm', release_year: 'year' }[k]; if (!key) continue;
          if (key === 'bpm') { t.bpm = parseFloat(v) || null; t.bpm_raw = t.bpm; t.bpm_auto = -1; }
          else if (key === 'year') t.year = parseInt(v) || null;
          else { t[key] = v; if (key === 'title') t.title_src = 'Manual'; if (key === 'artist') t.artist_src = 'Manual'; } } }
      save(); return m ? detail(ids[0]) : { ok: true };
    }
    if (p === '/api/usb') {
      if (data.action === 'import') return usbApply(new Set((data.ids || []).map(Number)));
      usbPending = null; return { ok: true };
    }
    throw new Error('not found');
  }

  return { init, handle, addFiles, convert: (ids, fmt, kbps, dir) => startJob(() => convert(ids, fmt, kbps, dir)), backup, restore, hotOf: id => hot(byId.get(id) || {}), settings: () => L.settings,
           tracks: () => L.tracks, linkedId: id => { const t = byId.get(id); return !!t && linked(t); }, audioURL, artURL, addFolder, addFolderFiles, reconnect, exportRekordbox, exportCSV, exportSerato, writeCrates, downloadCrates, usbScan, canPick,
           wipe: async () => { await kvSet('lib', null); location.reload(); } };
})();
