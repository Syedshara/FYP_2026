import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

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
    try { await login(username, password); navigate('/'); }
    catch { setError('Invalid username or password'); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#ffffff' }}>
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        style={{ width: '100%', maxWidth: 400, padding: 32 }}
      >
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: '#1a1a1a', marginBottom: 4, fontFamily: 'inherit' }}>
            IoT IDS Platform
          </h1>
          <p style={{ fontSize: 12, color: '#999' }}>Sign in</p>
        </div>

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
              placeholder="Enter your username" required autoFocus
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 2,
                border: '1px solid #e0e0e0', background: '#f7f7f7',
                color: '#1a1a1a', fontSize: 13, outline: 'none',
                fontFamily: 'inherit',
              }}
              onFocus={(e) => { e.target.style.borderColor = '#1a1a1a'; }}
              onBlur={(e) => { e.target.style.borderColor = '#e0e0e0'; }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#4a4a4a', marginBottom: 6 }}>Password</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'} value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password" required
                style={{
                  width: '100%', padding: '10px 44px 10px 12px', borderRadius: 2,
                  border: '1px solid #e0e0e0', background: '#f7f7f7',
                  color: '#1a1a1a', fontSize: 13, outline: 'none',
                  fontFamily: 'inherit',
                }}
                onFocus={(e) => { e.target.style.borderColor = '#1a1a1a'; }}
                onBlur={(e) => { e.target.style.borderColor = '#e0e0e0'; }}
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

          <button
            type="submit" disabled={isLoading}
            style={{
              width: '100%', padding: '10px 0', borderRadius: 2,
              background: '#1a1a1a', color: '#fff',
              fontSize: 13, fontWeight: 500, border: 'none',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.7 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { if (!isLoading) e.currentTarget.style.background = '#333'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#1a1a1a'; }}
          >
            {isLoading && <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} />}
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: '#999' }}>
          Don't have an account?{' '}
          <Link to="/register" style={{ color: '#1a1a1a', fontWeight: 500, textDecoration: 'none' }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            Register
          </Link>
        </p>
        <p style={{ textAlign: 'center', marginTop: 6, fontSize: 10, color: '#999' }}>
          Default: <span style={{ color: '#4a4a4a' }}>admin</span> / <span style={{ color: '#4a4a4a' }}>admin123</span>
        </p>
      </motion.div>
    </div>
  );
}
