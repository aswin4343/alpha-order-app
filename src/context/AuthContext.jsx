import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../utils/supabase.js'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  // Tracks the current user id across renders WITHOUT being an effect
  // dependency, so onAuthStateChange can tell "same user, token just
  // refreshed" apart from "actually a different user" without needing to
  // tear down and resubscribe the listener on every session update.
  const currentUserIdRef = useRef(null)

  // Load the profile row (role, name, route) for the logged-in user.
  const loadProfile = useCallback(async (userId) => {
    if (!userId) {
      setProfile(null)
      return
    }
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    if (!error) setProfile(data)
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      if (!active) return
      setSession(data.session)
      currentUserIdRef.current = data.session?.user?.id || null
      await loadProfile(data.session?.user?.id)
      setLoading(false)
    })()

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, sess) => {
      // Keep session and profile strictly in lockstep. On sign-out, clear both
      // so no previous rep's identity can linger into the next session.
      if (event === 'SIGNED_OUT' || !sess) {
        currentUserIdRef.current = null
        setSession(null)
        setProfile(null)
        return
      }

      // Supabase fires TOKEN_REFRESHED automatically whenever the browser tab
      // regains focus/visibility, for the SAME already-logged-in user — it is
      // not a new sign-in. Previously this branch unconditionally cleared and
      // reloaded the profile on every such event, which made `profile` briefly
      // become null; App.jsx renders a full Splash screen whenever profile is
      // null, so the ENTIRE app (including in-progress forms like New
      // Customer, an order being built, a QC checklist, etc.) unmounted and
      // reset every time someone switched tabs and came back. Only reset the
      // profile when the user identity actually changed.
      const identityChanged = sess.user?.id !== currentUserIdRef.current
      setSession(sess)
      if (identityChanged) {
        currentUserIdRef.current = sess.user?.id || null
        // Clear the old profile first, then load the new one, so a stale
        // profile can never be paired with a new session (prevents wrong rep
        // attribution).
        setProfile(null)
        await loadProfile(sess.user?.id)
      }
      // else: same user, just a refreshed token — session state is updated
      // above, but profile (and therefore the whole app tree) stays mounted.
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [loadProfile])

  const signIn = useCallback(async (email, password) => {
    // Always clear any existing session first so switching reps can never
    // leave a previous identity active underneath the new login.
    await supabase.auth.signOut()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
  }, [])

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    role: profile?.role ?? null,
    isAdmin: profile?.role === 'admin',
    isDeliveryAdmin: profile?.role === 'delivery_admin',
    isDeliveryRep: profile?.role === 'delivery_rep',
    loading,
    signIn,
    signOut,
    refreshProfile: async () => {
      const { data } = await supabase.auth.getUser()
      if (data?.user?.id) await loadProfile(data.user.id)
    }
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
