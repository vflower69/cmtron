// ===============================
// Evera Checkout (GitHub Pages)
// ===============================

async function checkout() {
  const cart = JSON.parse(localStorage.getItem("evera_cart")) || [];

  if (cart.length === 0) {
    alert("Your cart is empty.");
    return;
  }

  const res = await fetch("https://api.evera.com/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: cart }),
  });

  const { sessionId } = await res.json();

  if (!sessionId) {
    alert("Checkout error — session not created.");
    return;
  }

  const stripe = Stripe("pk_live_your_public_key_here");

  await stripe.redirectToCheckout({ sessionId });
}
