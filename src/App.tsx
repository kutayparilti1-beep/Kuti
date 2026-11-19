import React, { useCallback, useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { LogOut } from 'lucide-react';
import { AdminPanel } from './components/AdminPanel';
import { AuthGate, EmailVerificationGate } from './components/AuthGate';
import { ConfirmationModal } from './components/ConfirmationModal';
import { FaceMemoryPanel } from './components/FaceMemoryPanel';
import { GeminiChatbot } from './components/GeminiChatbot';
import { VoiceOrbStage } from './components/VoiceOrbStage';
import { WorkspaceHub } from './components/WorkspaceHub';
import {
  auth,
  connectWorkspaceWithGoogle,
  db,
  getWorkspaceAccessToken,
  handleFirestoreError,
  isAdminUser,
  logoutUser,
  OperationType,
  subscribeToAuth,
  syncUserRegistry,
} from './firebase';
import { dispatchNotification } from './services/notificationService';
import {
  createCalendarEvent,
  fetchCalendarEvents,
  sendGmailMessage,
} from './services/workspaceService';
import {
  AppTab,
  AssistantTask,
  ChatMessage,
  KnownFace,
  LearnedMemory,
  PendingMutationAction,
  UserNotification,
} from './types';

function toMillis(ts?: { toMillis?: () => number }): number {
  return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [verifiedState, setVerifiedState] = useState(false);
  const [workspaceToken, setWorkspaceToken] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('voice');

  const [knownFaces, setKnownFaces] = useState<KnownFace[]>([]);
  const [memories, setMemories] = useState<LearnedMemory[]>([]);
  const [tasks, setTasks] = useState<AssistantTask[]>([]);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const [pendingMutation, setPendingMutation] = useState<PendingMutationAction | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const notifiedEventIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsub = subscribeToAuth((currentUser, token) => {
      setUser(currentUser);
      setVerifiedState(Boolean(currentUser?.emailVerified));
      setWorkspaceToken(token);
      setAuthReady(true);
      if (currentUser && currentUser.emailVerified) {
        void syncUserRegistry(currentUser);
      }
      if (!currentUser) {
        setKnownFaces([]);
        setMemories([]);
        setTasks([]);
        setNotifications([]);
        setChatMessages([]);
        setActiveTab('voice');
      }
    });
    return () => unsub();
  }, []);

  // Firestore real-time listeners (strictly attached only when authenticated & verified)
  useEffect(() => {
    if (!user || !verifiedState) return;

    const uid = user.uid;

    const facesPath = `users/${uid}/known_faces`;
    const unsubFaces = onSnapshot(
      query(collection(db, 'users', uid, 'known_faces'), where('ownerId', '==', uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as KnownFace)
          .sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt));
        setKnownFaces(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, facesPath)
    );

    const memoriesPath = `users/${uid}/memories`;
    const unsubMemories = onSnapshot(
      query(collection(db, 'users', uid, 'memories'), where('ownerId', '==', uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as LearnedMemory)
          .sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt));
        setMemories(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, memoriesPath)
    );

    const tasksPath = `users/${uid}/tasks`;
    const unsubTasks = onSnapshot(
      query(collection(db, 'users', uid, 'tasks'), where('ownerId', '==', uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as AssistantTask)
          .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
        setTasks(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, tasksPath)
    );

    const notifPath = `users/${uid}/notifications`;
    const unsubNotifs = onSnapshot(
      query(collection(db, 'users', uid, 'notifications'), where('ownerId', '==', uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as UserNotification)
          .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
        setNotifications(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, notifPath)
    );

    const chatPath = `users/${uid}/chat_messages`;
    const unsubChat = onSnapshot(
      query(collection(db, 'users', uid, 'chat_messages'), where('ownerId', '==', uid)),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as ChatMessage)
          .sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
        setChatMessages(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, chatPath)
    );

    return () => {
      unsubFaces();
      unsubMemories();
      unsubTasks();
      unsubNotifs();
      unsubChat();
    };
  }, [user, verifiedState]);

  // Proactive Calendar upcoming meeting alerts (every 2 minutes when Workspace connected)
  useEffect(() => {
    if (!user || !verifiedState || !workspaceToken) return;

    const checkUpcoming = async () => {
      try {
        const events = await fetchCalendarEvents(workspaceToken, 1, 5);
        const now = Date.now();
        for (const ev of events) {
          const startMs = new Date(ev.start).getTime();
          const diffMin = Math.round((startMs - now) / 60000);
          if (diffMin >= 0 && diffMin <= 15 && !notifiedEventIdsRef.current.has(ev.id)) {
            notifiedEventIdsRef.current.add(ev.id);
            await dispatchNotification({
              userId: user.uid,
              userVerified: verifiedState,
              title: `Yaklaşan Etkinlik (${diffMin} dk)`,
              body: ev.summary,
              source: 'calendar',
            });
          }
        }
      } catch {
        // Ignore silent background polling errors
      }
    };

    void checkUpcoming();
    const timer = window.setInterval(() => {
      void checkUpcoming();
    }, 120000);

    return () => window.clearInterval(timer);
  }, [user, verifiedState, workspaceToken]);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => {
      setToastMsg((prev) => (prev === msg ? null : prev));
    }, 4500);
  }, []);

  const handleConnectWorkspace = useCallback(async (): Promise<string | null> => {
    try {
      const token = await connectWorkspaceWithGoogle();
      setWorkspaceToken(token);
      if (token) {
        showToast('Google Workspace (Gmail, Takvim ve Drive) bağlandı.');
      }
      return token;
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Google Workspace bağlantısı kurulamadı.');
      return null;
    }
  }, [showToast]);

  const handleConfirmMutation = async () => {
    if (!pendingMutation || !user) return;
    const token = workspaceToken || getWorkspaceAccessToken();
    if (!token) {
      showToast('Google Workspace erişim belirteci bulunamadı. Lütfen yeniden bağlanın.');
      setPendingMutation(null);
      return;
    }

    try {
      if (pendingMutation.type === 'send_email') {
        await sendGmailMessage(
          token,
          pendingMutation.to,
          pendingMutation.subject,
          pendingMutation.body
        );
        await dispatchNotification({
          userId: user.uid,
          userVerified: verifiedState,
          title: 'E-posta Gönderildi',
          body: `${pendingMutation.to} adresine "${pendingMutation.subject}" iletildi.`,
          source: 'gmail',
        });
        showToast('E-posta başarıyla gönderildi.');
      } else {
        await createCalendarEvent(token, {
          summary: pendingMutation.summary,
          startIso: pendingMutation.startIso,
          endIso: pendingMutation.endIso,
          description: pendingMutation.description,
          location: pendingMutation.location,
        });
        await dispatchNotification({
          userId: user.uid,
          userVerified: verifiedState,
          title: 'Takvim Etkinliği Eklendi',
          body: pendingMutation.summary,
          source: 'calendar',
        });
        showToast('Takvim etkinliği oluşturuldu.');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'İşlem uygulanamadı.');
    } finally {
      setPendingMutation(null);
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-300 flex items-center justify-center">
        <p className="text-sm">Vega Asistan hazırlanıyor...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthGate
        onAuthSuccess={(signedInUser, token) => {
          setUser(signedInUser);
          setVerifiedState(Boolean(signedInUser.emailVerified));
          setWorkspaceToken(token);
        }}
      />
    );
  }

  if (!verifiedState) {
    return (
      <EmailVerificationGate
        user={user}
        onVerified={(verifiedUser) => {
          setUser(auth.currentUser ?? verifiedUser);
          setVerifiedState(Boolean(verifiedUser.emailVerified));
        }}
      />
    );
  }

  const adminVisible = isAdminUser(user);

  // Guard if non-admin somehow had admin tab selected
  const effectiveTab: AppTab = activeTab === 'admin' && !adminVisible ? 'voice' : activeTab;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="border-b border-neutral-800/90 bg-neutral-950/90 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Wordmark */}
          <span className="font-display text-lg font-semibold tracking-tight text-white whitespace-nowrap shrink-0">
            Vega Asistan
          </span>

          {/* Zone 2: Clean Text Navigation Links */}
          <nav className="flex items-center gap-6 overflow-x-auto">
            <button
              type="button"
              onClick={() => setActiveTab('voice')}
              className={`py-5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                effectiveTab === 'voice'
                  ? 'border-amber-500 text-white'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              Sesli Asistan
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={`py-5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                effectiveTab === 'chat'
                  ? 'border-amber-500 text-white'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              Sohbet
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('memory')}
              className={`py-5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                effectiveTab === 'memory'
                  ? 'border-amber-500 text-white'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              Yüz &amp; Bellek
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('workspace')}
              className={`py-5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                effectiveTab === 'workspace'
                  ? 'border-amber-500 text-white'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              Workspace &amp; İş
            </button>
            {adminVisible && (
              <button
                type="button"
                onClick={() => setActiveTab('admin')}
                className={`py-5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  effectiveTab === 'admin'
                    ? 'border-amber-500 text-white'
                    : 'border-transparent text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Yönetici
              </button>
            )}
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => void logoutUser()}
              className="h-9 px-3.5 inline-flex items-center gap-2 text-xs font-medium text-neutral-200 bg-neutral-900 border border-neutral-800 rounded-lg hover:border-neutral-700 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
              Çıkış Yap
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
        {toastMsg && (
          <div className="mb-6 p-3.5 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-lg">
            {toastMsg}
          </div>
        )}

        {effectiveTab === 'voice' && (
          <VoiceOrbStage
            user={user}
            knownFaces={knownFaces}
            memories={memories}
            workspaceToken={workspaceToken}
            onConnectWorkspace={handleConnectWorkspace}
            onProposeMutation={setPendingMutation}
          />
        )}

        {effectiveTab === 'chat' && (
          <GeminiChatbot
            user={user}
            messages={chatMessages}
            knownFaces={knownFaces}
            memories={memories}
          />
        )}

        {effectiveTab === 'memory' && (
          <FaceMemoryPanel user={user} knownFaces={knownFaces} memories={memories} />
        )}

        {effectiveTab === 'workspace' && (
          <WorkspaceHub
            user={user}
            workspaceToken={workspaceToken}
            memories={memories}
            tasks={tasks}
            notifications={notifications}
            onConnectWorkspace={handleConnectWorkspace}
            onProposeMutation={setPendingMutation}
          />
        )}

        {effectiveTab === 'admin' && adminVisible && (
          <AdminPanel adminEmail={user.email || ''} />
        )}
      </main>

      <ConfirmationModal
        action={pendingMutation}
        onConfirm={handleConfirmMutation}
        onCancel={() => setPendingMutation(null)}
      />
    </div>
  );
}
