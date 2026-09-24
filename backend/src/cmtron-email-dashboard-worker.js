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

  return html(`
    <h1>📬 Cellmetron Email Dashboard</h1>

    <div class="stats">
      <div class="card">
        <h2>Inbound Emails</h2>
        <p>${inboundCount.count}</p>
        <a href="/inbound">View inbound logs →</a>
      </div>

      <div class="card">
        <h2>Send Errors</h2>
        <p>${errorCount.count}</p>
        <a href="/errors">View errors →</a>
      </div>

      <div class="card">
        <h2>Outbound Logs (KV)</h2>
        <a href="/outbound">View outbound logs →</a>
      </div>
    </div>

    <h2>Search</h2>
    <form action="/search">
      <input name="q" placeholder="Search subject, sender, body…" />
      <button>Search</button>
    </form>
  `);
}

// --- INBOUND EMAIL TABLE ---
async function inboundTable(env) {
  const rows = await env.EMAIL_DB.prepare(
    "SELECT * FROM emails ORDER BY received_at DESC LIMIT 200"
  ).all();

  return html(`
    <h1>📥 Inbound Emails</h1>
    <a href="/">← Back</a>
    <table>
      <tr>
        <th>ID</th><th>From</th><th>To</th><th>Subject</th>
        <th>Spam</th><th>Received</th>
      </tr>
      ${rows.results.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${r.from_addr}</td>
          <td>${r.to_addr}</td>
          <td>${r.subject}</td>
          <td>${r.is_spam ? "⚠️" : ""}</td>
          <td>${r.received_at}</td>
        </tr>
      `).join("")}
    </table>
  `);
}

// --- OUTBOUND SEND ATTEMPTS (KV) ---
async function outboundTable(env) {
  const list = await env.EMAIL_SEND_LOG_KV.list({ limit: 200 });

  return html(`
    <h1>📤 Outbound Send Attempts</h1>
    <a href="/">← Back</a>
    <table>
      <tr>
        <th>ID</th><th>Email ID</th><th>To</th><th>Subject</th><th>Sent At</th>
      </tr>
      ${await Promise.all(list.keys.map(async key => {
        const data = JSON.parse(await env.EMAIL_SEND_LOG_KV.get(key.name));
        return `
          <tr>
            <td>${data.sendId}</td>
            <td>${data.emailId}</td>
            <td>${data.to}</td>
            <td>${data.subject}</td>
            <td>${data.sentAt}</td>
          </tr>
        `;
      })).then(rows => rows.join(""))}
    </table>
  `);
}

// --- SEND ERRORS TABLE ---
async function errorTable(env) {
  const rows = await env.EMAIL_DB.prepare(
    "SELECT * FROM send_errors ORDER BY occurred_at DESC LIMIT 200"
  ).all();

  return html(`
    <h1>⚠️ Send Errors</h1>
    <a href="/">← Back</a>
    <table>
      <tr>
        <th>ID</th><th>Email ID</th><th>To</th><th>Error</th><th>Time</th>
      </tr>
      ${rows.results.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${r.email_id}</td>
          <td>${r.to_addr}</td>
          <td>${r.error}</td>
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
    <h1>🔍 Search Results for "${q}"</h1>
    <a href="/">← Back</a>
    <table>
      <tr>
        <th>ID</th><th>From</th><th>To</th><th>Subject</th><th>Received</th>
      </tr>
      ${rows.results.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${r.from_addr}</td>
          <td>${r.to_addr}</td>
          <td>${r.subject}</td>
          <td>${r.received_at}</td>
        </tr>
      `).join("")}
    </table>
  `);
}

// --- HTML WRAPPER ---
function html(content) {
  return new Response(`
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Cellmetron Email Dashboard</title>
      <style>
        body { font-family: Arial; padding: 20px; }
        table { border-collapse: collapse; width: 100%; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 8px; }
        th { background: #f0f0f0; }
        .stats { display: flex; gap: 20px; margin-bottom: 30px; }
        .card { padding: 20px; border: 1px solid #ccc; border-radius: 8px; width: 200px; }
        .card h2 { margin-top: 0; }
      </style>
    </head>
    <body>${content}</body>
    </html>
  `, { headers: { "Content-Type": "text/html" } });
}
