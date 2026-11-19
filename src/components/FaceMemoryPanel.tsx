import React, { useState } from 'react';
import { User } from 'firebase/auth';
import { deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { Brain, ImagePlus, ScanFace, Trash2, UserPlus } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { KnownFace, LearnedMemory, MemoryCategory } from '../types';

interface FaceMemoryPanelProps {
  user: User;
  knownFaces: KnownFace[];
  memories: LearnedMemory[];
}

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: 'Tercih',
  person_fact: 'Kişi Bilgisi',
  routine: 'Rutin',
  instruction: 'Özel Talimat',
  workspace_note: 'İş Notu',
};

export const FaceMemoryPanel: React.FC<FaceMemoryPanelProps> = ({
  user,
  knownFaces,
  memories,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageQuestion, setImageQuestion] = useState('');
  const [analysisText, setAnalysisText] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const [photoPersonName, setPhotoPersonName] = useState('');
  const [photoPersonRelation, setPhotoPersonRelation] = useState('');
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [newMemSubject, setNewMemSubject] = useState('');
  const [newMemContent, setNewMemContent] = useState('');
  const [newMemCategory, setNewMemCategory] = useState<MemoryCategory>('preference');
  const [savingMem, setSavingMem] = useState(false);

  const fileToBase64 = (file: File): Promise<{ base64: string; mimeType: string }> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const base64 = result.split(',')[1] || '';
        resolve({ base64, mimeType: file.type || 'image/jpeg' });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setAnalysisText(null);
    setPhotoError(null);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
  };

  const handleAnalyzePhoto = async () => {
    if (!selectedFile) return;
    setAnalyzing(true);
    setPhotoError(null);
    try {
      const { base64, mimeType } = await fileToBase64(selectedFile);
      const res = await fetch('/api/vision/analyze-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType,
          question: imageQuestion.trim() || undefined,
          knownFaces: knownFaces.map((f) => ({
            id: f.id,
            name: f.name,
            relation: f.relation,
            visualSignature: f.visualSignature,
          })),
        }),
      });
      const data = (await res.json()) as { analysis?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Fotoğraf analizi başarısız.');
      setAnalysisText(data.analysis || '');
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Fotoğraf incelenemedi.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleTeachFromPhoto = async () => {
    if (!selectedFile || !photoPersonName.trim()) {
      setPhotoError('Fotoğraf seçin ve kişinin adını yazın.');
      return;
    }
    setAnalyzing(true);
    setPhotoError(null);
    try {
      const { base64, mimeType } = await fileToBase64(selectedFile);
      const res = await fetch('/api/vision/analyze-face', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'register',
          imageBase64: base64,
          mimeType,
          personName: photoPersonName.trim(),
          relation: photoPersonRelation.trim(),
          notes: imageQuestion.trim(),
        }),
      });
      const data = (await res.json()) as {
        faceDetected?: boolean;
        visualSignature?: string;
        facialTraits?: string[];
        greetingNote?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Yüz kaydedilemedi.');
      if (!data.faceDetected || !data.visualSignature) {
        setPhotoError('Yüklenen fotoğrafta net bir yüz tespit edilemedi.');
        return;
      }

      const faceId = `face_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const path = `users/${user.uid}/known_faces/${faceId}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'known_faces', faceId), {
          id: faceId,
          ownerId: user.uid,
          name: photoPersonName.trim().slice(0, 80),
          relation: photoPersonRelation.trim().slice(0, 120),
          visualSignature: data.visualSignature.slice(0, 1500),
          facialTraits: (data.facialTraits || []).slice(0, 12).map((t) => t.slice(0, 80)),
          learnedNotes: imageQuestion.trim().slice(0, 1000),
          recognitionCount: 1,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }

      setAnalysisText(data.greetingNote || `${photoPersonName} başarıyla öğrenildi.`);
      setPhotoPersonName('');
      setPhotoPersonRelation('');
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'Kişi öğretilemedi.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDeleteFace = async (faceId: string) => {
    const path = `users/${user.uid}/known_faces/${faceId}`;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'known_faces', faceId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemSubject.trim() || !newMemContent.trim()) return;
    setSavingMem(true);
    const memoryId = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const path = `users/${user.uid}/memories/${memoryId}`;
    try {
      await setDoc(doc(db, 'users', user.uid, 'memories', memoryId), {
        id: memoryId,
        ownerId: user.uid,
        category: newMemCategory,
        subject: newMemSubject.trim().slice(0, 120),
        content: newMemContent.trim().slice(0, 1000),
        source: 'vision',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNewMemSubject('');
      setNewMemContent('');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    } finally {
      setSavingMem(false);
    }
  };

  const handleDeleteMemory = async (memoryId: string) => {
    const path = `users/${user.uid}/memories/${memoryId}`;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'memories', memoryId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  };

  return (
    <div className="space-y-8">
      {/* Photo Upload & Image Understanding Section */}
      <section className="border border-neutral-800 bg-neutral-900/50 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-800 pb-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-white">
              Fotoğraf Analizi ve Fotoğraftan Yüz Öğretme
            </h2>
            <p className="text-xs text-neutral-400 mt-0.5">
              Yüklediğiniz fotoğrafı derin analiz edin, kayıtlı kişileri otomatik tespit edin veya
              yeni bir kişiyi adıyla öğretin.
            </p>
          </div>
          <label className="h-10 px-4 inline-flex items-center gap-2 text-xs font-medium bg-neutral-800 text-neutral-100 rounded-lg hover:bg-neutral-700 transition-colors cursor-pointer shrink-0">
            <ImagePlus className="w-4 h-4" aria-hidden="true" />
            Fotoğraf Yükle
            <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
          </label>
        </div>

        <div className="grid lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5">
            <div className="aspect-[4/3] rounded-lg overflow-hidden bg-neutral-950 border border-neutral-800 flex items-center justify-center">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Yüklenen fotoğraf önizlemesi"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-center p-6 space-y-2">
                  <ScanFace className="w-8 h-8 text-neutral-600 mx-auto" aria-hidden="true" />
                  <p className="text-xs text-neutral-500">
                    Analiz için bir fotoğraf dosyası seçin.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-7 space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs text-neutral-300">
                Analiz Sorusu veya Not (İsteğe bağlı)
              </label>
              <input
                type="text"
                value={imageQuestion}
                onChange={(e) => setImageQuestion(e.target.value)}
                placeholder="Örn: Bu fotoğrafta kim var? veya Belgedeki görevleri çıkar."
                className="w-full h-10 px-3.5 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <input
                type="text"
                value={photoPersonName}
                onChange={(e) => setPhotoPersonName(e.target.value)}
                placeholder="Öğretilecek kişinin adı"
                className="h-10 px-3.5 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none focus:border-amber-500"
              />
              <input
                type="text"
                value={photoPersonRelation}
                onChange={(e) => setPhotoPersonRelation(e.target.value)}
                placeholder="İlişki / rol (örn: Takım Lideri)"
                className="h-10 px-3.5 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleAnalyzePhoto}
                disabled={!selectedFile || analyzing}
                className="h-10 px-4 text-xs font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 disabled:opacity-40 transition-colors cursor-pointer"
              >
                {analyzing ? 'İnceleniyor...' : 'Fotoğrafı Analiz Et'}
              </button>
              <button
                type="button"
                onClick={handleTeachFromPhoto}
                disabled={!selectedFile || !photoPersonName.trim() || analyzing}
                className="h-10 px-4 inline-flex items-center gap-1.5 text-xs font-medium bg-neutral-800 text-neutral-100 rounded-lg hover:bg-neutral-700 disabled:opacity-40 transition-colors cursor-pointer"
              >
                <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
                Fotoğraftan Yüzü Öğret
              </button>
            </div>

            {photoError && (
              <div className="p-3 text-xs text-red-200 bg-red-950/50 border border-red-900 rounded-lg">
                {photoError}
              </div>
            )}

            {analysisText && (
              <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">
                {analysisText}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Two-Column Face Profiles & Learned Memories */}
      <div className="grid lg:grid-cols-2 gap-6 items-start">
        {/* Known Faces */}
        <section className="border border-neutral-800 bg-neutral-900/50 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <ScanFace className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <h2 className="font-display text-lg font-semibold text-white">Yüz Belleği</h2>
            </div>
            <span className="font-mono-tabular text-xs text-neutral-400">
              {knownFaces.length} kişi
            </span>
          </div>

          {knownFaces.length === 0 ? (
            <p className="text-sm text-neutral-500 py-6">
              Henüz kayıtlı yüz yok. Kamerada veya fotoğrafta bir kişiyi adıyla tanıtın.
            </p>
          ) : (
            <div className="divide-y divide-neutral-800/80">
              {knownFaces.map((face) => (
                <article key={face.id} className="py-4 first:pt-1 last:pb-1 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-white">{face.name}</h3>
                      <div className="text-xs text-neutral-400 flex flex-wrap items-center gap-x-2 mt-0.5">
                        {face.relation && <span>{face.relation}</span>}
                        {face.relation && <span aria-hidden="true">·</span>}
                        <span className="font-mono-tabular">
                          {face.recognitionCount} kez tanındı
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteFace(face.id)}
                      aria-label={`${face.name} yüzünü sil`}
                      className="p-1.5 text-neutral-500 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="text-xs text-neutral-300 leading-relaxed">{face.visualSignature}</p>
                  {face.facialTraits.length > 0 && (
                    <p className="text-xs text-neutral-500">
                      {face.facialTraits.join(' · ')}
                    </p>
                  )}
                  {face.learnedNotes && (
                    <p className="text-xs text-amber-300/90">Not: {face.learnedNotes}</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Learned Memories */}
        <section className="border border-neutral-800 bg-neutral-900/50 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <h2 className="font-display text-lg font-semibold text-white">Öğrenilen Bilgiler</h2>
            </div>
            <span className="font-mono-tabular text-xs text-neutral-400">
              {memories.length} kayıt
            </span>
          </div>

          <form onSubmit={handleAddMemory} className="space-y-2.5 pb-3 border-b border-neutral-800">
            <div className="grid grid-cols-3 gap-2">
              <select
                value={newMemCategory}
                onChange={(e) => setNewMemCategory(e.target.value as MemoryCategory)}
                className="h-9 px-2.5 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-200 focus:outline-none focus:border-amber-500"
              >
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={newMemSubject}
                onChange={(e) => setNewMemSubject(e.target.value)}
                placeholder="Konu başlığı"
                className="col-span-2 h-9 px-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none focus:border-amber-500"
              />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newMemContent}
                onChange={(e) => setNewMemContent(e.target.value)}
                placeholder="Vega'nın hatırlamasını istediğiniz kural veya bilgi..."
                className="flex-1 h-9 px-3 text-xs bg-neutral-950 border border-neutral-800 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none focus:border-amber-500"
              />
              <button
                type="submit"
                disabled={savingMem || !newMemSubject.trim() || !newMemContent.trim()}
                className="h-9 px-4 text-xs font-medium bg-neutral-800 text-white rounded-lg hover:bg-neutral-700 disabled:opacity-40 cursor-pointer shrink-0"
              >
                Ekle
              </button>
            </div>
          </form>

          {memories.length === 0 ? (
            <p className="text-sm text-neutral-500 py-4">
              Sesli konuşurken öğrettiğiniz tercihler ve kurallar burada birikir.
            </p>
          ) : (
            <div className="divide-y divide-neutral-800/80 max-h-[420px] overflow-y-auto">
              {memories.map((mem) => (
                <article key={mem.id} className="py-3.5 first:pt-1 last:pb-1 space-y-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-xs text-amber-400">
                        {CATEGORY_LABELS[mem.category] || mem.category}
                      </span>
                      <h3 className="text-sm font-medium text-white">{mem.subject}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteMemory(mem.id)}
                      aria-label={`${mem.subject} bilgisini sil`}
                      className="p-1 text-neutral-500 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="text-xs text-neutral-300 leading-relaxed">{mem.content}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
