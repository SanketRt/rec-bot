/**
 * The control web UI, served at GET /. A single self-contained page (no build
 * step, no external assets) so it deploys with the rest of the app. The page is
 * public; the actions it calls are gated by the API token when one is set.
 *
 * NOTE: the embedded <script> must not use backticks or ${...} — this file is a
 * template literal, so those would be interpreted here.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>rec-bot</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:#0d1117; color:#e6edf3; }
  header { display:flex; align-items:center; gap:10px; padding:16px 20px;
           border-bottom:1px solid #21262d; position:sticky; top:0; background:#0d1117; }
  header h1 { font-size:18px; margin:0; font-weight:600; }
  .dot { width:10px; height:10px; border-radius:50%; background:#6e7681; }
  .dot.ok { background:#3fb950; } .dot.bad { background:#f85149; }
  main { max-width:760px; margin:0 auto; padding:20px; display:flex; flex-direction:column; gap:16px; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:12px; padding:18px; }
  .card h2 { font-size:14px; text-transform:uppercase; letter-spacing:.5px; color:#8b949e;
             margin:0 0 14px; }
  label { display:block; font-size:13px; color:#8b949e; margin:10px 0 4px; }
  input[type=text], input[type=number], select {
    width:100%; padding:9px 11px; background:#0d1117; border:1px solid #30363d;
    border-radius:8px; color:#e6edf3; font-size:14px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .row > div { flex:1; min-width:140px; }
  .checks { display:flex; gap:18px; flex-wrap:wrap; margin-top:12px; }
  .checks label { display:flex; align-items:center; gap:7px; margin:0; color:#e6edf3; font-size:14px; }
  button { font:inherit; cursor:pointer; border:none; border-radius:8px; padding:10px 16px; font-weight:600; }
  .primary { background:#238636; color:#fff; width:100%; margin-top:16px; padding:12px; font-size:15px; }
  .primary:hover { background:#2ea043; }
  .stop { background:#da3633; color:#fff; padding:6px 12px; font-size:13px; }
  .ghost { background:#21262d; color:#e6edf3; }
  .item { display:flex; align-items:center; justify-content:space-between; gap:12px;
          padding:11px 0; border-top:1px solid #21262d; }
  .item:first-child { border-top:none; }
  .item .meta { min-width:0; }
  .item .meta b { display:block; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item .meta span { color:#8b949e; font-size:12px; }
  .empty { color:#6e7681; font-size:14px; }
  details summary { cursor:pointer; color:#8b949e; font-size:13px; }
  #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%);
           padding:10px 18px; border-radius:8px; opacity:0; transition:opacity .2s;
           pointer-events:none; max-width:90%; }
  #toast.show { opacity:1; }
  #toast.good { background:#238636; color:#fff; } #toast.bad { background:#da3633; color:#fff; }
  .hint { color:#6e7681; font-size:12px; margin-top:6px; }
</style>
</head>
<body>
<header>
  <span id="dot" class="dot"></span>
  <h1>rec-bot</h1>
  <span id="cap" style="margin-left:auto;color:#8b949e;font-size:13px"></span>
</header>
<main>
  <section class="card">
    <h2>Start a recording</h2>
    <label>Google Meet link</label>
    <input id="url" type="text" placeholder="https://meet.google.com/abc-defg-hij" autocomplete="off"/>
    <label>Title (optional)</label>
    <input id="title" type="text" placeholder="Algorithms Lecture 5"/>
    <div class="row">
      <div>
        <label>Layout</label>
        <select id="layout">
          <option value="spotlight">Spotlight (active speaker / share)</option>
          <option value="auto">Auto</option>
          <option value="tiled">Tiled</option>
          <option value="sidebar">Sidebar</option>
        </select>
      </div>
      <div>
        <label>Max duration (min)</label>
        <input id="max" type="number" min="1" placeholder="default"/>
      </div>
    </div>
    <div class="checks">
      <label><input id="hideSelf" type="checkbox"/> Hide self-view</label>
      <label><input id="dismiss" type="checkbox" checked/> Dismiss popups</label>
    </div>
    <button class="primary" onclick="start()">Start recording</button>
  </section>

  <section class="card">
    <h2>Recording now</h2>
    <div id="active"><div class="empty">Nothing recording.</div></div>
  </section>

  <section class="card">
    <h2>Recent recordings</h2>
    <div id="history"><div class="empty">None yet.</div></div>
  </section>

  <details class="card">
    <summary>Settings</summary>
    <label>API token (only if the server requires one)</label>
    <input id="token" type="text" placeholder="paste API_TOKEN"/>
    <button class="ghost" style="margin-top:10px" onclick="saveToken()">Save</button>
    <div class="hint">Stored in this browser only.</div>
  </details>
</main>
<div id="toast"></div>
<script>
  var TOKEN_KEY = 'recbot_token';
  function getToken(){ return localStorage.getItem(TOKEN_KEY) || ''; }
  function headers(){ var h = {'Content-Type':'application/json'}; var t=getToken(); if(t) h['Authorization']='Bearer '+t; return h; }
  function toast(msg, bad){ var el=document.getElementById('toast'); el.textContent=msg; el.className='show '+(bad?'bad':'good'); setTimeout(function(){ el.className=''; }, 3500); }
  function api(path, opts){ opts=opts||{}; opts.headers=headers(); return fetch(path, opts).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }).catch(function(){ return {ok:r.ok,status:r.status,body:{}}; }); }); }
  function esc(s){ var d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }
  function fmtDur(sec){ sec=Math.max(0,Math.floor(sec)); var m=Math.floor(sec/60), s=sec%60; var h=Math.floor(m/60); m=m%60; return (h?h+'h ':'')+m+'m '+s+'s'; }
  function fmtAgo(ms){ var d=(Date.now()-ms)/1000; if(d<60) return 'just now'; if(d<3600) return Math.floor(d/60)+'m ago'; if(d<86400) return Math.floor(d/3600)+'h ago'; return Math.floor(d/86400)+'d ago'; }

  function start(){
    var url=document.getElementById('url').value.trim();
    if(!url){ toast('Enter a Meet link', true); return; }
    var body={
      meetUrl:url,
      title:document.getElementById('title').value.trim() || undefined,
      layout:document.getElementById('layout').value,
      hideSelfView:document.getElementById('hideSelf').checked,
      dismissPopups:document.getElementById('dismiss').checked
    };
    var max=parseInt(document.getElementById('max').value,10);
    if(!isNaN(max)) body.maxDurationMin=max;
    api('/record',{method:'POST',body:JSON.stringify(body)}).then(function(r){
      if(r.ok){ toast('Recording started'); document.getElementById('url').value=''; document.getElementById('title').value=''; refresh(); }
      else { toast((r.body&&r.body.error)||('Error '+r.status), true); }
    }).catch(function(){ toast('Network error', true); });
  }

  function stop(id){ api('/stop',{method:'POST',body:JSON.stringify({id:id})}).then(function(){ toast('Stopping…'); refresh(); }); }
  function stopAll(){ api('/stop',{method:'POST',body:JSON.stringify({})}).then(function(){ toast('Stopping all…'); refresh(); }); }

  function renderActive(list){
    var el=document.getElementById('active');
    if(!list || !list.length){ el.innerHTML='<div class="empty">Nothing recording.</div>'; return; }
    var html='';
    for(var i=0;i<list.length;i++){ var a=list[i];
      var elapsed=fmtDur((Date.now()-new Date(a.startedAt).getTime())/1000);
      html+='<div class="item"><div class="meta"><b>'+esc(a.title||a.meetUrl)+'</b>'
        +'<span>'+esc(a.meetUrl)+' · '+elapsed+'</span></div>'
        +'<button class="stop" onclick="stop(\\''+esc(a.id)+'\\')">Stop</button></div>';
    }
    el.innerHTML=html;
  }

  function renderHistory(files){
    var el=document.getElementById('history');
    if(!files || !files.length){ el.innerHTML='<div class="empty">None yet.</div>'; return; }
    var html='';
    for(var i=0;i<files.length;i++){ var f=files[i];
      html+='<div class="item"><div class="meta"><b>'+esc(f.name)+'</b>'
        +'<span>'+f.sizeMB+' MB · '+fmtAgo(f.mtime)+'</span></div></div>';
    }
    el.innerHTML=html;
  }

  function health(){
    api('/health').then(function(r){
      var dot=document.getElementById('dot');
      if(r.ok && r.body.status==='ok'){ dot.className='dot ok';
        document.getElementById('cap').textContent=r.body.active+' active / '+r.body.maxConcurrent+' max';
      } else dot.className='dot bad';
    }).catch(function(){ document.getElementById('dot').className='dot bad'; });
  }

  function refresh(){
    health();
    api('/recordings').then(function(r){ if(r.ok) renderActive(r.body.active); });
    api('/history').then(function(r){ if(r.ok) renderHistory(r.body.files); });
  }

  function saveToken(){ localStorage.setItem(TOKEN_KEY, document.getElementById('token').value.trim()); toast('Saved'); refresh(); }

  document.getElementById('token').value=getToken();
  refresh();
  setInterval(refresh, 4000);
</script>
</body>
</html>`;
