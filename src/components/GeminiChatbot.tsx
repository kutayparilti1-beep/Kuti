import React, { useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import { deleteDoc, doc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { MessageSquare, Send, Trash2 } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { BotRole, ChatMessage, KnownFace, LearnedMemory } from '../types';

interface GeminiChatbotProps {
  user: User;
  messages: ChatMessage[];
  knownFaces: KnownFace[];
  memories: LearnedMemory[];
}

const ROLE_OPTIONS: Array<{
  id: BotRole;
  label: string;
  description: string;
}> = [
  {
    id: 'general',
    label: 'Genel Asistan',
    description: 'Günlük sorular, özetler ve metin düzenleme.',
  },
  {
    id: 'deep_reasoning',
    label: 'Derin Düşünme',
    description: 'Adım adım mantık yürütme ve karmaşık analiz.',
  },
  {
    id: 'architect',
    label: 'İş Mimarı',
    description: 'Çok adımlı planlama ve strateji tasarımı.',
  },
  {
    id: 'fast',
    label: 'Hızlı Yanıt',
    description: 'Kısa ve anlık soru-cevap.',
  },
];

export const GeminiChatbot: React.FC<GeminiChatbotProps> = ({
  user,
  messages,
  knownFaces,
  memories,
}) => {
  const [botRole, setBotRole] = useState<BotRole>('general');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  const saveMessage = async (role: 'user' | 'model', text: string, roleUsed: BotRole) => {
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const path = `users/${user.uid}/chat_messages/${messageId}`;
    try {
      await setDoc(doc(db, 'users', user.uid, 'chat_messages', messageId), {
        id: messageId,
        ownerId: user.uid,
        role,
        botRole: roleUsed,
        text: text.slice(0, 12000),
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || streaming) return;

    setErrorMsg(null);
    setInput('');
    setStreaming(true);
    setStreamingText('');

    const currentRole = botRole;
    const priorHistory = messages.slice(-24).map((m) => ({
      role: m.role,
      text: m.text,
    }));

    try {
      await saveMessage('user', prompt, currentRole);

      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: prompt,
          history: priorHistory,
          botRole: currentRole,
          userEmail: user.email || '',
          knownFaces: knownFaces.map((f) => ({
            id: f.id,
            name: f.name,
            relation: f.relation,
            visualSignature: f.visualSignature,
          })),
          memories: memories.map((m) => ({
            category: m.category,
            subject: m.subject,
            content: m.content,
          })),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Sunucu yanıt vermedi (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const block of parts) {
          const line = block.trim();
          if (!line.startsWith('data:')) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;
          const payload = JSON.parse(jsonStr) as {
            text?: string;
            error?: string;
            done?: boolean;
          };
          if (payload.error) {
            throw new Error(payload.error);
          }
          if (payload.text) {
            accumulated += payload.text;
            setStreamingText(accumulated);
          }
        }
      }

      if (accumulated.trim()) {
        await saveMessage('model', accumulated.trim(), currentRole);
      }
      setStreamingText('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Sohbet yanıtı alınamadı.');
    } finally {
      setStreaming(false);
    }
  };

  const handleDeleteMessage = async (msgId: string) => {
    const path = `users/${user.uid}/chat_messages/${msgId}`;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'chat_messages', msgId));
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Mesaj silinemedi.');
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  };

  const handleClearHistory = async () => {
    if (messages.length === 0 || clearing) return;
    setClearing(true);
    setErrorMsg(null);
    try {
      const batch = writeBatch(db);
      for (const m of messages) {
        batch.delete(doc(db, 'users', user.uid, 'chat_messages', m.id));
      }
      await batch.commit();
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Sohbet temizlenemedi.');
    } finally {
      setClearing(false);
    }
  };

  const activeRoleMeta = ROLE_OPTIONS.find((r) => r.id === botRole) || ROLE_OPTIONS[0];

  return (
    <section className="max-w-5xl mx-auto border border-neutral-800 bg-neutral-900/50 rounded-xl flex flex-col h-[calc(100vh-11rem)] min-h-[540px]">
      {/* Header & Role Selector */}
      <div className="p-5 border-b border-neutral-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-amber-400" aria-hidden="true" />
            <h1 className="font-display text-lg font-semibold text-white">
              Çok Turlu Gemini Sohbeti
            </h1>
          </div>
          <p className="text-xs text-neutral-400">{activeRoleMeta.description}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-neutral-950 border border-neutral-800 rounded-lg overflow-x-auto">
            {ROLE_OPTIONS.map((role) => (
              <button
                key={role.id}
                type="button"
                disabled={streaming}
                onClick={() => setBotRole(role.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  botRole === role.id
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {role.label}
              </button>
            ))}
          </div>

          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => void handleClearHistory()}
              disabled={clearing || streaming}
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-neutral-300 bg-neutral-950 border border-neutral-800 rounded-lg hover:border-red-900 hover:text-red-300 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              Sohbeti Temizle
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Message Thread */}
      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        {messages.length === 0 && !streamingText ? (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-2">
            <MessageSquare className="w-8 h-8 text-neutral-600" aria-hidden="true" />
            <h2 className="text-sm font-medium text-neutral-200">
              Konuşmaya başlamak için bir soru sorun
            </h2>
            <p className="text-xs text-neutral-500 leading-relaxed">
              Vega, kayıtlı yüzleri ve öğrendiğiniz tercihleri hatırlar. Rol seçiciden Genel,
              Derin Düşünme, İş Mimarı veya Hızlı Yanıt modlarını değiştirebilirsiniz.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const roleLabel =
              ROLE_OPTIONS.find((r) => r.id === msg.botRole)?.label || 'Genel Asistan';
            return (
              <div
                key={msg.id}
                className={`flex flex-col ${
                  msg.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-3xl rounded-xl px-4 py-3 text-sm leading-relaxed space-y-1.5 border ${
                    msg.role === 'user'
                      ? 'bg-neutral-800 border-neutral-700 text-white'
                      : 'bg-neutral-950 border-neutral-800 text-neutral-200'
                  }`}
                >
                  <div className="flex items-center justify-between gap-4 text-xs text-neutral-400">
                    <span className={msg.role === 'model' ? 'text-amber-400 font-medium' : ''}>
                      {msg.role === 'user' ? 'Siz' : `Vega · ${roleLabel}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleDeleteMessage(msg.id)}
                      aria-label="Mesajı sil"
                      className="text-neutral-600 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                </div>
              </div>
            );
          })
        )}

        {streamingText && (
          <div className="flex flex-col items-start">
            <div className="max-w-3xl rounded-xl px-4 py-3 text-sm leading-relaxed space-y-1.5 border bg-neutral-950 border-amber-500/40 text-neutral-200">
              <div className="text-xs text-amber-400 font-medium">
                Vega · {activeRoleMeta.label}
              </div>
              <p className="whitespace-pre-wrap break-words">{streamingText}</p>
            </div>
          </div>
        )}

        <div ref={threadEndRef} />
      </div>

      {/* Error & Input Footer */}
      <div className="p-4 border-t border-neutral-800 space-y-3">
        {errorMsg && (
          <div
            role="alert"
            className="p-3 text-xs text-red-200 bg-red-950/50 border border-red-900 rounded-lg"
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSend} className="flex items-center gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={streaming}
            placeholder={`${activeRoleMeta.label} rolüne mesaj yazın...`}
            className="flex-1 h-11 px-4 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder:text-neutral-500 focus:outline-none focus:border-amber-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={streaming || !input.trim()}
            className="h-11 px-5 inline-flex items-center gap-2 text-sm font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Send className="w-4 h-4" aria-hidden="true" />
            {streaming ? 'Yanıtlanıyor...' : 'Gönder'}
          </button>
        </form>
      </div>
    </section>
  );
};
