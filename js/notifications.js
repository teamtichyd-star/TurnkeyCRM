// ─── TURNKEY CRM · NOTIFICATIONS ENGINE ───
// Shared across all pages via <script src="js/notifications.js">

const TIC_NOTIF = {

  async send(db, toUserName, message, type, link) {
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
        update: '📸', lead: '👤', followup: '📞'
      };
      const icon = icons[type] || '🔔';
      const title = icon + ' ' + (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Notification');

      // Save to Firestore (in-app bell + triggers web push via FCM token)
      await db.collection('notifications').add({
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

      // Trigger local web push if recipient has token & is online
      if (userData.fcmToken) {
        // Note: real push needs cloud function; for now show local notification if same user
        if (typeof currentUser !== 'undefined' && currentUser?.email === userEmail) {
          TIC_NOTIF.showLocalNotification(title, message, link);
        }
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
        icon: 'https://teamtichyd-star.github.io/TurnkeyCRM/icon-192.png',
        badge: 'https://teamtichyd-star.github.io/TurnkeyCRM/icon-192.png',
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
