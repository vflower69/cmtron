// Email Worker (cmtron-email-inbound) - patched to capture real email body
// Compatibility: nodejs_compat recommended
/*
Notes:
- Enhanced body extraction to handle Cloudflare Email Routing event shapes.
- Keeps all previous spam filtering, KV/D1 logging, forwarding, and auto-reply logic.
*/

export default {
  async email(message, env, ctx) {
    try {
      const to = (message.to || "").toLowerCase();
      const from = message.from;
      const subject = (message.headers && typeof message.headers.get === "function")
        ? (message.headers.get("subject") || "(no subject)")
        : "(no subject)";

      // --- Extract body robustly ---
      const body = await getEmailBody(message);

      // Optional debug while testing
      // console.log("DEBUG inbound message:", { typeofMessage: typeof message, hasTextFn: typeof message?.text === "function", sampleBody: (body || "").slice(0,200) });

      // --- 1. Basic spam filtering ---
      const spamScore = scoreSpam(subject, body);
      const isSpam = spamScore >= 5;

      // --- 2. Log to KV and D1 ---
      const id = `email-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // KV: raw email log
      if (env.EMAIL_LOG_KV && typeof env.EMAIL_LOG_KV.put === "function") {
        await env.EMAIL_LOG_KV.put(id, JSON.stringify({
          id,
          from,
          to,
          subject,
          body,
          spamScore,
          isSpam,
          receivedAt: new Date().toISOString()
        }));
      } else {
        console.warn("EMAIL_LOG_KV not available; skipping KV log for", id);
      }

      // D1: structured record
      if (env.EMAIL_DB && typeof env.EMAIL_DB.prepare === "function") {
        await env.EMAIL_DB.prepare(
          `INSERT INTO emails (id, from_addr, to_addr, subject, body, spam_score, is_spam, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id,
          from,
          to,
          subject,
          body,
          spamScore,
          isSpam ? 1 : 0,
          new Date().toISOString()
        ).run();
      } else {
        console.warn("EMAIL_DB binding missing; skipping D1 insert for", id);
      }

      // --- 3. Department-specific forwarding ---
      const forwardTo = routeDepartment(to, isSpam);

      if (!env.OUTBOUND_WORKER_URL) {
        console.error("OUTBOUND_WORKER_URL not configured; skipping forward.");
      } else {
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

      // --- 4. Auto-reply (only if not spam) ---
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

/* -------------------------
   Enhanced body extractor
   ------------------------- */
async function getEmailBody(message) {
  try {
    if (!message) return "(empty message)";

    // 1. If message.text() exists, use it
    if (typeof message.text === "function") {
      const text = await message.text();
      if (text && text.trim()) return text;
    }

    // 2. If message.body exists
    if (message.body) {
      if (typeof message.body === "string") return message.body;
      if (typeof message.body.text === "string") return message.body.text;
      if (typeof message.body.html === "string") return message.body.html;
      // If body has MIME parts
      if (Array.isArray(message.body.parts)) {
        const textPart = message.body.parts.find(p => p.type === "text/plain");
        if (textPart && textPart.data) return textPart.data;
        const htmlPart = message.body.parts.find(p => p.type === "text/html");
        if (htmlPart && htmlPart.data) return htmlPart.data;
      }
    }

    // 3. If message.raw exists (MIME string)
    if (message.raw && typeof message.raw === "string") return message.raw;

    // 4. If message.data.text exists
    if (message.data && typeof message.data.text === "string") return message.data.text;

    // 5. Fallback: stringify object
    return JSON.stringify(message);
  } catch (err) {
    console.error("getEmailBody error:", err);
    return "(error reading body)";
  }
}

/* -------------------------
   Helpers (unchanged)
   ------------------------- */

function routeDepartment(to, isSpam) {
  if (isSpam) return "spam@cellmetron.com";

  if (to.includes("research@cellmetron.com")) return "research.team@cellmetron.com";
  if (to.includes("press@cellmetron.com"))    return "media@cellmetron.com";
  if (to.includes("retail@cellmetron.com"))   return "sales@cellmetron.com";
  if (to.includes("investors@cellmetron.com"))return "investor.relations@cellmetron.com";
  if (to.includes("support@cellmetron.com"))  return "support.queue@cellmetron.com";

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
