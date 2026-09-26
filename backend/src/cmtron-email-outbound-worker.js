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
export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Use POST", { status: 405 });
    }

    const data = await request.json();
    const {
      to,
      from,
      originalTo,
      subject,
      text,
      spamScore,
      isSpam,
      emailId
    } = data;

    // --- 1. Log send attempt to KV ---
    const sendId = `send-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await env.EMAIL_SEND_LOG_KV.put(sendId, JSON.stringify({
      sendId,
      emailId,
      to,
      from,
      originalTo,
      subject,
      spamScore,
      isSpam,
      sentAt: new Date().toISOString()
    }));

    // --- 2. Send via Cloudflare Email API ---
    try {
      await env.SEND_EMAIL.send({
        from: from || "noreply@cellmetron.com",
        to,
        subject,
        text
      });

      return new Response("Email sent", { status: 200 });
    } catch (err) {
      // --- 3. Error logging to D1 ---
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

      return new Response("Failed to send email", { status: 500 });
    }
  }
};
