// Email Worker (cmtron-email-inbound) - FINAL version with correct body extraction
// Compatibility: nodejs_compat recommended

export default {
  async email(message, env, ctx) {
    try {
      const to = (message.to || "").toLowerCase();
      const from = message.from;
      const subject =
        message.headers?.get?.("subject") || "(no subject)";

      // --- Extract body robustly ---
      const body = await extractEmailBody(message);

      // DEBUG (safe)
      console.log("DEBUG inbound body length:", body?.length || 0);

      // --- 1. Basic spam filtering ---
      const spamScore = scoreSpam(subject, body);
      const isSpam = spamScore >= 5;

      // --- 2. Log to KV + D1 ---
      const id = `email-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      if (env.EMAIL_LOG_KV?.put) {
        await env.EMAIL_LOG_KV.put(
          id,
          JSON.stringify({
            id,
            from,
            to,
            subject,
            body,
            spamScore,
            isSpam,
            receivedAt: new Date().toISOString()
          })
        );
      }

      if (env.EMAIL_DB?.prepare) {
        await env.EMAIL_DB.prepare(
          `INSERT INTO emails (id, from_addr, to_addr, subject, body, spam_score, is_spam, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            id,
            from,
            to,
            subject,
            body,
            spamScore,
            isSpam ? 1 : 0,
            new Date().toISOString()
          )
          .run();
      }

      // --- 3. Forwarding ---
      const forwardTo = routeDepartment(to, isSpam);

      if (env.OUTBOUND_WORKER_URL) {
        await fetch(env.OUTBOUND_WORKER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: forwardTo,
            from,
            originalTo: to,
            subject,
            text: body,
            spamScore,
            isSpam,
            emailId: id
          })
        });
      }

      // --- 4. Auto-reply ---
      if (!isSpam) {
        const autoReply = buildAutoReply(to, from, subject);
        if (autoReply && env.OUTBOUND_WORKER_URL) {
          await fetch(env.OUTBOUND_WORKER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(autoReply)
          });
        }
      }
    } catch (err) {
      console.error("Inbound email handler error:", String(err));
    }
  }
};

/* ---------------------------------------------------------
   REAL Cloudflare Email Routing Body Extractor
   --------------------------------------------------------- */
async function extractEmailBody(message) {
  try {
    // 1) message.text()
    if (typeof message.text === "function") {
      const t = await message.text();
      if (t && t.trim()) return t;
    }

    // 2) message.body (string)
    if (typeof message.body === "string" && message.body.trim()) {
      return message.body;
    }

    // 3) message.body.text
    if (typeof message.body?.text === "string") {
      return message.body.text;
    }

    // 4) message.body.html
    if (typeof message.body?.html === "string") {
      return message.body.html;
    }

    // 5) message.body.plain (some CF accounts use this)
    if (typeof message.body?.plain === "string") {
      return message.body.plain;
    }

    // 6) MIME parts
    if (Array.isArray(message.body?.parts)) {
      const textPart = message.body.parts.find(p => p.type === "text/plain");
      if (textPart?.data) return textPart.data;

      const htmlPart = message.body.parts.find(p => p.type === "text/html");
      if (htmlPart?.data) return htmlPart.data;
    }

    // 7) message.raw (full MIME)
    if (typeof message.raw === "string" && message.raw.trim()) {
      return message.raw;
    }

    // 8) message.content (some CF internal formats)
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }

    // 9) message.data.text
    if (typeof message.data?.text === "string") {
      return message.data.text;
    }

    // 10) Last fallback: JSON dump
    return JSON.stringify(message);

  } catch (err) {
    console.error("extractEmailBody error:", err);
    return "(error reading body)";
  }
}

/* ---------------------------------------------------------
   Helpers
   --------------------------------------------------------- */

function routeDepartment(to, isSpam) {
  if (isSpam) return "spam@cellmetron.com";

  if (to.includes("research@cellmetron.com")) return "research.team@cellmetron.com";
  if (to.includes("press@cellmetron.com")) return "media@cellmetron.com";
  if (to.includes("retail@cellmetron.com")) return "sales@cellmetron.com";
  if (to.includes("investors@cellmetron.com")) return "investor.relations@cellmetron.com";
  if (to.includes("support@cellmetron.com")) return "support.queue@cellmetron.com";

  return "mikeliu89@hotmail.com";
}

function scoreSpam(subject, body) {
  const text = (subject + " " + body).toLowerCase();
  let score = 0;

  const badWords = [
    "free money", "viagra", "crypto giveaway", "work from home",
    "congratulations you won", "click here", "urgent action required"
  ];

  for (const w of badWords) if (text.includes(w)) score += 2;
  if (text.length < 40) score += 1;
  if (text.includes("http://")) score += 1;

  return score;
}

function buildAutoReply(to, from, subject) {
  if (to.includes("research@cellmetron.com")) {
    return {
      to: from,
      from: "research@cellmetron.com",
      subject: `Re: ${subject}`,
      text: `Thanks for contacting Cellmetron Research.\n\nWe’ve received your message and will respond within 2–3 business days.\n\n— Cellmetron Research`
    };
  }

  if (to.includes("press@cellmetron.com")) {
    return {
      to: from,
      from: "press@cellmetron.com",
      subject: `Re: ${subject}`,
      text: `Thanks for reaching out to Cellmetron press.\n\nOur media team will review your inquiry and get back to you shortly.\n\n— Cellmetron Communications`
    };
  }

  if (to.includes("support@cellmetron.com")) {
    return {
      to: from,
      from: "support@cellmetron.com",
      subject: `Re: ${subject}`,
      text: `Thanks for contacting Cellmetron Support.\n\nYour ticket has been received. We aim to respond within 24 hours.\n\n— Cellmetron Support`
    };
  }

  return null;
}
