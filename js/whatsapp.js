// TIC CRM - WhatsApp Module
// Sends messages via Meta WhatsApp Business Cloud API
// All credentials loaded from Firestore: settings/integrations.whatsapp

window.TIC_WA = (function() {
  let waConfig = null;
  let lastSendTime = 0;
  const RATE_LIMIT_MS = 3000; // Min 3 sec between sends

  async function loadConfig() {
    if (waConfig) return waConfig;
    try {
      const doc = await firebase.firestore().collection('settings').doc('integrations').get();
      if (doc.exists && doc.data().whatsapp && doc.data().whatsapp.accessToken) {
        waConfig = doc.data().whatsapp;
        return waConfig;
      }
    } catch(e) {
      console.error("WhatsApp config load failed:", e.message);
    }
    return null;
  }

  function normalizePhone(phone) {
    if (!phone) return null;
    let p = String(phone).replace(/[^0-9]/g, '');
    if (p.length === 10) p = '91' + p; // Indian numbers
    if (p.startsWith('0')) p = '91' + p.substring(1);
    return p;
  }

  async function logMessage(data) {
    try {
      await firebase.firestore().collection('whatsapp_messages').add({
        ...data,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt: new Date().toISOString()
      });
    } catch(e) {
      console.error("WA log failed:", e);
    }
  }

  async function sendText(toPhone, messageText, leadId, leadName) {
    const now = Date.now();
    if (now - lastSendTime < RATE_LIMIT_MS) {
      throw new Error(`Please wait ${Math.ceil((RATE_LIMIT_MS - (now - lastSendTime))/1000)}s before next send`);
    }

    const config = await loadConfig();
    if (!config) throw new Error("WhatsApp not configured. Contact admin.");

    const to = normalizePhone(toPhone);
    if (!to) throw new Error("Invalid phone number");

    lastSendTime = now;

    const url = `https://graph.facebook.com/${config.apiVersion || 'v25.0'}/${config.phoneNumberId}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: messageText }
      })
    });

    const result = await response.json();

    await logMessage({
      leadId: leadId || null,
      leadName: leadName || null,
      to: to,
      messageText: messageText,
      type: 'text',
      direction: 'outbound',
      status: result.messages ? 'sent' : 'failed',
      messageId: result.messages ? result.messages[0].id : null,
      errorCode: result.error ? result.error.code : null,
      errorMessage: result.error ? result.error.message : null,
      sentBy: firebase.auth().currentUser ? firebase.auth().currentUser.email : 'unknown',
      apiResponse: result
    });

    if (result.error) {
      const err = result.error;
      let userMessage = err.message;
      if (err.code === 131047) userMessage = "24-hour window expired. Recipient must message you first, or use a template.";
      if (err.code === 131051) userMessage = "Unsupported message type.";
      if (err.code === 131026) userMessage = "Message failed to send. Number may not be on WhatsApp.";
      if (err.code === 190) userMessage = "Access token expired. Contact admin.";
      throw new Error(userMessage);
    }

    return result;
  }

  async function getMessagesForLead(leadId) {
    try {
      const snap = await firebase.firestore().collection('whatsapp_messages')
        .where('leadId', '==', leadId).get();
      const messages = [];
      snap.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
      messages.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return messages;
    } catch(e) {
      console.error("Fetch WA history failed:", e);
      return [];
    }
  }

  return {
    loadConfig,
    normalizePhone,
    sendText,
    getMessagesForLead
  };
})();
