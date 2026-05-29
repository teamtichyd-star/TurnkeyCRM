// ─── TURNKEY CRM · NOTIFICATIONS ENGINE ───
// Shared across all pages via <script src="js/notifications.js">
// Writes to 'notifications' collection (matches index.html bell reader)
// Also sends to Telegram if user has telegramChatId

const TELEGRAM_BOT_TOKEN = '8924563406:AAHBxnGEHMb08bSXha_K1F-UZtFqZqNr3AA';
const TELEGRAM_BOT_USERNAME = 'TurnkeyCRM_Alerts_Bot';

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
      const telegramChatId = userData.telegramChatId;

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

      console.log('✅ In-app notification sent to', toUserName);

      if (telegramChatId) {
        await TIC_NOTIF.sendTelegram(telegramChatId, title + '\n\n' + message, link);
      }

      try {
        if (typeof listenNotifications === 'function') listenNotifications(userEmail);
        if (window.parent && window.parent.listenNotifications) window.parent.listenNotifications(userEmail);
      } catch(e) {}
    } catch(e) {
      console.warn('TIC_NOTIF send failed:', e);
    }
  },

  async sendTelegram(chatId, text, link) {
    try {
      const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
      const body = {
        chat_id: chatId,
        text: text + (link ? '\n\n🔗 https://teamtichyd-star.github.io/TurnkeyCRM/' + link : ''),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) console.log('📱 Telegram sent to', chatId);
      else console.warn('Telegram failed:', await res.text());
    } catch(e) {
      console.warn('Telegram send error:', e);
    }
  },

  async generateTelegramCode(db, userEmail) {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await db.collection('telegram_codes').doc(code).set({
      email: userEmail,
      createdAt: new Date().toISOString(),
      used: false
    });
    return {
      code: code,
      link: 'https://t.me/' + TELEGRAM_BOT_USERNAME + '?start=' + code
    };
  },

  async verifyTelegramCode(db, userEmail, code) {
    const doc = await db.collection('telegram_codes').doc(code.toUpperCase()).get();
    if (!doc.exists) return { success: false, error: 'Invalid code' };
    const data = doc.data();
    if (data.email !== userEmail) return { success: false, error: 'Code belongs to different user' };
    if (!data.chatId) return { success: false, error: 'Please click START in the bot first' };

    const userSnap = await db.collection('users').where('email','==',userEmail).limit(1).get();
    if (userSnap.empty) return { success: false, error: 'User not found' };
    await db.collection('users').doc(userSnap.docs[0].id).update({
      telegramChatId: data.chatId,
      telegramActivatedAt: new Date().toISOString()
    });

    await TIC_NOTIF.sendTelegram(data.chatId,
      '✅ <b>Telegram alerts activated!</b>\n\nYou will now receive instant notifications from TurnkeyCRM.', '');

    return { success: true };
  }
};
