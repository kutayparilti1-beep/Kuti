import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { Search, ShieldCheck } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { UserRegistryItem } from '../types';

interface AdminPanelProps {
  adminEmail: string;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({ adminEmail }) => {
  const [entries, setEntries] = useState<UserRegistryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const path = 'user_registry';
    const unsubscribe = onSnapshot(
      collection(db, path),
      (snapshot) => {
        const list = snapshot.docs
          .map((d) => d.data() as UserRegistryItem)
          .filter((item) => Boolean(item.email))
          .sort((a, b) => a.email.localeCompare(b.email, 'tr'));
        setEntries(list);
        setLoading(false);
      },
      (error) => {
        setLoading(false);
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );
    return () => unsubscribe();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((item) => item.email.toLowerCase().includes(q));
  }, [entries, search]);

  return (
    <section className="max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-neutral-800 pb-6">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
            <span>Yönetici Erişimi Doğrulandı</span>
          </div>
          <h1 className="font-display text-2xl font-semibold text-white">
            Uygulama Kullanıcı E-postaları
          </h1>
          <p className="text-sm text-neutral-400">
            Bu sekme yalnızca <span className="text-neutral-200">{adminEmail}</span> için görünür ve
            gizlilik gereği yalnızca kullanıcı e-posta adreslerini listeler.
          </p>
        </div>

        <div className="text-right shrink-0">
          <span className="text-xs text-neutral-500 block">Toplam Kullanıcı</span>
          <span className="font-mono-tabular text-2xl font-semibold text-white">
            {entries.length}
          </span>
        </div>
      </div>

      <div className="relative">
        <Search
          className="w-4 h-4 text-neutral-500 absolute left-3.5 top-1/2 -translate-y-1/2"
          aria-hidden="true"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="E-posta adresine göre filtrele..."
          className="w-full h-11 pl-10 pr-4 text-sm bg-neutral-900 border border-neutral-800 rounded-lg text-white placeholder:text-neutral-500 focus:outline-none focus:border-amber-500 transition-colors"
        />
      </div>

      <div className="border border-neutral-800 bg-neutral-900/60 rounded-xl overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-neutral-800 text-xs text-neutral-400">
              <th className="py-3.5 px-5 font-medium w-16">#</th>
              <th className="py-3.5 px-5 font-medium">Kullanıcı E-posta Adresi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/70 text-sm">
            {loading ? (
              Array.from({ length: 4 }).map((_, idx) => (
                <tr key={idx} className="h-11">
                  <td className="px-5">
                    <div className="h-3.5 w-6 bg-neutral-800 rounded animate-pulse" />
                  </td>
                  <td className="px-5">
                    <div className="h-3.5 w-56 bg-neutral-800 rounded animate-pulse" />
                  </td>
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={2} className="py-10 px-5 text-center text-sm text-neutral-500">
                  {search.trim()
                    ? 'Aramanızla eşleşen e-posta adresi bulunamadı.'
                    : 'Henüz kayıtlı kullanıcı e-postası bulunmuyor.'}
                </td>
              </tr>
            ) : (
              filtered.map((item, idx) => (
                <tr key={item.uid} className="h-11 hover:bg-neutral-800/40 transition-colors">
                  <td className="px-5 font-mono-tabular text-xs text-neutral-500">{idx + 1}</td>
                  <td className="px-5 text-neutral-100 font-medium">{item.email}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};
