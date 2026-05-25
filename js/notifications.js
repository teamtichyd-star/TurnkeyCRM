
// ─── TURNKEY CRM · NOTIFICATIONS ENGINE ───
// Shared across all pages via <script src="js/notifications.js">

const TIC_NOTIF = {

  // Write a notification to the assigned user's record in Firebase
  async send(db, toUserName, message, type, link) {
    if (!toUserName) return;
    try {
      // Find user doc by name
      const snap = await db.collection('users')
        .where('name', '==', toUserName).limit(1).get();
      if (snap.empty) return;
      const userDoc = snap.docs[0];
      const existing = userDoc.data().notifications || [];
      const notif = {
        id: Date.now().toString(),
        message,
        type,       // 'project' | 'task' | 'snag' | 'update'
        link: link || '',
        read: false,
        createdAt: new Date().toISOString()
      };
      existing.unshift(notif);
      // Keep max 50 notifications
      const trimmed = existing.slice(0, 50);
      await db.collection('users').doc(userDoc.id)
        .update({ notifications: trimmed });
    } catch(e) {
      console.warn('Notification send failed:', e);
    }
  },

  // Load notifications for current user and render bell
  async loadBell(db, currentUserName) {
    if (!currentUserName) return;
    try {
      const snap = await db.collection('users')
        .where('name', '==', currentUserName).limit(1).get();
      if (snap.empty) return;
      const data = snap.docs[0].data();
      const notifs = data.notifications || [];
      const unread = notifs.filter(n => !n.read).length;
      TIC_NOTIF._renderBell(unread, notifs, db, snap.docs[0].id);
    } catch(e) {
      console.warn('Notification load failed:', e);
    }
  },

  _renderBell(unreadCount, notifs, db, userDocId) {
    const bellBtn = document.getElementById('notif-bell-btn');
    const badge   = document.getElementById('notif-badge');
    const dropdown = document.getElementById('notif-dropdown');
    if (!bellBtn) return;

    // Badge
    if (badge) {
      badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
      badge.style.display = unreadCount > 0 ? 'flex' : 'none';
    }

    // Dropdown content
    if (dropdown) {
      if (notifs.length === 0) {
        dropdown.querySelector('.notif-list').innerHTML =
          '<div class="notif-empty"><i class="fas fa-bell-slash"></i><p>No notifications yet</p></div>';
      } else {
        dropdown.querySelector('.notif-list').innerHTML = notifs.slice(0, 20).map(n => {
          const icons = {
            project: '🏗️', task: '✅', snag: '⚠️',
            update: '📸', lead: '👤', followup: '📞'
          };
          const timeAgo = TIC_NOTIF._timeAgo(n.createdAt);
          return `
            <div class="notif-item ${n.read ? 'read' : 'unread'}" data-id="${n.id}">
              <div class="notif-icon">${icons[n.type] || '🔔'}</div>
              <div class="notif-content">
                <div class="notif-msg">${n.message}</div>
                <div class="notif-time">${timeAgo}</div>
              </div>
              ${!n.read ? '<div class="notif-dot"></div>' : ''}
            </div>`;
        }).join('');
      }
    }

    // Mark all read on open
    bellBtn.onclick = async (e) => {
      e.stopPropagation();
      const dd = document.getElementById('notif-dropdown');
      const isOpen = dd.classList.contains('open');
      dd.classList.toggle('open');
      if (!isOpen && unreadCount > 0) {
        // Mark all as read
        const updated = notifs.map(n => ({ ...n, read: true }));
        try {
          await db.collection('users').doc(userDocId)
            .update({ notifications: updated });
          if (badge) badge.style.display = 'none';
          document.querySelectorAll('.notif-item.unread').forEach(el => {
            el.classList.remove('unread');
            el.classList.add('read');
            const dot = el.querySelector('.notif-dot');
            if (dot) dot.remove();
          });
        } catch(e) {}
      }
    };

    // Close on outside click
    document.addEventListener('click', (e) => {
      const dd = document.getElementById('notif-dropdown');
      if (dd && !dd.contains(e.target) && e.target !== bellBtn) {
        dd.classList.remove('open');
      }
    });
  },

  _timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }
};
