import React, { useCallback, useEffect, useRef, useState } from 'react';
import { User } from 'firebase/auth';
import { doc, increment, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  ScanFace,
  UserPlus,
  Volume2,
  X,
} from 'lucide-react';
import { db, getWorkspaceAccessToken, handleFirestoreError, OperationType } from '../firebase';
import { dispatchNotification } from '../services/notificationService';
import {
  fetchCalendarEvents,
  fetchDriveFiles,
  fetchGmailMessages,
} from '../services/workspaceService';
import {
  KnownFace,
  LearnedMemory,
  PendingMutationAction,
  VoiceName,
} from '../types';

interface VoiceOrbStageProps {
  user: User;
  knownFaces: KnownFace[];
  memories: LearnedMemory[];
  workspaceToken: string | null;
  onConnectWorkspace: () => Promise<string | null>;
  onProposeMutation: (action: PendingMutationAction) => void;
}

interface TranscriptLine {
  id: string;
  speaker: 'Siz' | 'Vega';
  text: string;
}

const VOICES: Array<{ id: VoiceName; label: string }> = [
  { id: 'Zephyr', label: 'Zephyr (Dengeli)' },
  { id: 'Kore', label: 'Kore (Sıcak)' },
  { id: 'Puck', label: 'Puck (Dinamik)' },
  { id: 'Charon', label: 'Charon (Derin)' },
  { id: 'Fenrir', label: 'Fenrir (Güçlü)' },
];

function float32ToInt16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64PcmToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

export const VoiceOrbStage: React.FC<VoiceOrbStageProps> = ({
  user,
  knownFaces,
  memories,
  workspaceToken,
  onConnectWorkspace,
  onProposeMutation,
}) => {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected'>('idle');
  const [voiceName, setVoiceName] = useState<VoiceName>('Zephyr');
  const [cameraOn, setCameraOn] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [modelSpeaking, setModelSpeaking] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptLine[]>([]);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Quick manual face teach modal state
  const [teachOpen, setTeachOpen] = useState(false);
  const [teachName, setTeachName] = useState('');
  const [teachRelation, setTeachRelation] = useState('');
  const [teachNotes, setTeachNotes] = useState('');
  const [visionBusy, setVisionBusy] = useState(false);
  const [faceResult, setFaceResult] = useState<string | null>(null);

  // Refs to prevent stale closures inside audio/video/WebSocket callbacks
  const wsRef = useRef<WebSocket | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<number | null>(null);

  const knownFacesRef = useRef<KnownFace[]>(knownFaces);
  const memoriesRef = useRef<LearnedMemory[]>(memories);
  const tokenRef = useRef<string | null>(workspaceToken);
  const userRef = useRef<User>(user);

  useEffect(() => {
    knownFacesRef.current = knownFaces;
  }, [knownFaces]);

  useEffect(() => {
    memoriesRef.current = memories;
  }, [memories]);

  useEffect(() => {
    tokenRef.current = workspaceToken;
  }, [workspaceToken]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const appendTranscript = useCallback((speaker: 'Siz' | 'Vega', text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setTranscripts((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.speaker === speaker) {
        return [
          ...prev.slice(0, -1),
          { ...last, text: `${last.text} ${clean}`.replace(/\s+/g, ' ').trim() },
        ];
      }
      return [
        ...prev.slice(-11),
        { id: `${Date.now()}_${Math.random()}`, speaker, text: clean },
      ];
    });
  }, []);

  const captureCameraFrameBase64 = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }
    const canvas = document.createElement('canvas');
    const w = Math.min(640, video.videoWidth);
    const h = Math.round((w / video.videoWidth) * video.videoHeight);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    return dataUrl.split(',')[1] || null;
  }, []);

  const registerFaceFromImage = useCallback(
    async (
      imageBase64: string,
      name: string,
      relation: string,
      notes: string
    ): Promise<{ ok: boolean; message: string }> => {
      const res = await fetch('/api/vision/analyze-face', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'register',
          imageBase64,
          mimeType: 'image/jpeg',
          personName: name,
          relation,
          notes,
        }),
      });
      const data = (await res.json()) as {
        faceDetected?: boolean;
        visualSignature?: string;
        facialTraits?: string[];
        greetingNote?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Yüz analizi başarısız.');
      }
      if (!data.faceDetected || !data.visualSignature) {
        return {
          ok: false,
          message: 'Kamerada net bir yüz algılanamadı. Lütfen yüzünüzü kameraya yaklaştırın.',
        };
      }

      const currentUser = userRef.current;
      const faceId = `face_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const safeTraits = (data.facialTraits || [])
        .slice(0, 12)
        .map((t) => String(t).slice(0, 80));

      const path = `users/${currentUser.uid}/known_faces/${faceId}`;
      try {
        await setDoc(doc(db, 'users', currentUser.uid, 'known_faces', faceId), {
          id: faceId,
          ownerId: currentUser.uid,
          name: name.slice(0, 80),
          relation: relation.slice(0, 120),
          visualSignature: data.visualSignature.slice(0, 1500),
          facialTraits: safeTraits,
          learnedNotes: notes.slice(0, 1000),
          recognitionCount: 1,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }

      return {
        ok: true,
        message: data.greetingNote || `${name} yüz belleğine kaydedildi.`,
      };
    },
    []
  );

  const identifyFaceFromImage = useCallback(
    async (imageBase64: string): Promise<{ ok: boolean; message: string; matchedName?: string }> => {
      const faces = knownFacesRef.current.map((f) => ({
        id: f.id,
        name: f.name,
        relation: f.relation,
        visualSignature: f.visualSignature,
        facialTraits: f.facialTraits,
        learnedNotes: f.learnedNotes,
      }));

      const res = await fetch('/api/vision/analyze-face', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'identify',
          imageBase64,
          mimeType: 'image/jpeg',
          knownFaces: faces,
        }),
      });
      const data = (await res.json()) as {
        faceDetected?: boolean;
        matchedFaceId?: string;
        matchedName?: string;
        confidence?: string;
        reasoning?: string;
        observedDescription?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Yüz tanıma başarısız.');
      }
      if (!data.faceDetected) {
        return { ok: false, message: 'Kamerada yüz tespit edilemedi.' };
      }

      if (data.matchedFaceId && data.matchedName) {
        const currentUser = userRef.current;
        const matched = knownFacesRef.current.find((f) => f.id === data.matchedFaceId);
        if (matched) {
          const path = `users/${currentUser.uid}/known_faces/${matched.id}`;
          try {
            await updateDoc(doc(db, 'users', currentUser.uid, 'known_faces', matched.id), {
              recognitionCount: increment(1),
              updatedAt: serverTimestamp(),
            });
          } catch (error) {
            handleFirestoreError(error, OperationType.UPDATE, path);
          }
        }
        return {
          ok: true,
          matchedName: data.matchedName,
          message: `Tanınan kişi: ${data.matchedName} (Güven: ${data.confidence || 'yüksek'}). ${
            data.reasoning || ''
          }`,
        };
      }

      return {
        ok: true,
        message: `Bu kişi henüz kayıtlı değil. Gözlem: ${data.observedDescription || ''}. Adını söylerseniz öğrenebilirim.`,
      };
    },
    []
  );

  const executeLiveToolCall = useCallback(
    async (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const name = call.name || '';
      const args = call.args || {};
      const currentUser = userRef.current;
      const activeToken = tokenRef.current || getWorkspaceAccessToken();

      try {
        if (name === 'identify_or_register_face') {
          const action = String(args.action || 'identify');
          const frame = captureCameraFrameBase64();
          if (!frame) {
            return {
              error: 'Kamera kapalı veya görüntü henüz hazır değil. Kullanıcıdan kamerayı açmasını isteyin.',
            };
          }
          if (action === 'register') {
            const personName = String(args.name || '').trim();
            if (!personName) {
              return { error: 'Kişiyi kaydetmek için adı belirtilmelidir.' };
            }
            const relation = String(args.relation || '');
            const notes = String(args.notes || '');
            setStatusNote(`${personName} için yüz analizi yapılıyor...`);
            const result = await registerFaceFromImage(frame, personName, relation, notes);
            setFaceResult(result.message);
            setStatusNote(null);
            return result;
          } else {
            setStatusNote('Kameradaki yüz taranıyor...');
            const result = await identifyFaceFromImage(frame);
            setFaceResult(result.message);
            setStatusNote(null);
            return result;
          }
        }

        if (name === 'save_learned_memory') {
          const memoryId = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const validCats = ['preference', 'person_fact', 'routine', 'instruction', 'workspace_note'];
          const rawCat = String(args.category || 'preference');
          const category = validCats.includes(rawCat) ? rawCat : 'preference';
          const subject = String(args.subject || 'Öğrenilen Bilgi').slice(0, 120);
          const content = String(args.content || '').slice(0, 1000);
          const path = `users/${currentUser.uid}/memories/${memoryId}`;
          try {
            await setDoc(doc(db, 'users', currentUser.uid, 'memories', memoryId), {
              id: memoryId,
              ownerId: currentUser.uid,
              category,
              subject,
              content,
              source: 'voice',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (error) {
            handleFirestoreError(error, OperationType.CREATE, path);
          }
          setStatusNote(`Öğrenildi: ${subject}`);
          return { ok: true, message: `Kalıcı belleğe kaydedildi: ${subject}` };
        }

        if (name === 'check_gmail_inbox') {
          if (!activeToken) {
            return {
              needsWorkspaceAuth: true,
              message:
                'Gmail erişimi için kullanıcının Workspace & İş sekmesinden veya üst çubuktan Google Workspace bağlantısını onaylaması gerekiyor.',
            };
          }
          const messages = await fetchGmailMessages(
            activeToken,
            String(args.query || ''),
            Number(args.maxResults || 5)
          );
          return { count: messages.length, messages };
        }

        if (name === 'propose_send_email') {
          if (!activeToken) {
            return {
              needsWorkspaceAuth: true,
              message: 'E-posta göndermek için önce Google Workspace hesabınızı bağlayın.',
            };
          }
          onProposeMutation({
            type: 'send_email',
            to: String(args.to || ''),
            subject: String(args.subject || ''),
            body: String(args.body || ''),
          });
          return {
            awaitingUserConfirmation: true,
            message:
              'E-posta taslağı kullanıcı onay penceresinde açıldı. Kullanıcı onayladığında gönderilecektir.',
          };
        }

        if (name === 'check_calendar_events') {
          if (!activeToken) {
            return {
              needsWorkspaceAuth: true,
              message: 'Takvimi kontrol etmek için önce Google Workspace hesabınızı bağlayın.',
            };
          }
          const events = await fetchCalendarEvents(
            activeToken,
            Number(args.daysAhead || 3),
            8
          );
          return { count: events.length, events };
        }

        if (name === 'propose_create_calendar_event') {
          if (!activeToken) {
            return {
              needsWorkspaceAuth: true,
              message: 'Takvim etkinliği eklemek için önce Google Workspace hesabınızı bağlayın.',
            };
          }
          onProposeMutation({
            type: 'create_event',
            summary: String(args.summary || ''),
            startIso: String(args.startIso || new Date().toISOString()),
            endIso: String(args.endIso || new Date(Date.now() + 3600000).toISOString()),
            description: args.description ? String(args.description) : undefined,
            location: args.location ? String(args.location) : undefined,
          });
          return {
            awaitingUserConfirmation: true,
            message: 'Takvim etkinliği onay penceresi açıldı. Kullanıcı onayladığında eklenecektir.',
          };
        }

        if (name === 'search_google_drive') {
          if (!activeToken) {
            return {
              needsWorkspaceAuth: true,
              message: 'Google Drive dosyalarına erişmek için önce Google Workspace hesabınızı bağlayın.',
            };
          }
          const files = await fetchDriveFiles(activeToken, String(args.query || ''), 6);
          return { count: files.length, files };
        }

        if (name === 'send_browser_notification') {
          const validSources = ['voice', 'gmail', 'calendar', 'system'];
          const rawSource = String(args.source || 'voice');
          const source = (validSources.includes(rawSource) ? rawSource : 'voice') as
            | 'voice'
            | 'gmail'
            | 'calendar'
            | 'system';
          await dispatchNotification({
            userId: currentUser.uid,
            userVerified: currentUser.emailVerified,
            title: String(args.title || 'Vega Bildirimi'),
            body: String(args.body || ''),
            source,
          });
          return { ok: true, message: 'Bildirim gönderildi ve kaydedildi.' };
        }

        if (name === 'run_deep_task') {
          setStatusNote('Derin analiz çalıştırılıyor...');
          let workspaceSnapshot: Record<string, unknown> | undefined;
          if (activeToken) {
            const [emails, events, files] = await Promise.all([
              fetchGmailMessages(activeToken, '', 5).catch(() => []),
              fetchCalendarEvents(activeToken, 3, 6).catch(() => []),
              fetchDriveFiles(activeToken, '', 5).catch(() => []),
            ]);
            workspaceSnapshot = { emails, events, files };
          }
          const res = await fetch('/api/ai/deep-think', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: String(args.taskPrompt || ''),
              memories: memoriesRef.current.map((m) => ({
                category: m.category,
                subject: m.subject,
                content: m.content,
              })),
              workspaceSnapshot,
            }),
          });
          const data = (await res.json()) as {
            title?: string;
            spokenSummary?: string;
            detailedPlan?: string;
            error?: string;
          };
          setStatusNote(null);
          if (!res.ok) {
            throw new Error(data.error || 'Derin analiz hatası.');
          }
          const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const validCats = ['briefing', 'email', 'calendar', 'drive', 'analysis'];
          const rawCat = String(args.category || 'analysis');
          const category = validCats.includes(rawCat) ? rawCat : 'analysis';
          const path = `users/${currentUser.uid}/tasks/${taskId}`;
          try {
            await setDoc(doc(db, 'users', currentUser.uid, 'tasks', taskId), {
              id: taskId,
              ownerId: currentUser.uid,
              title: String(data.title || 'Asistan Görevi').slice(0, 160),
              summary: String(data.detailedPlan || data.spokenSummary || '').slice(0, 4000),
              category,
              status: 'pending',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (error) {
            handleFirestoreError(error, OperationType.CREATE, path);
          }
          return {
            title: data.title,
            spokenSummary: data.spokenSummary,
            savedToTasks: true,
          };
        }

        return { error: `Bilinmeyen araç: ${name}` };
      } catch (err) {
        setStatusNote(null);
        return {
          error: err instanceof Error ? err.message : 'Araç çalıştırılırken hata oluştu.',
        };
      }
    },
    [captureCameraFrameBase64, identifyFaceFromImage, onProposeMutation, registerFaceFromImage]
  );

  const stopPlaybackQueue = useCallback(() => {
    activeSourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch {
        // ignore
      }
    });
    activeSourcesRef.current.clear();
    if (outputCtxRef.current) {
      nextStartTimeRef.current = outputCtxRef.current.currentTime;
    }
    setModelSpeaking(false);
  }, []);

  const stopVoiceSession = useCallback(() => {
    stopPlaybackQueue();
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (inputCtxRef.current) {
      void inputCtxRef.current.close();
      inputCtxRef.current = null;
    }
    if (outputCtxRef.current) {
      void outputCtxRef.current.close();
      outputCtxRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setAudioLevel(0);
    setStatus('idle');
    setStatusNote(null);
  }, [stopPlaybackQueue]);

  const startVoiceSession = async () => {
    setErrorMsg(null);
    setStatus('connecting');
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      micStreamRef.current = micStream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      if (inputCtx.state === 'suspended') {
        await inputCtx.resume();
      }
      if (outputCtx.state === 'suspended') {
        await outputCtx.resume();
      }
      inputCtxRef.current = inputCtx;
      outputCtxRef.current = outputCtx;
      nextStartTimeRef.current = outputCtx.currentTime;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/live`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'init',
            userEmail: userRef.current.email || '',
            voiceName,
            knownFaces: knownFacesRef.current.map((f) => ({
              id: f.id,
              name: f.name,
              relation: f.relation,
              visualSignature: f.visualSignature,
              facialTraits: f.facialTraits,
              learnedNotes: f.learnedNotes,
            })),
            memories: memoriesRef.current.map((m) => ({
              category: m.category,
              subject: m.subject,
              content: m.content,
            })),
          })
        );
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data) as {
          type: string;
          data?: string;
          text?: string;
          message?: string;
          calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
        };

        if (msg.type === 'ready') {
          setStatus('connected');
          const source = inputCtx.createMediaStreamSource(micStream);
          const processor = inputCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          processor.onaudioprocess = (e) => {
            const channel = e.inputBuffer.getChannelData(0);
            let sum = 0;
            for (let i = 0; i < channel.length; i++) {
              sum += channel[i] * channel[i];
            }
            const rms = Math.sqrt(sum / channel.length);
            setAudioLevel(Math.min(1, rms * 5));

            if (wsRef.current?.readyState === WebSocket.OPEN) {
              const base64 = float32ToInt16Base64(channel);
              wsRef.current.send(JSON.stringify({ type: 'audio', audio: base64 }));
            }
          };

          source.connect(processor);
          processor.connect(inputCtx.destination);
        } else if (msg.type === 'audio' && msg.data && outputCtxRef.current) {
          const ctx = outputCtxRef.current;
          if (ctx.state === 'suspended') {
            await ctx.resume();
          }
          const floatSamples = base64PcmToFloat32(msg.data);
          const buffer = ctx.createBuffer(1, floatSamples.length, 24000);
          buffer.getChannelData(0).set(floatSamples);

          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(ctx.destination);

          const startAt = Math.max(ctx.currentTime, nextStartTimeRef.current);
          src.start(startAt);
          nextStartTimeRef.current = startAt + buffer.duration;
          activeSourcesRef.current.add(src);
          setModelSpeaking(true);

          src.onended = () => {
            activeSourcesRef.current.delete(src);
            if (activeSourcesRef.current.size === 0) {
              setModelSpeaking(false);
            }
          };
        } else if (msg.type === 'interrupted') {
          stopPlaybackQueue();
        } else if (msg.type === 'input_transcript' && msg.text) {
          appendTranscript('Siz', msg.text);
        } else if (msg.type === 'output_transcript' && msg.text) {
          appendTranscript('Vega', msg.text);
        } else if (msg.type === 'tool_call' && msg.calls) {
          const responses = await Promise.all(
            msg.calls.map(async (call) => ({
              id: call.id,
              name: call.name,
              response: await executeLiveToolCall(call),
            }))
          );
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'tool_response', responses }));
          }
        } else if (msg.type === 'error') {
          setErrorMsg(msg.message || 'Ses bağlantısı hatası.');
        } else if (msg.type === 'closed') {
          stopVoiceSession();
        }
      };

      ws.onerror = () => {
        setErrorMsg('WebSocket ses sunucusuna bağlanılamadı.');
        stopVoiceSession();
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          stopVoiceSession();
        }
      };
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Mikrofon izni alınamadı veya ses oturumu başlatılamadı.'
      );
      stopVoiceSession();
    }
  };

  // Camera lifecycle + 1 FPS streaming to Live API
  const toggleCamera = async () => {
    if (cameraOn) {
      if (frameIntervalRef.current) {
        window.clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
      if (camStreamRef.current) {
        camStreamRef.current.getTracks().forEach((t) => t.stop());
        camStreamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setCameraOn(false);
      return;
    }

    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      });
      camStreamRef.current = stream;
      setCameraOn(true);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Kameraya erişilemedi. Lütfen kamera iznini kontrol edin.'
      );
    }
  };

  useEffect(() => {
    if (cameraOn && videoRef.current && camStreamRef.current) {
      videoRef.current.srcObject = camStreamRef.current;
      void videoRef.current.play();

      frameIntervalRef.current = window.setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const base64 = captureCameraFrameBase64();
          if (base64) {
            wsRef.current.send(JSON.stringify({ type: 'video', video: base64 }));
          }
        }
      }, 1000); // Max 1 FPS per Live API rule
    }
    return () => {
      if (frameIntervalRef.current) {
        window.clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
    };
  }, [cameraOn, captureCameraFrameBase64]);

  useEffect(() => {
    return () => {
      stopVoiceSession();
      if (camStreamRef.current) {
        camStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [stopVoiceSession]);

  const handleManualIdentify = async () => {
    const frame = captureCameraFrameBase64();
    if (!frame) {
      setErrorMsg('Yüz taraması için önce kamerayı açın.');
      return;
    }
    setVisionBusy(true);
    setFaceResult(null);
    setErrorMsg(null);
    try {
      const res = await identifyFaceFromImage(frame);
      setFaceResult(res.message);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Yüz taraması başarısız.');
    } finally {
      setVisionBusy(false);
    }
  };

  const handleManualTeachSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const frame = captureCameraFrameBase64();
    if (!frame) {
      setErrorMsg('Kişiyi tanıtmak için önce kamerayı açın.');
      return;
    }
    if (!teachName.trim()) {
      setErrorMsg('Lütfen kişinin adını girin.');
      return;
    }
    setVisionBusy(true);
    setErrorMsg(null);
    try {
      const res = await registerFaceFromImage(
        frame,
        teachName.trim(),
        teachRelation.trim(),
        teachNotes.trim()
      );
      setFaceResult(res.message);
      if (res.ok) {
        setTeachOpen(false);
        setTeachName('');
        setTeachRelation('');
        setTeachNotes('');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Kişi kaydedilemedi.');
    } finally {
      setVisionBusy(false);
    }
  };

  const orbScale =
    status === 'connected' ? 1 + Math.max(audioLevel * 0.18, modelSpeaking ? 0.14 : 0) : 1;

  return (
    <div className="grid lg:grid-cols-12 gap-6 items-stretch">
      {/* Main Voice-Only Assistant Stage */}
      <section className="lg:col-span-7 border border-neutral-800 bg-neutral-900/50 rounded-xl p-6 sm:p-8 flex flex-col justify-between min-h-[540px]">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800/80 pb-5">
          <div>
            <h1 className="font-display text-2xl font-semibold text-white">
              Sesli Asistan Stüdyosu
            </h1>
            <p className="text-xs text-neutral-400 mt-1">
              Yalnızca sesli iletişim · {knownFaces.length} kayıtlı yüz · {memories.length} öğrenilen bilgi
            </p>
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="voice-select" className="sr-only">
              Asistan Sesi
            </label>
            <select
              id="voice-select"
              value={voiceName}
              disabled={status !== 'idle'}
              onChange={(e) => setVoiceName(e.target.value as VoiceName)}
              className="h-9 px-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-200 focus:outline-none focus:border-amber-500 disabled:opacity-50"
            >
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>

            {!workspaceToken && (
              <button
                type="button"
                onClick={() => void onConnectWorkspace()}
                className="h-9 px-3 text-xs font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg hover:bg-amber-500/20 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Workspace Bağla
              </button>
            )}
          </div>
        </div>

        {/* Central Acoustic Orb */}
        <div className="my-8 flex flex-col items-center justify-center space-y-6">
          <div className="relative w-48 h-48 flex items-center justify-center">
            <div
              style={{ transform: `scale(${orbScale})` }}
              className={`w-40 h-40 rounded-full border transition-transform duration-150 flex items-center justify-center ${
                status === 'connected'
                  ? modelSpeaking
                    ? 'border-amber-400 bg-amber-500/15'
                    : 'border-neutral-600 bg-neutral-800/70'
                  : 'border-neutral-800 bg-neutral-900'
              }`}
            >
              <div
                className={`w-24 h-24 rounded-full flex items-center justify-center border ${
                  status === 'connected'
                    ? 'border-amber-500/50 bg-neutral-950 text-amber-400'
                    : 'border-neutral-800 bg-neutral-950 text-neutral-500'
                }`}
              >
                {status === 'connected' ? (
                  modelSpeaking ? (
                    <Volume2 className="w-8 h-8" aria-hidden="true" />
                  ) : (
                    <Mic className="w-8 h-8" aria-hidden="true" />
                  )
                ) : (
                  <MicOff className="w-8 h-8" aria-hidden="true" />
                )}
              </div>
            </div>
          </div>

          <div className="text-center space-y-1.5">
            <div className="flex items-center justify-center gap-2 text-sm font-medium text-white">
              {status === 'connected' && (
                <span className="w-2 h-2 rounded-full bg-emerald-500" aria-hidden="true" />
              )}
              <span>
                {status === 'idle'
                  ? 'Konuşmaya başlamak için mikrofonu açın'
                  : status === 'connecting'
                  ? 'Ses oturumu bağlanıyor...'
                  : modelSpeaking
                  ? 'Vega konuşuyor...'
                  : 'Dinleniyor — doğrudan konuşabilirsiniz'}
              </span>
            </div>
            {statusNote && <p className="text-xs text-amber-400">{statusNote}</p>}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3">
            {status === 'idle' ? (
              <button
                type="button"
                onClick={startVoiceSession}
                className="h-11 px-6 flex items-center gap-2 text-sm font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Mic className="w-4 h-4" aria-hidden="true" />
                Sesli Asistanı Başlat
              </button>
            ) : (
              <button
                type="button"
                onClick={stopVoiceSession}
                className="h-11 px-6 flex items-center gap-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <MicOff className="w-4 h-4" aria-hidden="true" />
                Oturumu Sonlandır
              </button>
            )}

            <button
              type="button"
              onClick={toggleCamera}
              className={`h-11 px-5 flex items-center gap-2 text-sm font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                cameraOn
                  ? 'bg-neutral-800 border-amber-500/50 text-amber-300'
                  : 'bg-neutral-950 border-neutral-800 text-neutral-300 hover:border-neutral-700'
              }`}
            >
              {cameraOn ? (
                <>
                  <CameraOff className="w-4 h-4" aria-hidden="true" />
                  Kamerayı Kapat
                </>
              ) : (
                <>
                  <Camera className="w-4 h-4" aria-hidden="true" />
                  Yüz Analizi İçin Kamerayı Aç
                </>
              )}
            </button>
          </div>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="mb-4 p-3 text-xs text-red-200 bg-red-950/50 border border-red-900 rounded-lg"
          >
            {errorMsg}
          </div>
        )}

        {/* Ambient Live Voice Transcript (Read-Only, Voice-Only Interface) */}
        <div className="border-t border-neutral-800/80 pt-4 space-y-2.5">
          <div className="flex items-center justify-between text-xs text-neutral-500">
            <span>Canlı Konuşma Akışı</span>
            {transcripts.length > 0 && (
              <button
                type="button"
                onClick={() => setTranscripts([])}
                className="hover:text-neutral-300 transition-colors cursor-pointer"
              >
                Temizle
              </button>
            )}
          </div>
          <div className="h-36 overflow-y-auto space-y-2 pr-1 text-sm">
            {transcripts.length === 0 ? (
              <p className="text-xs text-neutral-500 leading-relaxed">
                Örnek sesli komutlar: &quot;Ben Kutay, yüzümü kaydet&quot;, &quot;Bugünkü
                takvimimi ve okunmamış maillerimi kontrol et&quot;, &quot;Kahvemi sade sevdiğimi
                unutma&quot;, &quot;10 dakika sonra toplantı bildirimi gönder&quot;.
              </p>
            ) : (
              transcripts.map((line) => (
                <div key={line.id} className="leading-relaxed">
                  <span
                    className={`text-xs font-medium mr-2 ${
                      line.speaker === 'Vega' ? 'text-amber-400' : 'text-neutral-400'
                    }`}
                  >
                    {line.speaker}:
                  </span>
                  <span className="text-neutral-200 text-xs sm:text-sm">{line.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Right Column: Live Camera & Instant Face Recognition */}
      <section className="lg:col-span-5 border border-neutral-800 bg-neutral-900/50 rounded-xl p-6 flex flex-col justify-between space-y-5">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold text-white">
            Canlı Yüz Analizi ve Tanıma
          </h2>
          <p className="text-xs text-neutral-400">
            Kamerayı açtığınızda Vega yüzleri gerçek zamanlı görür; adını söylediğiniz kişileri
            kalıcı olarak öğrenir.
          </p>
        </div>

        <div className="relative aspect-[4/3] w-full rounded-lg overflow-hidden bg-neutral-950 border border-neutral-800 flex items-center justify-center">
          <video
            ref={videoRef}
            muted
            playsInline
            className={`w-full h-full object-cover ${cameraOn ? 'block' : 'hidden'}`}
          />
          {!cameraOn && (
            <div className="text-center p-6 space-y-2">
              <ScanFace className="w-10 h-10 text-neutral-600 mx-auto" aria-hidden="true" />
              <p className="text-xs text-neutral-500">
                Kamera kapalı. Yüz tanıma veya yeni kişi tanıtmak için kamerayı başlatın.
              </p>
            </div>
          )}
        </div>

        {faceResult && (
          <div className="p-3.5 bg-neutral-950 border border-neutral-800 rounded-lg text-xs text-neutral-200 leading-relaxed">
            {faceResult}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={handleManualIdentify}
            disabled={!cameraOn || visionBusy}
            className="h-10 px-3 flex items-center justify-center gap-2 text-xs font-medium bg-neutral-800 text-neutral-100 rounded-lg hover:bg-neutral-700 disabled:opacity-40 transition-colors cursor-pointer"
          >
            <ScanFace className="w-4 h-4" aria-hidden="true" />
            {visionBusy ? 'Taranıyor...' : 'Kim Var? (Tara)'}
          </button>

          <button
            type="button"
            onClick={() => setTeachOpen(true)}
            disabled={!cameraOn || visionBusy}
            className="h-10 px-3 flex items-center justify-center gap-2 text-xs font-medium bg-amber-500/15 border border-amber-500/35 text-amber-300 rounded-lg hover:bg-amber-500/25 disabled:opacity-40 transition-colors cursor-pointer"
          >
            <UserPlus className="w-4 h-4" aria-hidden="true" />
            Bu Kişiyi Tanıt
          </button>
        </div>

        <div className="pt-3 border-t border-neutral-800/80 space-y-2">
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span>Tanınan Son Kişiler</span>
            <span className="font-mono-tabular text-neutral-500">{knownFaces.length}</span>
          </div>
          {knownFaces.length === 0 ? (
            <p className="text-xs text-neutral-500">Henüz tanıtılmış bir yüz yok.</p>
          ) : (
            <div className="space-y-1.5 max-h-32 overflow-y-auto">
              {knownFaces.slice(0, 5).map((face) => (
                <div
                  key={face.id}
                  className="flex items-center justify-between text-xs py-1.5 border-b border-neutral-800/50 last:border-0"
                >
                  <div className="truncate pr-2">
                    <span className="text-neutral-100 font-medium">{face.name}</span>
                    {face.relation && (
                      <span className="text-neutral-500 ml-1.5">· {face.relation}</span>
                    )}
                  </div>
                  <span className="font-mono-tabular text-neutral-500 shrink-0">
                    {face.recognitionCount}x
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Teach Person Modal */}
      {teachOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
        >
          <form
            onSubmit={handleManualTeachSubmit}
            className="max-w-md w-full bg-neutral-900 border border-neutral-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-semibold text-white">
                Kameradaki Kişiyi Tanıt
              </h3>
              <button
                type="button"
                onClick={() => setTeachOpen(false)}
                className="p-1 text-neutral-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-neutral-400">
              Vega mevcut kamera karesindeki yüz özelliklerini çıkarıp kalıcı belleğine
              kaydedecektir.
            </p>
            <div className="space-y-1.5">
              <label className="block text-xs text-neutral-300">Adı</label>
              <input
                type="text"
                required
                value={teachName}
                onChange={(e) => setTeachName(e.target.value)}
                placeholder="Örn: Ahmet Yılmaz"
                className="w-full h-10 px-3 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-amber-500"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs text-neutral-300">İlişki / Rol (İsteğe bağlı)</label>
              <input
                type="text"
                value={teachRelation}
                onChange={(e) => setTeachRelation(e.target.value)}
                placeholder="Örn: İş Ortağım, Kardeşim"
                className="w-full h-10 px-3 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-amber-500"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs text-neutral-300">Not (İsteğe bağlı)</label>
              <input
                type="text"
                value={teachNotes}
                onChange={(e) => setTeachNotes(e.target.value)}
                placeholder="Örn: Toplantılarda resmi hitap sever"
                className="w-full h-10 px-3 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white focus:outline-none focus:border-amber-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setTeachOpen(false)}
                className="px-4 py-2 text-xs font-medium text-neutral-300 bg-neutral-800 rounded-lg hover:bg-neutral-700 cursor-pointer"
              >
                Vazgeç
              </button>
              <button
                type="submit"
                disabled={visionBusy}
                className="px-4 py-2 text-xs font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 disabled:opacity-50 cursor-pointer"
              >
                {visionBusy ? 'Kaydediliyor...' : 'Yüzü Öğret'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
