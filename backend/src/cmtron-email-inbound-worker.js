// ======================================================
//  Cellmetron Inbound Email Security Worker (Advanced)
// ======================================================

export default {
  async email(event, env, ctx) {
    try {
      await validateD1Schema(env);
      // --------------------------------------------------
      // Basic fields
      // --------------------------------------------------
      const from = event.from || "";
      const to = event.to || "";
      const subject =
        (event.headers && event.headers.get("subject")) || "(no subject)";

      // --------------------------------------------------
      // Auth: DKIM / SPF / DMARC / ARC / IP
      // --------------------------------------------------
      const auth = extractAuthResults(event);
      const clientIp = extractClientIp(event);

      // --------------------------------------------------
      // Body extraction (robust) + HTML → text
      // --------------------------------------------------
      const rawBody = await extractEmailBody(event);
      const bodyText = normalizeBodyToText(rawBody);

      // --------------------------------------------------
      // Attachments
      // --------------------------------------------------
      //const attachments = extractAttachments(event);
      const attachments = await processAttachments(event, env, id);


      // --------------------------------------------------
      // URL extraction
      // --------------------------------------------------
      const urls = extractUrls(bodyText);

      // --------------------------------------------------
      // Scoring: spam (rules + Bayesian‑style), IP, URLs, attachments
      // --------------------------------------------------
      const ruleSpamScore = scoreSpamRules(subject, bodyText);
      const bayesSpamScore = scoreBayesianSpam(subject, bodyText);
      const ipScore = scoreIpReputation(clientIp);
      const urlScore = scoreUrlReputation(urls);
      const attachmentScore = scoreAttachmentRisk(attachments);

      const spamScore = ruleSpamScore + bayesSpamScore;

      // --------------------------------------------------
      // Auth score (DKIM/SPF + spam)
      // --------------------------------------------------
      const authScore = computeAuthScore(auth, spamScore);

      // --------------------------------------------------
      // Unified risk score
      // --------------------------------------------------
      const riskScore =
        authScore +
        ipScore +
        urlScore +
        attachmentScore;

      const isSpam = spamScore >= 5 || riskScore >= 10;

      // --------------------------------------------------
      // Normalize for D1
      // --------------------------------------------------
      const safeFrom = String(from || "");
      let safeTo = String(to || ""); // mutable for routing overrides
      const safeSubject = String(subject || "");
      const safeBody = String(bodyText || "(empty)");
      const safeSpamScore = Number(spamScore || 0);
      const safeRiskScore = Number(riskScore || 0);
      const safeIsSpam = isSpam ? 1 : 0;
      const safeTimestamp = new Date().toISOString();

      // --------------------------------------------------
      // ID
      // --------------------------------------------------
      const id = `email-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;

      // --------------------------------------------------
      // Structured logging (Cloudflare Analytics friendly)
// --------------------------------------------------
      console.log(
        JSON.stringify({
          type: "inbound_email",
          id,
          from: safeFrom,
          to: safeTo,
          subject: safeSubject,
          bodyPreview: safeBody.slice(0, 200),
          ruleSpamScore,
          bayesSpamScore,
          spamScore: safeSpamScore,
          authScore,
          ipScore,
          urlScore,
          attachmentScore,
          riskScore: safeRiskScore,
          isSpam: !!isSpam,
          dkim: auth.dkim,
          spf: auth.spf,
          dmarc: auth.dmarc,
          arc: auth.arc,
          clientIp,
          urlsCount: urls.length,
          attachmentsCount: attachments.length,
          receivedAt: safeTimestamp
        })
      );

      // --------------------------------------------------
      // KV logging
      // --------------------------------------------------
      if (env.EMAIL_LOG_KV?.put) {
        await env.EMAIL_LOG_KV.put(
          id,
          JSON.stringify({
            id,
            from: safeFrom,
            to: safeTo,
            subject: safeSubject,
            body: safeBody,
            ruleSpamScore,
            bayesSpamScore,
            spamScore: safeSpamScore,
            authScore,
            ipScore,
            urlScore,
            attachmentScore,
            riskScore: safeRiskScore,
            isSpam,
            dkim: auth.dkim,
            spf: auth.spf,
            dmarc: auth.dmarc,
            arc: auth.arc,
            clientIp,
            urls,
            attachments,
            receivedAt: safeTimestamp
          })
        );
      }

      // --------------------------------------------------
      // D1 logging
      //   (add columns: dkim_result, spf_result, dmarc_result,
//    arc_result, risk_score, urls_json, attachments_json)
// --------------------------------------------------
// D1 logging
try {
  if (env.EMAIL_DB?.prepare) {
    await env.EMAIL_DB
      .prepare(
        `INSERT INTO emails (
           id,
           from_addr,
           to_addr,
           subject,
           body,
           spam_score,
           risk_score,
           is_spam,
           received_at,
           dkim_result,
           spf_result,
           dmarc_result,
           arc_result,
           client_ip,
           urls_json,
           attachments_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        safeFrom,
        safeTo,
        safeSubject,
        safeBody,
        safeSpamScore,
        safeRiskScore,
        safeIsSpam,
        safeTimestamp,
        auth.dkim.result,
        auth.spf.result,
        auth.dmarc.result,
        auth.arc.result,
        clientIp,
        JSON.stringify(urls),
        JSON.stringify(attachments)
      )
      .run();
  }
} catch (err) {
  console.log(
    JSON.stringify({
      type: "d1_insert_error",
      id,
      error: String(err)
    })
  );

  // Fallback: KV-only log so you never lose the email
  if (env.EMAIL_LOG_KV?.put) {
    await env.EMAIL_LOG_KV.put(
      `d1-failed-${id}`,
      JSON.stringify({
        id,
        from: safeFrom,
        to: safeTo,
        subject: safeSubject,
        body: safeBody,
        spamScore: safeSpamScore,
        riskScore: safeRiskScore,
        isSpam,
        dkim: auth.dkim,
        spf: auth.spf,
        dmarc: auth.dmarc,
        arc: auth.arc,
        clientIp,
        urls,
        attachments,
        receivedAt: safeTimestamp,
        d1Error: String(err)
      })
    );
  }
}


      // --------------------------------------------------
      // Auth / risk‑based rejection / routing
      // --------------------------------------------------

      // Hard reject: extremely suspicious mail
      if (riskScore >= 15) {
        console.log(
          JSON.stringify({
            type: "reject_email",
            id,
            reason: "riskScore >= 15",
            from: safeFrom,
            to: safeTo
          })
        );

        if (env.OUTBOUND_WORKER_URL) {
          await fetch(env.OUTBOUND_WORKER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to: safeFrom,
              from: "noreply@cellmetron.com",
              subject: `Re: ${safeSubject}`,
              text:
                "Your message could not be delivered due to security concerns.\n\n" +
                "Our system detected authentication and content issues " +
                "that suggest this email may be unsafe.",
            })
          });
        }

        return; // stop processing
      }

      // Medium suspicion: route to spam
      if (riskScore >= 8) {
        console.log(
          JSON.stringify({
            type: "route_spam",
            id,
            reason: "riskScore >= 8",
            from: safeFrom,
            to: safeTo
          })
        );
        safeTo = "spam@cellmetron.com";
      }

      // --------------------------------------------------
      // Forwarding
      // --------------------------------------------------
      const forwardTo = routeDepartment(safeTo, isSpam);

      if (env.OUTBOUND_WORKER_URL) {
        await fetch(env.OUTBOUND_WORKER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: forwardTo,
            from: safeFrom,
            originalTo: safeTo,
            subject: safeSubject,
            text: safeBody,
            ruleSpamScore,
            bayesSpamScore,
            spamScore: safeSpamScore,
            authScore,
            ipScore,
            urlScore,
            attachmentScore,
            riskScore: safeRiskScore,
            isSpam,
            emailId: id,
            dkim: auth.dkim,
            spf: auth.spf,
            dmarc: auth.dmarc,
            arc: auth.arc,
            clientIp,
            urls,
            attachments
          })
        });
      }

      // --------------------------------------------------
      // Auto reply (only for low‑risk mail)
// --------------------------------------------------
      if (!isSpam && riskScore < 8) {
        const autoReply = buildAutoReply(safeTo, safeFrom, safeSubject);
        if (autoReply && env.OUTBOUND_WORKER_URL) {
          await fetch(env.OUTBOUND_WORKER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(autoReply)
          });
        }
      }
    } catch (err) {
      console.error("Inbound email handler error:", err);
    }
  }
};

// ======================================================
//  Auth: DKIM / SPF / DMARC / ARC / IP
// ======================================================

function extractAuthResults(event) {
  const headers = event.headers || new Map();

  const authHeader =
    headers.get("authentication-results") ||
    headers.get("Authentication-Results") ||
    "";

  const receivedSpf =
    headers.get("received-spf") || headers.get("Received-SPF") || "";

  const dmarcHeader =
    headers.get("dmarc-filter") ||
    headers.get("DMARC-Filter") ||
    headers.get("dmarc-status") ||
    headers.get("DMARC-Status") ||
    "";

  const arcHeader =
    headers.get("arc-authentication-results") ||
    headers.get("ARC-Authentication-Results") ||
    "";

  const dkimResult = parseAuthHeaderFor(authHeader, "dkim");
  const spfResult =
    parseAuthHeaderFor(authHeader, "spf") || parseSpfHeader(receivedSpf);
  const dmarcResult = parseDmarcHeader(dmarcHeader || authHeader);
  const arcResult = parseArcHeader(arcHeader);

  return {
    dkim: {
      header: authHeader,
      result: dkimResult || "unknown"
    },
    spf: {
      header: receivedSpf || authHeader,
      result: spfResult || "unknown"
    },
    dmarc: {
      header: dmarcHeader || authHeader,
      result: dmarcResult || "unknown"
    },
    arc: {
      header: arcHeader,
      result: arcResult || "unknown"
    }
  };
}

function parseAuthHeaderFor(header, mechanism) {
  if (!header) return null;
  const lower = header.toLowerCase();
  const idx = lower.indexOf(mechanism + "=");
  if (idx === -1) return null;
  const after = lower.slice(idx + mechanism.length + 1);
  const token = after.split(";")[0].trim();
  return token || null;
}

function parseSpfHeader(header) {
  if (!header) return null;
  const lower = header.toLowerCase();
  if (lower.includes("pass")) return "pass";
  if (lower.includes("fail")) return "fail";
  if (lower.includes("softfail")) return "softfail";
  if (lower.includes("neutral")) return "neutral";
  return null;
}

function parseDmarcHeader(header) {
  if (!header) return null;
  const lower = header.toLowerCase();
  if (lower.includes("pass")) return "pass";
  if (lower.includes("reject")) return "reject";
  if (lower.includes("quarantine")) return "quarantine";
  if (lower.includes("none")) return "none";
  return null;
}

function parseArcHeader(header) {
  if (!header) return null;
  const lower = header.toLowerCase();
  if (lower.includes("pass")) return "pass";
  if (lower.includes("fail")) return "fail";
  if (lower.includes("none")) return "none";
  return null;
}

function extractClientIp(event) {
  const headers = event.headers || new Map();
  const cfConnectingIp =
    headers.get("cf-connecting-ip") ||
    headers.get("CF-Connecting-IP") ||
    "";
  const xForwardedFor =
    headers.get("x-forwarded-for") ||
    headers.get("X-Forwarded-For") ||
    "";

  return cfConnectingIp || xForwardedFor.split(",")[0].trim() || "";
}

// ======================================================
//  Robust Body Extraction
// ======================================================

async function extractEmailBody(event) {
  try {
    // 1️⃣ Try text() and html() first
    if (typeof event.text === "function") {
      const t = await event.text();
      if (t?.trim()) return t;
    }
    if (typeof event.html === "function") {
      const h = await event.html();
      if (h?.trim()) return h;
    }

    // 2️⃣ Handle ReadableStream (event.body or event.raw)
    const stream = event.body || event.raw;
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      return new TextDecoder("utf-8").decode(merged);
    }

    // 3️⃣ Handle ArrayBuffer or Blob
    if (stream instanceof ArrayBuffer) {
      return new TextDecoder("utf-8").decode(new Uint8Array(stream));
    }
    if (stream instanceof Blob) {
      return await stream.text();
    }

    // 4️⃣ Fallbacks
    if (event.data?.text) return event.data.text;
    if (event.data?.html) return event.data.html;
    if (typeof event.raw === "string") return event.raw;
    return "(empty)";
  } catch (err) {
    console.error("extractEmailBody() failed:", err);
    return "(empty)";
  }
}

// ======================================================
//  HTML → text normalization
// ======================================================

function normalizeBodyToText(body) {
  if (!body) return "(empty)";
  if (typeof body !== "string") body = String(body);

  const looksHtml =
    body.includes("<html") ||
    body.includes("<body") ||
    body.includes("<p") ||
    body.includes("<br") ||
    body.includes("</");

  if (!looksHtml) return body;

  let text = body.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<head[\s\S]*?<\/head>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text || "(empty)";
}

// ======================================================
//  Attachment extraction + risk scoring
// ======================================================

function extractAttachments(event) {
  const attachments = [];

  if (event.body?.attachments?.length) {
    for (const a of event.body.attachments) {
      attachments.push({
        filename: a.filename || null,
        contentType: a.type || a.contentType || null,
        size: a.size || null
      });
    }
  }

  if (event.body?.parts?.length) {
    for (const p of event.body.parts) {
      const isAttachment =
        p.disposition === "attachment" ||
        p.disposition === "inline" ||
        !!p.filename;

      if (isAttachment) {
        attachments.push({
          filename: p.filename || null,
          contentType: p.type || p.contentType || null,
          size: p.size || (p.data ? String(p.data).length : null)
        });
      }
    }
  }

  return attachments;
}

function scoreAttachmentRisk(attachments) {
  let score = 0;
  const riskyExtensions = [
    ".exe",
    ".scr",
    ".bat",
    ".cmd",
    ".js",
    ".vbs",
    ".ps1",
    ".jar",
    ".msi"
  ];

  for (const a of attachments) {
    const name = (a.filename || "").toLowerCase();
    const type = (a.contentType || "").toLowerCase();

    if (!name && !type) continue;

    if (riskyExtensions.some(ext => name.endsWith(ext))) {
      score += 4;
    }

    if (type.includes("application/x-msdownload")) score += 4;
    if (type.includes("application/x-executable")) score += 4;
    if (type.includes("application/x-sh")) score += 3;
    if (type.includes("application/x-bat")) score += 3;

    if (type.includes("application/zip") || name.endsWith(".zip")) {
      score += 1;
    }
  }

  return score;
}

// ======================================================
//  URL extraction + reputation scoring
// ======================================================

function extractUrls(text) {
  if (!text) return [];
  const urlRegex =
    /\bhttps?:\/\/[^\s)]+/gi;
  const matches = text.match(urlRegex) || [];
  return matches.map(u => u.trim());
}

function scoreUrlReputation(urls) {
  let score = 0;

  const suspiciousHosts = [
    "bit.ly",
    "tinyurl.com",
    "goo.gl",
    "t.co",
    "ow.ly"
  ];

  for (const url of urls) {
    const lower = url.toLowerCase();

    if (lower.includes("@")) score += 2; // obfuscated

    if (suspiciousHosts.some(h => lower.includes(h))) {
      score += 2;
    }

    if (lower.includes("login") || lower.includes("verify")) {
      score += 2;
    }

    if (lower.includes("crypto") || lower.includes("wallet")) {
      score += 2;
    }
  }

  return score;
}

// ======================================================
//  IP reputation scoring (heuristic)
// ======================================================

function scoreIpReputation(ip) {
  if (!ip) return 1; // unknown IP, small penalty

  const privateRanges = [
    "10.",
    "192.168.",
    "172.16.",
    "172.17.",
    "172.18.",
    "172.19.",
    "172.20.",
    "172.21.",
    "172.22.",
    "172.23.",
    "172.24.",
    "172.25.",
    "172.26.",
    "172.27.",
    "172.28.",
    "172.29.",
    "172.30.",
    "172.31."
  ];

  if (privateRanges.some(p => ip.startsWith(p))) {
    return 0; // internal / private
  }

  // Very naive heuristic: unknown public IP gets small penalty
  return 1;
}

// ======================================================
//  Spam scoring: rules + Bayesian‑style
// ======================================================

function scoreSpamRules(subject, body) {
  const text = (subject + " " + body).toLowerCase();
  let score = 0;

  const badWords = [
    "free money",
    "viagra",
    "crypto giveaway",
    "work from home",
    "congratulations you won",
    "click here",
    "urgent action required"
  ];

  for (const w of badWords) if (text.includes(w)) score += 2;
  if (text.length < 40) score += 1;
  if (text.includes("http://")) score += 1;

  return score;
}

function scoreBayesianSpam(subject, body) {
  const text = (subject + " " + body).toLowerCase();
  let score = 0;

  const spamIndicators = [
    "act now",
    "limited time",
    "risk free",
    "no obligation",
    "winner",
    "guaranteed",
    "double your",
    "earn $$$",
    "investment opportunity"
  ];

  const hamIndicators = [
    "meeting",
    "invoice",
    "receipt",
    "report",
    "schedule",
    "project",
    "minutes",
    "follow up",
    "thank you"
  ];

  for (const w of spamIndicators) if (text.includes(w)) score += 1;
  for (const w of hamIndicators) if (text.includes(w)) score -= 1;

  if (score < 0) score = 0;
  return score;
}

// ======================================================
//  Auth score (DKIM/SPF + spam)
// ======================================================

function computeAuthScore({ dkim, spf, dmarc, arc }, spamScore) {
  let score = 0;

  // DKIM
  if (dkim.result === "pass") score += 0;
  else if (dkim.result === "neutral") score += 1;
  else if (dkim.result === "fail") score += 3;
  else score += 2; // unknown

  // SPF
  if (spf.result === "pass") score += 0;
  else if (spf.result === "neutral") score += 1;
  else if (spf.result === "softfail") score += 2;
  else if (spf.result === "fail") score += 3;
  else score += 2; // unknown

  // DMARC
  if (dmarc.result === "pass" || dmarc.result === "none") score += 0;
  else if (dmarc.result === "quarantine") score += 2;
  else if (dmarc.result === "reject") score += 4;
  else score += 1; // unknown

  // ARC
  if (arc.result === "pass" || arc.result === "none") score += 0;
  else if (arc.result === "fail") score += 2;
  else score += 1; // unknown

  // Spam score
  score += spamScore;

  return score;
}

// ======================================================
//  Routing
// ======================================================

function routeDepartment(to, isSpam) {
  if (isSpam) return "spam@cellmetron.com";
  if (to.includes("research@cellmetron.com"))
    return "research.team@cellmetron.com";
  if (to.includes("press@cellmetron.com"))
    return "media@cellmetron.com";
  if (to.includes("retail@cellmetron.com"))
    return "sales@cellmetron.com";
  if (to.includes("investors@cellmetron.com"))
    return "investor.relations@cellmetron.com";
  if (to.includes("support@cellmetron.com"))
    return "support.queue@cellmetron.com";
  return "mikeliu89@hotmail.com";
}

// ======================================================
//  Auto Replies
// ======================================================

function buildAutoReply(to, from, subject) {
  if (to.includes("research@cellmetron.com")) {
    return {
      to: from,
      from: "research@cellmetron.com",
      subject: `Re: ${subject}`,
      text:
        "Thanks for contacting Cellmetron Research.\n\n" +
        "We’ve received your message and will respond within 2–3 business days.\n\n" +
        "— Cellmetron Research"
    };
  }

  if (to.includes("press@cellmetron.com")) {
    return {
      to: from,
      from: "press@cellmetron.com",
      subject: `Re: ${subject}`,
      text:
        "Thanks for reaching out to Cellmetron press.\n\n" +
        "Our media team will review your inquiry and get back to you shortly.\n\n" +
        "— Cellmetron Communications"
    };
  }

  if (to.includes("support@cellmetron.com")) {
    return {
      to: from,
      from: "support@cellmetron.com",
      subject: `Re: ${subject}`,
      text:
        "Thanks for contacting Cellmetron Support.\n\n" +
        "Your ticket has been received. We aim to respond within 24 hours.\n\n" +
        "— Cellmetron Support"
    };
  }

  return null;
}

async function validateD1Schema(env) {
  if (!env.EMAIL_DB?.prepare) return;

  try {
    const result = await env.EMAIL_DB
      .prepare("PRAGMA table_info(emails);")
      .all();

    const cols = (result?.results || result?.rows || []).map(r => r.name);

    const required = [
      "id",
      "from_addr",
      "to_addr",
      "subject",
      "body",
      "spam_score",
      "risk_score",
      "is_spam",
      "received_at",
      "dkim_result",
      "spf_result",
      "dmarc_result",
      "arc_result",
      "client_ip",
      "urls_json",
      "attachments_json"
    ];

    const missing = required.filter(c => !cols.includes(c));

    if (missing.length) {
      console.log(
        JSON.stringify({
          type: "d1_schema_error",
          message: "emails table missing required columns",
          missing
        })
      );
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        type: "d1_schema_validation_failed",
        error: String(err)
      })
    );
  }
}

async function processAttachments(event, env, emailId) {
  const attachments = [];

  if (event.body?.parts?.length) {
    for (const part of event.body.parts) {
      const isAttachment =
        part.disposition === "attachment" ||
        part.filename ||
        part.name;

      if (isAttachment && part.data) {
        const filename = part.filename || part.name || "attachment.bin";
        const contentType = part.type || "application/octet-stream";
        const base64Data = part.data;

        // Decode base64 to binary
        const binary = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

        // Store in KV for download
        const kvKey = `${emailId}-${filename}`;
        if (env.EMAIL_ATTACHMENTS_KV?.put) {
          await env.EMAIL_ATTACHMENTS_KV.put(kvKey, binary, {
            metadata: { contentType, filename }
          });
        }

        attachments.push({
          filename,
          contentType,
          size: binary.length,
          kvKey
        });
      }
    }
  }

  return attachments;
}
