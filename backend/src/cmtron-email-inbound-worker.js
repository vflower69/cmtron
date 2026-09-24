/*
export default {
  async email(message, env, ctx) {
    const from = message.from;
    const to = message.to;
    const subject = message.headers.get("subject");
    const body = await message.text();

    // Forward all Cellmetron mail to your real inbox
    await fetch(env.OUTBOUND_WORKER_URL, {
      method: "POST",
      body: JSON.stringify({
        to: "mikeliu89@hotmail.com",
        subject: `[Cellmetron] ${subject}`,
        text: `From: ${from}\nTo: ${to}\n\n${body}`
      })
    });
  }
};
*/
// Email Worker (cmtron-email-inbound)
// Compatibility: nodejs_compat recommended
export default {
  async email(message, env, ctx) {
    const to = message.to.toLowerCase();
    const from = message.from;
    const subject = message.headers.get("subject") || "(no subject)";
    const body = await message.text();

    // --- 1. Basic spam filtering (cheap heuristics) ---
    const spamScore = scoreSpam(subject, body);
    const isSpam = spamScore >= 5;

    // --- 2. Log to KV and D1 ---
    const id = `email-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // KV: raw email log
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

    // D1: structured record
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

    // --- 3. Department-specific forwarding ---
    const forwardTo = routeDepartment(to, isSpam);

    // Call outbound HTTP Worker
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

    // --- 4. Auto-reply (only if not spam) ---
    if (!isSpam) {
      const autoReply = buildAutoReply(to, from, subject);
      if (autoReply) {
        await fetch(env.OUTBOUND_WORKER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(autoReply)
        });
      }
    }
  }
};

// --- Helpers ---

function routeDepartment(to, isSpam) {
  if (isSpam) return "spam@cellmetron.com";

  if (to.includes("research@cellmetron.com")) return "research.team@cellmetron.com";
  if (to.includes("press@cellmetron.com"))    return "media@cellmetron.com";
  if (to.includes("retail@cellmetron.com"))   return "sales@cellmetron.com";
  if (to.includes("investors@cellmetron.com"))return "investor.relations@cellmetron.com";
  if (to.includes("support@cellmetron.com"))  return "support.queue@cellmetron.com";

  // Catch-all
  return "mikeliu89@hotmail.com";
}

function scoreSpam(subject, body) {
  const text = (subject + " " + body).toLowerCase();
  let score = 0;

  const badWords = [
    "free money", "viagra", "crypto giveaway", "work from home",
    "congratulations you won", "click here", "urgent action required"
  ];

  for (const w of badWords) {
    if (text.includes(w)) score += 2;
  }

  if (text.length < 40) score += 1;          // very short
  if (text.includes("http://")) score += 1; // non-https links

  return score;
}

function buildAutoReply(to, from, subject) {
  // Different auto-replies per department
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

  // No auto-reply for other addresses
  return null;
}
