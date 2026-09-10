// ===============================
// Evera Frontend Commerce System
// GitHub Pages (Frontend) + Cloudflare Workers (Backend)
// ===============================

const API_BASE = "https://api.evera.com"; // your Cloudflare backend

// ===============================
// CART SYSTEM
// ===============================

const cart = JSON.parse(localStorage.getItem("evera_cart")) || [];

function saveCart() {
  localStorage.setItem("evera_cart", JSON.stringify(cart));
}

function addToCart(productName) {
  cart.push({ name: productName, qty: 1 });
  saveCart();
  alert(productName + " added to cart");
}

function renderCart() {
  const container = document.getElementById("cart-items");
  if (!container) return;

  if (cart.length === 0) {
    container.innerHTML = "<p>Your cart is empty.</p>";
    return;
  }

  container.innerHTML = cart
    .map(
      item =>
        `<div class="card mb-lg">
          <h3>${item.name}</h3>
          <p>Qty: ${item.qty}</p>
        </div>`
    )
    .join("");
}

// ===============================
// SUBSCRIPTION SYSTEM
// ===============================

function renderSubscription() {
  const container = document.getElementById("subscription-details");
  if (!container) return;

  const plan = localStorage.getItem("evera_subscription");

  if (!plan) {
    container.innerHTML = "<p>No active subscription.</p>";
    return;
  }

  container.innerHTML = `
    <div class="card">
      <h3>Active Subscription</h3>
      <p>${plan}</p>
    </div>
  `;
}

// Cloudflare-powered subscription
async function subscribe(plan) {
  const email = prompt("Enter your email for subscription:");
  if (!email) return;

  await fetch(`${API_BASE}/create-subscription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, plan }),
  });

  // Save locally so subscription page shows it
  localStorage.setItem("evera_subscription", plan);

  alert("Subscription started for " + plan);
}

// ===============================
// SUBSCRIPTION MANAGEMENT
// ===============================

function pauseSubscription() {
  alert("Subscription paused (wire to backend).");
}

function cancelSubscription() {
  localStorage.removeItem("evera_subscription");
  alert("Subscription cancelled (wire to backend).");
}

// ===============================
// BACKEND SYNC HELPERS (optional)
// ===============================

async function syncCartToBackend() {
  await fetch(`${API_BASE}/cart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: cart }),
  });
}

async function syncSubscriptionToBackend() {
  const plan = localStorage.getItem("evera_subscription");
  if (!plan) return;

  await fetch(`${API_BASE}/subscription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
}

// ===============================
// Global Header & Footer Includes
// ===============================

function loadHTML(id, file) {
  fetch(file)
    .then(response => response.text())
    .then(data => {
      const container = document.getElementById(id);
      if (container) container.innerHTML = data;
    })
    .catch(err => console.error(`Error loading ${file}:`, err));
}

document.addEventListener("DOMContentLoaded", () => {
  loadHTML("header", "header.html");
  loadHTML("footer", "footer.html");
});
