// ─── TURNKEY CRM · NOTIFICATIONS ENGINE ───
// Shared across all pages via <script src="js/notifications.js">

// Cloudflare Worker holds the OneSignal REST API key server-side (browsers
// can never call OneSignal's send API directly — see cf-worker/worker.js).
const PUSH_WORKER_URL = 'https://orange-sea-e881.teamtic-hyd.workers.dev/send-push';

const TIC_NOTIF = {

  // dedupeId (optional): pass a stable, deterministic id (e.g. derived from
  // the source event's own doc id) when the same event could be observed by
  // more than one independent listener at once -- e.g. the same user with
  // two tabs open, each running its own onSnapshot watcher. Without it,
  // each observer calls .add() and creates its own duplicate notification;
  // with it, every observer writes the *same* document id, so no matter how
  // many tabs see the event, exactly one notification survives.
  async send(db, toUserName, message, type, link, dedupeId) {
    if (!toUserName || !db) return;
    try {
      const userSnap = await db.collection('users')
        .where('name', '==', toUserName).limit(1).get();

      if (userSnap.empty) {
        console.warn('TIC_NOTIF: user not found:', toUserName);
        return;
      }

      const userData = userSnap.docs[0].data();
      const userEmail = userData.email;

      if (!userEmail) {
        console.warn('TIC_NOTIF: user has no email:', toUserName);
        return;
      }

      const icons = {
        project: '🏗️', task: '✅', snag: '⚠️',
        update: '📸', lead: '👤', followup: '📞', attendance: '📅', staff: '👤'
      };
      const icon = icons[type] || '🔔';
      const title = icon + ' ' + (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Notification');

      // Save to Firestore (in-app bell + triggers web push via FCM token)
      const notifRef = dedupeId ? db.collection('notifications').doc(dedupeId) : db.collection('notifications').doc();
      await notifRef.set({
        to: userEmail,
        toName: toUserName,
        title: title,
        body: message,
        type: type || 'general',
        link: link || '',
        read: false,
        createdAt: new Date().toISOString()
      });

      console.log('✅ Notification sent to', toUserName);

      // Show a local popup immediately if the recipient is the current tab
      if (typeof currentUser !== 'undefined' && currentUser?.email === userEmail) {
        TIC_NOTIF.showLocalNotification(title, message, link);
      }

      // Real push (works even when their tab/browser is closed), via the
      // OneSignal subscription ID saved when they clicked "Enable Notifications"
      if (userData.osPlayerId) {
        fetch(PUSH_WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId: userData.osPlayerId,
            title: title,
            message: message,
            url: link ? ('https://crm.turnkeyinteriorcontractors.com/' + link) : undefined
          })
        }).catch(e => console.warn('Push webhook failed:', e.message));
      }

      // Auto-refresh bell
      try {
        if (typeof listenNotifications === 'function') listenNotifications(userEmail);
        if (window.parent && window.parent.listenNotifications) window.parent.listenNotifications(userEmail);
      } catch(e) {}
    } catch(e) {
      console.warn('TIC_NOTIF send failed:', e);
    }
  },

  // Show OS-level notification (works when tab open/background)
  showLocalNotification(title, body, link) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, {
        body: body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'tic-' + Date.now(),
        requireInteraction: false
      });
      n.onclick = () => {
        window.focus();
        if (link) window.location.href = link;
        n.close();
      };
    } catch(e) { console.warn('Local notification failed:', e); }
  },

  // Request notification permission
  async requestPermission() {
    if (!('Notification' in window)) {
      alert('Your browser does not support notifications');
      return false;
    }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') {
      alert('Notifications blocked. Please enable in browser settings.');
      return false;
    }
    const result = await Notification.requestPermission();
    return result === 'granted';
  }
};

// ─── WhatsApp reply alert ───
// Raises a bell notification when a customer replies on WhatsApp -- but
// only if we sent *them* a template/campaign message in the last 72 hours;
// an old lead texting in on their own doesn't fire the bell. Notifies
// whoever the matching lead is assigned to, or "info" (admin) if no
// assignment is found.
//
// Scoped to the 20 most-recent inbound messages (not the whole
// whatsapp_messages collection) so this can't become the same kind of
// read-amplification problem the leads.html listener was.
//
// This file is loaded on leads/projects/tasks/index, so several pages/tabs
// can each be running their own independent copy of this listener at once
// (e.g. one person with Leads open in one tab and the Dashboard in
// another). Every copy observes the same new message, so every copy would
// otherwise create its own duplicate notification -- send() is called here
// with a dedupeId derived from the source message's own doc id, so no
// matter how many tabs see it, exactly one notification survives.
//
// There's no free-tier-safe way to run this as a true always-on server job
// (see the Firestore billing/quota constraints already hit when a Cloud
// Function / Worker cron approach was tried for a similar always-on check).
(function() {
  let waAlertArmed = false;
  setTimeout(() => { waAlertArmed = true; }, 3000);
  const CAMPAIGN_WINDOW_MS = 72 * 60 * 60 * 1000;

  async function wasSentCampaignRecently(db, phoneFull) {
    if (!phoneFull) return false;
    const cutoff = new Date(Date.now() - CAMPAIGN_WINDOW_MS).toISOString();
    const snap = await db.collection('whatsapp_messages')
      .where('to', '==', phoneFull)
      .where('direction', '==', 'outbound')
      .where('type', '==', 'template')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return false;
    return snap.docs[0].data().createdAt >= cutoff;
  }

  firebase.auth().onAuthStateChanged(function(user) {
    if (!user) return;
    const db = firebase.firestore();
    db.collection('whatsapp_messages')
      .where('direction', '==', 'inbound')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
          if (change.type !== 'added' || !waAlertArmed) return;
          const msg = change.doc.data();
          try {
            const phoneFull = (msg.from || '').replace(/[^0-9]/g, '');
            // Alert on every inbound reply (campaign or not).

            const phone10 = phoneFull.slice(-10);
            let recipient = 'info';
            if (phone10) {
              const leadSnap = await db.collection('leads').where('phone', '==', phone10).limit(1).get();
              if (!leadSnap.empty) {
                const assignedTo = (leadSnap.docs[0].data().assignedTo || '').trim();
                if (assignedTo) recipient = assignedTo;
              }
            }
            const senderLabel = (msg.contactName && msg.contactName !== 'Unknown') ? msg.contactName : ('+' + phone10);
            await TIC_NOTIF.send(db, recipient, '💬 New WhatsApp reply from ' + senderLabel, 'lead', 'whatsapp-inbox.html', 'wa-reply-' + change.doc.id);
          } catch (e) { console.warn('WA reply alert failed:', e); }
        });
      }, e => console.warn('WA reply listener failed:', e));
  });
})();
