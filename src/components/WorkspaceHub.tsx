import React, { useCallback, useEffect, useState } from 'react';
import { User } from 'firebase/auth';
import { deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  Bell,
  Calendar,
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  Mail,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  dispatchNotification,
  requestDesktopNotificationPermission,
} from '../services/notificationService';
import {
  fetchCalendarEvents,
  fetchDriveFiles,
  fetchGmailMessages,
} from '../services/workspaceService';
import {
  AssistantTask,
  CalendarEventSummary,
  DriveFileSummary,
  GmailMessageSummary,
  LearnedMemory,
  PendingMutationAction,
  UserNotification,
} from '../types';

interface WorkspaceHubProps {
  user: User;
  workspaceToken: string | null;
  memories: LearnedMemory[];
  tasks: AssistantTask[];
  notifications: UserNotification[];
  onConnectWorkspace: () => Promise<string | null>;
  onProposeMutation: (action: PendingMutationAction) => void;
}

export const WorkspaceHub: React.FC<WorkspaceHubProps> = ({
  user,
  workspaceToken,
  memories,
  tasks,
  notifications,
  onConnectWorkspace,
  onProposeMutation,
}) => {
  const [emails, setEmails] = useState<GmailMessageSummary[]>([]);
  const [events, setEvents] = useState<CalendarEventSummary[]>([]);
  const [files, setFiles] = useState<DriveFileSummary[]>([]);
  const [loadingWs, setLoadingWs] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

  const [briefingBusy, setBriefingBusy] = useState(false);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    typeof window !== 'undefined' && 'Notification' in window
      ? Notification.permission
      : 'default'
  );

  // Quick manual compose triggers (still go through explicit ConfirmationModal!)
  const [composeEmailOpen, setComposeEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');

  const [composeEventOpen, setComposeEventOpen] = useState(false);
  const [eventTitle, setEventTitle] = useState('');
  const [eventStart, setEventStart] = useState('');
  const [eventEnd, setEventEnd] = useState('');

  const loadWorkspaceData = useCallback(async () => {
    if (!workspaceToken) return;
    setLoadingWs(true);
    setWsError(null);
    try {
      const [gmailList, calendarList, driveList] = await Promise.all([
        fetchGmailMessages(workspaceToken, '', 6),
        fetchCalendarEvents(workspaceToken, 5, 8),
        fetchDriveFiles(workspaceToken, '', 6),
      ]);

      // Run fast priority triage using gemini-3.1-flash-lite
      let enrichedEmails = gmailList;
      if (gmailList.length > 0) {
        try {
          const triageRes = await fetch('/api/ai/fast-triage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              emails: gmailList.map((e) => ({
                id: e.id,
                subject: e.subject,
                from: e.from,
                snippet: e.snippet,
              })),
            }),
          });
          if (triageRes.ok) {
            const triageData = (await triageRes.json()) as {
              items?: Array<{ id: string; priority: string; actionTip: string }>;
            };
            const map = new Map((triageData.items ?? []).map((i) => [i.id, i]));
            enrichedEmails = gmailList.map((e) => ({
              ...e,
              priority: map.get(e.id)?.priority,
              actionTip: map.get(e.id)?.actionTip,
            }));
          }
        } catch {
          // Non-fatal fast triage fallback
        }
      }

      setEmails(enrichedEmails);
      setEvents(calendarList);
      setFiles(driveList);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Google Workspace verileri alınamadı.';
      if (rawMsg.includes('(401)')) {
        setWsError(
          'Google Workspace oturum süresi doldu. Sağ üstteki "Google Workspace Bağla" butonuyla yeniden bağlanın.'
        );
      } else {
        setWsError(rawMsg);
      }
    } finally {
      setLoadingWs(false);
    }
  }, [workspaceToken]);

  useEffect(() => {
    void loadWorkspaceData();
  }, [loadWorkspaceData]);

  const handleEnableNotifications = async () => {
    const perm = await requestDesktopNotificationPermission();
    setNotifPerm(perm);
    if (perm === 'granted') {
      await dispatchNotification({
        userId: user.uid,
        userVerified: user.emailVerified,
        title: 'Vega Bildirimleri Aktif',
        body: 'Yaklaşan takvim toplantıları ve önemli e-postalar için bildirim alacaksınız.',
        source: 'system',
      });
    }
  };

  const handleSendTestNotification = async () => {
    await dispatchNotification({
      userId: user.uid,
      userVerified: user.emailVerified,
      title: 'Asistan Kontrol Bildirimi',
      body: `Merhaba ${user.email}, masaüstü bildirim sistemi çalışıyor.`,
      source: 'system',
    });
  };

  const handleGenerateBriefing = async () => {
    setBriefingBusy(true);
    setWsError(null);
    try {
      const res = await fetch('/api/ai/deep-think', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt:
            'Kullanıcının son e-postalarını, yaklaşan takvim etkinliklerini, Drive dosyalarını ve öğrenilmiş bellek tercihlerini analiz ederek kapsamlı bir günlük çalışma planı ve acil eylem önerileri hazırla.',
          memories: memories.map((m) => ({
            category: m.category,
            subject: m.subject,
            content: m.content,
          })),
          workspaceSnapshot: { emails, events, files },
        }),
      });
      const data = (await res.json()) as {
        title?: string;
        spokenSummary?: string;
        detailedPlan?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Brifing oluşturulamadı.');

      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const path = `users/${user.uid}/tasks/${taskId}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'tasks', taskId), {
          id: taskId,
          ownerId: user.uid,
          title: String(data.title || 'Günlük Akıllı Brifing').slice(0, 160),
          summary: String(data.detailedPlan || data.spokenSummary || '').slice(0, 4000),
          category: 'briefing',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }

      await dispatchNotification({
        userId: user.uid,
        userVerified: user.emailVerified,
        title: data.title || 'Günlük Brifing Hazır',
        body: data.spokenSummary || 'Yeni analiz görev panonuza eklendi.',
        source: 'system',
      });
    } catch (err) {
      setWsError(err instanceof Error ? err.message : 'Brifing üretilemedi.');
    } finally {
      setBriefingBusy(false);
    }
  };

  const handleCompleteTask = async (task: AssistantTask) => {
    if (task.status === 'completed') return;
    const path = `users/${user.uid}/tasks/${task.id}`;
    try {
      await updateDoc(doc(db, 'users', user.uid, 'tasks', task.id), {
        status: 'completed',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    const path = `users/${user.uid}/tasks/${taskId}`;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'tasks', taskId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  };

  const handleMarkNotifRead = async (notifId: string) => {
    const path = `users/${user.uid}/notifications/${notifId}`;
    try {
      await updateDoc(doc(db, 'users', user.uid, 'notifications', notifId), {
        read: true,
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  };

  const handleProposeEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailTo.trim() || !emailSubject.trim() || !emailBody.trim()) return;
    onProposeMutation({
      type: 'send_email',
      to: emailTo.trim(),
      subject: emailSubject.trim(),
      body: emailBody.trim(),
    });
    setComposeEmailOpen(false);
    setEmailTo('');
    setEmailSubject('');
    setEmailBody('');
  };

  const handleProposeEventSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!eventTitle.trim() || !eventStart || !eventEnd) return;
    onProposeMutation({
      type: 'create_event',
      summary: eventTitle.trim(),
      startIso: new Date(eventStart).toISOString(),
      endIso: new Date(eventEnd).toISOString(),
    });
    setComposeEventOpen(false);
    setEventTitle('');
    setEventStart('');
    setEventEnd('');
  };

  return (
    <div className="space-y-6">
      {/* Top Action Strip */}
      <div className="border border-neutral-800 bg-neutral-900/50 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-white">
            Google Workspace, İşler ve Bildirimler
          </h1>
          <p className="text-xs text-neutral-400 mt-1">
            {workspaceToken
              ? 'Gmail, Google Takvim ve Drive bağlı. Sesli asistanınız doğrudan işlem yapabilir.'
              : 'E-posta ve takvim kontrolü için Google Workspace hesabınızı bağlayın.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {!workspaceToken ? (
            <button
              type="button"
              onClick={() => void onConnectWorkspace()}
              className="h-10 px-4 text-xs font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 transition-colors cursor-pointer"
            >
              Google Workspace Bağla
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void loadWorkspaceData()}
                disabled={loadingWs}
                className="h-10 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium bg-neutral-800 text-neutral-200 rounded-lg hover:bg-neutral-700 transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingWs ? 'animate-spin' : ''}`} />
                Yenile
              </button>
              <button
                type="button"
                onClick={handleGenerateBriefing}
                disabled={briefingBusy}
                className="h-10 px-4 inline-flex items-center gap-1.5 text-xs font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 disabled:opacity-50 transition-colors cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                {briefingBusy ? 'Analiz Ediliyor...' : 'Günlük Akıllı Brifing Oluştur'}
              </button>
            </>
          )}

          {notifPerm !== 'granted' ? (
            <button
              type="button"
              onClick={handleEnableNotifications}
              className="h-10 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium border border-neutral-700 text-neutral-200 rounded-lg hover:border-amber-500 transition-colors cursor-pointer"
            >
              <Bell className="w-3.5 h-3.5" aria-hidden="true" />
              Bildirim İzni Ver
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSendTestNotification}
              className="h-10 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium border border-neutral-800 text-neutral-300 rounded-lg hover:border-neutral-700 transition-colors cursor-pointer"
            >
              <Bell className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              Bildirim Testi Gönder
            </button>
          )}
        </div>
      </div>

      {wsError && (
        <div className="p-3.5 text-xs text-red-200 bg-red-950/50 border border-red-900 rounded-lg">
          {wsError}
        </div>
      )}

      {/* Workspace 3-Column Live Panels */}
      <div className="grid lg:grid-cols-3 gap-6 items-start">
        {/* Gmail */}
        <section className="border border-neutral-800 bg-neutral-900/50 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <h2 className="font-display text-base font-semibold text-white">Gmail Gelen Kutusu</h2>
            </div>
            {workspaceToken && (
              <button
                type="button"
                onClick={() => setComposeEmailOpen((v) => !v)}
                className="text-xs text-amber-400 hover:text-amber-300 inline-flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                E-posta Yaz
              </button>
            )}
          </div>

          {composeEmailOpen && (
            <form onSubmit={handleProposeEmailSubmit} className="space-y-2 pb-3 border-b border-neutral-800">
              <input
                type="email"
                required
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="Alıcı e-posta"
                className="w-full h-9 px-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white"
              />
              <input
                type="text"
                required
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="Konu"
                className="w-full h-9 px-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white"
              />
              <textarea
                required
                rows={3}
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                placeholder="Mesajınız..."
                className="w-full p-2.5 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white"
              />
              <button
                type="submit"
                className="w-full h-9 text-xs font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 cursor-pointer"
              >
                Onay Penceresini Aç
              </button>
            </form>
          )}

          {!workspaceToken ? (
            <p className="text-xs text-neutral-500 py-4">Gmail verisi için Google Workspace bağlayın.</p>
          ) : loadingWs ? (
            <div className="space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-14 bg-neutral-800/50 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : emails.length === 0 ? (
            <p className="text-xs text-neutral-500 py-4">Gelen kutusunda ileti bulunamadı.</p>
          ) : (
            <div className="divide-y divide-neutral-800/70 max-h-80 overflow-y-auto">
              {emails.map((mail) => (
                <article key={mail.id} className="py-3 first:pt-0 last:pb-0 space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-neutral-400 truncate">{mail.from}</span>
                    {mail.priority && (
                      <span
                        className={`shrink-0 ${
                          mail.priority === 'yuksek'
                            ? 'text-red-400'
                            : mail.priority === 'orta'
                            ? 'text-amber-400'
                            : 'text-neutral-500'
                        }`}
                      >
                        {mail.priority === 'yuksek'
                          ? 'Öncelikli'
                          : mail.priority === 'orta'
                          ? 'Normal'
                          : 'Düşük'}
                      </span>
                    )}
                  </div>
                  <h3 className="text-xs font-semibold text-white truncate">{mail.subject}</h3>
                  <p className="text-xs text-neutral-400 line-clamp-2">{mail.snippet}</p>
                  {mail.actionTip && (
                    <p className="text-xs text-amber-300/90">{mail.actionTip}</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Calendar */}
        <section className="border border-neutral-800 bg-neutral-900/50 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <h2 className="font-display text-base font-semibold text-white">Google Takvim</h2>
            </div>
            {workspaceToken && (
              <button
                type="button"
                onClick={() => setComposeEventOpen((v) => !v)}
                className="text-xs text-amber-400 hover:text-amber-300 inline-flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Etkinlik Ekle
              </button>
            )}
          </div>

          {composeEventOpen && (
            <form onSubmit={handleProposeEventSubmit} className="space-y-2 pb-3 border-b border-neutral-800">
              <input
                type="text"
                required
                value={eventTitle}
                onChange={(e) => setEventTitle(e.target.value)}
                placeholder="Etkinlik adı"
                className="w-full h-9 px-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white"
              />
              <input
                type="datetime-local"
                required
                value={eventStart}
                onChange={(e) => setEventStart(e.target.value)}
                className="w-full h-9 px-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white"
              />
              <input
                type="datetime-local"
                required
                value={eventEnd}
                onChange={(e) => setEventEnd(e.target.value)}
                className="w-full h-9 px-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white"
              />
              <button
                type="submit"
                className="w-full h-9 text-xs font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 cursor-pointer"
              >
                Onay Penceresini Aç
              </button>
            </form>
          )}

          {!workspaceToken ? (
            <p className="text-xs text-neutral-500 py-4">Takvim için Google Workspace bağlayın.</p>
          ) : loadingWs ? (
            <div className="space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-14 bg-neutral-800/50 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <p className="text-xs text-neutral-500 py-4">Önümüzdeki 5 gün için etkinlik yok.</p>
          ) : (
            <div className="divide-y divide-neutral-800/70 max-h-80 overflow-y-auto">
              {events.map((ev) => (
                <article key={ev.id} className="py-3 first:pt-0 last:pb-0 space-y-1">
                  <h3 className="text-xs font-semibold text-white">{ev.summary}</h3>
                  <p className="text-xs font-mono-tabular text-amber-400">
                    {new Date(ev.start).toLocaleString('tr-TR', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </p>
                  {ev.location && <p className="text-xs text-neutral-400">{ev.location}</p>}
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Drive */}
        <section className="border border-neutral-800 bg-neutral-900/50 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <h2 className="font-display text-base font-semibold text-white">Google Drive</h2>
            </div>
            <span className="font-mono-tabular text-xs text-neutral-500">{files.length}</span>
          </div>

          {!workspaceToken ? (
            <p className="text-xs text-neutral-500 py-4">Drive dosyaları için Google Workspace bağlayın.</p>
          ) : loadingWs ? (
            <div className="space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-12 bg-neutral-800/50 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : files.length === 0 ? (
            <p className="text-xs text-neutral-500 py-4">Drive dosyası bulunamadı.</p>
          ) : (
            <div className="divide-y divide-neutral-800/70 max-h-80 overflow-y-auto">
              {files.map((file) => (
                <div
                  key={file.id}
                  className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-white truncate">{file.name}</p>
                    <p className="text-xs font-mono-tabular text-neutral-500 mt-0.5">
                      {new Date(file.modifiedTime).toLocaleDateString('tr-TR')}
                    </p>
                  </div>
                  {file.webViewLink && (
                    <a
                      href={file.webViewLink}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${file.name} dosyasını aç`}
                      className="p-1.5 text-neutral-400 hover:text-amber-400 shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Bottom Row: Deep Analysis Tasks & Notifications */}
      <div className="grid lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-7 border border-neutral-800 bg-neutral-900/50 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <h2 className="font-display text-base font-semibold text-white">
              Yapay Zeka Görevleri ve Derin Analizler
            </h2>
            <span className="font-mono-tabular text-xs text-neutral-500">{tasks.length}</span>
          </div>

          {tasks.length === 0 ? (
            <p className="text-xs text-neutral-500 py-4">
              Henüz oluşturulmuş görev yok. Sesli komutla iş isteyin veya &quot;Günlük Akıllı
              Brifing Oluştur&quot; butonuna basın.
            </p>
          ) : (
            <div className="divide-y divide-neutral-800/70 max-h-80 overflow-y-auto">
              {tasks.map((task) => (
                <article key={task.id} className="py-3.5 first:pt-0 last:pb-0 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-xs text-amber-400">
                        {task.status === 'completed' ? 'Tamamlandı' : 'Bekliyor'} · {task.category}
                      </span>
                      <h3 className="text-sm font-semibold text-white">{task.title}</h3>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {task.status === 'pending' && (
                        <button
                          type="button"
                          onClick={() => void handleCompleteTask(task)}
                          title="Tamamlandı olarak işaretle"
                          className="p-1.5 text-neutral-400 hover:text-emerald-400 cursor-pointer"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDeleteTask(task.id)}
                        title="Sil"
                        className="p-1.5 text-neutral-500 hover:text-red-400 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-neutral-300 whitespace-pre-wrap leading-relaxed">
                    {task.summary}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="lg:col-span-5 border border-neutral-800 bg-neutral-900/50 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <h2 className="font-display text-base font-semibold text-white">Bildirim Geçmişi</h2>
            <span className="font-mono-tabular text-xs text-neutral-500">
              {notifications.filter((n) => !n.read).length} okunmamış
            </span>
          </div>

          {notifications.length === 0 ? (
            <p className="text-xs text-neutral-500 py-4">Henüz gönderilmiş bildirim yok.</p>
          ) : (
            <div className="divide-y divide-neutral-800/70 max-h-80 overflow-y-auto">
              {notifications.map((n) => (
                <div
                  key={n.id}
                  onClick={() => !n.read && void handleMarkNotifRead(n.id)}
                  className={`py-3 first:pt-0 last:pb-0 space-y-1 ${
                    !n.read ? 'cursor-pointer' : 'opacity-70'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-white">{n.title}</span>
                    <span className="text-neutral-500">{n.read ? 'Okundu' : 'Yeni'}</span>
                  </div>
                  <p className="text-xs text-neutral-400">{n.body}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
