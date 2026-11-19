import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import {
  FunctionDeclaration,
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  ThinkingLevel,
  Type,
} from "@google/genai";

const PORT = 3000;

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

const LIVE_TOOLS: FunctionDeclaration[] = [
  {
    name: "identify_or_register_face",
    description:
      "Kameradaki kisiyi mevcut yuz belleginden tanimlar (action='identify') veya kullanici bir kisinin adini soyleyip tanittiginda kisiyi yuz analizi ile bellege kaydeder (action='register').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: "Islem turu: 'identify' veya 'register'",
        },
        name: {
          type: Type.STRING,
          description: "Tanitilan kisinin adi (ornek: Ahmet, Kutay, Elif)",
        },
        relation: {
          type: Type.STRING,
          description: "Kisiyi tanimlayan iliski veya rol (ornek: Proje Yoneticisi, Arkadas, Kullanici)",
        },
        notes: {
          type: Type.STRING,
          description: "Kisi hakkinda ogrenilen ek notlar",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "save_learned_memory",
    description:
      "Kullanicinin asistana ogrettigi bir tercihi, rutini, kisi bilgisini veya ozel talimati kalici bellege kaydeder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          description: "Kategori: preference, person_fact, routine, instruction veya workspace_note",
        },
        subject: {
          type: Type.STRING,
          description: "Bilginin kisa basligi",
        },
        content: {
          type: Type.STRING,
          description: "Ogrenilen bilginin tam aciklamasi",
        },
      },
      required: ["category", "subject", "content"],
    },
  },
  {
    name: "check_gmail_inbox",
    description:
      "Kullanicinin Gmail gelen kutusunu kontrol eder, son e-postalari veya okunmamis iletileri getirir.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Gmail arama sorgusu (ornek: is:unread, from:ahmet)",
        },
        maxResults: {
          type: Type.NUMBER,
          description: "Getirilecek maksimum e-posta sayisi (varsayilan 5)",
        },
      },
    },
  },
  {
    name: "propose_send_email",
    description:
      "Kullanici adina yeni bir e-posta gondermek icin onay penceresi acar. Kullanici onaylamadan e-posta gonderilmez.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: {
          type: Type.STRING,
          description: "Alici e-posta adresi",
        },
        subject: {
          type: Type.STRING,
          description: "E-posta konusu",
        },
        body: {
          type: Type.STRING,
          description: "E-posta metni",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "check_calendar_events",
    description:
      "Kullanicinin Google Takvim etkinliklerini kontrol eder ve yaklasan toplantilari listeler.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        daysAhead: {
          type: Type.NUMBER,
          description: "Kac gunluk etkinliklerin kontrol edilecegi (varsayilan 3)",
        },
      },
    },
  },
  {
    name: "propose_create_calendar_event",
    description:
      "Google Takvim'de yeni bir etkinlik olusturmak icin onay penceresi acar. Kullanici onaylamadan etkinlik eklenmez.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: {
          type: Type.STRING,
          description: "Etkinlik basligi",
        },
        startIso: {
          type: Type.STRING,
          description: "Baslangic zamani ISO-8601 formatinda (ornek: 2026-11-20T14:00:00+03:00)",
        },
        endIso: {
          type: Type.STRING,
          description: "Bitis zamani ISO-8601 formatinda",
        },
        description: {
          type: Type.STRING,
          description: "Etkinlik aciklamasi",
        },
        location: {
          type: Type.STRING,
          description: "Konum veya toplanti linki",
        },
      },
      required: ["summary", "startIso", "endIso"],
    },
  },
  {
    name: "search_google_drive",
    description: "Google Drive dosyalarinda arama yapar veya son dosyalari listeler.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Dosya adi veya arama kelimesi",
        },
      },
    },
  },
  {
    name: "send_browser_notification",
    description:
      "Kullaniciya masaustu/tarayici bildirimi gonderir ve bildirim gecmisine kaydeder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: {
          type: Type.STRING,
          description: "Bildirim basligi",
        },
        body: {
          type: Type.STRING,
          description: "Bildirim icerigi",
        },
        source: {
          type: Type.STRING,
          description: "Kaynak: voice, gmail, calendar veya system",
        },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "run_deep_task",
    description:
      "Karmasik planlama, gunluk brifing, e-posta/takvim/drive sentezi veya derin analiz gorevlerini calistirir ve gorev panosuna kaydeder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskPrompt: {
          type: Type.STRING,
          description: "Yapilacak is veya analiz talebi",
        },
        category: {
          type: Type.STRING,
          description: "Kategori: briefing, email, calendar, drive veya analysis",
        },
      },
      required: ["taskPrompt", "category"],
    },
  },
];

interface FaceContextItem {
  id: string;
  name: string;
  relation?: string;
  visualSignature: string;
  facialTraits?: string[];
  learnedNotes?: string;
}

interface MemoryContextItem {
  category: string;
  subject: string;
  content: string;
}

function buildLiveSystemInstruction(
  userEmail: string,
  knownFaces: FaceContextItem[],
  memories: MemoryContextItem[]
): string {
  const facesText =
    knownFaces.length > 0
      ? knownFaces
          .map(
            (f, idx) =>
              `${idx + 1}. ${f.name}${f.relation ? ` (${f.relation})` : ""}: ${f.visualSignature}${
                f.facialTraits && f.facialTraits.length > 0
                  ? ` | Ozellikler: ${f.facialTraits.join(", ")}`
                  : ""
              }${f.learnedNotes ? ` | Not: ${f.learnedNotes}` : ""}`
          )
          .join("\n")
      : "Henuz kayitli bir yuz profili yok.";

  const memoriesText =
    memories.length > 0
      ? memories.map((m) => `- [${m.category}] ${m.subject}: ${m.content}`).join("\n")
      : "Henuz kayitli ozel bilgi yok.";

  return `Sen Vega Asistan'sin: ogrenmeye yatkin, yuz tanima yetenegine sahip, yalnizca sesle iletisim kuran akilli kisisel asistansin.
Aktif kullanici e-postasi: ${userEmail || "Bilinmiyor"}
Bugunun tarihi ve saati: ${new Date().toISOString()}

KURALLARIN:
1. Daima dogal, akici, kisa ve anlasilir Turkce konus. Sesli asistan oldugun icin uzun madde isaretleri okumak yerine sohbet dilinde ozetle.
2. YUZ TANIMA VE OGRENME:
   - Kullanici kamerayi actiginda goruntudeki kisileri asagidaki KAYITLI YUZLER listesiyle karsilastir. Eger listedeki biriyle eslesirse hemen adiyla hitap et (ornegin "Merhaba Ahmet, hos geldin!").
   - Kullanici bir kisiyi adini soyleyerek tanitirsa (ornegin "Bu arkadasim Zeynep", "Ben Kutay, beni kaydet"), MUTLAKA \`identify_or_register_face\` aracini \`action: "register"\` ile cagirarak o kisiyi kalici yuz bellegine kaydet.
   - Kullanici "Karsimdaki kim?" veya "Beni taniyor musun?" derse \`identify_or_register_face\` aracini \`action: "identify"\` ile cagir.
3. SUREKLI OGRENME:
   - Kullanici sana kendi tercihlerini, rutinlerini, kurallarini veya kisiler hakkindaki bilgileri ogrettiginde \`save_learned_memory\` aracini cagirarak kalici bellege kaydet.
4. GOOGLE WORKSPACE VE IS YAPMA:
   - E-posta kontrolu istendiginde \`check_gmail_inbox\`, takvim soruldugunda \`check_calendar_events\`, Drive soruldugunda \`search_google_drive\` araclarini kullan.
   - E-posta gonderme veya takvim etkinligi olusturma istendiginde \`propose_send_email\` veya \`propose_create_calendar_event\` aracini cagir; kullanici onay penceresinden onaylayacaktir.
   - Hatirlatma veya bildirim istendiginde \`send_browser_notification\` aracini kullan.
   - Derin analiz, gunluk brifing veya karmasik is istendiginde \`run_deep_task\` aracini cagir.

KAYITLI YUZLER:
${facesText}

OGRENILMIS BELLEK:
${memoriesText}`;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "12mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  // Face extraction or identification endpoint using gemini-4-hydrogen
  app.post("/api/vision/analyze-face", async (req, res) => {
    try {
      const { imageBase64, mimeType, mode, knownFaces, personName, relation, notes } = req.body as {
        imageBase64?: string;
        mimeType?: string;
        mode: "register" | "identify";
        knownFaces?: FaceContextItem[];
        personName?: string;
        relation?: string;
        notes?: string;
      };

      if (!imageBase64) {
        return res.status(400).json({ error: "Goruntu verisi eksik." });
      }

      const imagePart = {
        inlineData: {
          mimeType: mimeType || "image/jpeg",
          data: imageBase64,
        },
      };

      if (mode === "register") {
        const prompt = `Bu goruntudeki kisinin yuzunu ve ayirt edici gorunum ozelliklerini analiz et.
Tanitilan kisi: ${personName || "Belirtilmedi"} (${relation || "Belirtilmedi"}).
Ek notlar: ${notes || "Yok"}.
Gorevin: Bu kisiyi gelecekteki kamera veya fotograf karelerinde tekrar taniyabilmemiz icin ayirt edici bir gorsel imza olustur.
Goruntude net bir yuz veya kisi yoksa faceDetected: false dondur.
Turkce olarak yanit ver.`;

        const response = await ai.models.generateContent({
          model: "gemini-4-hydrogen",
          contents: { parts: [imagePart, { text: prompt }] },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                faceDetected: { type: Type.BOOLEAN },
                visualSignature: {
                  type: Type.STRING,
                  description:
                    "Yuz sekli, sac rengi/tarzi, goz/kas yapisi, gozluk/sakal ve belirgin ozelliklerin detayli Turkce ozeti.",
                },
                facialTraits: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "En fazla 8 kisa ayirt edici ozellik etiketi.",
                },
                greetingNote: {
                  type: Type.STRING,
                  description: "Kisi kaydedildikten sonra soylenebilecek kisa Turkce onay cumlesi.",
                },
              },
              required: ["faceDetected", "visualSignature", "facialTraits", "greetingNote"],
            },
          },
        });

        const parsed = JSON.parse((response.text ?? "{}").trim());
        return res.json(parsed);
      }

      // Identify mode
      const candidates = (knownFaces ?? [])
        .map(
          (f) =>
            `ID: ${f.id} | Ad: ${f.name} | Iliski: ${f.relation || "-"} | Imza: ${f.visualSignature} | Ozellikler: ${(f.facialTraits || []).join(", ")}`
        )
        .join("\n");

      const identifyPrompt = `Goruntudeki kisiyi incele ve asagidaki kayitli yuz profilleriyle karsilastir.
Kayitli profiller:
${candidates || "Kayitli profil yok."}

Eger goruntudeki kisi kayitli profillerden biriyle acikca eslesiyorsa matchedFaceId ve matchedName alanlarini doldur.
Eger kimseyle eslesmiyorsa veya goruntude yuz yoksa matchedFaceId bos birak ve nedenini Turkce acikla.`;

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: { parts: [imagePart, { text: identifyPrompt }] },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              faceDetected: { type: Type.BOOLEAN },
              matchedFaceId: { type: Type.STRING },
              matchedName: { type: Type.STRING },
              confidence: { type: Type.STRING, description: "yuksek, orta veya dusuk" },
              reasoning: { type: Type.STRING },
              observedDescription: { type: Type.STRING },
            },
            required: [
              "faceDetected",
              "matchedFaceId",
              "matchedName",
              "confidence",
              "reasoning",
              "observedDescription",
            ],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? "{}").trim());
      return res.json(parsed);
    } catch (error) {
      console.error("Vision face analysis error:", error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Yuz analizi sirasinda hata olustu.",
      });
    }
  });

  // General uploaded photo understanding endpoint using gemini-4-hydrogen
  app.post("/api/vision/analyze-image", async (req, res) => {
    try {
      const { imageBase64, mimeType, question, knownFaces } = req.body as {
        imageBase64?: string;
        mimeType?: string;
        question?: string;
        knownFaces?: FaceContextItem[];
      };

      if (!imageBase64) {
        return res.status(400).json({ error: "Fotograf verisi gerekli." });
      }

      const facesContext =
        knownFaces && knownFaces.length > 0
          ? `Kayitli kisiler:\n${knownFaces
              .map((f) => `- ${f.name} (${f.relation || "Tanidik"}): ${f.visualSignature}`)
              .join("\n")}`
          : "Kayitli yuz profili henuz yok.";

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeType || "image/jpeg",
                data: imageBase64,
              },
            },
            {
              text: `${facesContext}\n\nKullanici sorusu/talimati: ${
                question || "Bu fotografi detayli analiz et, varsa tanidik kisileri belirt ve yapilabilecek isleri cikar."
              }\n\nLutfen net, duzenli ve Turkce yanit ver.`,
            },
          ],
        },
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
      });

      return res.json({ analysis: response.text ?? "Analiz uretilemedi." });
    } catch (error) {
      console.error("Vision image analysis error:", error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Fotograf analizi basarisiz oldu.",
      });
    }
  });

  // Deep thinking task & briefing endpoint (ThinkingLevel.HIGH, no maxOutputTokens)
  app.post("/api/ai/deep-think", async (req, res) => {
    try {
      const { prompt, memories, workspaceSnapshot } = req.body as {
        prompt?: string;
        memories?: MemoryContextItem[];
        workspaceSnapshot?: {
          emails?: unknown[];
          events?: unknown[];
          files?: unknown[];
        };
      };

      if (!prompt) {
        return res.status(400).json({ error: "Gorev istemi gerekli." });
      }

      const memoryContext =
        memories && memories.length > 0
          ? memories.map((m) => `- [${m.category}] ${m.subject}: ${m.content}`).join("\n")
          : "Kayitli ogrenilmis bilgi yok.";

      const workspaceContext = workspaceSnapshot
        ? JSON.stringify(workspaceSnapshot, null, 2)
        : "Workspace verisi saglanmadi.";

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: `Kullanici Bellegi:\n${memoryContext}\n\nGoogle Workspace Ozeti:\n${workspaceContext}\n\nGorev / Analiz Talebi:\n${prompt}`,
        config: {
          systemInstruction:
            "Sen Vega Asistan'in derin dusunme ve is yurutme motorusun. Verilen e-posta, takvim, Drive ve kullanici bellegi verilerini sentezleyerek somut, onceliklendirilmis ve Turkce bir eylem plani olustur. Kisa bir sesli ozet basligi ve detayli analiz sun.",
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "Kisa gorev basligi" },
              spokenSummary: {
                type: Type.STRING,
                description: "Sesli asistanin okuyabilecegi 2-3 cumlelik ozet",
              },
              detailedPlan: {
                type: Type.STRING,
                description: "Detayli analiz, oncelikler ve adimlar",
              },
            },
            required: ["title", "spokenSummary", "detailedPlan"],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? "{}").trim());
      return res.json(parsed);
    } catch (error) {
      console.error("Deep think error:", error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Derin analiz sirasinda hata olustu.",
      });
    }
  });

  // Fast triage endpoint using gemini-3.1-flash-lite
  app.post("/api/ai/fast-triage", async (req, res) => {
    try {
      const { emails } = req.body as {
        emails?: Array<{ id: string; subject: string; from: string; snippet: string }>;
      };

      if (!emails || emails.length === 0) {
        return res.json({ items: [] });
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: `Asagidaki e-postalari onem derecesine gore hizlica siniflandir ve her biri icin 1 cumlelik Turkce eylem onerisi yaz:\n${JSON.stringify(
          emails
        )}`,
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MINIMAL,
          },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    priority: { type: Type.STRING, description: "yuksek, orta veya dusuk" },
                    actionTip: { type: Type.STRING },
                  },
                  required: ["id", "priority", "actionTip"],
                },
              },
            },
            required: ["items"],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? "{}").trim());
      return res.json(parsed);
    } catch (error) {
      console.error("Fast triage error:", error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Hizli siniflandirma basarisiz.",
      });
    }
  });

  // Multi-turn streaming Gemini Chatbot endpoint (ai.chats.create + SSE)
  app.post("/api/chat/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const sendEvent = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const {
        message,
        history,
        botRole,
        userEmail,
        knownFaces,
        memories,
      } = req.body as {
        message?: string;
        history?: Array<{ role: "user" | "model"; text: string }>;
        botRole?: "general" | "deep_reasoning" | "architect" | "fast";
        userEmail?: string;
        knownFaces?: FaceContextItem[];
        memories?: MemoryContextItem[];
      };

      if (!message || !message.trim()) {
        sendEvent({ error: "Mesaj boş olamaz." });
        return res.end();
      }

      const roleConfigMap: Record<
        "general" | "deep_reasoning" | "architect" | "fast",
        { model: string; thinkingLevel: ThinkingLevel; persona: string }
      > = {
        general: {
          model: "gemini-4-hydrogen",
          thinkingLevel: ThinkingLevel.LOW,
          persona:
            "Sen Vega Asistan'ın Genel Sohbet uzmanısın. Günlük soruları, planlamaları, özetlemeleri ve metin düzenlemelerini net, sıcak ve pratik Türkçe ile yanıtlarsın.",
        },
        deep_reasoning: {
          model: "gemini-4-hydrogen",
          thinkingLevel: ThinkingLevel.HIGH,
          persona:
            "Sen Vega Asistan'ın Derin Düşünme ve Analiz uzmanısın. Karmaşık problemleri adım adım irdeler, varsayımları sorgular, riskleri ve alternatifleri tartarak gerekçeli Türkçe çözümler sunarsın.",
        },
        architect: {
          model: "gemini-4-hydrogen",
          thinkingLevel: ThinkingLevel.HIGH,
          persona:
            "Sen Vega Asistan'ın Etkileşimli İş ve Sistem Mimarı'sın. Çok adımlı iş akışları, e-posta/takvim koordinasyonu, teknik mimari kararları ve uygulanabilir kontrol listeleri üretirsin.",
        },
        fast: {
          model: "gemini-3.1-flash-lite",
          thinkingLevel: ThinkingLevel.MINIMAL,
          persona:
            "Sen Vega Asistan'ın Hızlı Yanıt modusun. Kısa, öz, doğrudan sonuca giden Türkçe yanıtlar verirsin.",
        },
      };

      const selected = roleConfigMap[botRole || "general"] || roleConfigMap.general;

      const memoryLines = (memories ?? [])
        .slice(0, 20)
        .map((m) => `- [${m.category}] ${m.subject}: ${m.content}`)
        .join("\n");

      const faceLines = (knownFaces ?? [])
        .slice(0, 15)
        .map((f) => `- ${f.name}${f.relation ? ` (${f.relation})` : ""}`)
        .join("\n");

      const systemInstruction = `${selected.persona}
Aktif kullanıcı: ${userEmail || "Bilinmiyor"}
Bugünün tarihi: ${new Date().toISOString()}

Kayıtlı Yüzler:
${faceLines || "Yok"}

Öğrenilmiş Kullanıcı Belleği:
${memoryLines || "Yok"}

Kurallar: Yanıtlarını kullanıcının dili olan Türkçe ile düzenli, okunaklı ve gerçeğe dayalı şekilde ver.`;

      const formattedHistory = (history ?? [])
        .filter((h) => h && h.text && h.text.trim())
        .slice(-24)
        .map((h) => ({
          role: h.role === "model" ? "model" : "user",
          parts: [{ text: h.text }],
        }));

      const chat = ai.chats.create({
        model: selected.model,
        history: formattedHistory,
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel: selected.thinkingLevel,
          },
        },
      });

      const streamResponse = await chat.sendMessageStream({
        message: message.trim(),
      });

      for await (const chunk of streamResponse) {
        if (chunk.text) {
          sendEvent({ text: chunk.text });
        }
      }

      sendEvent({ done: true, model: selected.model });
      res.end();
    } catch (error) {
      console.error("Chat stream error:", error);
      sendEvent({
        error:
          error instanceof Error ? error.message : "Sohbet yanıtı oluşturulurken hata oluştu.",
      });
      res.end();
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws/live" });

  wss.on("connection", (clientWs: WebSocket) => {
    let liveSession: Awaited<ReturnType<typeof ai.live.connect>> | null = null;
    let isClosing = false;

    const safeSend = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    clientWs.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          userEmail?: string;
          voiceName?: string;
          knownFaces?: FaceContextItem[];
          memories?: MemoryContextItem[];
          audio?: string;
          video?: string;
          responses?: Array<{ id?: string; name?: string; response: Record<string, unknown> }>;
        };

        if (msg.type === "init") {
          const allowedVoices = ["Zephyr", "Kore", "Puck", "Charon", "Fenrir"];
          const selectedVoice = allowedVoices.includes(msg.voiceName || "")
            ? msg.voiceName!
            : "Zephyr";

          const systemInstruction = buildLiveSystemInstruction(
            msg.userEmail || "",
            msg.knownFaces || [],
            msg.memories || []
          );

          liveSession = await ai.live.connect({
            model: "gemini-3.8-live",
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: selectedVoice },
                },
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              tools: [{ functionDeclarations: LIVE_TOOLS }],
              systemInstruction,
            },
            callbacks: {
              onopen: () => {
                safeSend({ type: "ready" });
              },
              onmessage: (message: LiveServerMessage) => {
                const content = message.serverContent;
                if (content?.inputTranscription?.text) {
                  safeSend({
                    type: "input_transcript",
                    text: content.inputTranscription.text,
                  });
                }
                if (content?.outputTranscription?.text) {
                  safeSend({
                    type: "output_transcript",
                    text: content.outputTranscription.text,
                  });
                }
                for (const part of content?.modelTurn?.parts ?? []) {
                  if (part.inlineData?.data) {
                    safeSend({ type: "audio", data: part.inlineData.data });
                  }
                }
                if (content?.interrupted) {
                  safeSend({ type: "interrupted" });
                }
                if (content?.turnComplete) {
                  safeSend({ type: "turn_complete" });
                }
                if (message.toolCall?.functionCalls?.length) {
                  safeSend({
                    type: "tool_call",
                    calls: message.toolCall.functionCalls,
                  });
                }
              },
              onerror: (err) => {
                console.error("Gemini Live error:", err);
                safeSend({
                  type: "error",
                  message: "Canli ses baglantisinda bir sorun olustu.",
                });
              },
              onclose: () => {
                if (!isClosing) {
                  safeSend({ type: "closed" });
                }
              },
            },
          });
          return;
        }

        if (!liveSession) return;

        if (msg.type === "audio" && msg.audio) {
          liveSession.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
          });
        } else if (msg.type === "video" && msg.video) {
          liveSession.sendRealtimeInput({
            video: { data: msg.video, mimeType: "image/jpeg" },
          });
        } else if (msg.type === "tool_response" && msg.responses) {
          liveSession.sendToolResponse({
            functionResponses: msg.responses.map((r) => ({
              id: r.id,
              name: r.name,
              response: r.response,
            })),
          });
        }
      } catch (err) {
        console.error("WebSocket message error:", err);
        safeSend({
          type: "error",
          message: err instanceof Error ? err.message : "Ses akisi islenemedi.",
        });
      }
    });

    clientWs.on("close", () => {
      isClosing = true;
      try {
        liveSession?.close();
      } catch {
        // ignore close errors
      }
      liveSession = null;
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      const indexHtml = path.join(distPath, "index.html");
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send("Build missing.");
      }
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Vega Asistan server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
