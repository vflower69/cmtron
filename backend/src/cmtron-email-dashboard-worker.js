export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- ROUTES ---
    if (path === "/") return dashboardHome(env);
    if (path === "/inbound") return inboundTable(env);
    if (path === "/outbound") return outboundTable(env);
    if (path === "/errors") return errorTable(env);
    if (path === "/search") return searchEmails(env, url);

    // NEW ROUTES
    if (path === "/analytics") return departmentAnalytics(env);
    if (path === "/spam-heatmap") return spamHeatmap(env);
    if (path === "/email") return emailDetail(env, url);

    return new Response("Not found", { status: 404 });
  }
};

// --- HOME PAGE ---
async function dashboardHome(env) {
  const inboundCount = await env.EMAIL_DB.prepare(
    "SELECT COUNT(*) AS count FROM emails"
  ).first();

  const errorCount = await env.EMAIL_DB.prepare(
    "SELECT COUNT(*) AS count FROM send_errors"
  ).first();

  const spamStats = await env.EMAIL_DB.prepare(
    "SELECT SUM(is_spam) AS spam, SUM(1 - is_spam) AS ham FROM emails"
  ).first();

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
      <h2>Navigation</h2>
      <nav class="nav-links">
        <a href="/analytics">Department analytics</a>
        <a href="/inbound">Inbound logs</a>
        <a href="/outbound">Outbound logs</a>
        <a href="/errors">Send errors</a>
      </nav>
    </section>

    <section>
      <h2>Search</h2>
      <form action="/search" class="search-form">
        <input name="q" placeholder="Search subject, sender, body…" />
        <button>Search</button>
      </form>
    </section>
  `);
}

// --- INBOUND EMAIL TABLE ---
async function inboundTable(env) {
  const rows = await env.EMAIL_DB.prepare(
    "SELECT * FROM emails ORDER BY received_at DESC LIMIT 200"
  ).all();

  return html(`
    <header>
      <h1>Inbound Emails</h1>
      <a href="/">← Back</a>
    </header>
    <table>
      <tr>
        <th>ID</th><th>From</th><th>To</th><th>Subject</th>
        <th>Spam</th><th>Received</th><th>Detail</th>
      </tr>
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

// --- OUTBOUND SEND ATTEMPTS (KV) ---
async function outboundTable(env) {
  const list = await env.EMAIL_SEND_LOG_KV.list({ limit: 200 });

  const rows = await Promise.all(list.keys.map(async key => {
    const data = JSON.parse(await env.EMAIL_SEND_LOG_KV.get(key.name));
    return data;
  }));

  return html(`
    <header>
      <h1>Outbound Send Attempts</h1>
      <a href="/">← Back</a>
    </header>
    <table>
      <tr>
        <th>ID</th><th>Email ID</th><th>To</th><th>Subject</th><th>Sent At</th>
      </tr>
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

// --- SEND ERRORS TABLE ---
async function errorTable(env) {
  const rows = await env.EMAIL_DB.prepare(
    "SELECT * FROM send_errors ORDER BY occurred_at DESC LIMIT 200"
  ).all();

  return html(`
    <header>
      <h1>Send Errors</h1>
      <a href="/">← Back</a>
    </header>
    <table>
      <tr>
        <th>ID</th><th>Email ID</th><th>To</th><th>Error</th><th>Time</th>
      </tr>
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

// --- SEARCH ---
async function searchEmails(env, url) {
  const q = url.searchParams.get("q") || "";
  const rows = await env.EMAIL_DB.prepare(
    `SELECT * FROM emails
     WHERE subject LIKE ? OR from_addr LIKE ? OR body LIKE ?
     ORDER BY received_at DESC LIMIT 200`
  ).bind(`%${q}%`, `%${q}%`, `%${q}%`).all();

  return html(`
    <header>
      <h1>Search Results for "${escape(q)}"</h1>
      <a href="/">← Back</a>
    </header>
    <table>
      <tr>
        <th>ID</th><th>From</th><th>To</th><th>Subject</th><th>Received</th><th>Detail</th>
      </tr>
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

// --- DEPARTMENT ANALYTICS ---
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
    <header>
      <h1>Department Analytics</h1>
      <a href="/">← Back</a>
    </header>
    <table>
      <tr>
        <th>Department</th><th>Total</th><th>Spam</th><th>Clean</th>
      </tr>
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

// --- SPAM HEATMAP ---
async function spamHeatmap(env) {
  const rows = await env.EMAIL_DB.prepare(
    `SELECT
       substr(received_at, 1, 10) AS day,
       SUM(is_spam) AS spam,
       SUM(1 - is_spam) AS clean
     FROM emails
     GROUP BY day
     ORDER BY day DESC
     LIMIT 30`
  ).all();

  return html(`
    <header>
      <h1>Spam Heatmap (Last 30 Days)</h1>
      <a href="/">← Back</a>
    </header>

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

// --- EMAIL DETAIL PAGE ---
async function emailDetail(env, url) {
  const id = url.searchParams.get("id");
  if (!id) return new Response("Missing id", { status: 400 });

  const row = await env.EMAIL_DB.prepare(
    "SELECT * FROM emails WHERE id = ?"
  ).bind(id).first();

  if (!row) return new Response("Email not found", { status: 404 });

  return html(`
    <header>
      <h1>Email Detail</h1>
      <a href="/inbound">← Back</a>
    </header>

    <section class="detail">
      <h2>Metadata</h2>
      <p><strong>ID:</strong> ${row.id}</p>
      <p><strong>From:</strong> ${row.from_addr}</p>
      <p><strong>To:</strong> ${row.to_addr}</p>
      <p><strong>Subject:</strong> ${escape(row.subject)}</p>
      <p><strong>Received:</strong> ${row.received_at}</p>
      <p><strong>Spam:</strong> ${row.is_spam ? "Yes" : "No"} (score: ${row.spam_score})</p>
    </section>

    <section class="detail-body">
      <h2>Body</h2>
      <pre>${escape(row.body)}</pre>
    </section>
  `);
}

// --- HTML WRAPPER WITH CELLMETRON THEME ---
function html(content) {
  return new Response(`
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Cellmetron Email Dashboard</title>
      <style>
        :root {
          --bg: #050b12;
          --card-bg: #0b1624;
          --accent: #1fd1b5;
          --accent-soft: rgba(31, 209, 181, 0.15);
          --text: #e5edf7;
          --muted: #8a9bb5;
          --border: #1c2938;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 24px;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: radial-gradient(circle at top left, #0f172a 0, #020617 50%, #000 100%);
          color: var(--text);
        }
        header h1 {
          margin: 0 0 4px;
          font-size: 28px;
          letter-spacing: 0.03em;
        }
        header p {
          margin: 0 0 16px;
          color: var(--muted);
        }
        a {
          color: var(--accent);
          text-decoration: none;
        }
        a:hover {
          text-decoration: underline;
        }
        .cards {
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
          margin: 16px 0 24px;
        }
        .card {
          background: var(--card-bg);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 16px;
          min-width: 220px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.4);
        }
        .card h2 {
          margin: 0 0 8px;
          font-size: 16px;
        }
        .card p.big {
          font-size: 24px;
          margin: 0 0 8px;
        }
        .nav-links {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 16px;
        }
        .nav-links a {
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: rgba(15,23,42,0.8);
        }
        .nav-links a:hover {
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .search-form {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
        input[name="q"] {
          flex: 1;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: #020617;
          color: var(--text);
        }
        button {
          padding: 8px 14px;
          border-radius: 8px;
          border: none;
          background: var(--accent);
          color: #021017;
          font-weight: 600;
          cursor: pointer;
        }
        button:hover {
          filter: brightness(1.1);
        }
        table {
          border-collapse: collapse;
          width: 100%;
          margin-top: 16px;
          background: rgba(2,6,23,0.9);
          border-radius: 12px;
          overflow: hidden;
        }
        th, td {
          border-bottom: 1px solid #111827;
          padding: 8px 10px;
          font-size: 13px;
        }
        th {
          background: #020617;
          text-align: left;
        }
        tr:nth-child(even) td {
          background: rgba(15,23,42,0.7);
        }
        .heatmap {
          margin-top: 16px;
        }
        .heat-row {
          display: flex;
          align-items: center;
          margin-bottom: 6px;
        }
        .heat-day {
          width: 110px;
          font-size: 12px;
          color: var(--muted);
        }
        .heat-bar {
          flex: 1;
          border-radius: 999px;
          padding: 4px 10px;
          border: 1px solid var(--border);
          display: flex;
          align-items: center;
        }
        .heat-label {
          font-size: 11px;
          color: var(--text);
        }
        .detail {
          margin-top: 16px;
          background: var(--card-bg);
          border-radius: 12px;
          padding: 16px;
          border: 1px solid var(--border);
        }
        .detail-body {
          margin-top: 16px;
          background: #020617;
          border-radius: 12px;
          padding: 16px;
          border: 1px solid #111827;
        }
        pre {
          white-space: pre-wrap;
          word-wrap: break-word;
          font-size: 13px;
        }
        section { margin-top: 16px; }
      </style>
    </head>
    <body>${content}</body>
    </html>
  `, { headers: { "Content-Type": "text/html" } });
}

function escape(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
