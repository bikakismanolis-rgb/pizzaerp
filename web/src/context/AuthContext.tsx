import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

interface AuthState {
  session: Session | null
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<{ needsConfirm: boolean }>
  signOut: () => Promise<void>
  /** «Ξέχασα τον κωδικό»: στέλνει email με σύνδεσμο */
  sendReset: (email: string) => Promise<void>
  /** ήρθε από τον σύνδεσμο του email: θέλει νέο κωδικό */
  recovering: boolean
  setNewPassword: (password: string) => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [recovering, setRecovering] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  const signUp = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
    // Αν το "Confirm email" είναι ενεργό, δεν υπάρχει session ακόμα
    return { needsConfirm: !data.session }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  const sendReset = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/' })
    if (error) throw error
  }

  const setNewPassword = async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
    setRecovering(false)
  }

  return (
    <Ctx.Provider value={{ session, user: session?.user ?? null, loading, signIn, signUp, signOut, sendReset, recovering, setNewPassword }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
