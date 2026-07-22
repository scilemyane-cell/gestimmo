const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: "europe-west3", maxInstances: 10 });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Fait le lien entre l'identifiant de tarif Stripe et le nom du palier GestImmo.
// Les 3 valeurs viennent des secrets GitHub (PRICE_ESSENTIEL / PRICE_PRO / PRICE_EXPERT),
// injectées dans functions/.env au moment du déploiement — jamais commitées dans le repo.
function getPlanFromPriceId(priceId) {
  const map = {
    [process.env.PRICE_ESSENTIEL]: "essentiel",
    [process.env.PRICE_PRO]: "pro",
    [process.env.PRICE_EXPERT]: "expert",
  };
  return map[priceId] || null;
}

// ── Créer une session de paiement Stripe (appelée depuis l'app) ────────────
exports.createCheckoutSession = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Connecte-toi avant de t'abonner.");
  }
  const uid = request.auth.uid;
  const email = request.auth.token.email || undefined;
  const { priceId } = request.data;

  const plan = getPlanFromPriceId(priceId);
  if (!plan) {
    throw new HttpsError("invalid-argument", "Palier d'abonnement inconnu.");
  }

  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  let stripeCustomerId = userSnap.exists ? userSnap.data().stripeCustomerId : null;

  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email,
      metadata: { uid },
    });
    stripeCustomerId = customer.id;
    await userRef.set({ stripeCustomerId }, { merge: true });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: stripeCustomerId,
    client_reference_id: uid,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 30,
      metadata: { uid, plan },
    },
    metadata: { uid, plan },
    success_url: "https://scilemyane-cell.github.io/gestimmo/dashboard.html?abonnement=succes",
    cancel_url: "https://scilemyane-cell.github.io/gestimmo/dashboard.html?abonnement=annule",
    allow_promotion_codes: true,
  });

  return { url: session.url };
});

// ── Créer une session du portail client Stripe (gérer/résilier l'abonnement) ──
exports.createPortalSession = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Connecte-toi d'abord.");
  }
  const uid = request.auth.uid;
  const userSnap = await db.collection("users").doc(uid).get();
  const stripeCustomerId = userSnap.exists ? userSnap.data().stripeCustomerId : null;
  if (!stripeCustomerId) {
    throw new HttpsError("failed-precondition", "Aucun abonnement Stripe associé à ce compte.");
  }
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: "https://scilemyane-cell.github.io/gestimmo/dashboard.html",
  });
  return { url: portalSession.url };
});

// ── Webhook Stripe : reçoit les événements et met à jour Firestore ─────────
exports.stripeWebhook = onRequest(
  { cors: false, rawBody: true },
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Signature webhook invalide:", err.message);
      res.status(400).send(`Webhook signature invalide: ${err.message}`);
      return;
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const uid = session.client_reference_id || session.metadata?.uid;
          const plan = session.metadata?.plan;
          if (uid) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            await db.collection("users").doc(uid).set(
              {
                stripeCustomerId: session.customer,
                subscription: {
                  status: subscription.status,
                  plan: plan || null,
                  priceId: subscription.items.data[0]?.price?.id || null,
                  stripeSubscriptionId: subscription.id,
                 currentPeriodEnd: subscription.current_period_end || null,
trialEnd: subscription.trial_end || null,
cancelAtPeriodEnd: subscription.cancel_at_period_end || null,
                },
              },
              { merge: true }
            );
          }
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.created": {
          const subscription = event.data.object;
          const uid = subscription.metadata?.uid;
          if (uid) {
            const plan = subscription.metadata?.plan || getPlanFromPriceId(subscription.items.data[0]?.price?.id);
            await db.collection("users").doc(uid).set(
              {
                subscription: {
                  status: subscription.status,
                  plan: plan || null,
                  priceId: subscription.items.data[0]?.price?.id || null,
                  stripeSubscriptionId: subscription.id,
                  currentPeriodEnd: subscription.current_period_end || null,
trialEnd: subscription.trial_end || null,
cancelAtPeriodEnd: subscription.cancel_at_period_end || null,
                },
              },
              { merge: true }
            );
          }
          break;
        }
        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const uid = subscription.metadata?.uid;
          if (uid) {
            await db.collection("users").doc(uid).set(
              {
                subscription: {
                  status: "canceled",
                  plan: null,
                  priceId: null,
                  stripeSubscriptionId: subscription.id,
            currentPeriodEnd: subscription.current_period_end || null,
                  cancelAtPeriodEnd: true,
                },
              },
              { merge: true }
            );
          }
          break;
        }
        default:
          // Événement non géré, on ignore silencieusement.
          break;
      }
      res.status(200).send("ok");
    } catch (err) {
      console.error("Erreur traitement webhook:", err);
      res.status(500).send("Erreur interne");
    }
  }
);
