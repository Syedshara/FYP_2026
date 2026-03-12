import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authApi } from '@/api/auth';
import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

const FONT = 'JetBrains Mono, monospace';

export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPw) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      await authApi.register({ username, email, password });
      setSuccess(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid #3c3c3c', background: '#1c1c1c',
    color: '#ececec', fontSize: 13, outline: 'none',
    fontFamily: FONT,
  };

  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = '#ff6d5a';
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = '#3c3c3c';
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#18191c' }}>
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        style={{
          width: '100%', maxWidth: 420, padding: 32,
          background: '#2d2d2d', border: '1px solid #3c3c3c', borderRadius: 12,
        }}
      >
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: '#ececec', marginBottom: 4, fontFamily: FONT }}>
            Create Account
          </h1>
          <p style={{ fontSize: 12, color: '#888888', fontFamily: FONT }}>Register for a new security dashboard account</p>
        </div>

        {success ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
            style={{
              padding: 24, borderRadius: 8, textAlign: 'center',
              background: '#1c1c1c', border: '1px solid #3c3c3c',
            }}
          >
            <p style={{ fontSize: 14, fontWeight: 600, color: '#18a058', marginBottom: 4, fontFamily: FONT }}>Account Created!</p>
            <p style={{ fontSize: 12, color: '#888888', fontFamily: FONT }}>Redirecting to login...</p>
          </motion.div>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && (
              <div style={{
                padding: '8px 12px', marginBottom: 16, fontSize: 12, fontFamily: FONT,
                background: 'rgba(208,48,80,0.1)', color: '#d03050',
                border: '1px solid rgba(208,48,80,0.3)', borderRadius: 8,
              }}>
                {error}
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888888', marginBottom: 6, fontFamily: FONT }}>Username</label>
              <input
                type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="Choose a username" required autoFocus
                style={inputStyle} onFocus={onFocus} onBlur={onBlur}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888888', marginBottom: 6, fontFamily: FONT }}>Email</label>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email" required
                style={inputStyle} onFocus={onFocus} onBlur={onBlur}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888888', marginBottom: 6, fontFamily: FONT }}>Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'} value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Create a password (min 6 chars)" required
                  style={{ ...inputStyle, paddingRight: 44 }} onFocus={onFocus} onBlur={onBlur}
                />
                <button
                  type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-0 top-0 h-full flex items-center justify-center"
                  style={{ width: 40, background: 'none', border: 'none', color: '#888888', cursor: 'pointer', fontSize: 11, fontFamily: FONT }}
                >
                  {showPw ? 'hide' : 'show'}
                </button>
              </div>
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#888888', marginBottom: 6, fontFamily: FONT }}>Confirm Password</label>
              <input
                type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)}
                placeholder="Re-enter your password" required
                style={inputStyle} onFocus={onFocus} onBlur={onBlur}
              />
            </div>

            <button
              type="submit" disabled={loading}
              style={{
                width: '100%', padding: '10px 0', borderRadius: 8,
                background: '#ff6d5a', color: '#fff',
                fontSize: 13, fontWeight: 500, border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                fontFamily: FONT,
              }}
              onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = '#e05a48'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#ff6d5a'; }}
            >
              {loading && <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />}
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>
        )}

        <p style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: '#888888', fontFamily: FONT }}>
          Already have an account?{' '}
          <Link to="/login" style={{ color: '#ff6d5a', fontWeight: 500, textDecoration: 'none' }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            Sign in
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
