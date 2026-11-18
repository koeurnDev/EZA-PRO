const BRAND_LOGO_DATA_URL = "data:image/webp;base64,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";

export function renderAdminHtml() {
  return `<!DOCTYPE html>
<html lang="km">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>EZA PRO — Cloud Admin</title>
<link rel="icon" type="image/webp" href="${BRAND_LOGO_DATA_URL}">
<style>
  :root {
    --bg: #060a14;
    --surface: #0d1526;
    --surface2: #121d33;
    --surface3: #182642;
    --border: rgba(148, 163, 184, 0.16);
    --border-strong: rgba(56, 189, 248, 0.35);
    --cyan: #38bdf8;
    --teal: #22d3ee;
    --green: #10b981;
    --amber: #f59e0b;
    --red: #ef4444;
    --text: #f8fafc;
    --muted: #94a3b8;
    --radius: 16px;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0;
    font-family: 'Kantumruy Pro', 'Khmer OS Siemreap', 'Segoe UI', system-ui, sans-serif;
    background: radial-gradient(circle at 80% -10%, rgba(14, 116, 144, 0.28), transparent 45%), var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding-bottom: 84px;
    line-height: 1.5;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 14px; }
  .sticky-head {
    position: sticky; top: 0; z-index: 40;
    background: rgba(6, 10, 20, 0.88);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    padding: 10px 14px;
  }
  .sticky-inner {
    max-width: 980px; margin: 0 auto;
    display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 16px; }
  .brand-badge {
    width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center; flex-shrink: 0;
    background: linear-gradient(135deg, #facc15, var(--teal)); color: #070b16; font-size: 18px;
    box-shadow: 0 4px 14px rgba(34, 211, 238, 0.25);
  }
  .head-actions { display: flex; align-items: center; gap: 8px; }
  .tabs-desktop {
    display: flex; gap: 6px; background: var(--surface); border: 1px solid var(--border);
    padding: 5px; border-radius: 13px; margin-bottom: 14px;
  }
  .tab-btn {
    flex: 1; padding: 10px 12px; border-radius: 9px; background: transparent; color: var(--muted);
    font-size: 13.5px; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 6px;
  }
  .tab-btn.active {
    background: linear-gradient(135deg, rgba(2, 132, 199, 0.35), rgba(34, 211, 238, 0.2));
    color: #fff; border: 1px solid var(--border-strong);
  }
  .mobile-nav {
    display: none; position: fixed; bottom: 0; left: 0; right: 0; z-index: 50;
    background: rgba(13, 21, 38, 0.96); backdrop-filter: blur(12px);
    border-top: 1px solid var(--border); padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
    gap: 6px;
  }
  .mobile-nav button {
    flex: 1; background: transparent; color: var(--muted); padding: 8px 4px; border-radius: 10px;
    font-size: 11.5px; display: flex; flex-direction: column; align-items: center; gap: 3px;
  }
  .mobile-nav button.active { color: var(--cyan); background: rgba(56, 189, 248, 0.12); }
  @media (max-width: 680px) {
    .tabs-desktop { display: none; }
    .mobile-nav { display: flex; }
  }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 16px; margin-bottom: 14px;
  }
  .stats-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px;
  }
  @media (max-width: 640px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
  .stat-pill {
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
    padding: 12px; text-align: left; cursor: pointer; transition: border-color .15s, transform .1s;
    display: flex; flex-direction: column; gap: 2px;
  }
  .stat-pill.active { border-color: var(--cyan); background: rgba(56, 189, 248, 0.1); }
  .stat-pill .lbl { font-size: 12px; color: var(--muted); font-weight: 600; }
  .stat-pill .num { font-size: 22px; font-weight: 800; color: #fff; }
  .search-wrap { position: relative; margin-bottom: 14px; }
  .search-wrap input {
    width: 100%; padding: 12px 42px 12px 14px; font-size: 14px;
    border-radius: 13px; background: var(--surface); border: 1px solid var(--border);
  }
  .search-clear {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: var(--surface3); color: var(--muted); width: 28px; height: 28px; min-height: 28px;
    border-radius: 50%; padding: 0; display: grid; place-items: center; font-size: 12px;
  }
  label.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #cbd5e1; font-weight: 600; }
  input, select {
    width: 100%; background: #070c17; color: var(--text); border: 1px solid #26334a;
    border-radius: 11px; padding: 11px 13px; font-size: 14px; outline: none; font-family: inherit;
    min-height: 44px;
  }
  input:focus, select:focus { border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15); }
  button {
    border: 0; border-radius: 11px; padding: 10px 14px; font-size: 13.5px; font-weight: 700;
    cursor: pointer; font-family: inherit; transition: transform .1s, opacity .15s;
    min-height: 40px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  button:active { transform: scale(0.97); }
  .btn-primary { background: linear-gradient(135deg, #0284c7, #06b6d4); color: #fff; }
  .btn-ghost { background: var(--surface3); color: #e2e8f0; border: 1px solid var(--border); }
  .btn-green { background: rgba(16, 185, 129, 0.16); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); }
  .btn-amber { background: rgba(245, 158, 11, 0.16); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.35); }
  .btn-red { background: rgba(239, 68, 68, 0.16); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); }
  .btn-icon { width: 40px; padding: 0; }
  .lic-list { display: flex; flex-direction: column; gap: 12px; }
  .lic-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 15px; display: flex; flex-direction: column; gap: 12px;
  }
  .lic-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .cust-name { font-size: 16px; font-weight: 800; color: #fff; }
  .cust-contact { font-size: 12.5px; color: #7dd3fc; margin-top: 2px; }
  .pill {
    padding: 4px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 700; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .p-active { background: rgba(16, 185, 129, 0.18); color: #34d399; }
  .p-warn { background: rgba(245, 158, 11, 0.18); color: #fbbf24; }
  .p-bad { background: rgba(239, 68, 68, 0.18); color: #f87171; }
  .key-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
    background: #070c17; border: 1px solid var(--border); border-radius: 11px; padding: 8px 11px;
  }
  .key-code {
    font-family: ui-monospace, monospace; font-size: 14px; font-weight: 800; color: var(--teal);
    letter-spacing: 0.4px; word-break: break-all; cursor: pointer;
  }
  .info-strip { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12.5px; color: var(--muted); }
  .info-chip { background: var(--surface2); padding: 4px 9px; border-radius: 8px; }
  .card-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  @media (max-width: 480px) {
    .card-actions { grid-template-columns: 1fr 1fr; }
    .card-actions .span2 { grid-column: span 2; }
  }
  .preset-row { display: flex; flex-wrap: wrap; gap: 7px; }
  .preset-chip {
    background: var(--surface2); color: #cbd5e1; border: 1px solid var(--border);
    padding: 8px 12px; border-radius: 999px; font-size: 12.5px; min-height: 36px;
  }
  .preset-chip.active {
    background: rgba(56, 189, 248, 0.22); color: #fff; border-color: var(--cyan);
  }
  .modal-bg {
    position: fixed; inset: 0; z-index: 80; background: rgba(3, 6, 14, 0.78); backdrop-filter: blur(6px);
    display: none; align-items: center; justify-content: center; padding: 14px;
  }
  .modal-bg.open { display: flex; }
  .modal-sheet {
    width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto;
    background: var(--surface); border: 1px solid var(--border-strong); border-radius: 20px;
    padding: 18px; display: flex; flex-direction: column; gap: 14px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65);
  }
  .modal-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .modal-title { font-size: 16.5px; font-weight: 800; color: #fff; }
  .switch-row {
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
    background: var(--surface2); border: 1px solid var(--border); border-radius: 13px; padding: 13px 14px;
    cursor: pointer;
  }
  .switch {
    position: relative; width: 48px; height: 28px; flex-shrink: 0;
  }
  .switch input { opacity: 0; width: 0; height: 0; min-height: 0; }
  .slider {
    position: absolute; inset: 0; background: #334155; border-radius: 999px; transition: .2s;
  }
  .slider:before {
    content: ""; position: absolute; height: 22px; width: 22px; left: 3px; bottom: 3px;
    background: #fff; border-radius: 50%; transition: .2s;
  }
  .switch input:checked + .slider { background: var(--cyan); }
  .switch input:checked + .slider:before { transform: translateX(20px); }
  .login-box { max-width: 400px; margin: 56px auto; }
  .pw-wrap { position: relative; }
  .pw-wrap input { padding-right: 46px; }
  .pw-eye {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    background: transparent; color: var(--muted); width: 34px; height: 34px; min-height: 34px; padding: 0;
  }
  .toast {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 120;
    background: #0f172a; border: 1px solid var(--cyan); color: #fff;
    padding: 10px 16px; border-radius: 12px; font-size: 13.5px; font-weight: 700;
    display: none; box-shadow: 0 12px 32px rgba(0,0,0,0.55); max-width: 92vw; text-align: center;
  }
  .log-card {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 12px;
    padding: 11px 13px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<div id="loginScreen" class="wrap">
  <div class="card login-box">
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
      <img class="brand-badge" src="${BRAND_LOGO_DATA_URL}" alt="EZA PRO" style="background:transparent; padding:0; object-fit:contain; box-shadow:none;">
      <div>
        <div style="font-size:18px; font-weight:800;">EZA PRO Admin</div>
        <div style="font-size:12.5px; color:var(--muted);">ចូលគ្រប់គ្រងភ្ញៀវ & License ២៤ម៉ោង</div>
      </div>
    </div>
    <form onsubmit="handleLogin(event)" style="display:flex; flex-direction:column; gap:12px;">
      <label class="field">ពាក្យសម្ងាត់ Admin (Password)
        <div class="pw-wrap">
          <input type="password" id="adminSecretInput" placeholder="បញ្ចូល Admin Password..." required autocomplete="current-password">
          <button type="button" class="pw-eye" onclick="togglePw()" title="បង្ហាញ/លាក់ពាក្យសម្ងាត់">👁️</button>
        </div>
      </label>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#cbd5e1; cursor:pointer;">
        <input type="checkbox" id="rememberLoginCheck" style="width:18px; height:18px; min-height:18px;">
        <span>ចងចាំការចូលលើទូរស័ព្ទ/ម៉ាស៊ីនផ្ទាល់ខ្លួននេះ</span>
      </label>
      <div id="loginErr" style="font-size:13px; color:#f87171;"></div>
      <button type="submit" class="btn-primary" style="width:100%; min-height:46px; font-size:15px;">🔓 ចូលគ្រប់គ្រង</button>
    </form>
  </div>
</div>

<div id="appShell" hidden>
  <header class="sticky-head">
    <div class="sticky-inner">
      <div class="brand">
        <img class="brand-badge" src="${BRAND_LOGO_DATA_URL}" alt="EZA PRO" style="background:transparent; padding:0; object-fit:contain; box-shadow:none;">
        <div>
          <div>EZA PRO Admin</div>
          <div style="font-size:11.5px; color:var(--muted); font-weight:500;">Cloudflare Worker + D1</div>
        </div>
      </div>
      <div class="head-actions">
        <button class="btn-primary" onclick="openCreateModal()">＋ បង្កើត Key</button>
        <button class="btn-ghost btn-icon" onclick="loadOverview()" title="Refresh">🔄</button>
        <button class="btn-red btn-icon" onclick="logout()" title="ចាកចេញ">🚪</button>
      </div>
    </div>
  </header>

  <main class="wrap">
    <nav class="tabs-desktop">
      <button class="tab-btn active" data-tab="users" onclick="switchTab(this)">👥 ភ្ញៀវ & Keys (<span id="tabCountUsers">0</span>)</button>
      <button class="tab-btn" data-tab="system" onclick="switchTab(this)">📢 កំណត់ប្រព័ន្ធ</button>
      <button class="tab-btn" data-tab="logs" onclick="switchTab(this)">📜 ប្រវត្តិប្រើប្រាស់</button>
    </nav>

    <section id="tab-users">
      <div class="stats-grid">
        <button class="stat-pill active" data-filter="all" onclick="setFilter(this)">
          <span class="lbl">Key សរុប</span>
          <span class="num" id="stTotal">0</span>
        </button>
        <button class="stat-pill" data-filter="active" onclick="setFilter(this)">
          <span class="lbl">🟢 កំពុងសកម្ម</span>
          <span class="num" id="stActive" style="color:var(--green)">0</span>
        </button>
        <button class="stat-pill" data-filter="blocked" onclick="setFilter(this)">
          <span class="lbl">⛔ ផ្អាក / Ban</span>
          <span class="num" id="stBlocked" style="color:var(--red)">0</span>
        </button>
        <button class="stat-pill" data-filter="expired" onclick="setFilter(this)">
          <span class="lbl">⏰ ផុតកំណត់</span>
          <span class="num" id="stExpired" style="color:var(--amber)">0</span>
        </button>
      </div>

      <div class="search-wrap">
        <input type="search" id="searchInput" placeholder="🔍 ស្វែងរក ឈ្មោះភ្ញៀវ, Telegram, License Key, ឬ Machine ID..." oninput="renderLicenses()">
        <button type="button" class="search-clear" onclick="clearSearch()" title="សម្អាត">✕</button>
      </div>

      <div id="licList" class="lic-list"></div>
    </section>

    <section id="tab-system" hidden>
      <div class="card" style="display:flex; flex-direction:column; gap:14px;">
        <div style="font-size:16px; font-weight:800;">🎛️ គ្រប់គ្រងកម្មវិធីភ្ញៀវពីចម្ងាយ</div>

        <label class="switch-row">
          <div>
            <div style="font-size:14px; font-weight:700; color:#fca5a5;">🚧 បិទកម្មវិធីទាំងអស់បណ្ដោះអាសន្ន (Maintenance)</div>
            <div style="font-size:12px; color:var(--muted);">ភ្ញៀវបើក .exe មិនចេញទេ និងឃើញសារជូនដំណឹងខាងក្រោម</div>
          </div>
          <span class="switch"><input type="checkbox" id="setMaintLock"><span class="slider"></span></span>
        </label>

        <label class="field">📢 សារប្រកាសលើក្បាលកម្មវិធី (Banner)
          <div style="display:flex; gap:8px;">
            <input type="text" id="setBanner" placeholder="ឧ. កំណែថ្មី v1.0.1 ដំណើរការលឿនជាងមុន!">
            <button type="button" class="btn-ghost" onclick="document.getElementById('setBanner').value=''">🧹 លុប</button>
          </div>
        </label>

        <label class="field">⬇️ Link ទាញយក .exe ជំនាន់ថ្មី (ស្រេចចិត្ត)
          <input type="url" id="setDownloadUrl" placeholder="https://drive.google.com/...">
        </label>

        <label class="field">🏷️ កំណែអប្បបរមា (Min App Version)
          <input type="text" id="setMinVer" value="1.0.0">
        </label>

        <label class="field">🛠️ Link ជំនួយធានាថែទាំ (Telegram / លេខទំនាក់ទំនងអតិថិជន)
          <input type="text" id="setSupportContact" placeholder="https://t.me/ezapro_support">
        </label>

        <button class="btn-primary" style="min-height:46px; font-size:14.5px;" onclick="saveSettings()">💾 រក្សាទុកការកំណត់ប្រព័ន្ធ</button>
      </div>
    </section>

    <section id="tab-logs" hidden>
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <strong style="font-size:15.5px;">📜 សកម្មភាពចុងក្រោយ (40 លើក)</strong>
          <button class="btn-ghost" onclick="loadOverview()">🔄 Refresh</button>
        </div>
        <div id="auditLogs" style="display:flex; flex-direction:column; gap:8px;"></div>
      </div>
    </section>
  </main>

  <nav class="mobile-nav">
    <button class="active" data-tab="users" onclick="switchTab(this)"><span>👥</span><span>ភ្ញៀវ & Keys</span></button>
    <button data-tab="system" onclick="switchTab(this)"><span>📢</span><span>ប្រព័ន្ធ</span></button>
    <button data-tab="logs" onclick="switchTab(this)"><span>📜</span><span>ប្រវត្តិ</span></button>
  </nav>
</div>

<div id="createModal" class="modal-bg" onclick="if(event.target===this) closeCreateModal()">
  <div class="modal-sheet">
    <div class="modal-head">
      <div class="modal-title">🎫 បង្កើត License Key ថ្មី</div>
      <button class="btn-ghost btn-icon" onclick="closeCreateModal()">✕</button>
    </div>

    <form id="createForm" onsubmit="createLicense(event)" style="display:flex; flex-direction:column; gap:12px;">
      <label class="field">ឈ្មោះភ្ញៀវ / ចំណាំ (ងាយស្រួលរកពេលក្រោយ)
        <input type="text" id="newName" placeholder="ឧ. សុខា (VIP)">
      </label>

      <label class="field">Telegram / លេខទូរស័ព្ទ (ស្រេចចិត្ត)
        <input type="text" id="newContact" placeholder="ឧ. @sokha ឬ 012 345 678">
      </label>

      <div>
        <div style="font-size:13px; color:#cbd5e1; font-weight:600; margin-bottom:7px;">ប្រើជាមួយកម្មវិធីណា?</div>
        <div class="preset-row" id="appScopeChips">
          <button type="button" class="preset-chip active" data-scope="all" onclick="pickAppScope(this)">🌟 ទាំងពីរ App</button>
          <button type="button" class="preset-chip" data-scope="studio" onclick="pickAppScope(this)">🎙️ Studio (បកប្រែ)</button>
          <button type="button" class="preset-chip" data-scope="downloader" onclick="pickAppScope(this)">🎬 Downloader (ដោនរឿង)</button>
        </div>
        <input type="hidden" id="newAppScopeVal" value="all">
      </div>

      <div>
        <div style="font-size:13px; color:#cbd5e1; font-weight:600; margin-bottom:7px;">កញ្ចប់តម្លៃ និងការធានាថែទាំ (គិតថ្ងៃចាប់ពីភ្ញៀវបើកដំបូង)</div>
        <div class="preset-row" id="durationChips">
          <button type="button" class="preset-chip active" data-plan="monthly_10" data-price="10" data-days="30" onclick="pickDuration(this)">💎 $10 / ខែ (30 ថ្ងៃ)</button>
          <button type="button" class="preset-chip" data-plan="yearly_50" data-price="50" data-days="365" onclick="pickDuration(this)">👑 $50 / ឆ្នាំ (365 ថ្ងៃ · ចំណេញ $70)</button>
          <button type="button" class="preset-chip" data-plan="quarterly_25" data-price="25" data-days="90" onclick="pickDuration(this)">⚡ $25 / 3 ខែ</button>
          <button type="button" class="preset-chip" data-plan="trial_7" data-price="0" data-days="7" onclick="pickDuration(this)">🎁 7 ថ្ងៃ (សាកល្បង)</button>
          <button type="button" class="preset-chip" data-plan="lifetime" data-price="0" data-days="0" onclick="pickDuration(this)">♾️ Lifetime</button>
        </div>
        <input type="hidden" id="newDurationVal" value="30">
        <input type="hidden" id="newPlanIdVal" value="monthly_10">
        <input type="hidden" id="newPriceUsdVal" value="10">
      </div>

      <details style="background:var(--surface2); border:1px solid var(--border); border-radius:11px; padding:10px 12px;">
        <summary style="cursor:pointer; font-size:13px; color:#94a3b8; font-weight:600;">⚙️ កំណត់បន្ថែម (ចំនួនម៉ាស៊ីន / Machine ID)</summary>
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
          <label class="field">ចំនួនម៉ាស៊ីនអនុញ្ញាត
            <input type="number" id="newMaxMachines" value="1" min="1" max="20">
          </label>
          <label class="field">ចង Machine ID ជាមុន (ទុកទំនេរ = ចងលើម៉ាស៊ីនដំបូង)
            <input type="text" id="newPrebind" placeholder="ឧ. EZA-XXXX-XXXX-XXXX">
          </label>
        </div>
      </details>

      <button type="submit" class="btn-primary" style="min-height:48px; font-size:15px;">⚡ បង្កើត License Key ភ្លាម</button>
    </form>

    <div id="createdResultBox" hidden style="background:#070c17; border:1px solid rgba(16,185,129,0.45); border-radius:14px; padding:14px; display:flex; flex-direction:column; gap:10px;">
      <div style="color:#34d399; font-weight:800; font-size:14px;">✅ បង្កើត Key រួចរាល់!</div>
      <code id="createdKeyCode" class="key-code" style="font-size:16px; text-align:center; padding:10px; background:var(--surface); border-radius:9px;"></code>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        <button type="button" class="btn-green" onclick="copyCreatedKeyOnly()">📋 ចម្លង Key</button>
        <button type="button" class="btn-primary" onclick="copyCreatedGreeting()">💬 ចម្លងសារផ្ញើភ្ញៀវ</button>
      </div>
      <button type="button" class="btn-ghost" onclick="resetCreateForm()">＋ បង្កើត Key មួយទៀត</button>
    </div>
  </div>
</div>

<div id="manageModal" class="modal-bg" onclick="if(event.target===this) closeManageModal()">
  <div class="modal-sheet">
    <div class="modal-head">
      <div>
        <div class="modal-title" id="mgTitle">⚙️ គ្រប់គ្រងអតិថិជន</div>
        <code id="mgKeyText" style="font-size:12px; color:var(--teal);"></code>
      </div>
      <button class="btn-ghost btn-icon" onclick="closeManageModal()">✕</button>
    </div>

    <div style="display:flex; flex-direction:column; gap:8px;">
      <div style="font-size:12.5px; color:var(--muted); font-weight:700;">⏱️ បន្តសុពលភាពគណនី (គិតបន្តពីថ្ងៃផុតកំណត់)</div>
      <div style="display:flex; flex-wrap:wrap; gap:6px;">
        <button class="btn-ghost" data-ext="7" data-plan="trial_7" data-price="0" onclick="mgExtend(this)">+7 ថ្ងៃ</button>
        <button class="btn-primary" data-ext="30" data-plan="monthly_10" data-price="10" onclick="mgExtend(this)">💎 +1 ខែ ($10)</button>
        <button class="btn-ghost" data-ext="90" data-plan="quarterly_25" data-price="25" onclick="mgExtend(this)">+3 ខែ ($25)</button>
        <button class="btn-green" data-ext="365" data-plan="yearly_50" data-price="50" onclick="mgExtend(this)">👑 +1 ឆ្នាំ ($50)</button>
        <button class="btn-ghost" data-ext="0" data-lifetime="1" onclick="mgExtend(this)">♾️ ដូរជា Lifetime</button>
      </div>
    </div>

    <div style="display:flex; flex-direction:column; gap:8px;">
      <div style="font-size:12.5px; color:var(--muted); font-weight:700;">🚦 ស្ថានភាពគណនី</div>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
        <button class="btn-green" data-st="active" onclick="mgStatus(this)">✅ សកម្ម</button>
        <button class="btn-amber" data-st="paused" onclick="mgStatus(this)">⏸ ផ្អាក</button>
        <button class="btn-red" data-st="revoked" onclick="mgStatus(this)">⛔ Ban</button>
      </div>
    </div>

    <div style="background:var(--surface2); border:1px solid var(--border); border-radius:12px; padding:11px; display:flex; flex-direction:column; gap:8px;">
      <div style="font-size:12.5px; color:#cbd5e1; font-weight:700;">🖥️ ម៉ាស៊ីនដែលបានភ្ជាប់ (<span id="mgBoundCount">0/1</span>)</div>
      <div id="mgMachinesList" style="font-family:ui-monospace, monospace; font-size:12px; color:#7dd3fc; word-break:break-all;"></div>
      <button class="btn-amber" onclick="mgResetMachines()">🔄 Reset ម៉ាស៊ីន (ឲ្យភ្ញៀវដាក់ម៉ាស៊ីនថ្មី)</button>
    </div>

    <form onsubmit="mgSaveInfo(event)" style="display:flex; flex-direction:column; gap:9px; border-top:1px solid var(--border); padding-top:12px;">
      <div style="font-size:12.5px; color:var(--muted); font-weight:700;">✏️ កែព័ត៌មានភ្ញៀវ</div>
      <input type="text" id="mgEditName" placeholder="ឈ្មោះភ្ញៀវ">
      <div style="display:grid; grid-template-columns:1.4fr 0.6fr; gap:8px;">
        <input type="text" id="mgEditContact" placeholder="Telegram / ទូរស័ព្ទ">
        <input type="number" id="mgEditMax" min="1" max="20" placeholder="ម៉ាស៊ីន">
      </div>
      <select id="mgEditAppScope">
        <option value="all">🌟 ទាំងពីរ App (Studio + Downloader)</option>
        <option value="studio">🎙️ EZA PRO Studio (បកប្រែ/បញ្ចូលសំឡេង)</option>
        <option value="downloader">🎬 EZA PRO Downloader (ទាញយករឿង)</option>
      </select>
      <button type="submit" class="btn-primary">💾 រក្សាទុកព័ត៌មានភ្ញៀវ</button>
    </form>

    <button class="btn-red" onclick="mgDelete()">🗑 លុប License Key នេះចោល</button>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
const SECRET_STORAGE_KEY = 'eza_cloud_admin_secret_v2';
let overviewData = { licenses: [], settings: {}, logs: [], serverNow: Date.now() };
let activeFilter = 'all';
let activeManageKey = '';
let lastCreatedKey = '';
let lastCreatedMsg = '';

function toast(msg) {
  const el = document.getElementById('toast');
  el.innerText = msg;
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.display = 'none'; }, 2800);
}

async function copyText(txt, customToast) {
  try { await navigator.clipboard.writeText(txt); } catch (_) {}
  toast(customToast || ('📋 បានចម្លង៖ ' + txt));
}

function getSecret() {
  return sessionStorage.getItem(SECRET_STORAGE_KEY) || localStorage.getItem(SECRET_STORAGE_KEY) || '';
}

function setSecret(secret, remember) {
  sessionStorage.setItem(SECRET_STORAGE_KEY, secret);
  if (remember) localStorage.setItem(SECRET_STORAGE_KEY, secret);
  else localStorage.removeItem(SECRET_STORAGE_KEY);
}

function clearSecret() {
  sessionStorage.removeItem(SECRET_STORAGE_KEY);
  localStorage.removeItem(SECRET_STORAGE_KEY);
}

function togglePw() {
  const inp = document.getElementById('adminSecretInput');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || 'GET',
    headers: { 'content-type': 'application/json', 'x-admin-secret': getSecret() },
    body: body ? JSON.stringify(body) : null
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function handleLogin(e) {
  e.preventDefault();
  const secret = document.getElementById('adminSecretInput').value.trim();
  const remember = Boolean(document.getElementById('rememberLoginCheck').checked);
  const errEl = document.getElementById('loginErr');
  errEl.innerText = '';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret })
    });
    const d = await res.json();
    if (!res.ok || !d.success) throw new Error(d.error || 'Login failed');
    setSecret(secret, remember);
    document.getElementById('loginScreen').hidden = true;
    document.getElementById('appShell').hidden = false;
    await loadOverview();
  } catch (err) {
    errEl.innerText = '❌ ' + err.message;
  }
}

function logout() {
  clearSecret();
  location.reload();
}

function switchTab(btn) {
  const tab = btn.getAttribute('data-tab');
  ['users', 'system', 'logs'].forEach(t => {
    document.getElementById('tab-' + t).hidden = (t !== tab);
  });
  document.querySelectorAll('[data-tab]').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-tab') === tab);
  });
}

function setFilter(btn) {
  activeFilter = btn.getAttribute('data-filter') || 'all';
  document.querySelectorAll('.stat-pill').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-filter') === activeFilter);
  });
  renderLicenses();
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  renderLicenses();
}

function openCreateModal() {
  resetCreateForm();
  document.getElementById('createModal').classList.add('open');
}
function closeCreateModal() {
  document.getElementById('createModal').classList.remove('open');
}

function resetCreateForm() {
  document.getElementById('createForm').hidden = false;
  document.getElementById('createdResultBox').hidden = true;
  document.getElementById('newName').value = '';
  document.getElementById('newContact').value = '';
  document.getElementById('newPrebind').value = '';
  document.getElementById('newAppScopeVal').value = 'all';
  document.getElementById('newDurationVal').value = '30';
  document.getElementById('newPlanIdVal').value = 'monthly_10';
  document.getElementById('newPriceUsdVal').value = '10';
  document.querySelectorAll('#appScopeChips .preset-chip').forEach(c => {
    c.classList.toggle('active', c.getAttribute('data-scope') === 'all');
  });
  document.querySelectorAll('#durationChips .preset-chip').forEach(c => {
    c.classList.toggle('active', c.getAttribute('data-plan') === 'monthly_10');
  });
}

function pickAppScope(btn) {
  const scope = btn.getAttribute('data-scope') || 'all';
  document.getElementById('newAppScopeVal').value = scope;
  document.querySelectorAll('#appScopeChips .preset-chip').forEach(c => {
    c.classList.toggle('active', c === btn);
  });
}

function appScopeBadge(scope) {
  if (scope === 'studio') return '<span class="info-chip" style="color:#c4b5fd; border-color:rgba(167,139,250,0.4);">🎙️ Studio</span>';
  if (scope === 'downloader') return '<span class="info-chip" style="color:#6ee7b7; border-color:rgba(16,185,129,0.4);">🎬 Downloader</span>';
  return '<span class="info-chip" style="color:#7dd3fc; border-color:rgba(56,189,248,0.4);">🌟 ទាំងពីរ App</span>';
}

function planTierBadge(planId, priceUsd) {
  if (planId === 'yearly_50') return '<span class="info-chip" style="color:#fde68a; border-color:rgba(250,204,21,0.45);">👑 $50/ឆ្នាំ · VIP</span>';
  if (planId === 'monthly_10') return '<span class="info-chip" style="color:#6ee7b7; border-color:rgba(16,185,129,0.45);">💎 $10/ខែ</span>';
  if (planId === 'quarterly_25') return '<span class="info-chip" style="color:#93c5fd; border-color:rgba(96,165,250,0.4);">⚡ $25/3ខែ</span>';
  if (planId === 'trial_7') return '<span class="info-chip" style="color:#cbd5e1;">🎁 សាកល្បង 7d</span>';
  if (planId === 'lifetime') return '<span class="info-chip" style="color:#f9a8d4; border-color:rgba(244,114,182,0.45);">♾️ Lifetime</span>';
  return priceUsd > 0 ? '<span class="info-chip">$' + esc(priceUsd) + '</span>' : '';
}

function pickDuration(btn) {
  const days = btn.getAttribute('data-days');
  const planId = btn.getAttribute('data-plan') || 'monthly_10';
  const priceUsd = btn.getAttribute('data-price') || '0';
  document.getElementById('newDurationVal').value = days;
  document.getElementById('newPlanIdVal').value = planId;
  document.getElementById('newPriceUsdVal').value = priceUsd;
  document.querySelectorAll('#durationChips .preset-chip').forEach(c => {
    c.classList.toggle('active', c === btn);
  });
}

function copyCreatedKeyOnly() {
  if (lastCreatedKey) copyText(lastCreatedKey);
}
function copyCreatedGreeting() {
  if (lastCreatedMsg) copyText(lastCreatedMsg, '📩 បានចម្លងសារផ្ញើភ្ញៀវរួចរាល់!');
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function relTime(ms) {
  if (!ms) return 'មិនទាន់ចូលប្រើ';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return 'អម្បាញ់មិញ';
  if (sec < 3600) return Math.floor(sec / 60) + ' នាទីមុន';
  if (sec < 86400) return Math.floor(sec / 3600) + ' ម៉ោងមុន';
  return Math.floor(sec / 86400) + ' ថ្ងៃមុន';
}

function expiryBadge(item, now) {
  if (item.status === 'revoked') return '<span class="pill p-bad">⛔ បានបិទ (Ban)</span>';
  if (item.status === 'paused') return '<span class="pill p-warn">⏸ កំពុងផ្អាក</span>';
  if (!item.expiresAt) return '<span class="pill p-active">♾️ Lifetime</span>';
  const daysLeft = Math.ceil((item.expiresAt - now) / 86400000);
  if (daysLeft <= 0) return '<span class="pill p-bad">⏰ ផុតកំណត់ហើយ</span>';
  if (daysLeft <= 5) return '<span class="pill p-warn">⏳ នៅសល់ ' + daysLeft + ' ថ្ងៃ</span>';
  return '<span class="pill p-active">🟢 នៅសល់ ' + daysLeft + ' ថ្ងៃ</span>';
}

async function loadOverview() {
  try {
    overviewData = await api('/api/admin/overview', 'GET');
    const st = overviewData.stats || {};
    document.getElementById('stTotal').innerText = st.total || 0;
    document.getElementById('stActive').innerText = st.active || 0;
    document.getElementById('stBlocked').innerText = st.blocked || 0;
    document.getElementById('stExpired').innerText = st.expired || 0;
    document.getElementById('tabCountUsers').innerText = st.total || 0;

    const s = overviewData.settings || {};
    document.getElementById('setBanner').value = s.maintenance_banner || '';
    document.getElementById('setDownloadUrl').value = s.download_url || '';
    document.getElementById('setMinVer').value = s.min_app_version || '1.0.0';
    document.getElementById('setSupportContact').value = s.support_contact || 'https://t.me/ezapro_support';
    document.getElementById('setMaintLock').checked = s.maintenance_locked === '1';

    renderLicenses();
    renderLogs();
  } catch (err) {
    if (String(err.message).toLowerCase().includes('unauthorized')) {
      clearSecret();
      document.getElementById('loginScreen').hidden = false;
      document.getElementById('appShell').hidden = true;
    } else {
      toast('❌ ' + err.message);
    }
  }
}

function renderLicenses() {
  const q = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  const now = overviewData.serverNow || Date.now();
  const rows = (overviewData.licenses || []).filter(item => {
    if (activeFilter === 'active' && item.effectiveStatus !== 'active') return false;
    if (activeFilter === 'blocked' && item.status !== 'paused' && item.status !== 'revoked') return false;
    if (activeFilter === 'expired' && item.effectiveStatus !== 'expired') return false;
    if (!q) return true;
    return (
      item.licenseKey.toLowerCase().includes(q) ||
      item.customerName.toLowerCase().includes(q) ||
      item.contact.toLowerCase().includes(q) ||
      (item.appScope || 'all').toLowerCase().includes(q) ||
      (item.boundMachines || []).join(',').toLowerCase().includes(q)
    );
  });

  const listEl = document.getElementById('licList');
  if (!rows.length) {
    listEl.innerHTML = '<div class="card" style="text-align:center; color:var(--muted); padding:28px;">មិនមានអតិថិជនក្នុងបញ្ជីនេះទេ — ចុច <strong>＋ បង្កើត Key</strong> ដើម្បីចាប់ផ្ដើម។</div>';
    return;
  }

  listEl.innerHTML = rows.map(item => {
    const blocked = item.status !== 'active';
    const expStr = item.expiresAt ? new Date(item.expiresAt).toLocaleDateString('en-GB') : 'គ្មានថ្ងៃផុត';
    return '<div class="lic-card" data-key="' + esc(item.licenseKey) + '">' +
      '<div class="lic-top">' +
        '<div>' +
          '<div class="cust-name">' + esc(item.customerName || 'អតិថិជនទូទៅ') + '</div>' +
          (item.contact ? '<div class="cust-contact">' + esc(item.contact) + '</div>' : '') +
        '</div>' +
        expiryBadge(item, now) +
      '</div>' +
      '<div class="key-row">' +
        '<code class="key-code" onclick="copyCardKey(this)" title="ចុចដើម្បីចម្លង Key">' + esc(item.licenseKey) + '</code>' +
        '<button type="button" class="btn-ghost" style="min-height:32px; padding:4px 10px; font-size:12px;" onclick="copyCardKey(this)">📋 Copy</button>' +
      '</div>' +
      '<div class="info-strip">' +
        planTierBadge(item.planId, item.priceUsd) +
        appScopeBadge(item.appScope || 'all') +
        '<span class="info-chip">🖥️ ម៉ាស៊ីន ' + item.boundMachines.length + '/' + item.maxMachines + '</span>' +
        '<span class="info-chip">📅 ' + expStr + '</span>' +
        '<span class="info-chip">🕒 ' + relTime(item.lastSeenAt) + '</span>' +
      '</div>' +
      '<div class="card-actions">' +
        '<button type="button" class="btn-ghost" onclick="copyCardMsg(this)">💬 សារផ្ញើភ្ញៀវ</button>' +
        (blocked
          ? '<button type="button" class="btn-green" onclick="quickToggleBan(this)">✅ បើកវិញ</button>'
          : '<button type="button" class="btn-red" onclick="quickToggleBan(this)">⛔ បិទ (Ban)</button>'
        ) +
        '<button type="button" class="btn-primary span2" onclick="openManageFromBtn(this)">⚙️ គ្រប់គ្រង / បន្តថ្ងៃ</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function findCardKey(el) {
  const card = el && el.closest ? el.closest('[data-key]') : null;
  return card ? card.getAttribute('data-key') : '';
}

function appLabelForGreeting(scope) {
  if (scope === 'studio') return 'EZA PRO Studio';
  if (scope === 'downloader') return 'EZA PRO Downloader';
  return 'EZA PRO (Studio & Downloader)';
}

function buildGreeting(key, expiresAt, appScope, planId) {
  const dur = expiresAt ? ('សុពលភាពដល់ថ្ងៃ ' + new Date(expiresAt).toLocaleDateString('en-GB')) : 'Lifetime';
  const planLbl = planId === 'yearly_50' ? 'កញ្ចប់ $50/ឆ្នាំ (VIP)' : (planId === 'monthly_10' ? 'កញ្ចប់ $10/ខែ' : dur);
  const appLbl = appLabelForGreeting(appScope || 'all');
  const support = (overviewData.settings && overviewData.settings.support_contact) || 'https://t.me/ezapro_support';
  return 'សូមស្វាគមន៍មកកាន់ ' + appLbl + '!\\n📦 ' + planLbl + ' (' + dur + ')\\n🔑 License Key៖ ' + key + '\\n🛠️ ធានាថែទាំ និងជំនួយបច្ចេកទេស៖ ' + support + '\\nសូមបើកកម្មវិធីលើកុំព្យូទ័រ រួចបញ្ចូល Key នេះដើម្បីចាប់ផ្ដើមប្រើប្រាស់។';
}

function copyCardKey(btn) {
  const key = findCardKey(btn);
  if (key) copyText(key);
}

function copyCardMsg(btn) {
  const key = findCardKey(btn);
  const item = (overviewData.licenses || []).find(l => l.licenseKey === key);
  if (item) copyText(buildGreeting(item.licenseKey, item.expiresAt, item.appScope, item.planId), '💬 បានចម្លងសារផ្ញើភ្ញៀវរួចរាល់!');
}

async function quickToggleBan(btn) {
  const key = findCardKey(btn);
  const item = (overviewData.licenses || []).find(l => l.licenseKey === key);
  if (!item) return;
  const nextStatus = item.status === 'active' ? 'revoked' : 'active';
  await doAction(key, 'set_status', { status: nextStatus });
}

function openManageFromBtn(btn) {
  const key = findCardKey(btn);
  const item = (overviewData.licenses || []).find(l => l.licenseKey === key);
  if (!item) return;
  activeManageKey = item.licenseKey;
  document.getElementById('mgTitle').innerText = '⚙️ ' + (item.customerName || 'គ្រប់គ្រងអតិថិជន');
  document.getElementById('mgKeyText').innerText = item.licenseKey;
  document.getElementById('mgBoundCount').innerText = item.boundMachines.length + '/' + item.maxMachines;
  const machinesEl = document.getElementById('mgMachinesList');
  if (!item.boundMachines.length) {
    machinesEl.innerHTML = '<span style="color:var(--muted);">មិនទាន់ភ្ជាប់ម៉ាស៊ីនណាមួយទេ</span>';
  } else {
    machinesEl.innerHTML = item.boundMachines.map(hwid =>
      '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:4px 0;">' +
        '<span>' + esc(hwid) + '</span>' +
        '<button type="button" class="btn-ghost" style="min-height:26px; padding:2px 8px; font-size:11px;" data-hwid="' + esc(hwid) + '" onclick="mgUnbindMachine(this)">✕ ដោះ</button>' +
      '</div>'
    ).join('');
  }
  document.getElementById('mgEditName').value = item.customerName || '';
  document.getElementById('mgEditContact').value = item.contact || '';
  document.getElementById('mgEditMax').value = item.maxMachines || 1;
  document.getElementById('mgEditAppScope').value = item.appScope || 'all';
  document.getElementById('manageModal').classList.add('open');
}

function closeManageModal() {
  document.getElementById('manageModal').classList.remove('open');
}

async function mgUnbindMachine(btn) {
  const machineId = btn.getAttribute('data-hwid');
  if (!machineId) return;
  await doAction(activeManageKey, 'unbind_machine', { machineId });
  closeManageModal();
}

async function mgExtend(btn) {
  const isLifetime = btn.getAttribute('data-lifetime') === '1';
  if (isLifetime) {
    if (!confirm('ដូរ License Key ' + activeManageKey + ' ទៅជា Lifetime មែនទេ?')) return;
    await doAction(activeManageKey, 'extend_days', { lifetime: true });
    closeManageModal();
    return;
  }
  const days = Number(btn.getAttribute('data-ext') || 0);
  const planId = btn.getAttribute('data-plan') || '';
  const priceUsd = Number(btn.getAttribute('data-price') || 0);
  await doAction(activeManageKey, 'extend_days', { days, planId, priceUsd });
  closeManageModal();
}

async function mgStatus(btn) {
  const status = btn.getAttribute('data-st');
  await doAction(activeManageKey, 'set_status', { status });
  closeManageModal();
}

async function mgResetMachines() {
  await doAction(activeManageKey, 'reset_machines', {});
  closeManageModal();
}

async function mgSaveInfo(e) {
  e.preventDefault();
  await doAction(activeManageKey, 'update_info', {
    customerName: document.getElementById('mgEditName').value.trim(),
    contact: document.getElementById('mgEditContact').value.trim(),
    maxMachines: Number(document.getElementById('mgEditMax').value || 1),
    appScope: document.getElementById('mgEditAppScope').value || 'all'
  });
  closeManageModal();
}

async function mgDelete() {
  if (!confirm('លុប License Key ' + activeManageKey + ' ជាអចិន្ត្រៃយ៍មែនទេ?')) return;
  await doAction(activeManageKey, 'delete', {});
  closeManageModal();
}

async function createLicense(e) {
  e.preventDefault();
  try {
    const durationDays = Number(document.getElementById('newDurationVal').value || 0);
    const planId = document.getElementById('newPlanIdVal').value || 'monthly_10';
    const priceUsd = Number(document.getElementById('newPriceUsdVal').value || 0);
    const appScope = document.getElementById('newAppScopeVal').value || 'all';
    const data = await api('/api/admin/licenses', 'POST', {
      customerName: document.getElementById('newName').value.trim(),
      contact: document.getElementById('newContact').value.trim(),
      appScope,
      planId,
      priceUsd,
      durationDays,
      maxMachines: Number(document.getElementById('newMaxMachines').value || 1),
      prebindMachineId: document.getElementById('newPrebind').value.trim()
    });
    const lic = data.license;
    lastCreatedKey = lic.licenseKey;
    lastCreatedMsg = buildGreeting(lic.licenseKey, lic.expiresAt, lic.appScope || appScope, lic.planId || planId);
    document.getElementById('createdKeyCode').innerText = lastCreatedKey;
    document.getElementById('createForm').hidden = true;
    document.getElementById('createdResultBox').hidden = false;
    await copyText(lastCreatedKey, '✅ បង្កើត និងចម្លង Key រួចរាល់!');
    await loadOverview();
  } catch (err) {
    toast('❌ ' + err.message);
  }
}

async function doAction(licenseKey, action, extra) {
  try {
    await api('/api/admin/licenses/action', 'POST', { licenseKey, action, ...extra });
    toast('✅ បានធ្វើបច្ចុប្បន្នភាពរួចរាល់!');
    await loadOverview();
  } catch (err) {
    toast('❌ ' + err.message);
  }
}

async function saveSettings() {
  try {
    await api('/api/admin/settings', 'POST', {
      maintenance_banner: document.getElementById('setBanner').value.trim(),
      download_url: document.getElementById('setDownloadUrl').value.trim(),
      min_app_version: document.getElementById('setMinVer').value.trim(),
      support_contact: document.getElementById('setSupportContact').value.trim(),
      maintenance_locked: document.getElementById('setMaintLock').checked,
      router_locked: false
    });
    toast('💾 រក្សាទុកការកំណត់ប្រព័ន្ធរួចរាល់!');
    await loadOverview();
  } catch (err) {
    toast('❌ ' + err.message);
  }
}

function renderLogs() {
  const el = document.getElementById('auditLogs');
  const logs = overviewData.logs || [];
  if (!logs.length) {
    el.innerHTML = '<div style="color:var(--muted); font-size:13px;">មិនទាន់មានប្រវត្តិសកម្មភាពទេ។</div>';
    return;
  }
  const eventLabels = {
    activate: '🟢 ភ្ជាប់ម៉ាស៊ីនថ្មី',
    reject_limit: '⚠️ លើសចំនួនម៉ាស៊ីន',
    reject_wrong_app: '🚫 ខុសប្រភេទ App',
    reject_revoked: '⛔ ព្យាយាមចូល Key ដែលបិទ',
    reject_paused: '⏸ Key កំពុងផ្អាក',
    reject_expired: '⏰ Key ផុតកំណត់',
    reject_not_found: '❓ Key មិនត្រឹមត្រូវ',
    admin_create: '🎫 បង្កើត Key ថ្មី',
    admin_extend: '⏱️ បន្តសុពលភាព',
    admin_reset_hwid: '🔄 Reset ម៉ាស៊ីន',
    admin_unbind_hwid: '🖥️ ដោះម៉ាស៊ីន ១ គ្រឿង',
    admin_revoked: '⛔ Admin Ban Key',
    admin_paused: '⏸ Admin ផ្អាក Key',
    admin_active: '✅ Admin បើក Key វិញ',
    admin_delete: '🗑 លុប Key'
  };
  el.innerHTML = logs.map(l =>
    '<div class="log-card">' +
      '<div>' +
        '<div style="font-size:13.5px; font-weight:700;">' + esc(eventLabels[l.event] || l.event) + '</div>' +
        '<div style="font-size:12px; color:var(--muted); margin-top:2px;">' +
          '<code>' + esc(l.license_key || '-') + '</code> · ' + esc(l.detail || '') + (l.machine_id ? ' · 🖥️ ' + esc(l.machine_id) : '') +
        '</div>' +
      '</div>' +
      '<div style="font-size:12px; color:var(--muted);">' + relTime(l.created_at) + '</div>' +
    '</div>'
  ).join('');
}

if (getSecret()) {
  document.getElementById('loginScreen').hidden = true;
  document.getElementById('appShell').hidden = false;
  loadOverview();
}
</script>
</body>
</html>`;
}

