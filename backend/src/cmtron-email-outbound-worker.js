/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
/*
export default {
  async fetch(request, env, ctx) {
    // You can view your logs in the Observability dashboard
    console.info({ message: 'Hello World Worker received a request!' }); 
    return new Response('Hello World!');

    const data = await request.json();

    await env.SEND_EMAIL.send({
      from: "contact@cellmetron.com",
      to: data.to,
      subject: data.subject,
      text: data.text
    });

    return new Response("Email sent");
  }
};
*/

// HTTP Worker (cmtron-email-outbound)

const ALLOWED_DOMAINS = [
  "cellmetron.com",
  "sugihairproducts.com",
  "sugi-global.com",
  "glorilliant.com"
];

function validateSender(sender) {
  const email = (sender || "").trim().toLowerCase();

  const parts = email.split("@");

  if (parts.length !== 2) {
    throw new Error(`Invalid sender address: ${email}`);
  }

  const domain = parts[1];

  if (!ALLOWED_DOMAINS.includes(domain)) {
    throw new Error(`Unauthorized sender domain: ${domain}`);
  }

  return email;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Use POST", { status: 405 });
    }

    let data;
    try {
      data = await request.json();
    } catch (err) {
      return new Response("Invalid JSON", { status: 400 });
    }

    const {
      to,
      from,
      originalTo,
      subject,
      text,
      attachments = [],
      spamScore,
      isSpam,
      emailId
    } = data;

    let sender;
    try {

      sender = from
        ? validateSender(from)
        : "noreply@sugi-global.com";

    } catch (err) {

      return new Response(
        JSON.stringify({
          ok: false,
          error: err.message
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    const senderDomain = sender.split("@")[1];

	// --- DEBUG: Print raw incoming attachments ---
    console.log("RAW incoming attachments:", JSON.stringify(attachments, null, 2));

    // --- 1. Prepare attachments (sanitize MIME + raw bytes) ---
    const preparedAttachments = [];

    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        const bytes = new Uint8Array(a.content || []);

        const safeMime =
          a.contentType && a.contentType.includes("/")
            ? a.contentType
            : "application/octet-stream";

		// --- DEBUG: Print MIME decision ---
        console.log("Attachment:", a.filename);
        console.log("Original contentType:", a.contentType);
        console.log("Safe MIME used:", safeMime);
        console.log(`Attachment size: ${bytes.length} bytes`);

        preparedAttachments.push({
          filename: a.filename || "attachment",
          content: bytes, // ⭐ raw bytes, NOT base64
          type: safeMime, // ✅ Cloudflare expects 'type'
          disposition: "attachment" // ✅ required by Cloudflare
        });
      }
    }

	// --- DEBUG: Print final payload sent to Cloudflare ---
    console.log("Prepared attachments:", JSON.stringify(preparedAttachments, null, 2));

    // --- 2. Log send attempt to KV ---
    const sendId = `send-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await env.EMAIL_SEND_LOG_KV.put(sendId, JSON.stringify({
      sendId,
      emailId,
      senderDomain,
      to,
      from: sender,
      originalTo,
      subject,
      text,
      attachments: preparedAttachments.map(a => ({
        filename: a.filename,
        contentType: a.type,
        size: a.content.length
      })),
      spamScore,
      isSpam,
      sentAt: new Date().toISOString()
    }));

    // --- 3. Store outbound email + attachments in D1 ---
    await env.EMAIL_DB.prepare(
      `INSERT INTO sent_emails
       (id, email_id, from_addr, to_addr, original_to, subject, body, spam_score, is_spam, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sendId,
      emailId || null,
      sender,
      to,
      originalTo || null,
      subject,
      text,
      spamScore || null,
      isSpam ? 1 : 0,
      new Date().toISOString()
    ).run();

    // Store attachments as BLOBs in D1 table sent_attachments
    for (const a of preparedAttachments) {
      await env.EMAIL_DB.prepare(
        `INSERT INTO sent_attachments (email_id, filename, content_type, data)
         VALUES (?, ?, ?, ?)`
      ).bind(
        sendId,
        a.filename,
        a.type,
        a.content   // Uint8Array → stored as BLOB
      ).run();
    }

    console.log("Stored outbound email + attachments in D1");
	console.log("Final SEND_EMAIL payload:", JSON.stringify(preparedAttachments, null, 2));

    // --- 4. Send via Cloudflare Email API ---
    try {
      await env.SEND_EMAIL.send({
        from: sender,
        to,
        subject,
        text,
        attachments: preparedAttachments
      });

      return new Response(
        JSON.stringify({
          ok: true,
          sendId,
          senderDomain
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    } catch (err) {
      console.log("Cloudflare SEND_EMAIL error:", String(err));

      await env.EMAIL_DB.prepare(
        `INSERT INTO send_errors (id, email_id, to_addr, error, occurred_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        sendId,
        emailId || null,
        to,
        String(err),
        new Date().toISOString()
      ).run();

      return new Response(
        JSON.stringify({ ok: false, error: String(err) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }
};
