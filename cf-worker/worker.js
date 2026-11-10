// TIC Worker — handles both:
//   1. WhatsApp Cloud API webhook (GET verify / POST inbound messages) — unchanged from before
//   2. /send-push — sends a OneSignal push on behalf of TurnkeyCRM (env.ONESIGNAL_API_KEY)

const VERIFY_TOKEN = "TIC_WA_SECRET_2026";
const FIREBASE_PROJECT_ID = "turnkeycrm-ce7b8";
const FIREBASE_API_KEY = "AIzaSyBLQhUZA-VN4_A9FhQWmlRSQZC2D95KoE8";

const PUSH_ALLOWED_ORIGIN = "https://crm.turnkeyinteriorcontractors.com";
const ONESIGNAL_APP_ID = "9bc49e74-801f-4ffb-ab7e-ea78ba2f1089";
const META_APP_ID = "27765675376376657";

async function handleSendPush(request, env) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": PUSH_ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { playerId, title, message, url: linkUrl } = body;
  if (!playerId) {
    return new Response(JSON.stringify({ error: "playerId required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const osResponse = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Key ${env.ONESIGNAL_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      include_subscription_ids: [playerId],
      headings: { en: title || "Turnkey CRM" },
      contents: { en: message || "You have a new update." },
      url: linkUrl || `${PUSH_ALLOWED_ORIGIN}/`,
      priority: 10,
      chrome_web_icon: `${PUSH_ALLOWED_ORIGIN}/icon-192.png?v=4`,
      chrome_web_badge: `${PUSH_ALLOWED_ORIGIN}/icon-badge.png?v=4`,
    }),
  });

  const result = await osResponse.text();
  return new Response(result, {
    status: osResponse.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Google service-account auth (RS256 JWT -> OAuth2 access token) ───
// Used only to call the Identity Toolkit Admin API, scoped to the
// crm-auth-admin service account which has ONLY the Firebase Authentication
// Admin IAM role (no Firestore/Storage/etc access).
function base64url(input) {
  let bytes;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGoogleAccessToken(clientEmail, privateKeyPem, scope) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const signInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;

  const pemBody = privateKeyPem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const derBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    derBytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signInput)
  );
  const jwt = `${signInput}.${base64url(signature)}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error("Token exchange failed: " + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

// ─── Caller authorization ───
// Both /delete-user and /update-user can fully take over any account (reset
// password, change email, delete), so callers must prove they're a real,
// currently-logged-in CRM admin. The client sends its own Firebase ID token;
// we hand that to Identity Toolkit's own accounts:lookup (no service-account
// privilege needed for this call) which authoritatively verifies the token
// and returns the account it belongs to. We then check that email against
// env.ADMIN_EMAILS (comma-separated) -- this never trusts anything the
// client merely *claims*, only what Google's own lookup confirms.
async function verifyCallerIsAdmin(idToken, env) {
  if (!idToken) return { ok: false, error: "missing idToken" };
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json();
    const email = data.users?.[0]?.email;
    if (!email) return { ok: false, error: "invalid or expired idToken" };
    const adminEmails = (env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes(email.toLowerCase())) {
      return { ok: false, error: "not an admin" };
    }
    return { ok: true, email };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── /delete-user — deletes a Firebase Auth account by email ───
// The CRM's "Delete User" only removes the Firestore profile (client SDK
// can't delete other users' Auth accounts); this endpoint closes that gap
// so the email becomes free to re-register immediately.
async function handleDeleteUser(request, env) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": PUSH_ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { email, idToken } = body;
  if (!email) {
    return new Response(JSON.stringify({ error: "email required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const auth = await verifyCallerIsAdmin(idToken, env);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: "Unauthorized: " + auth.error }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const accessToken = await getGoogleAccessToken(
      env.FIREBASE_SA_CLIENT_EMAIL,
      env.FIREBASE_SA_PRIVATE_KEY,
      "https://www.googleapis.com/auth/identitytoolkit"
    );

    const lookupRes = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: [email] }),
    });
    const lookupData = await lookupRes.json();
    const user = lookupData.users?.[0];

    if (!user) {
      return new Response(JSON.stringify({ success: true, message: "No Auth account found for this email (already clean)" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const deleteRes = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:delete", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ localId: user.localId }),
    });

    if (!deleteRes.ok) {
      const errText = await deleteRes.text();
      return new Response(JSON.stringify({ success: false, error: errText }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, deletedUid: user.localId }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// ─── /revoke-drive — removes a departed user from every project Drive folder ───
// The browser can't be trusted to ask Drive directly (the Apps Script web app is
// public), so only a verified CRM admin can reach it here, and the Apps Script
// itself also demands a shared secret (env.DRIVE_REVOKE_SECRET) that never
// leaves this Worker.
const DRIVE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxdTuXOpGVg5XWFW64A1DR8OFGI7vcy-Q1XLLdx5Qjk2tT9ly91aph4zLLCgHp-0AiX1g/exec";
async function handleRevokeDrive(request, env) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": PUSH_ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON" }, 400); }
  const emails = (Array.isArray(body.emails) ? body.emails : []).map(e => String(e).trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+$/.test(e));
  if (!emails.length) return json({ error: "emails required" }, 400);

  const auth = await verifyCallerIsAdmin(body.idToken, env);
  if (!auth.ok) return json({ error: "Unauthorized: " + auth.error }, 403);
  if (!env.DRIVE_REVOKE_SECRET) return json({ success: false, error: "DRIVE_REVOKE_SECRET not configured on the Worker" }, 500);

  try {
    const res = await fetch(DRIVE_SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({ action: "revokeAccess", secret: env.DRIVE_REVOKE_SECRET, emails }),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = { success: false, error: "Drive script returned: " + text.slice(0, 120) }; }
    return json(data, data.success ? 200 : 502);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
}

// ─── /update-user — changes an existing user's Auth email and/or password ───
// Client SDK can only ever update the *currently signed-in* user's own
// credentials; an admin editing someone else's login needs this same
// service-account path as /delete-user. Firestore's users/{email} doc is
// migrated/updated separately by the caller after this succeeds.
async function handleUpdateUser(request, env) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": PUSH_ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { email, newEmail, newPassword, idToken } = body;
  if (!email) {
    return new Response(JSON.stringify({ error: "email required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!newEmail && !newPassword) {
    return new Response(JSON.stringify({ error: "newEmail or newPassword required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (newPassword && newPassword.length < 6) {
    return new Response(JSON.stringify({ error: "newPassword must be at least 6 characters" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const auth = await verifyCallerIsAdmin(idToken, env);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: "Unauthorized: " + auth.error }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const accessToken = await getGoogleAccessToken(
      env.FIREBASE_SA_CLIENT_EMAIL,
      env.FIREBASE_SA_PRIVATE_KEY,
      "https://www.googleapis.com/auth/identitytoolkit"
    );

    const lookupRes = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: [email] }),
    });
    const lookupData = await lookupRes.json();
    const user = lookupData.users?.[0];
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: "No Auth account found for " + email }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const updatePayload = { localId: user.localId, returnSecureToken: false };
    if (newEmail) { updatePayload.email = newEmail; updatePayload.emailVerified = true; }
    if (newPassword) { updatePayload.password = newPassword; }

    const updateRes = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:update", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(updatePayload),
    });
    const updateData = await updateRes.json();

    if (!updateRes.ok) {
      return new Response(JSON.stringify({ success: false, error: updateData.error?.message || JSON.stringify(updateData) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, uid: user.localId, email: newEmail || email }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// Produces a human-readable label for every WhatsApp message type Meta
// sends — previously only text/button replies were handled and everything
// else (documents, images, audio, video, location, interactive replies...)
// fell back to a generic "[non-text message]" placeholder.
function extractMessageText(msg) {
  switch (msg.type) {
    case "text":
      return msg.text?.body || "[empty message]";
    case "button":
      return msg.button?.text || "[button reply]";
    case "interactive":
      return msg.interactive?.button_reply?.title
        || msg.interactive?.list_reply?.title
        || "[interactive reply]";
    case "image":
      return "📷 Photo" + (msg.image?.caption ? ": " + msg.image.caption : "");
    case "video":
      return "🎥 Video" + (msg.video?.caption ? ": " + msg.video.caption : "");
    case "document":
      return "📄 Document: " + (msg.document?.filename || "file");
    case "audio":
      return msg.audio?.voice ? "🎤 Voice message" : "🎵 Audio";
    case "sticker":
      return "😀 Sticker";
    case "location":
      return "📍 Location shared" + (msg.location?.name ? ": " + msg.location.name : "");
    case "contacts":
      return "👤 Contact shared: " + (msg.contacts?.[0]?.name?.formatted_name || "contact");
    case "reaction":
      return msg.reaction?.emoji ? `Reacted ${msg.reaction.emoji}` : "[reaction]";
    case "unsupported":
      // WhatsApp itself couldn't identify the content type (e.g. polls,
      // newer message kinds the Business API doesn't relay) — Meta gives
      // no further detail than this in the webhook payload.
      return "⚠️ Unsupported message type (WhatsApp didn't share the content)";
    default:
      return `[unrecognized message type: ${msg.type}]`;
  }
}

const MEDIA_TYPES = ["image", "video", "document", "audio", "sticker"];
function extractMediaInfo(msg) {
  if (!MEDIA_TYPES.includes(msg.type)) return null;
  const m = msg[msg.type];
  if (!m?.id) return null;
  return { mediaId: m.id, mimeType: m.mime_type || "", filename: m.filename || "" };
}

// ─── /media/{mediaId} — proxies WhatsApp media (photos, documents, audio,
// video) so the CRM can display/download them. Meta's webhook media links
// are short-lived and require the access token to fetch, so the browser
// can't load them directly — this endpoint does the authenticated fetch
// server-side and streams the bytes back with a CORS header.
async function handleGetMedia(request, env, mediaId) {
  const corsHeaders = { "Access-Control-Allow-Origin": PUSH_ALLOWED_ORIGIN };

  if (!mediaId) {
    return new Response("mediaId required", { status: 400, headers: corsHeaders });
  }

  try {
    const lookupRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    });
    const lookupData = await lookupRes.json();
    if (!lookupData.url) {
      return new Response(JSON.stringify({ error: lookupData.error?.message || "Media not found or expired" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const mediaRes = await fetch(lookupData.url, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    });
    if (!mediaRes.ok) {
      return new Response("Failed to fetch media from WhatsApp", { status: 502, headers: corsHeaders });
    }

    return new Response(mediaRes.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": lookupData.mime_type || mediaRes.headers.get("content-type") || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// ─── /template-upload — proxies the Meta resumable upload API used for a
// WhatsApp template's header image. Meta's upload session endpoint doesn't
// send CORS headers, so the browser can't call it directly (fails as
// "Failed to fetch" on the preflight); this does both upload steps
// server-side and hands back just the resulting header handle.
async function handleTemplateUpload(request, env) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": PUSH_ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-File-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const fileType = request.headers.get("X-File-Type") || "application/octet-stream";
    const fileBytes = await request.arrayBuffer();

    const sessionRes = await fetch(
      `https://graph.facebook.com/v19.0/${META_APP_ID}/uploads?file_length=${fileBytes.byteLength}&file_type=${encodeURIComponent(fileType)}&access_token=${encodeURIComponent(env.WA_ACCESS_TOKEN)}`,
      { method: "POST" }
    );
    const sessionData = await sessionRes.json();
    if (!sessionData.id) {
      return new Response(JSON.stringify({ error: "Upload session failed: " + (sessionData.error?.message || JSON.stringify(sessionData)) }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const uploadRes = await fetch(`https://graph.facebook.com/v19.0/${sessionData.id}`, {
      method: "POST",
      headers: { Authorization: `OAuth ${env.WA_ACCESS_TOKEN}`, "file_offset": "0" },
      body: fileBytes,
    });
    const uploadData = await uploadRes.json();
    if (!uploadData.h) {
      return new Response(JSON.stringify({ error: "Upload finalize failed: " + (uploadData.error?.message || JSON.stringify(uploadData)) }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ handle: uploadData.h }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// ─── /media-upload — uploads an image via WhatsApp's regular (non-resumable)
// Media API, returning a media id that can be reused as a template's
// HEADER parameter when *sending* a message (separate from the resumable
// upload API used at template *creation* time, which only produces a
// one-time handle, not something you can reference later).
async function handleMediaUpload(request, env) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": PUSH_ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-File-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(request.url);
    const phoneNumberId = url.searchParams.get("phone_number_id");
    if (!phoneNumberId) {
      return new Response(JSON.stringify({ error: "phone_number_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const fileType = request.headers.get("X-File-Type") || "application/octet-stream";
    const fileBytes = await request.arrayBuffer();

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([fileBytes], { type: fileType }), "upload");

    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
      body: form,
    });
    const data = await res.json();
    if (!data.id) {
      return new Response(JSON.stringify({ error: "Media upload failed: " + (data.error?.message || JSON.stringify(data)) }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ mediaId: data.id }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

async function handleWhatsAppWebhook(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Verification failed", { status: 403 });
  }

  if (request.method === "POST") {
    try {
      const body = await request.json();
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      if (!value) return new Response("OK", { status: 200 });

      if (value.messages) {
        for (const msg of value.messages) {
          const contact = value.contacts?.[0];
          const media = extractMediaInfo(msg);
          const messageData = {
            fields: {
              from: { stringValue: msg.from },
              messageId: { stringValue: msg.id },
              type: { stringValue: msg.type },
              messageText: { stringValue: extractMessageText(msg) },
              contactName: { stringValue: contact?.profile?.name || "Unknown" },
              direction: { stringValue: "inbound" },
              status: { stringValue: "received" },
              timestamp: { stringValue: String(msg.timestamp) },
              createdAt: { stringValue: new Date().toISOString() },
              rawPayload: { stringValue: JSON.stringify(msg) },
              ...(media ? {
                mediaId: { stringValue: media.mediaId },
                mimeType: { stringValue: media.mimeType },
                filename: { stringValue: media.filename },
              } : {}),
            },
          };
          const r = await fetch(
            `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/whatsapp_messages?key=${FIREBASE_API_KEY}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(messageData) }
          );
          const result = await r.json();
          console.log("Firestore write:", JSON.stringify(result));

          // Push alert to CRM users tagged wa_alerts=1 (admins/managers), even when the CRM is closed.
          if (ctx) ctx.waitUntil(sendWaReplyPush(env, msg, contact).catch(e => console.log("WA push failed:", e.message)));
          else await sendWaReplyPush(env, msg, contact).catch(e => console.log("WA push failed:", e.message));
        }
      }

      if (value.statuses) {
        for (const status of value.statuses) {
          const statusData = {
            fields: {
              messageId: { stringValue: status.id },
              status: { stringValue: status.status },
              recipient: { stringValue: status.recipient_id },
              timestamp: { stringValue: String(status.timestamp) },
              statusUpdateAt: { stringValue: new Date().toISOString() },
              rawPayload: { stringValue: JSON.stringify(status) },
            },
          };
          await fetch(
            `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/whatsapp_status_updates?key=${FIREBASE_API_KEY}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(statusData) }
          );
        }
      }

      return new Response("OK", { status: 200 });
    } catch (e) {
      return new Response("Error: " + e.message, { status: 500 });
    }
  }

  return new Response("TIC WhatsApp Webhook - OK", { status: 200 });
}

// Push notification for every inbound WhatsApp message.
async function sendWaReplyPush(env, msg, contact) {
  if (!env.ONESIGNAL_API_KEY) return;
  const phone = String(msg.from || "");
  const name = contact?.profile?.name;
  const who = name ? `${name} (+${phone})` : `+${phone}`;
  let preview = extractMessageText(msg) || "";
  if (msg.type === "unsupported") preview = "Sent a message WhatsApp couldn't share – please call back";
  if (preview.length > 120) preview = preview.slice(0, 117) + "...";
  const res = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Key ${env.ONESIGNAL_API_KEY}` },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      filters: [{ field: "tag", key: "wa_alerts", relation: "=", value: "1" }],
      headings: { en: `💬 WhatsApp reply: ${who}` },
      contents: { en: preview || "New WhatsApp message" },
      url: `${PUSH_ALLOWED_ORIGIN}/index.html#whatsapp-inbox`,
      priority: 10,
      chrome_web_icon: `${PUSH_ALLOWED_ORIGIN}/icon-192.png?v=4`,
      chrome_web_badge: `${PUSH_ALLOWED_ORIGIN}/icon-badge.png?v=4`,
    }),
  });
  console.log("WA reply push:", res.status, await res.text());
}

// 9:00 AM IST attendance reminder (cron in wrangler.toml). Broadcasts to every
// subscribed device via OneSignal's segment -- no Firestore reads needed.
async function sendAttendanceReminder(env) {
  const res = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Key ${env.ONESIGNAL_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      included_segments: ["Subscribed Users"],
      headings: { en: "⏰ Mark your attendance" },
      contents: { en: "Good morning! Please mark today's attendance and fill yesterday's daily report." },
      url: `${PUSH_ALLOWED_ORIGIN}/index.html`,
      priority: 10,
      chrome_web_icon: `${PUSH_ALLOWED_ORIGIN}/icon-192.png?v=4`,
      chrome_web_badge: `${PUSH_ALLOWED_ORIGIN}/icon-badge.png?v=4`,
    }),
  });
  console.log("attendance reminder:", res.status, await res.text());
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendAttendanceReminder(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/send-push") {
      return handleSendPush(request, env);
    }
    if (url.pathname === "/delete-user") {
      return handleDeleteUser(request, env);
    }
    if (url.pathname === "/revoke-drive") {
      return handleRevokeDrive(request, env);
    }
    if (url.pathname === "/update-user") {
      return handleUpdateUser(request, env);
    }
    if (url.pathname === "/media") {
      return handleGetMedia(request, env, url.searchParams.get("id"));
    }
    if (url.pathname === "/template-upload") {
      return handleTemplateUpload(request, env);
    }
    if (url.pathname === "/media-upload") {
      return handleMediaUpload(request, env);
    }
    return handleWhatsAppWebhook(request, env, ctx);
  },
};
