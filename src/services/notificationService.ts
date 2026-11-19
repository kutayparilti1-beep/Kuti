import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';

export async function requestDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  return await Notification.requestPermission();
}

export function playSubtleNotificationTone() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.14);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
    setTimeout(() => {
      void ctx.close();
    }, 500);
  } catch {
    // Ignore audio context autoplay restrictions
  }
}

export async function dispatchNotification(params: {
  userId: string;
  userVerified: boolean;
  title: string;
  body: string;
  source: 'voice' | 'gmail' | 'calendar' | 'system';
}): Promise<string> {
  const safeTitle = params.title.slice(0, 120) || 'Vega Bildirimi';
  const safeBody = params.body.slice(0, 500) || 'Yeni bildirim.';
  const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(safeTitle, {
        body: safeBody,
        tag: notifId,
      });
    } catch {
      // Some browsers restrict Notification constructor in iframes
    }
  }

  playSubtleNotificationTone();

  if (params.userVerified) {
    const path = `users/${params.userId}/notifications/${notifId}`;
    try {
      await setDoc(doc(db, 'users', params.userId, 'notifications', notifId), {
        id: notifId,
        ownerId: params.userId,
        title: safeTitle,
        body: safeBody,
        source: params.source,
        read: false,
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  return notifId;
}
