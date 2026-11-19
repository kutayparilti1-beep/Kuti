import React, { useState } from 'react';
import { User } from 'firebase/auth';
import { AlertCircle, CheckCircle2, Lock, Mail, RefreshCw } from 'lucide-react';
import {
  logoutUser,
  registerWithEmail,
  reloadCurrentUser,
  resendVerificationEmail,
  resetPasswordEmail,
  signInWithEmail,
  signInWithGoogleWorkspace,
} from '../firebase';

interface AuthGateProps {
  onAuthSuccess: (user: User, workspaceToken: string | null) => void;
}

function translateAuthError(error: unknown): string {
  const code = (error as { code?: string })?.code || '';
  const msg = error instanceof Error ? error.message : String(error);

  if (code === 'auth/operation-not-allowed') {
    return 'E-posta/Şifre girişi Firebase projenizde henüz etkinleştirilmemiş. Firebase Console > Authentication > Sign-in method bölümünden "Email/Password" sağlayıcısını açabilir veya hemen yukarıdaki Google ile Giriş Yap butonunu kullanabilirsiniz.';
  }
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'E-posta adresi veya şifre hatalı.';
  }
  if (code === 'auth/email-already-in-use') {
    return 'Bu e-posta adresi ile zaten kayıtlı bir hesap var.';
  }
  if (code === 'auth/weak-password') {
    return 'Şifre en az 6 karakter olmalıdır.';
  }
  if (code === 'auth/invalid-email') {
    return 'Lütfen geçerli bir e-posta adresi girin.';
  }
  if (code === 'auth/popup-closed-by-user') {
    return 'Google giriş penceresi kapatıldı. Lütfen tekrar deneyin.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Çok fazla deneme yapıldı. Lütfen biraz bekleyip tekrar deneyin.';
  }
  return msg || 'Giriş sırasında bir hata oluştu.';
}

export const AuthGate: React.FC<AuthGateProps> = ({ onAuthSuccess }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);

  const handleGoogleLogin = async () => {
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const { user, accessToken } = await signInWithGoogleWorkspace();
      onAuthSuccess(user, accessToken);
    } catch (err) {
      setError(translateAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!email.trim() || !password) {
      setError('Lütfen e-posta ve şifre alanlarını doldurun.');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'login') {
        const user = await signInWithEmail(email, password);
        onAuthSuccess(user, null);
      } else {
        const user = await registerWithEmail(email, password);
        setInfo('Hesabınız oluşturuldu ve doğrulama bağlantısı e-postanıza gönderildi.');
        onAuthSuccess(user, null);
      }
    } catch (err) {
      setError(translateAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError(null);
    setInfo(null);
    if (!email.trim()) {
      setError('Şifre sıfırlama bağlantısı için önce e-posta adresinizi yazın.');
      return;
    }
    setLoading(true);
    try {
      await resetPasswordEmail(email);
      setInfo('Şifre sıfırlama bağlantısı e-posta adresinize gönderildi.');
    } catch (err) {
      setError(translateAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 grid lg:grid-cols-2 items-stretch">
      {/* Left: Sign-In Form */}
      <div className="flex flex-col justify-between p-8 sm:p-12 lg:p-16 border-b lg:border-b-0 lg:border-r border-neutral-800/80">
        <div className="flex items-center justify-between">
          <span className="font-display text-xl font-semibold tracking-tight text-white">
            Vega Asistan
          </span>
          <span className="text-xs text-neutral-500 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" aria-hidden="true" />
            Güvenli Erişim
          </span>
        </div>

        <div className="max-w-md w-full mx-auto my-12 space-y-8">
          <div className="space-y-3">
            <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-white [text-wrap:balance]">
              Sesle yönetin, yüzleri tanıyın ve işlerinizi hızlandırın.
            </h1>
            <p className="text-sm text-neutral-400 leading-relaxed">
              Sesli yapay zeka asistanınızı kullanmak, yüz belleğinize erişmek ve Google Workspace
              hesabınızı yönetmek için oturum açın.
            </p>
          </div>

          {/* Official Google Sign-In Button */}
          <div className="space-y-4">
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={loading}
              className="gsi-material-button"
            >
              <div className="gsi-material-button-content-wrapper">
                <div className="gsi-material-button-icon">
                  <svg
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 48 48"
                    style={{ display: 'block' }}
                  >
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    />
                    <path fill="none" d="M0 0h48v48H0z" />
                  </svg>
                </div>
                <span className="gsi-material-button-contents">Google ile Giriş Yap</span>
              </div>
            </button>
            <p className="text-xs text-neutral-500 text-center">
              Google ile giriş yaptığınızda Gmail, Takvim ve Drive erişimi tek adımda bağlanır.
            </p>
          </div>

          <div className="relative flex items-center py-1">
            <div className="flex-grow border-t border-neutral-800" />
            <span className="mx-4 text-xs text-neutral-500 shrink-0">veya e-posta ile</span>
            <div className="flex-grow border-t border-neutral-800" />
          </div>

          {/* Email / Password Tabs */}
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-1 p-1 bg-neutral-900 border border-neutral-800 rounded-lg">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                  setInfo(null);
                }}
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  mode === 'login'
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Giriş Yap
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError(null);
                  setInfo(null);
                }}
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  mode === 'register'
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Kayıt Ol
              </button>
            </div>

            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="auth-email" className="block text-xs font-medium text-neutral-300">
                  E-posta Adresi
                </label>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ornek@alanadi.com"
                  autoComplete="email"
                  className="w-full h-11 px-3.5 text-sm bg-neutral-900 border border-neutral-800 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none focus:border-amber-500 transition-colors"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="auth-password" className="block text-xs font-medium text-neutral-300">
                    Şifre
                  </label>
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={handleForgotPassword}
                      className="text-xs text-neutral-400 hover:text-amber-400 transition-colors cursor-pointer"
                    >
                      Şifremi unuttum
                    </button>
                  )}
                </div>
                <input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="En az 6 karakter"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  className="w-full h-11 px-3.5 text-sm bg-neutral-900 border border-neutral-800 rounded-lg text-white placeholder:text-neutral-600 focus:outline-none focus:border-amber-500 transition-colors"
                />
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 p-3.5 text-xs text-red-200 bg-red-950/50 border border-red-900/70 rounded-lg leading-relaxed"
                >
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}

              {info && (
                <div className="flex items-start gap-2.5 p-3.5 text-xs text-emerald-200 bg-emerald-950/50 border border-emerald-900/70 rounded-lg leading-relaxed">
                  <CheckCircle2
                    className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span>{info}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 px-4 text-sm font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {loading
                  ? 'İşleniyor...'
                  : mode === 'login'
                  ? 'E-posta ile Giriş Yap'
                  : 'Hesap Oluştur'}
              </button>
            </form>
          </div>
        </div>

        <p className="text-xs text-neutral-600">
          Oturum açılmadan sesli asistan, kamera analizi ve veritabanı özellikleri kilitlidir.
        </p>
      </div>

      {/* Right: Architectural Visual Panel */}
      <div className="relative hidden lg:flex flex-col justify-end overflow-hidden bg-neutral-900">
        {!imageError ? (
          <img
            src="/src/assets/images/vega_acoustic_glass_1795106246725.jpg"
            alt="Vega Asistan akustik cam ve titanyum heykeli"
            referrerPolicy="no-referrer"
            onError={() => setImageError(true)}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-neutral-900 via-neutral-950 to-amber-950/30" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 via-neutral-950/45 to-transparent" />

        <div className="relative z-10 p-14 max-w-xl space-y-5">
          <p className="text-xs font-medium text-amber-400">
            Gerçek Zamanlı Ses · Yüz Belleği · Google Workspace
          </p>
          <h2 className="font-display text-2xl font-semibold text-white leading-snug [text-wrap:balance]">
            Tanıttığınız kişileri yüzünden hatırlayan, tercihinizi öğrenen ve işlerinizi sesle
            yürüten kişisel çalışma ortamı.
          </h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-300 pt-2 border-t border-white/10">
            <span>Canlı Sesli Sohbet</span>
            <span aria-hidden="true">·</span>
            <span>Kamera & Fotoğraf Yüz Tanıma</span>
            <span aria-hidden="true">·</span>
            <span>Gmail & Takvim Bildirimleri</span>
          </div>
        </div>
      </div>
    </div>
  );
};

interface EmailVerificationGateProps {
  user: User;
  onVerified: (updatedUser: User) => void;
}

export const EmailVerificationGate: React.FC<EmailVerificationGateProps> = ({
  user,
  onVerified,
}) => {
  const [checking, setChecking] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const updated = await reloadCurrentUser();
      if (updated && updated.emailVerified) {
        onVerified(updated);
      } else {
        setError('E-posta adresiniz henüz doğrulanmamış görünüyor. Gelen kutunuzdaki bağlantıya tıklayın.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Doğrulama kontrol edilemedi.');
    } finally {
      setChecking(false);
    }
  };

  const handleResend = async () => {
    setError(null);
    try {
      await resendVerificationEmail();
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'E-posta gönderilemedi.');
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full border border-neutral-800 bg-neutral-900 rounded-xl p-8 space-y-6">
        <div className="w-11 h-11 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
          <Mail className="w-5 h-5" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <h1 className="font-display text-xl font-semibold text-white">
            E-posta Doğrulaması Gerekli
          </h1>
          <p className="text-sm text-neutral-400 leading-relaxed">
            Güvenliğiniz ve kalıcı yüz/bellek veritabanı erişimi için{' '}
            <span className="text-neutral-200 font-medium">{user.email}</span> adresine gönderilen
            doğrulama bağlantısını onaylayın.
          </p>
        </div>

        {error && (
          <div className="p-3 text-xs text-red-200 bg-red-950/60 border border-red-900 rounded-lg">
            {error}
          </div>
        )}
        {sent && (
          <div className="p-3 text-xs text-emerald-200 bg-emerald-950/60 border border-emerald-900 rounded-lg">
            Doğrulama e-postası yeniden gönderildi.
          </div>
        )}

        <div className="space-y-3">
          <button
            type="button"
            onClick={handleCheck}
            disabled={checking}
            className="w-full h-11 px-4 flex items-center justify-center gap-2 text-sm font-medium bg-amber-500 text-neutral-950 rounded-lg hover:bg-amber-400 transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
            Doğrulamayı Kontrol Et
          </button>

          <button
            type="button"
            onClick={handleResend}
            className="w-full h-10 px-4 text-xs font-medium text-neutral-300 bg-neutral-800 rounded-lg hover:bg-neutral-700 transition-colors cursor-pointer"
          >
            Doğrulama Bağlantısını Tekrar Gönder
          </button>

          <button
            type="button"
            onClick={() => void logoutUser()}
            className="w-full h-10 px-4 text-xs font-medium text-neutral-400 hover:text-white transition-colors cursor-pointer"
          >
            Farklı Hesapla Giriş Yap
          </button>
        </div>
      </div>
    </div>
  );
};
