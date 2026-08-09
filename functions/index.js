const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: "europe-west3", maxInstances: 10 });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// UID Firebase Auth personnel de Valentin (compte valentin.giliane@gmail.com) — sert à écrire
// automatiquement les encaissements Stripe dans son suivi "Micro-entreprise" privé, quel que
// soit l'utilisateur/abonné à l'origine du paiement. Ne JAMAIS écrire dans ce document pour
// un autre UID que celui-ci.
const NOVIMMO_ME_UID = "dFhEx33SAKfKvcRCUt1ZABTsLfv2";

// Fait le lien entre l'identifiant de tarif Stripe et le nom du palier Novimmo.
// Les valeurs viennent des secrets GitHub (PRICE_ESSENTIEL / PRICE_PRO / PRICE_EXPERT /
// PRICE_IA_ILLIMITEE), injectées dans functions/.env au moment du déploiement — jamais
// commitées dans le repo.
function getPlanFromPriceId(priceId) {
  const map = {
    [process.env.PRICE_ESSENTIEL]: "essentiel",
    [process.env.PRICE_PRO]: "pro",
    [process.env.PRICE_EXPERT]: "expert",
    [process.env.PRICE_IA_ILLIMITEE]: "ia_illimitee",
  };
  return map[priceId] || null;
}

// L'add-on "Lecture IA illimitée" est un abonnement séparé, cumulable avec n'importe quel
// palier principal — on ne veut donc jamais écraser le statut de l'abonnement principal
// avec celui de l'add-on (et inversement). Ce champ détermine dans quelle clé Firestore
// écrire selon le plan concerné.
function isAddon(plan) {
  return plan === "ia_illimitee";
}

// ── Enregistre automatiquement un encaissement Stripe réel dans le suivi Micro-entreprise ──
// Appelée uniquement sur "invoice.paid" (facture Stripe réellement encaissée — couvre aussi
// bien le premier paiement à la fin de l'essai gratuit que les renouvellements annuels).
// Dédoublonnage par id de facture Stripe (une facture ne peut jamais être ajoutée deux fois,
// même si Stripe retente l'envoi du webhook).
async function enregistrerEncaissementME(invoice) {
  if (!invoice.paid || !invoice.amount_paid) return; // rien de réellement encaissé, on ignore
  const meRef = db.collection("users").doc(NOVIMMO_ME_UID).collection("prive").doc("microentreprise");

  // Les métadonnées {uid, plan} sont posées sur l'abonnement (subscription_data.metadata),
  // pas systématiquement propagées sur la facture — on va donc les chercher sur l'abonnement.
  let uid = invoice.metadata?.uid || null;
  let plan = invoice.metadata?.plan || null;
  if ((!uid || !plan) && invoice.subscription) {
    try {
      const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
      uid = uid || subscription.metadata?.uid || null;
      plan = plan || subscription.metadata?.plan || getPlanFromPriceId(subscription.items.data[0]?.price?.id);
    } catch (e) {
      console.error("Impossible de récupérer l'abonnement pour la facture", invoice.id, e.message);
    }
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(meRef);
    const data = snap.exists ? snap.data() : {};
    const ca = Array.isArray(data.ca) ? data.ca : [];
    if (ca.some((c) => c.stripeInvoiceId === invoice.id)) return; // déjà enregistré, on ignore

    const dateEncaissement = invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    ca.push({
      id: "stripe_" + invoice.id,
      date: dateEncaissement,
      montant: invoice.amount_paid / 100,
      origine: "Abonnement Stripe" + (plan ? " — " + plan : "") + (uid ? " (uid " + uid.slice(0, 8) + "…)" : ""),
      stripeInvoiceId: invoice.id,
      auto: true, // ajouté automatiquement — distingue des lignes saisies à la main
    });
    tx.set(meRef, { ca }, { merge: true });
  });
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
      // L'add-on Lecture IA illimitée n'a pas d'essai gratuit (contrairement aux paliers
      // principaux) — c'est un complément payant dès le départ.
      ...(isAddon(plan) ? {} : { trial_period_days: 30 }),
      metadata: { uid, plan },
    },
    metadata: { uid, plan },
    success_url: "https://novimmo.immo/dashboard.html?abonnement=succes",
    cancel_url: "https://novimmo.immo/dashboard.html?abonnement=annule",
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
    return_url: "https://novimmo.immo/dashboard.html",
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
            const champ = isAddon(plan) ? "subscriptionAddonIA" : "subscription";
            await db.collection("users").doc(uid).set(
              {
                stripeCustomerId: session.customer,
                [champ]: {
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
            const champ = isAddon(plan) ? "subscriptionAddonIA" : "subscription";
            await db.collection("users").doc(uid).set(
              {
                [champ]: {
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
            const plan = subscription.metadata?.plan || getPlanFromPriceId(subscription.items.data[0]?.price?.id);
            const champ = isAddon(plan) ? "subscriptionAddonIA" : "subscription";
            await db.collection("users").doc(uid).set(
              {
                [champ]: {
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
        case "invoice.paid": {
          // Paiement réellement encaissé (premier paiement à la fin de l'essai gratuit, ou
          // renouvellement annuel) — alimente automatiquement le suivi Micro-entreprise.
          const invoice = event.data.object;
          await enregistrerEncaissementME(invoice);
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

// ── Envoyer un email via Resend (remplace Gmail pour l'OTP et le lien de signature) ──
// Accepte optionnellement UNE pièce jointe (pieceJointe: {filename, base64Data}) OU PLUSIEURS
// (piecesJointes: [{filename, base64Data}, ...] — ex: bail signé + DPE + état des risques
// ensemble), et un corps HTML (html) en plus du texte brut (corps) pour afficher un vrai
// bouton de signature plutôt qu'un lien brut.
exports.envoyerEmailResend = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Connexion requise.");
  }
  const { destinataire, sujet, corps, pieceJointe, piecesJointes, html } = request.data || {};
  if (!destinataire || !sujet || !corps) {
    throw new HttpsError("invalid-argument", "destinataire, sujet et corps sont requis.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destinataire)) {
    throw new HttpsError("invalid-argument", "Adresse email invalide.");
  }
  const body = {
    from: "Novimmo <no-reply@novimmo.immo>",
    to: [destinataire],
    subject: sujet,
    text: corps,
  };
  if (html) {
    body.html = html;
  }
  // Piste plusieurs pièces jointes si fourni, sinon retombe sur l'unique pieceJointe (rétro-
  // compatible avec les appels existants qui n'envoient qu'un seul fichier).
  const listePieces = Array.isArray(piecesJointes) && piecesJointes.length
    ? piecesJointes
    : (pieceJointe ? [pieceJointe] : []);
  const attachmentsValides = listePieces.filter((p) => p && p.filename && p.base64Data);
  if (attachmentsValides.length) {
    body.attachments = attachmentsValides.map((p) => ({ filename: p.filename, content: p.base64Data }));
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Resend API error:", errText);
      throw new HttpsError("internal", "Échec de l'envoi de l'email.");
    }
    return { ok: true };
  } catch (e) {
    console.error("envoyerEmailResend error:", e);
    throw new HttpsError("internal", "Échec de l'envoi de l'email.");
  }
});