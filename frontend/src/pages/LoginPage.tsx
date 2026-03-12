import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

const FONT = 'JetBrains Mono, monospace';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const { login, isLoading } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try { await login(username, password); navigate('/workspace'); }
    catch { setError('Invalid username or password'); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#18191c' }}>
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        style={{
          width: '100%', maxWidth: 400, padding: 32,
          background: '#2d2d2d', border: '1px solid #3c3c3c', borderRadius: 12,
        }}
      >
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: '#ececec', marginBottom: 4, fontFamily: FONT }}>
            IoT IDS Platform
          </h1>
          <p style={{ fontSize: 12, color: '#888888', fontFamily: FONT }}>Sign in</p>
        </div>

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
              placeholder="Enter your username" required autoFocus
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 8,
                border: '1px solid #3c3c3c', background: '#1c1c1c',
                color: '#ececec', fontSize: 13, outline: 'none',
                fontFamily: FONT,
              }}
              onFocus={(e) => { e.target.style.borderColor = '#ff6d5a'; }}
              onBlur={(e) => { e.target.style.borderColor = '#3c3c3c'; }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#888888', marginBottom: 6, fontFamily: FONT }}>Password</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'} value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password" required
                style={{
                  width: '100%', padding: '10px 44px 10px 12px', borderRadius: 8,
                  border: '1px solid #3c3c3c', background: '#1c1c1c',
                  color: '#ececec', fontSize: 13, outline: 'none',
                  fontFamily: FONT,
                }}
                onFocus={(e) => { e.target.style.borderColor = '#ff6d5a'; }}
                onBlur={(e) => { e.target.style.borderColor = '#3c3c3c'; }}
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

          <button
            type="submit" disabled={isLoading}
            style={{
              width: '100%', padding: '10px 0', borderRadius: 8,
              background: '#ff6d5a', color: '#fff',
              fontSize: 13, fontWeight: 500, border: 'none',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.7 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              fontFamily: FONT,
            }}
            onMouseEnter={(e) => { if (!isLoading) e.currentTarget.style.background = '#e05a48'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#ff6d5a'; }}
          >
            {isLoading && <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />}
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: '#888888', fontFamily: FONT }}>
          Don't have an account?{' '}
          <Link to="/register" style={{ color: '#ff6d5a', fontWeight: 500, textDecoration: 'none' }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            Register
          </Link>
        </p>
        <p style={{ textAlign: 'center', marginTop: 6, fontSize: 10, color: '#888888', fontFamily: FONT }}>
          Default: <span style={{ color: '#ececec' }}>admin</span> / <span style={{ color: '#ececec' }}>admin123</span>
        </p>
      </motion.div>
    </div>
  );
}
