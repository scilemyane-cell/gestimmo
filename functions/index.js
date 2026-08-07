
// ── Envoyer un email via Resend (remplace Gmail pour l'OTP et le lien de signature) ──
exports.envoyerEmailResend = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Connexion requise.");
  }
  const { destinataire, sujet, corps } = request.data || {};
  if (!destinataire || !sujet || !corps) {
    throw new HttpsError("invalid-argument", "destinataire, sujet et corps sont requis.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destinataire)) {
    throw new HttpsError("invalid-argument", "Adresse email invalide.");
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Novimmo <no-reply@novimmo.immo>",
        to: [destinataire],
        subject: sujet,
        text: corps,
      }),
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