/**
 * CTCT Choir Songbook - Local Network Server v5
 * Run: node server.js
 * Then open http://YOUR-IP:3000 on any device on same WiFi
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT     = 3000;
const SERV_DIR = __dirname;
const MIME     = {'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css','.png':'image/png','.ico':'image/x-icon'};
const NO_STORE = {'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0'};
const STATE_FILE  = path.join(SERV_DIR, 'current_slide.json');
const SONGS_FILE  = path.join(SERV_DIR, 'songs_final.json');
const BACKUP_DIR  = path.join(SERV_DIR, 'backups');

// ── State ─────────────────────────────────────────────────────
let clients      = [];   // SSE display clients
let currentSlide = loadCurrentSlide();   // last slide pushed

// ── Helpers ───────────────────────────────────────────────────
function getIPs() {
  const skip = /virtual|vmware|vbox|virtualbox|hyper-v|vethernet|loopback|npcap|bluetooth/i;
  const skipAddress = /^(169\.254\.|192\.168\.56\.)/;
  const all = [];
  const preferred = [];

  for (const [name, iface] of Object.entries(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const item = {name, address: addr.address};
      all.push(item);
      if (!skip.test(name) && !skipAddress.test(addr.address)) preferred.push(item);
    }
  }

  preferred.sort((a, b) => {
    const aw = /wi-?fi|wireless|wlan/i.test(a.name) ? 0 : 1;
    const bw = /wi-?fi|wireless|wlan/i.test(b.name) ? 0 : 1;
    return aw - bw;
  });

  return preferred.length ? preferred : all;
}

function getIP() {
  const ips = getIPs();
  return ips[0] ? ips[0].address : 'localhost';
}

function push(data) {
  const msg = 'data: ' + JSON.stringify(data) + '\n\n';
  clients = clients.filter(r => { try { r.write(msg); return true; } catch { return false; } });
}

function loadCurrentSlide() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveCurrentSlide(slide) {
  fs.writeFile(STATE_FILE, JSON.stringify(slide), () => {});
}

function loadSongsFile() {
  try {
    return JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function backupSongsFile() {
  try {
    if (!fs.existsSync(SONGS_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(SONGS_FILE, path.join(BACKUP_DIR, `songs_final.${stamp}.json`));
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}

function normalizeTitle(title) {
  return (title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function serveFile(res, requestPath) {
  let cleanPath = decodeURIComponent(requestPath.split('?')[0]);
  if (cleanPath === '/' || cleanPath === '') cleanPath = '/index.html';
  if (cleanPath.startsWith('/ctct-songbook/')) cleanPath = cleanPath.slice('/ctct-songbook'.length);

  const fp = path.resolve(SERV_DIR, '.' + cleanPath.replace(/\\/g, '/'));
  if (!fp.startsWith(SERV_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fp);
    const headers = {'Content-Type': MIME[ext] || 'application/octet-stream'};
    if (ext === '.json' || path.basename(fp) === 'sw.js') Object.assign(headers, NO_STORE);
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ── Server ────────────────────────────────────────────────────
http.createServer((req, res) => {
  const url  = new URL(req.url, 'http://x');
  const path_ = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // SSE - display clients subscribe
  if (path_ === '/events') {
    res.writeHead(200, {
      'Content-Type':               'text/event-stream',
      'Cache-Control':              'no-cache',
      'Connection':                 'keep-alive',
      'Access-Control-Allow-Origin':'*',
      'X-Accel-Buffering':          'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write('retry: 3000\n');
    res.write('data: ' + JSON.stringify({type:'connected', slide: currentSlide}) + '\n\n');
    clients.push(res);
    req.on('close', () => { clients = clients.filter(c => c !== res); });
    return;
  }

  // POST slide from controller
  if (path_ === '/slide' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        const slide = {
          ...incoming,
          displayText: incoming.displayText || incoming.fullText || incoming.text || '',
          ndiText: incoming.ndiText || incoming.text || incoming.fullText || incoming.displayText || '',
        };
        currentSlide = slide;
        saveCurrentSlide(slide);
        push(slide);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, clients: clients.length}));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  // Add/import songs - persists to songs_final.json on disk so every device sees them
  if (path_ === '/admin/songs' && req.method === 'POST') {
    let body = '';
    let tooBig = false;
    req.on('data', d => {
      body += d;
      if (body.length > 8 * 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) { res.writeHead(413); res.end('Payload too large'); return; }
      try {
        const parsed = JSON.parse(body);
        const incoming = Array.isArray(parsed.songs) ? parsed.songs : [];
        if (!incoming.length) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:'No songs provided'}));
          return;
        }

        const current = loadSongsFile();
        const seen = new Set(current.map(s => normalizeTitle(s.title)));
        let added = 0, skipped = 0;
        for (const s of incoming) {
          if (!s || !s.title || !Array.isArray(s.sections) || !s.sections.length) { skipped++; continue; }
          const norm = normalizeTitle(s.title);
          if (seen.has(norm)) { skipped++; continue; }
          seen.add(norm);
          current.push(s);
          added++;
        }

        if (added > 0) {
          backupSongsFile();
          fs.writeFileSync(SONGS_FILE, JSON.stringify(current, null, 2));
        }

        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, added, skipped, total: current.length}));
      } catch (e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, error:'Invalid request body'}));
      }
    });
    return;
  }

  // Status
  if (path_ === '/status') {
    const ip = getIP();
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({displays: clients.length, ip, addresses: getIPs(), port: PORT}));
    return;
  }

  // Last slide snapshot for pages that reconnect after OBS/browser refreshes
  if (path_ === '/current') {
    res.writeHead(200, {'Content-Type':'application/json', ...NO_STORE});
    res.end(JSON.stringify(currentSlide || {}));
    return;
  }

  // Display page (for projector/TV)
  if (path_ === '/display') { serveDisplay(res, false); return; }

  // NDI page (for OBS capture)
  if (path_ === '/ndi') { serveDisplay(res, true); return; }

  // Control page (for worship leader)
  if (path_ === '/control') { serveControl(res); return; }

  // Static files, including /ctct-songbook/... aliases used by the PWA config
  serveFile(res, path_);

}).listen(PORT, '0.0.0.0', () => {
  const ip = getIP();
  const urls = getIPs().map(item => '  - http://' + item.address + ':' + PORT + '  (' + item.name + ')');
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   CTCT Choir Songbook - Local Network Server v5   ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Songbook:  http://' + ip + ':' + PORT + '/          ');
  console.log('║  Display:   http://' + ip + ':' + PORT + '/display   ');
  console.log('║  Control:   http://' + ip + ':' + PORT + '/control   ');
  console.log('║  NDI:       http://' + ip + ':' + PORT + '/ndi       ');
  console.log('╚══════════════════════════════════════════════════╝\n');
  if (urls.length) console.log('Available network addresses:\n' + urls.join('\n') + '\n');
});

// Keepalive every 20s so OBS doesn't drop SSE
setInterval(() => {
  clients = clients.filter(r => { try { r.write(': ka\n\n'); return true; } catch { return false; } });
}, 20000);

// ── DISPLAY PAGE ──────────────────────────────────────────────
function serveDisplay(res, isNDI) {
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>CTCT ${isNDI ? 'NDI' : 'Display'}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:${isNDI ? 'transparent' : '#000'};font-family:Georgia,serif;color:#fff}

/* Waiting screen - shown before first slide */
#wait{
  position:fixed;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;text-align:center;
  padding:40px;background:#000;
  transition:opacity .5s;
}
#wait h1{font-size:clamp(18px,3vw,36px);font-family:-apple-system,sans-serif;
  font-weight:300;letter-spacing:.1em;color:rgba(255,255,255,.3);margin-bottom:12px}
#wait p{font-size:clamp(12px,1.5vw,16px);color:rgba(255,255,255,.15);font-family:-apple-system,sans-serif}
#sse-status{position:fixed;top:12px;left:12px;font-size:13px;font-family:-apple-system,sans-serif;font-weight:700;padding:6px 14px;border-radius:8px;z-index:999}
#sse-status.connecting{background:rgba(255,165,0,.15);color:orange;border:1px solid rgba(255,165,0,.3)}
#sse-status.connected{background:rgba(63,185,80,.12);color:#3fb950;border:1px solid rgba(63,185,80,.25)}
#sse-status.error{background:rgba(231,76,60,.15);color:#e74c3c;border:1px solid rgba(231,76,60,.3)}

/* Main content area */
#wrap{
  position:fixed;inset:0;display:none;
  flex-direction:column;align-items:center;justify-content:${isNDI ? 'flex-end' : 'center'};
  padding:${isNDI ? '24px 60px' : '40px 80px'};
  text-align:center;background:#000;
  transition:background .8s;
}
#wrap.chorus-mode{background:#0d0404}

#song-name{
  font-family:-apple-system,sans-serif;
  font-size:${isNDI ? 'clamp(12px,1.8vw,22px)' : 'clamp(14px,2vw,26px)'};
  color:#5ba4f5;letter-spacing:.1em;text-transform:uppercase;
  margin-bottom:10px;font-weight:500;width:100%;
}
#sect-label{
  font-family:-apple-system,sans-serif;
  font-size:${isNDI ? 'clamp(10px,1.2vw,15px)' : 'clamp(11px,1.4vw,17px)'};
  letter-spacing:.2em;text-transform:uppercase;
  margin-bottom:18px;font-weight:700;width:100%;
}
#sect-label.verse{color:#a8d8f0}
#sect-label.chorus{color:#f7a6b0}
#sect-label.bridge{color:#b8f0b8}
#sect-label.pre-chorus{color:#f0d080}

#lyrics{
  font-size:${isNDI ? 'clamp(28px,3.2vw,42px)' : 'clamp(28px,5vw,68px)'};
  line-height:${isNDI ? '1.18' : '1.7'};color:#fff;
  white-space:pre-wrap;word-break:break-word;
  width:100%;max-width:${isNDI ? '1180px' : '1400px'};
  text-shadow:${isNDI ? '0 2px 0 #000,2px 0 0 #000,0 -2px 0 #000,-2px 0 0 #000,0 4px 8px rgba(0,0,0,.9)' : '0 2px 30px rgba(0,0,0,.9)'};
}
${isNDI ? `
#wait{display:none;background:transparent}
#wrap{
  padding:0 4vw clamp(8px,2vh,24px);
  background:transparent;
}
#wrap.chorus-mode{background:transparent}
#song-name,#sect-label,#key-display,#chunk-dots,#progress,#copyright{display:none!important}
#lyrics{
  background:transparent;
  border-radius:0;
  padding:0 12px;
  max-width:1180px;
  font-family:Arial,Helvetica,sans-serif;
  font-weight:700;
  letter-spacing:0;
  -webkit-text-stroke:1.5px rgba(0,0,0,.9);
  paint-order:stroke fill;
}
#sse-status{display:none}
` : ''}
#key-display{
  margin-top:16px;font-size:clamp(13px,1.6vw,20px);
  color:#5ba4f5;font-family:-apple-system,sans-serif;
  font-weight:700;letter-spacing:.1em;opacity:.4;
}
#chunk-dots{display:flex;gap:7px;justify-content:center;margin-top:12px}
.dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.2)}
.dot.on{background:rgba(91,164,245,.85)}
#progress{position:fixed;bottom:0;left:0;height:2px;background:#1e88e5;transition:width .4s}
#copyright{position:fixed;bottom:8px;right:14px;font-size:10px;
  color:rgba(255,255,255,.1);font-family:-apple-system,sans-serif}
</style>
</head>
<body>

<div id="sse-status" class="connecting">⟳ Connecting...</div>

<div id="wait">
  <h1>CAPE TOWN CHRISTIAN TABERNACLE</h1>
  <p>Open Display Control and select a song to begin</p>
  <p id="server-url" style="font-size:12px;margin-top:16px;color:rgba(255,255,255,.2);font-family:-apple-system,sans-serif"></p>
</div>
<script>document.getElementById('server-url').textContent='Server: '+window.location.host;</script>

<div id="wrap">
  <div id="song-name"></div>
  <div id="sect-label"></div>
  <div id="lyrics"></div>
  <div id="key-display"></div>
  <div id="chunk-dots"></div>
</div>

<div id="progress" style="width:0"></div>
<div id="copyright">© 2024 Michee Diankeba · CTCT Choir Songbook</div>

<script>
const IS_NDI = ${isNDI ? 'true' : 'false'};
const INITIAL_SLIDE = ${JSON.stringify(currentSlide || {}).replace(/</g, '\\u003c')};

// DOM elements
const statusEl = document.getElementById('sse-status');
const waitEl   = document.getElementById('wait');
const wrapEl   = document.getElementById('wrap');
const songEl   = document.getElementById('song-name');
const sectEl   = document.getElementById('sect-label');
const lyrEl    = document.getElementById('lyrics');
const keyEl    = document.getElementById('key-display');
const dotsEl   = document.getElementById('chunk-dots');
const progEl   = document.getElementById('progress');

let lastSlideKey = '';

function setStatus(cls, text) {
  statusEl.className = cls;
  statusEl.textContent = text;
}

// Connect to SSE, with polling backup for OBS/browser environments that stall EventSource.
let sse = null;
if ('EventSource' in window) {
  try {
    sse = new EventSource('/events');
    sse.onopen = () => {
      setStatus('connected', '● Live - ' + window.location.host);
    };
    sse.onerror = () => {
      setStatus('error', '● Live backup mode - polling');
    };
  } catch (e) {
    setStatus('error', '● Live backup mode - polling');
  }
} else {
  setStatus('error', '● Live backup mode - polling');
}

// Font size based on content
function calcFontSize(text) {
  if (IS_NDI) return 'clamp(28px,3.2vw,42px)';
  const lines = text.split('\\n').filter(l => l.trim()).length;
  const maxLen = Math.max(...text.split('\\n').map(l => l.length), 1);
  if (lines > 8 || maxLen > 55) return 'clamp(20px,3vw,40px)';
  if (lines > 6 || maxLen > 42) return 'clamp(24px,3.8vw,52px)';
  if (lines > 4 || maxLen > 30) return 'clamp(28px,4.5vw,60px)';
  return 'clamp(32px,5vw,68px)';
}

// Update chunk position dots (NDI only)
function updateDots(cur, tot) {
  if (!IS_NDI || tot <= 1) { dotsEl.innerHTML = ''; return; }
  dotsEl.innerHTML = Array.from({length: tot}, (_, i) =>
    '<div class="dot' + (i === cur ? ' on' : '') + '"></div>'
  ).join('');
}

// Render a slide onto the screen
function showSlide(d) {
  lastSlideKey = JSON.stringify(d);
  const displayText = IS_NDI
    ? (d.ndiText || d.text || '')
    : (d.displayText || d.fullText || d.text || '');

  // Switch from waiting screen to content
  waitEl.style.display = 'none';
  wrapEl.style.display = 'flex';

  // Song name
  songEl.textContent = d.song || '';

  // Section label + type colour
  const st = (d.sectionType || 'verse').toLowerCase();
  sectEl.textContent = d.section || '';
  sectEl.className   = st;

  // Background mood
  wrapEl.className = st === 'chorus' ? 'chorus-mode' : '';

  // Lyrics - set directly, no opacity animation that might hide content
  lyrEl.textContent  = displayText;
  lyrEl.style.fontSize = calcFontSize(displayText);

  // Key
  keyEl.textContent = d.key ? 'Key of ' + d.key : '';

  // Progress bar
  progEl.style.width = d.total > 0
    ? ((d.index + 1) / d.total * 100) + '%'
    : '0';

  // Chunk dots
  updateDots(d.chunkIndex || 0, d.chunkTotal || 1);
}

// Blank the screen
function blankScreen() {
  lastSlideKey = JSON.stringify({type:'blank'});

  waitEl.style.display  = 'none';
  wrapEl.style.display  = 'flex';
  wrapEl.className      = '';
  lyrEl.textContent     = '';
  songEl.textContent    = '';
  sectEl.textContent    = '';
  keyEl.textContent     = '';
  progEl.style.width    = '0';
  dotsEl.innerHTML      = '';
}

// Handle incoming SSE messages
if (sse) sse.onmessage = (e) => {
  let d;
  try { d = JSON.parse(e.data); } catch { return; }

  if (d.type === 'blank') {
    blankScreen();
    return;
  }

  if (d.type === 'connected') {
    // Restore last slide if one exists
    if (d.slide && d.slide.text && d.slide.type !== 'blank') {
      showSlide(d.slide);
    }
    return;
  }

  // Any other message with text = show it
  if (d.text) {
    showSlide(d);
    statusEl.textContent = '● Live · ' + d.song;
    statusEl.className = 'connected';
  }
};

function applyIncoming(d, source) {
  if (!d || Object.keys(d).length === 0) return;
  const key = JSON.stringify(d);
  if (key === lastSlideKey) return;

  if (d.type === 'blank') {
    blankScreen();
  } else if (d.text) {
    showSlide(d);
  } else {
    return;
  }

  if (source === 'poll') setStatus('connected', '● Live backup mode - ' + window.location.host);
}

function pollCurrent() {
  fetch('/current', {cache:'no-store'})
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (statusEl.className !== 'connected') {
        setStatus('connected', '● Live backup mode - ' + window.location.host);
      }
      applyIncoming(d, 'poll');
    })
    .catch(() => {});
}

setStatus('connected', '● Live backup mode - ' + window.location.host);
applyIncoming(INITIAL_SLIDE, 'initial');
pollCurrent();
setInterval(pollCurrent, 1000);

// Keep status always visible so user can see connection state
// Update it with server URL for reference
statusEl.title = 'Connected to: ' + window.location.host;
</script>
</body>
</html>`;
  res.writeHead(200, {'Content-Type': 'text/html', ...NO_STORE});
  res.end(html);
}

// ── CONTROL PAGE ──────────────────────────────────────────────
function serveControl(res) {
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>CTCT Display Control v5</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg:#0d1117;--sur:#161b22;--sur2:#21262d;--sur3:#2d333b;--blue:#1e88e5;--blue2:#42a5f5;--text:#e6edf3;--text2:#8b949e;--text3:#484f58;--border:#30363d;--green:#3fb950;--gold:#d4a94a;--red:#e74c3c}
body{font-family:-apple-system,sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden}
#topbar{background:var(--sur);border-bottom:1px solid var(--border);padding:10px 14px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:50}
#topbar h1{font-size:14px;font-weight:700;flex:1}
#conn-status{font-size:10px;padding:3px 8px;border-radius:10px;font-weight:600}
#conn-status.on{background:rgba(63,185,80,.15);color:var(--green);border:1px solid rgba(63,185,80,.3)}
#conn-status.off{background:rgba(231,76,60,.15);color:var(--red);border:1px solid rgba(231,76,60,.3)}
#search-wrap{padding:10px 14px}
#search{width:100%;background:var(--sur2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:14px;color:var(--text);outline:none}
#search::placeholder{color:var(--text3)}
#search:focus{border-color:var(--blue)}
#song-list{overflow-y:auto;height:calc(100vh - 92px)}
.song-row{padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:10px}
.song-row:active{background:var(--sur2)}
.sr-key{font-size:11px;font-weight:700;color:#fff;background:var(--blue);padding:2px 7px;border-radius:4px;flex-shrink:0}
.sr-title{font-size:14px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#controller{display:none;position:fixed;inset:0;background:var(--bg);z-index:100;flex-direction:column;overflow:hidden}
#ctrl-header{background:var(--sur);border-bottom:1px solid var(--border);padding:10px 14px;display:flex;align-items:center;gap:8px;flex-shrink:0}
#ctrl-back{background:none;border:none;color:var(--blue2);font-size:15px;cursor:pointer;padding:4px 8px}
#ctrl-title{font-size:14px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ctrl-key{font-size:12px;font-weight:700;color:#fff;background:var(--blue);padding:3px 10px;border-radius:6px;display:none}
#displays-badge{font-size:10px;color:var(--green);background:rgba(63,185,80,.1);border:1px solid rgba(63,185,80,.25);padding:3px 8px;border-radius:10px}
#slide-preview{background:var(--sur);margin:10px;border-radius:10px;padding:14px;border:1px solid var(--border);flex-shrink:0}
#preview-section{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--gold);margin-bottom:6px}
#preview-text{font-size:14px;line-height:1.6;color:var(--text);white-space:pre-wrap;max-height:none;overflow:visible}
#slide-list{flex:1;overflow-y:auto;padding:8px 10px 110px}
.slide-chip{padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--sur2);margin-bottom:6px;cursor:pointer}
.slide-chip:active{background:var(--sur3)}
.slide-chip.current{border-color:var(--blue);background:rgba(30,136,229,.12)}
.sc-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);margin-bottom:3px}
.sc-label.verse{color:#a8d8f0}.sc-label.chorus{color:#f7a6b0}.sc-label.bridge{color:#b8f0b8}
.sc-text{font-size:12px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#nav-btns{position:fixed;bottom:0;left:0;right:0;background:var(--sur);border-top:1px solid var(--border);padding:10px;display:flex;gap:8px;z-index:101}
.nav-btn{flex:1;padding:14px 8px;border-radius:10px;border:none;font-size:15px;cursor:pointer;font-weight:700;font-family:-apple-system,sans-serif;transition:all .15s}
.nav-btn:active{opacity:.8;transform:scale(.97)}
#btn-blank{background:var(--sur2);color:var(--text2);border:1px solid var(--border);flex:0 0 52px}
#btn-blank.blanked{background:rgba(231,76,60,.15);color:var(--red)}
#btn-prev{background:var(--sur2);color:var(--text2);border:1px solid var(--border);flex:0 0 52px}
#btn-next{background:var(--blue);color:#fff;flex:2}
#btn-sect{background:var(--sur3);color:var(--text3);font-size:11px;border:1px solid var(--border);flex:0 0 70px}
</style>
</head>
<body>
<div id="topbar">
  <h1>🎚 CTCT Display Control</h1>
  <span id="conn-status" class="off">0 displays</span>
</div>
<div id="search-wrap">
  <input id="search" type="search" placeholder="Search songs..." autocorrect="off" autocomplete="off">
</div>
<div id="song-list"><div style="padding:20px;color:#8b949e;text-align:center">Loading songs...</div></div>

<div id="controller">
  <div id="ctrl-header">
    <button id="ctrl-back">← Back</button>
    <span id="ctrl-title"></span>
    <span id="ctrl-key"></span>
    <span id="displays-badge">0 displays</span>
  </div>
  <div id="slide-preview">
    <div id="preview-section">Select a section</div>
    <div id="preview-text">-</div>
  </div>
  <div id="slide-list"></div>
  <div id="nav-btns">
    <button class="nav-btn" id="btn-blank">⬛</button>
    <button class="nav-btn" id="btn-prev">‹</button>
    <button class="nav-btn" id="btn-next">Next ›</button>
    <button class="nav-btn" id="btn-sect">Section ↓</button>
  </div>
</div>

<script>
let SONGS=[], filtered=[], current=null, slides=[], si=0, blanked=false, ndiChunks=[], ndiIdx=0, dc=0;

// Load songs
fetch('/songs_final.json', {cache:'no-store'})
  .then(r => {
    console.log('Songs fetch status:', r.status);
    if(!r.ok) throw new Error('songs_final.json returned HTTP '+r.status);
    return r.json();
  })
  .then(data => {
    const bundled = Array.isArray(data) ? data : [];
    let local = [];
    try {
      const saved = localStorage.getItem('ctct-local-songs') || '[]';
      const parsed = JSON.parse(saved);
      local = Array.isArray(parsed) ? parsed : [];
    } catch(e) {
      console.warn('Could not read ctct-local-songs:', e);
    }

    const seen = new Set();
    SONGS = bundled.concat(local)
      .filter(s => s && s.title && s.sections && s.sections.length > 0)
      .filter(s => {
        const key = (s.title || '').trim().toLowerCase() + '|' + (s.key || '');
        if(seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a,b) => a.title.localeCompare(b.title));

    filtered=SONGS;
    console.log('Songs loaded:', SONGS.length, 'bundled:', bundled.length, 'local:', local.length);
    renderList();
    if(!SONGS.length) {
      document.getElementById('song-list').innerHTML = '<div style="padding:20px;color:#e74c3c;text-align:center">No songs found. Open the main songbook once on this same browser, or restore songs_final.json beside server.js.</div>';
    }
  })
  .catch(e => {
    console.error('Songs load FAILED:', e);
    document.getElementById('song-list').innerHTML = '<div style="padding:20px;color:red">Error: Could not load songs. Is songs_final.json in the same folder as server.js?</div>';
  });

function renderList(){
  document.getElementById('song-list').innerHTML=filtered.map((s,i)=>
    '<div class="song-row" onclick="openSong('+i+')">'+(s.key?'<span class="sr-key">'+s.key+'</span>':'')+
    '<span class="sr-title">'+s.title+'</span></div>'
  ).join('');
}

document.getElementById('search').addEventListener('input',function(){
  const q=this.value.toLowerCase().trim();
  filtered=q?SONGS.filter(s=>s.title.toLowerCase().includes(q)||(s.key&&s.key.toLowerCase().includes(q))):SONGS;
  renderList();
});

function openSong(i){
  current=filtered[i]; si=0; blanked=false; ndiChunks=[]; ndiIdx=0;
  document.getElementById('btn-blank').classList.remove('blanked');
  document.getElementById('btn-blank').textContent='⬛';
  slides=current.sections.map(sec=>({
    song:current.title, key:current.key||'',
    section:sec.label||sec.type||'Verse',
    sectionType:sec.type||'verse',
    text:sec.text.replace(/\[[^\]]+\]/g,'').trim()
  }));
  document.getElementById('ctrl-title').textContent=current.title;
  const kEl=document.getElementById('ctrl-key');
  kEl.textContent=current.key||''; kEl.style.display=current.key?'inline-block':'none';
  renderSlides(); go(0);
  document.getElementById('controller').style.display='flex';
}

document.getElementById('ctrl-back').onclick=()=>{
  document.getElementById('controller').style.display='none'; current=null;
};

function renderSlides(){
  document.getElementById('slide-list').innerHTML=slides.map((sl,i)=>
    '<div class="slide-chip'+(i===si?' current':'')+'" onclick="go('+i+')" id="sc'+i+'">'+
    '<div class="sc-label '+sl.sectionType+'">'+sl.section+'</div>'+
    '<div class="sc-text">'+(sl.text.split('\\n')[0]||'')+'</div></div>'
  ).join('');
}

function go(i){
  if(i<0||i>=slides.length)return;
  si=i; const sl=slides[i];
  document.getElementById('preview-section').textContent=sl.section;
  document.getElementById('preview-text').textContent=sl.text;
  document.querySelectorAll('.slide-chip').forEach((el,idx)=>el.classList.toggle('current',idx===si));
  const sc=document.getElementById('sc'+i); if(sc)sc.scrollIntoView({block:'nearest'});
  // Build NDI chunks
  const lines=sl.text.split('\\n').filter(l=>l.trim()); const cs=2;
  ndiChunks=[]; ndiIdx=0;
  for(let j=0;j<lines.length;j+=cs) ndiChunks.push(lines.slice(j,j+cs).join('\\n'));
  if(!ndiChunks.length)ndiChunks=[sl.text];
  updateNextBtn();
  if(!blanked) sendSlide(sl,i,ndiChunks[0],0,ndiChunks.length);
}

function updateNextBtn(){
  const btn=document.getElementById('btn-next');
  btn.textContent=ndiIdx>=ndiChunks.length-1?'Next Section ›':'Next Line ›';
}

function sendSlide(sl,idx,text,ci,ct){
  fetch('/slide',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...sl,displayText:sl.text,fullText:sl.text,ndiText:text,text,index:idx,total:slides.length,type:'slide',chunkIndex:ci,chunkTotal:ct})
  }).then(r=>r.json()).then(d=>{
    dc=d.clients||0;
    document.getElementById('displays-badge').textContent=dc+' display'+(dc!==1?'s':'');
    document.getElementById('conn-status').textContent=dc+' display'+(dc!==1?'s':'')+' connected';
    document.getElementById('conn-status').className=dc>0?'on':'off';
  }).catch(()=>{});
}

// Button wiring
document.getElementById('btn-next').onclick=()=>{
  if(ndiIdx<ndiChunks.length-1){
    ndiIdx++; sendSlide(slides[si],si,ndiChunks[ndiIdx],ndiIdx,ndiChunks.length); updateNextBtn();
  } else { ndiChunks=[]; ndiIdx=0; go(Math.min(si+1,slides.length-1)); }
};
document.getElementById('btn-prev').onclick=()=>{
  if(ndiIdx>0){ ndiIdx--; sendSlide(slides[si],si,ndiChunks[ndiIdx],ndiIdx,ndiChunks.length); updateNextBtn(); }
  else { ndiChunks=[]; ndiIdx=0; go(Math.max(si-1,0)); }
};
document.getElementById('btn-sect').onclick=()=>{ ndiChunks=[]; ndiIdx=0; go(Math.min(si+1,slides.length-1)); };
document.getElementById('btn-blank').onclick=()=>{
  blanked=!blanked;
  const btn=document.getElementById('btn-blank');
  btn.classList.toggle('blanked',blanked);
  btn.textContent=blanked?'▶':'⬛';
  if(blanked){
    fetch('/slide',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'blank',song:'',section:'',text:'',key:'',index:0,total:0})
    }).then(r=>r.json()).then(d=>{dc=d.clients||0;}).catch(()=>{});
  } else { go(si); }
};

// Swipe on controller
let tx=0;
document.getElementById('controller').addEventListener('touchstart',e=>{tx=e.touches[0].clientX;},{passive:true});
document.getElementById('controller').addEventListener('touchend',e=>{
  const dx=e.changedTouches[0].clientX-tx;
  if(Math.abs(dx)>60){ndiChunks=[];ndiIdx=0;go(dx<0?Math.min(si+1,slides.length-1):Math.max(si-1,0));}
},{passive:true});

// Status poll
function poll(){
  fetch('/status').then(r=>r.json()).then(d=>{
    dc=d.displays;
    document.getElementById('conn-status').textContent=dc+' display'+(dc!==1?'s':'')+' connected';
    document.getElementById('conn-status').className=dc>0?'on':'off';
  }).catch(()=>{
    document.getElementById('conn-status').textContent='Server offline';
    document.getElementById('conn-status').className='off';
  });
}
poll(); setInterval(poll,5000);
</script>
</body></html>`;
  res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
  res.end(html);
}
