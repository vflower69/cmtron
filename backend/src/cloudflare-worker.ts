import Stripe from "stripe";

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  FRONTEND_ORIGIN: string;
  DB: D1Database;
}

const getStripe = (env: Env) =>
  new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse();
    }

    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      return createCheckoutSession(request, env);
    }

    if (url.pathname === "/create-subscription" && request.method === "POST") {
      return createSubscription(request, env);
    }

    if (url.pathname === "/stripe-webhook" && request.method === "POST") {
      return stripeWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------- CORS helper ----------

function corsResponse(body: any = null, status = 200) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// ---------- Checkout session (one-time payments) ----------

async function createCheckoutSession(request: Request, env: Env) {
  const data = await request.json(); // { items: [{ name, qty }] }

  const line_items = (data.items || []).map((item: any) => ({
    quantity: item.qty || 1,
    price_data: {
      currency: "usd",
      unit_amount: 4900, // $49.00 example; adjust per product
      product_data: {
        name: item.name,
      },
    },
  }));

  const stripe = getStripe(env);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items,
    success_url: `${env.FRONTEND_ORIGIN}/success.html`,
    cancel_url: `${env.FRONTEND_ORIGIN}/cart.html`,
  });

  return corsResponse({ sessionId: session.id });
}

// ---------- Subscription creation ----------

async function createSubscription(request: Request, env: Env) {
  const data = await request.json(); // { email, plan }

  const stripe = getStripe(env);

  // Map Evera plan → Stripe price ID
  const priceMap: Record<string, string> = {
    "Morning Cube Subscription": "price_morning",
    "Refresh Cube Subscription": "price_refresh",
    "Dual Subscription": "price_dual",
  };

  const priceId = priceMap[data.plan];
  if (!priceId) return corsResponse({ error: "Unknown plan" }, 400);

  const customer = await stripe.customers.create({
    email: data.email,
  });

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceId }],
  });

  await env.DB.prepare(
    `INSERT INTO subscriptions (email, plan, stripe_customer_id, stripe_subscription_id)
     VALUES (?, ?, ?, ?)`
  )
    .bind(data.email, data.plan, customer.id, subscription.id)
    .run();

  return corsResponse({ subscriptionId: subscription.id });
}

// ---------- Stripe webhook ----------

async function stripeWebhook(request: Request, env: Env) {
  const stripe = getStripe(env);

  const sig = request.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    return new Response(`Webhook error: ${err.message}`, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;

      await env.DB.prepare(
        `INSERT INTO orders (stripe_session_id, email, amount_total)
         VALUES (?, ?, ?)`
      )
        .bind(
          session.id,
          session.customer_details?.email || "",
          session.amount_total || 0
        )
        .run();
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;

      // You can update subscription status here if needed
      await env.DB.prepare(
        `UPDATE subscriptions
         SET plan = plan, stripe_subscription_id = ?, created_at = CURRENT_TIMESTAMP
         WHERE stripe_customer_id = ?`
      )
        .bind(sub.id, customerId)
        .run();
      break;
    }

    default:
      // ignore others for now
      break;
  }

  return new Response("ok", { status: 200 });
}
