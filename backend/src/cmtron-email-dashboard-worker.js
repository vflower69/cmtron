// cmtron-email-dashboard (updated)
// Bindings required: EMAIL_DB (D1), EMAIL_LOG_KV (KV), EMAIL_SEND_LOG_KV (KV)
// Optional env var: REQUIRE_ACCESS = "true" to enforce Cloudflare Access header check
/*
Featuring:
1. Searchable inbox
2. Spam scoring visibility
3. Department routing audit
4. Outbound send logs
5. Error logs
6. Clean HTML dashboard
7. Department analytics page
8. Spam heatmap
9. “View full email” detail page
10. Cellmetron-branded dashboard theme (teal/black, clean cards)
11. CSV export buttons
12. Charts.js graphs
13. Authentication (Cloudflare Access)
14. Dark/light theme toggle

Deployment notes & checklist:
1. Bindings — ensure EMAIL_DB, EMAIL_LOG_KV, EMAIL_SEND_LOG_KV are bound to this Worker.
2. Cloudflare Access check (optional; controlled by REQUIRE_ACCESS env var) — set Worker variable REQUIRE_ACCESS = "true" to enforce Cloudflare Access header check. Also configure an Access policy in Cloudflare Access for the Worker route.
3. Chart.js — Charts.js graphs on the dashboard (spam trend + department volume) using CDN https://cdn.jsdelivr.net/npm/chart.js, loaded from jsdelivr CDN; no extra server work required.
4. CSV exports — /export?type=inbound|outbound|errors returns text/csv with Content-Disposition for download.
5. Dark / light theme toggle — client stores preference in localStorage under cmtron-theme.
6. KV limits — outbound export reads up to 1000 KV keys; increase or paginate if you expect more.

The Eamil Dashboard URLs:
Once deployed, you get:
URL	              Purpose
/	                Home dashboard
/inbound	        Inbound email logs
/outbound	        Outbound send attempts (KV)
/errors	          Send errors (D1)
/search?q=term	  Search inbound emails
/analytics        Department analytics
/spam-heatmap     Spam vs non‑spam by day
/email?id=...     Full email detail view

Example: https://email-dashboard.cellmetron.com/spam-heatmap
*/

export default {
  async fetch(request, env) {
    // Optional Access enforcement
    if (env.REQUIRE_ACCESS === "true") {
      // Cloudflare Access injects headers when user is authenticated.
      // Common header: 'cf-access-jwt-assertion' or 'cf-access-authenticated-user-email'
      const hasAccess = request.headers.get("cf-access-jwt-assertion") ||
                        request.headers.get("cf-access-authenticated-user-email");
      if (!hasAccess) {
        return new Response("Access denied. Enable Cloudflare Access or set REQUIRE_ACCESS=false.", { status: 401 });
      }
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // --- ROUTES ---
    if (path === "/") return dashboardHome(env);
    if (path === "/inbound") return inboundTable(env);
    if (path === "/outbound") return outboundTable(env);
    if (path === "/errors") return errorTable(env);
    if (path === "/search") return searchEmails(env, url);

    // New pages
    if (path === "/analytics") return departmentAnalytics(env);
    if (path === "/spam-heatmap") return spamHeatmap(env);
    if (path === "/email") return emailDetail(env, url);
    if (path === "/charts") return chartsPage(env);
    if (path === "/export") return exportCsv(env, url);

    return new Response("Not found", { status: 404 });
  }
}

/* -------------------------
   Pages and helpers
   ------------------------- */

async function dashboardHome(env) {
  const inboundCount = await env.EMAIL_DB.prepare("SELECT COUNT(*) AS count FROM emails").first();
  const errorCount = await env.EMAIL_DB.prepare("SELECT COUNT(*) AS count FROM send_errors").first();
  const spamStats = await env.EMAIL_DB.prepare("SELECT SUM(is_spam) AS spam, SUM(1 - is_spam) AS ham FROM emails").first();

  // Prepare small datasets for charts (last 30 days spam trend + department totals)
  const spamRows = await env.EMAIL_DB.prepare(
    `SELECT substr(received_at,1,10) AS day, SUM(is_spam) AS spam, SUM(1 - is_spam) AS clean
     FROM emails
     GROUP BY day
     ORDER BY day DESC
     LIMIT 30`
  ).all();

  const deptRows = await env.EMAIL_DB.prepare(
    `SELECT
       CASE
         WHEN to_addr LIKE '%research@cellmetron.com%' THEN 'Research'
         WHEN to_addr LIKE '%press@cellmetron.com%'    THEN 'Press'
         WHEN to_addr LIKE '%retail@cellmetron.com%'   THEN 'Retail'
         WHEN to_addr LIKE '%investors@cellmetron.com%'THEN 'Investors'
         WHEN to_addr LIKE '%support@cellmetron.com%'  THEN 'Support'
         ELSE 'Other'
       END AS department,
       COUNT(*) AS total
     FROM emails
     GROUP BY department
     ORDER BY total DESC`
  ).all();

  // Inline JSON for client charts
  const spamData = JSON.stringify(spamRows.results.reverse()); // oldest -> newest
  const deptData = JSON.stringify(deptRows.results);

  return html(`
    <header>
      <h1>Cellmetron Email Dashboard</h1>
      <p>Operational view of inbound, outbound, spam, and routing.</p>
    </header>

    <section class="cards">
      <div class="card">
        <h2>Inbound Emails</h2>
        <p class="big">${inboundCount.count}</p>
        <a href="/inbound">View inbound logs →</a>
      </div>

      <div class="card">
        <h2>Send Errors</h2>
        <p class="big">${errorCount.count}</p>
        <a href="/errors">View errors →</a>
      </div>

      <div class="card">
        <h2>Spam vs Clean</h2>
        <p>Spam: ${spamStats.spam || 0}</p>
        <p>Clean: ${spamStats.ham || 0}</p>
        <a href="/spam-heatmap">View spam heatmap →</a>
      </div>
    </section>

    <section>
      <h2>Charts</h2>
      <div class="chart-row">
        <canvas id="spamTrend" width="600" height="240"></canvas>
        <canvas id="deptChart" width="400" height="240"></canvas>
      </div>
      <a class="small-link" href="/charts">Open charts page →</a>
    </section>

    <section>
      <h2>Navigation</h2>
      <nav class="nav-links">
        <a href="/analytics">Department analytics</a>
        <a href="/inbound">Inbound logs</a>
        <a href="/outbound">Outbound logs</a>
        <a href="/errors">Send errors</a>
        <a href="/export?type=inbound">Export CSV (inbound)</a>
      </nav>
    </section>

    <section>
      <h2>Search</h2>
      <form action="/search" class="search-form">
        <input name="q" placeholder="Search subject, sender, body…" />
        <button>Search</button>
      </form>
    </section>

    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      // Theme toggle
      (function(){
        const root = document.documentElement;
        const toggle = document.createElement('button');
        toggle.id = 'themeToggle';
        toggle.textContent = localStorage.getItem('cmtron-theme') === 'light' ? '🌙' : '☀️';
        toggle.style = 'position:fixed;right:18px;top:18px;padding:8px;border-radius:8px;border:none;cursor:pointer;';
        document.body.appendChild(toggle);
        function applyTheme(t){
          if(t === 'light'){ root.classList.add('light'); toggle.textContent='🌙'; }
          else { root.classList.remove('light'); toggle.textContent='☀️'; }
          localStorage.setItem('cmtron-theme', t);
        }
        toggle.addEventListener('click', ()=> applyTheme(localStorage.getItem('cmtron-theme') === 'light' ? 'dark' : 'light'));
        if(!localStorage.getItem('cmtron-theme')) localStorage.setItem('cmtron-theme','dark');
        applyTheme(localStorage.getItem('cmtron-theme'));
      })();

      // Charts data injected from server
      const spamRows = ${spamData};
      const deptRows = ${deptData};

      // Spam trend chart
      (function(){
        const labels = spamRows.map(r => r.day);
        const spam = spamRows.map(r => r.spam);
        const clean = spamRows.map(r => r.clean);
        const ctx = document.getElementById('spamTrend').getContext('2d');
        new Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [
              { label: 'Spam', data: spam, borderColor: '#ff4b4b', backgroundColor: 'rgba(255,75,75,0.12)', fill: true },
              { label: 'Clean', data: clean, borderColor: '#1fd1b5', backgroundColor: 'rgba(31,209,181,0.12)', fill: true }
            ]
          },
          options: { responsive: true, maintainAspectRatio: false }
        });
      })();

      // Department bar chart
      (function(){
        const labels = deptRows.map(r => r.department);
        const data = deptRows.map(r => r.total);
        const ctx = document.getElementById('deptChart').getContext('2d');
        new Chart(ctx, {
          type: 'bar',
          data: { labels, datasets: [{ label: 'Volume', data, backgroundColor: '#1fd1b5' }] },
          options: { responsive: true, maintainAspectRatio: false }
        });
      })();
    </script>
  `, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
}

// inbound table (unchanged except detail link)
async function inboundTable(env) {
  const rows = await env.EMAIL_DB.prepare("SELECT * FROM emails ORDER BY received_at DESC LIMIT 200").all();
  return html(`
    <header><h1>Inbound Emails</h1><a href="/">← Back</a></header>
    <table>
      <tr><th>ID</th><th>From</th><th>To</th><th>Subject</th><th>Spam</th><th>Received</th><th>Detail</th></tr>
      ${rows.results.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${r.from_addr}</td>
          <td>${r.to_addr}</td>
          <td>${escape(r.subject)}</td>
          <td>${r.is_spam ? "⚠️" : ""}</td>
          <td>${r.received_at}</td>
          <td><a href="/email?id=${encodeURIComponent(r.id)}">View</a></td>
        </tr>
      `).join("")}
    </table>
  `);
}

// outbound table (KV)
async function outboundTable(env) {
  const list = await env.EMAIL_SEND_LOG_KV.list({ limit: 200 });
  const rows = await Promise.all(list.keys.map(async key => JSON.parse(await env.EMAIL_SEND_LOG_KV.get(key.name))));
  return html(`
    <header><h1>Outbound Send Attempts</h1><a href="/">← Back</a></header>
    <table>
      <tr><th>ID</th><th>Email ID</th><th>To</th><th>Subject</th><th>Sent At</th></tr>
      ${rows.map(d => `
        <tr>
          <td>${d.sendId}</td>
          <td>${d.emailId}</td>
          <td>${d.to}</td>
          <td>${escape(d.subject)}</td>
          <td>${d.sentAt}</td>
        </tr>
      `).join("")}
    </table>
  `);
}

// errors table
async function errorTable(env) {
  const rows = await env.EMAIL_DB.prepare("SELECT * FROM send_errors ORDER BY occurred_at DESC LIMIT 200").all();
  return html(`
    <header><h1>Send Errors</h1><a href="/">← Back</a></header>
    <table>
      <tr><th>ID</th><th>Email ID</th><th>To</th><th>Error</th><th>Time</th></tr>
      ${rows.results.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${r.email_id}</td>
          <td>${r.to_addr}</td>
          <td>${escape(r.error)}</td>
          <td>${r.occurred_at}</td>
        </tr>
      `).join("")}
    </table>
  `);
}

// search
async function searchEmails(env, url) {
  const q = url.searchParams.get("q") || "";
  const rows = await env.EMAIL_DB.prepare(
    `SELECT * FROM emails WHERE subject LIKE ? OR from_addr LIKE ? OR body LIKE ? ORDER BY received_at DESC LIMIT 200`
  ).bind(`%${q}%`, `%${q}%`, `%${q}%`).all();

  return html(`
    <header><h1>Search Results for "${escape(q)}"</h1><a href="/">← Back</a></header>
    <table>
      <tr><th>ID</th><th>From</th><th>To</th><th>Subject</th><th>Received</th><th>Detail</th></tr>
      ${rows.results.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${r.from_addr}</td>
          <td>${r.to_addr}</td>
          <td>${escape(r.subject)}</td>
          <td>${r.received_at}</td>
          <td><a href="/email?id=${encodeURIComponent(r.id)}">View</a></td>
        </tr>
      `).join("")}
    </table>
  `);
}

// department analytics
async function departmentAnalytics(env) {
  const rows = await env.EMAIL_DB.prepare(
    `SELECT
       CASE
         WHEN to_addr LIKE '%research@cellmetron.com%' THEN 'Research'
         WHEN to_addr LIKE '%press@cellmetron.com%'    THEN 'Press'
         WHEN to_addr LIKE '%retail@cellmetron.com%'   THEN 'Retail'
         WHEN to_addr LIKE '%investors@cellmetron.com%'THEN 'Investors'
         WHEN to_addr LIKE '%support@cellmetron.com%'  THEN 'Support'
         ELSE 'Other'
       END AS department,
       COUNT(*) AS total,
       SUM(is_spam) AS spam,
       SUM(1 - is_spam) AS clean
     FROM emails
     GROUP BY department
     ORDER BY total DESC`
  ).all();

  return html(`
    <header><h1>Department Analytics</h1><a href="/">← Back</a></header>
    <table>
      <tr><th>Department</th><th>Total</th><th>Spam</th><th>Clean</th></tr>
      ${rows.results.map(r => `
        <tr>
          <td>${r.department}</td>
          <td>${r.total}</td>
          <td>${r.spam}</td>
          <td>${r.clean}</td>
        </tr>
      `).join("")}
    </table>
  `);
}

// spam heatmap
async function spamHeatmap(env) {
  const rows = await env.EMAIL_DB.prepare(
    `SELECT substr(received_at,1,10) AS day, SUM(is_spam) AS spam, SUM(1 - is_spam) AS clean
     FROM emails GROUP BY day ORDER BY day DESC LIMIT 30`
  ).all();

  return html(`
    <header><h1>Spam Heatmap (Last 30 Days)</h1><a href="/">← Back</a></header>
    <div class="heatmap">
      ${rows.results.map(r => {
        const total = r.spam + r.clean;
        const spamRatio = total ? (r.spam / total) : 0;
        const intensity = Math.round(spamRatio * 100);
        return `
          <div class="heat-row">
            <span class="heat-day">${r.day}</span>
            <span class="heat-bar" style="background: linear-gradient(to right, #ff4b4b ${intensity}%, #1f2933 ${intensity}%);">
              <span class="heat-label">Spam: ${r.spam}, Clean: ${r.clean}</span>
            </span>
          </div>
        `;
      }).join("")}
    </div>
  `);
}

// email detail
async function emailDetail(env, url) {
  const id = url.searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400 });
  const row = await env.EMAIL_DB.prepare("SELECT * FROM emails WHERE id = ?").bind(id).first();
  if (!row) return new Response("Email not found", { status: 404 });

  return html(`
    <header><h1>Email Detail</h1><a href="/inbound">← Back</a></header>
    <section class="detail">
      <h2>Metadata</h2>
      <p><strong>ID:</strong> ${row.id}</p>
      <p><strong>From:</strong> ${row.from_addr}</p>
      <p><strong>To:</strong> ${row.to_addr}</p>
      <p><strong>Subject:</strong> ${escape(row.subject)}</p>
      <p><strong>Received:</strong> ${row.received_at}</p>
      <p><strong>Spam:</strong> ${row.is_spam ? "Yes" : "No"} (score: ${row.spam_score})</p>
    </section>
    <section class="detail-body"><h2>Body</h2><pre>${escape(row.body)}</pre></section>
  `);
}

/* -------------------------
   CSV export endpoint
   /export?type=inbound|outbound|errors
   ------------------------- */
async function exportCsv(env, url) {
  const type = url.searchParams.get("type") || "inbound";
  if (type === "inbound") {
    const rows = await env.EMAIL_DB.prepare("SELECT * FROM emails ORDER BY received_at DESC").all();
    const csv = toCsv(rows.results, ["id","from_addr","to_addr","subject","spam_score","is_spam","received_at","body"]);
    return new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=inbound_emails.csv" }});
  }
  if (type === "errors") {
    const rows = await env.EMAIL_DB.prepare("SELECT * FROM send_errors ORDER BY occurred_at DESC").all();
    const csv = toCsv(rows.results, ["id","email_id","to_addr","error","occurred_at"]);
    return new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=send_errors.csv" }});
  }
  if (type === "outbound") {
    const list = await env.EMAIL_SEND_LOG_KV.list({ limit: 1000 });
    const rows = await Promise.all(list.keys.map(async k => JSON.parse(await env.EMAIL_SEND_LOG_KV.get(k.name))));
    const csv = toCsv(rows, ["sendId","emailId","to","subject","sentAt"]);
    return new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=outbound_logs.csv" }});
  }
  return new Response("Invalid export type", { status: 400 });
}

function toCsv(rows, fields) {
  const esc = v => {
    if (v === null || v === undefined) return "";
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const header = fields.join(",") + "\n";
  const body = rows.map(r => fields.map(f => esc(r[f])).join(",")).join("\n");
  return header + body;
}

/* -------------------------
   Charts page (full-screen charts)
   ------------------------- */
async function chartsPage(env) {
  const spamRows = await env.EMAIL_DB.prepare(
    `SELECT substr(received_at,1,10) AS day, SUM(is_spam) AS spam, SUM(1 - is_spam) AS clean
     FROM emails GROUP BY day ORDER BY day DESC LIMIT 60`
  ).all();
  const deptRows = await env.EMAIL_DB.prepare(
    `SELECT
       CASE
         WHEN to_addr LIKE '%research@cellmetron.com%' THEN 'Research'
         WHEN to_addr LIKE '%press@cellmetron.com%'    THEN 'Press'
         WHEN to_addr LIKE '%retail@cellmetron.com%'   THEN 'Retail'
         WHEN to_addr LIKE '%investors@cellmetron.com%'THEN 'Investors'
         WHEN to_addr LIKE '%support@cellmetron.com%'  THEN 'Support'
         ELSE 'Other'
       END AS department,
       COUNT(*) AS total
     FROM emails
     GROUP BY department ORDER BY total DESC`
  ).all();

  return html(`
    <header><h1>Charts</h1><a href="/">← Back</a></header>
    <div class="charts-full">
      <canvas id="spamTrendFull" width="900" height="300"></canvas>
      <canvas id="deptChartFull" width="900" height="300"></canvas>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      const spamRows = ${JSON.stringify(spamRows.results.reverse())};
      const deptRows = ${JSON.stringify(deptRows.results)};

      (function(){
        const labels = spamRows.map(r => r.day);
        const spam = spamRows.map(r => r.spam);
        const clean = spamRows.map(r => r.clean);
        new Chart(document.getElementById('spamTrendFull').getContext('2d'), {
          type: 'line',
          data: { labels, datasets: [{ label:'Spam', data: spam, borderColor:'#ff4b4b' }, { label:'Clean', data: clean, borderColor:'#1fd1b5' }] },
          options: { responsive:true, maintainAspectRatio:false }
        });

        new Chart(document.getElementById('deptChartFull').getContext('2d'), {
          type: 'bar',
          data: { labels: deptRows.map(r=>r.department), datasets: [{ label:'Volume', data: deptRows.map(r=>r.total), backgroundColor:'#1fd1b5' }] },
          options: { responsive:true, maintainAspectRatio:false }
        });
      })();
    </script>
  `, { headers: { "Content-Type": "text/html; charset=UTF-8" }});
}

/* -------------------------
   HTML wrapper + theme + styles
   ------------------------- */
function html(content, opts = {}) {
  return new Response(`
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Cellmetron Email Dashboard</title>
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <style>
        :root {
          --bg: #050b12;
          --card-bg: #0b1624;
          --accent: #1fd1b5;
          --accent-soft: rgba(31, 209, 181, 0.12);
          --text: #e5edf7;
          --muted: #8a9bb5;
          --border: #1c2938;
        }
        :root.light {
          --bg: #f6fbfb;
          --card-bg: #ffffff;
          --accent: #0b8f7a;
          --accent-soft: rgba(11,143,122,0.08);
          --text: #0b1b1a;
          --muted: #5b6b73;
          --border: #e6eef0;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0; padding: 24px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          background: radial-gradient(circle at top left, #0f172a 0, #020617 50%, #000 100%);
          color: var(--text);
        }
        :root.light body { background: #f6fbfb; }
        header h1 { margin: 0 0 4px; font-size: 28px; letter-spacing: 0.03em; }
        header p { margin: 0 0 16px; color: var(--muted); }
        a { color: var(--accent); text-decoration: none; }
        .cards { display:flex; gap:16px; margin:16px 0 24px; flex-wrap:wrap; }
        .card { background:var(--card-bg); border:1px solid var(--border); border-radius:12px; padding:16px; min-width:220px; box-shadow:0 10px 30px rgba(0,0,0,0.35); }
        .card h2 { margin:0 0 8px; font-size:16px; }
        .card p.big { font-size:24px; margin:0 0 8px; }
        .nav-links { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
        .nav-links a { padding:8px 12px; border-radius:999px; border:1px solid var(--border); background: rgba(15,23,42,0.6); }
        .nav-links a:hover { border-color:var(--accent); background:var(--accent-soft); }
        .search-form { display:flex; gap:8px; margin-top:8px; }
        input[name="q"] { flex:1; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:#020617; color:var(--text); }
        :root.light input[name="q"] { background:#fff; color:var(--text); }
        button { padding:8px 14px; border-radius:8px; border:none; background:var(--accent); color:#021017; font-weight:600; cursor:pointer; }
        table { border-collapse:collapse; width:100%; margin-top:16px; background: rgba(2,6,23,0.9); border-radius:12px; overflow:hidden; }
        :root.light table { background: #fff; }
        th, td { border-bottom:1px solid #111827; padding:8px 10px; font-size:13px; }
        th { background:#020617; text-align:left; }
        :root.light th { background:#f3f7f7; }
        tr:nth-child(even) td { background: rgba(15,23,42,0.7); }
        :root.light tr:nth-child(even) td { background: #fbfdfe; }
        .heatmap { margin-top:16px; }
        .heat-row { display:flex; align-items:center; margin-bottom:6px; }
        .heat-day { width:110px; font-size:12px; color:var(--muted); }
        .heat-bar { flex:1; border-radius:999px; padding:4px 10px; border:1px solid var(--border); display:flex; align-items:center; }
        .detail, .detail-body { margin-top:16px; background:var(--card-bg); border-radius:12px; padding:16px; border:1px solid var(--border); }
        pre { white-space:pre-wrap; word-wrap:break-word; font-size:13px; color:var(--text); }
        .chart-row { display:flex; gap:16px; margin-top:12px; flex-wrap:wrap; }
        .small-link { display:inline-block; margin-top:8px; color:var(--muted); }
        .charts-full canvas { width:100%; max-width:900px; height:320px; display:block; margin:16px 0; }
      </style>
    </head>
    <body>${content}</body>
    </html>
  `, { headers: { "Content-Type": "text/html; charset=UTF-8" }});
}

/* -------------------------
   Utilities
   ------------------------- */
function escape(str = "") {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
