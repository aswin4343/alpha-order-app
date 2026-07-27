import { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import appIcon from '../assets/app_icon.png'

// Simple username-style login. Reps enter e.g. "rep1"; we append the domain
// so they never have to type the full internal email address.
const LOGIN_DOMAIN = '@alpha.app'

export default function LoginScreen() {
  const { signIn } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    const u = username.trim().toLowerCase()
    if (!u || !password) {
      setError('Enter username and password')
      return
    }
    // Allow either a bare username or a full email.
    const email = u.includes('@') ? u : u + LOGIN_DOMAIN
    setBusy(true)
    const err = await signIn(email, password)
    setBusy(false)
    if (err) setError('Invalid username or password')
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
      <div className="w-full max-w-sm">
        <img
          src={appIcon}
          alt="Alpha Trade Links"
          className="h-20 w-20 rounded-3xl object-contain mx-auto mb-5"
        />
        <h1 className="text-xl font-bold text-slate-800 text-center">Alpha Trade Links</h1>
        <p className="text-sm text-slate-500 text-center mt-1 mb-8">Sign in to continue</p>

        <label className="block text-sm font-medium text-slate-600 mb-1.5">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          autoComplete="username"
          placeholder="e.g. rep1"
          className="w-full rounded-xl border border-slate-200 px-4 py-3.5 outline-none focus:border-brand-500 mb-4"
        />

        <label className="block text-sm font-medium text-slate-600 mb-1.5">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoComplete="current-password"
          placeholder="Password"
          className="w-full rounded-xl border border-slate-200 px-4 py-3.5 outline-none focus:border-brand-500 mb-6"
        />

        {error && <p className="text-sm text-red-500 text-center mb-4">{error}</p>}

        <button
          onClick={submit}
          disabled={busy}
          className="w-full rounded-xl bg-brand-600 text-white py-4 font-bold active:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400"
        >
          {busy ? 'Signing in…' : 'Sign In'}
        </button>

        <p className="text-xs text-slate-400 text-center mt-6">
          Contact your administrator if you cannot sign in.
        </p>
      </div>
    </div>
  )
}
