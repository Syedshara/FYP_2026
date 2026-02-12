import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { authApi } from '@/api/auth';
import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

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
    width: '100%', padding: '10px 12px', borderRadius: 2,
    border: '1px solid #e0e0e0', background: '#f7f7f7',
    color: '#1a1a1a', fontSize: 13, outline: 'none',
    fontFamily: 'inherit',
  };

  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = '#1a1a1a';
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = '#e0e0e0';
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#ffffff' }}>
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        style={{ width: '100%', maxWidth: 420, padding: 32 }}
      >
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: '#1a1a1a', marginBottom: 4, fontFamily: 'inherit' }}>
            Create Account
          </h1>
          <p style={{ fontSize: 12, color: '#999' }}>Register for a new security dashboard account</p>
        </div>

        {success ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
            style={{
              padding: 24, borderRadius: 2, textAlign: 'center',
              background: '#f7f7f7', border: '1px solid #e0e0e0',
            }}
          >
            <p style={{ fontSize: 14, fontWeight: 600, color: '#1a1a1a', marginBottom: 4 }}>Account Created!</p>
            <p style={{ fontSize: 12, color: '#999' }}>Redirecting to login...</p>
          </motion.div>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && (
              <div style={{
                padding: '8px 12px', marginBottom: 16, fontSize: 12,
                background: 'rgba(197,48,48,.07)', color: '#c53030',
                border: '1px solid rgba(197,48,48,.2)', borderRadius: 2,
              }}>
                {error}
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#4a4a4a', marginBottom: 6 }}>Username</label>
              <input
                type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="Choose a username" required autoFocus
                style={inputStyle} onFocus={onFocus} onBlur={onBlur}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#4a4a4a', marginBottom: 6 }}>Email</label>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email" required
                style={inputStyle} onFocus={onFocus} onBlur={onBlur}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#4a4a4a', marginBottom: 6 }}>Password</label>
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
                  style={{ width: 40, background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}
                >
                  {showPw ? 'hide' : 'show'}
                </button>
              </div>
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#4a4a4a', marginBottom: 6 }}>Confirm Password</label>
              <input
                type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)}
                placeholder="Re-enter your password" required
                style={inputStyle} onFocus={onFocus} onBlur={onBlur}
              />
            </div>

            <button
              type="submit" disabled={loading}
              style={{
                width: '100%', padding: '10px 0', borderRadius: 2,
                background: '#1a1a1a', color: '#fff',
                fontSize: 13, fontWeight: 500, border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = '#333'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#1a1a1a'; }}
            >
              {loading && <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />}
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>
        )}

        <p style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: '#999' }}>
          Already have an account?{' '}
          <Link to="/login" style={{ color: '#1a1a1a', fontWeight: 500, textDecoration: 'none' }}
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
