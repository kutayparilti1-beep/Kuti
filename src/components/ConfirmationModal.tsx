import React, { useState } from 'react';
import { Calendar, Mail, ShieldAlert, X } from 'lucide-react';
import { PendingMutationAction } from '../types';

interface ConfirmationModalProps {
  action: PendingMutationAction | null;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  action,
  onConfirm,
  onCancel,
}) => {
  const [submitting, setSubmitting] = useState(false);

  if (!action) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-action-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
    >
      <div className="max-w-lg w-full bg-neutral-900 border border-neutral-800 rounded-xl p-6 space-y-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
              {action.type === 'send_email' ? (
                <Mail className="w-5 h-5" aria-hidden="true" />
              ) : (
                <Calendar className="w-5 h-5" aria-hidden="true" />
              )}
            </div>
            <div>
              <h2 id="confirm-action-title" className="font-display text-lg font-semibold text-white">
                {action.type === 'send_email'
                  ? 'E-posta Gönderimini Onayla'
                  : 'Takvim Etkinliği Oluşturmayı Onayla'}
              </h2>
              <p className="text-xs text-neutral-400">
                Google Workspace hesabınızda değişiklik yapılmadan önce onayınız gerekiyor.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Kapat"
            className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg space-y-3 text-sm">
          {action.type === 'send_email' ? (
            <>
              <div>
                <span className="text-xs text-neutral-500 block">Alıcı</span>
                <span className="text-neutral-100 font-medium">{action.to}</span>
              </div>
              <div>
                <span className="text-xs text-neutral-500 block">Konu</span>
                <span className="text-neutral-100 font-medium">{action.subject}</span>
              </div>
              <div>
                <span className="text-xs text-neutral-500 block">İçerik</span>
                <p className="text-neutral-300 whitespace-pre-wrap text-xs leading-relaxed mt-1">
                  {action.body}
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <span className="text-xs text-neutral-500 block">Etkinlik Başlığı</span>
                <span className="text-neutral-100 font-medium">{action.summary}</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-xs text-neutral-500 block">Başlangıç</span>
                  <span className="text-neutral-200 font-mono-tabular text-xs">
                    {new Date(action.startIso).toLocaleString('tr-TR')}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-neutral-500 block">Bitiş</span>
                  <span className="text-neutral-200 font-mono-tabular text-xs">
                    {new Date(action.endIso).toLocaleString('tr-TR')}
                  </span>
                </div>
              </div>
              {action.location && (
                <div>
                  <span className="text-xs text-neutral-500 block">Konum</span>
                  <span className="text-neutral-300 text-xs">{action.location}</span>
                </div>
              )}
              {action.description && (
                <div>
                  <span className="text-xs text-neutral-500 block">Açıklama</span>
                  <p className="text-neutral-300 text-xs mt-1">{action.description}</p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-amber-300/90">
          <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>Bu işlem yalnızca siz onayladığınızda Google hesabınıza işlenir.</span>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-neutral-300 bg-neutral-800 rounded-lg hover:bg-neutral-700 transition-colors cursor-pointer"
          >
            İptal Et
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {submitting
              ? 'Uygulanıyor...'
              : action.type === 'send_email'
              ? 'Onayla ve Gönder'
              : 'Onayla ve Oluştur'}
          </button>
        </div>
      </div>
    </div>
  );
};
