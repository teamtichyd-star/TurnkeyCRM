// ─── TURNKEY CRM · NOTIFICATIONS ENGINE ───
// Shared across all pages via <script src="js/notifications.js">
// Writes to 'notifications' collection (matches index.html bell reader)

const TIC_NOTIF = {

  // ─── SEND NOTIFICATION ───
  // Called as: TIC_NOTIF.send(db, userName, message, type, link)
  // Auto-resolves userName → email, writes to 'notifications' collection
  async send(db, toUserName, message, type, link) {
    if (!toUserName || !db) return;
    try {
      // Step 1: Find user's email by name
      const userSnap = await db.collection('users')
        .where('name', '==', toUserName).limit(1).get();

      if (userSnap.empty) {
        console.warn('TIC_NOTIF: user not found:', toUserName);
        return;
      }

      const userEmail = userSnap.docs[0].data().email;
      if (!userEmail) {
        console.warn('TIC_NOTIF: user has no email:', toUserName);
        return;
      }

      // Step 2: Write to notifications collection (where bell reads from)
      const icons = {
        project: '🏗️',
        task: '✅',
        snag: '⚠️',
        update: '📸',
        lead: '👤',
        followup: '📞'
      };
      const icon = icons[type] || '🔔';

      await db.collection('notifications').add({
        to: userEmail,
        toName: toUserName,
        title: icon + ' ' + (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Notification'),
        body: message,
        type: type || 'general',
        link: link || '',
        read: false,
        createdAt: new Date().toISOString()
      });

      console.log('✅ Notification sent to', toUserName, '(' + userEmail + ')');
      try { if (typeof listenNotifications === 'function') listenNotifications(userEmail); if (window.parent && window.parent.listenNotifications) window.parent.listenNotifications(userEmail); } catch(e) {}
    } catch(e) {
      console.warn('TIC_NOTIF send failed:', e);
    }
  },

  // ─── SEND TO ALL USERS ───
  async sendToAll(db, message, type, link) {
    if (!db) return;
    try {
      const usersSnap = await db.collection('users').get();
      const batch = db.batch();
      const icons = {
        project: '🏗️', task: '✅', snag: '⚠️',
        update: '📸', lead: '👤', followup: '📞'
      };
      const icon = icons[type] || '🔔';

      usersSnap.docs.forEach(userDoc => {
        const userData = userDoc.data();
        if (!userData.email) return;
        const notifRef = db.collection('notifications').doc();
        batch.set(notifRef, {
          to: userData.email,
          toName: userData.name || '',
          title: icon + ' ' + (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Notification'),
          body: message,
          type: type || 'general',
          link: link || '',
          read: false,
          createdAt: new Date().toISOString()
        });
      });
      await batch.commit();
      console.log('✅ Notification sent to all users');
    } catch(e) {
      console.warn('TIC_NOTIF sendToAll failed:', e);
    }
  },

  // ─── REFRESH BELL COUNT (optional helper) ───
  // Call from any page after sending a notification to update bell immediately
  async refreshBell(db, userEmail) {
    if (!db || !userEmail) return;
    try {
      const snap = await db.collection('notifications')
        .where('to', '==', userEmail)
        .where('read', '==', false).get();
      const count = snap.size;
      const badge = document.getElementById('notifCount');
      const bell = document.getElementById('bellIcon');
      if (badge) {
        if (count > 0) {
          badge.textContent = count;
          badge.style.display = 'flex';
          if (bell) bell.style.color = 'var(--primary)';
        } else {
          badge.style.display = 'none';
          if (bell) bell.style.color = 'var(--subtext)';
        }
      }
    } catch(e) {
      console.warn('TIC_NOTIF refreshBell failed:', e);
    }
  }
};