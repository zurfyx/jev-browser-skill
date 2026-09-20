// Small self-contained pages for live mode. Scripts run inside a sandboxed iframe.
export const samples = {
  login: {
    title: "Login, then a dashboard",
    goal: "Log in as ada, then search the dashboard for 'quarterly report' and open the first result. Done when the report page is visible.",
    texts: "ada, quarterly report",
    secret: "hunter2",
    html: `<!doctype html><title>Acme Console</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:28px;color:#222}h1{font-size:22px;margin:0 0 14px}
label{display:block;margin:8px 0 2px;color:#555;font-size:13px}input,select{font:inherit;padding:6px 8px;border:1px solid #bbb;border-radius:6px;width:240px}
button{font:inherit;padding:7px 14px;border-radius:6px;border:1px solid #333;background:#333;color:#fff;margin-top:12px;cursor:pointer}
nav a{margin-right:14px}.card{border:1px solid #ddd;border-radius:8px;padding:12px;margin:10px 0;max-width:420px}.err{color:#b00020}</style>
<div id="app"></div>
<script>
const app=document.getElementById('app');let user=null,q='';
const views={
  login:()=>\`<h1>Acme Console</h1><form id="f"><label>Username</label><input name="u" autocomplete="off"><label>Password</label><input name="p" type="password"><br><button>Sign in</button></form><p class="err" id="err"></p><p><a href="#help">Forgot password?</a></p>\`,
  home:()=>\`<nav><a href="#home">Home</a><a href="#reports">Reports</a><a href="#settings">Settings</a><a href="#logout">Sign out</a></nav><h1>Welcome, \${user}</h1>
    <form id="s"><label>Search documents</label><input name="q" placeholder="Search…" autocomplete="off"> <button>Search</button></form><div id="results"></div>\`,
  results:()=>\`<nav><a href="#home">Home</a><a href="#reports">Reports</a><a href="#settings">Settings</a></nav><h1>Results for "\${q}"</h1>
    <div class="card"><a href="#doc/q3">Q3 quarterly report</a><br><small>Finance · updated yesterday</small></div>
    <div class="card"><a href="#doc/plan">Annual plan</a><br><small>Strategy · last month</small></div>\`,
  doc:()=>\`<nav><a href="#home">Home</a><a href="#results">Back to results</a></nav><h1>Q3 quarterly report</h1><p>Revenue grew 12% quarter over quarter. Costs were flat.</p><p><a href="#home">Home</a></p>\`,
  settings:()=>\`<nav><a href="#home">Home</a></nav><h1>Settings</h1><form id="set"><label>Language</label><select name="lang"><option>English</option><option>Català</option><option>Deutsch</option></select><label><input type="checkbox" name="news" style="width:auto"> Email me product news</label><button>Save</button></form><p id="saved"></p>\`,
};
function render(){const h=location.hash.slice(1)||'login';const v=h.startsWith('doc')?'doc':(views[h]?h:'home');
  if(!user&&v!=='login'){location.hash='';return}
  app.innerHTML=views[v]();
  if(v==='login')app.querySelector('#f').onsubmit=e=>{e.preventDefault();const d=new FormData(e.target);if(d.get('u')==='ada'&&d.get('p')==='hunter2'){user='ada';location.hash='home'}else document.getElementById('err').textContent='Wrong username or password.'};
  if(v==='home')app.querySelector('#s').onsubmit=e=>{e.preventDefault();q=new FormData(e.target).get('q');location.hash='results'};
  if(v==='settings')app.querySelector('#set').onsubmit=e=>{e.preventDefault();document.getElementById('saved').textContent='Saved.'};
}
addEventListener('hashchange',()=>{if(location.hash==='#logout'){user=null;location.hash=''}else render()});render();
</script>`,
  },
  form: {
    title: "A settings form",
    goal: "Set the display name to Ada Lovelace, choose Català as the language, enable the weekly digest, then save. Done when 'Saved' is shown.",
    texts: "Ada Lovelace",
    secret: "",
    html: `<!doctype html><title>Profile settings</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:28px;color:#222}h1{font-size:22px}label{display:block;margin:10px 0 2px;color:#555;font-size:13px}
input,select,textarea{font:inherit;padding:6px 8px;border:1px solid #bbb;border-radius:6px;width:260px}button{font:inherit;padding:7px 14px;border-radius:6px;border:1px solid #333;background:#333;color:#fff;margin-top:14px;cursor:pointer}</style>
<h1>Profile settings</h1>
<form id="f"><label>Display name</label><input name="name" autocomplete="off"><label>Language</label><select name="lang"><option>English</option><option>Català</option><option>Español</option></select>
<label><input type="checkbox" name="digest" style="width:auto"> Weekly digest</label><label><input type="checkbox" name="beta" style="width:auto"> Beta features</label>
<label>Bio</label><textarea name="bio" rows="3"></textarea><br><button>Save changes</button> <button type="button">Cancel</button></form><p id="out"></p>
<script>document.getElementById('f').onsubmit=e=>{e.preventDefault();const d=new FormData(e.target);document.getElementById('out').textContent='Saved: '+d.get('name')+' · '+d.get('lang')+(d.get('digest')?' · digest on':'')}</script>`,
  },
  custom: { title: "Paste your own HTML (scripts disabled)", goal: "", texts: "", secret: "", html: "" },
};
