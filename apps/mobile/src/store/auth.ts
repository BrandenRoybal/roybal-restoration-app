/**
 * Auth store (Zustand)
 * Tracks current session + profile, drives navigation.
 */

import { Session, User } from "@supabase/supabase-js";
import { create } from "zustand";
import { supabase } from "../lib/supabase";
import type { Profile } from "@roybal/shared";

interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  isLoading: boolean;
  setSession: (session: Session | null) => void;
  fetchProfile: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  profile: null,
  isLoading: true,

  setSession: (session) => {
    set({ session, user: session?.user ?? null, isLoading: false });
    if (session?.user) {
      get().fetchProfile();
    } else {
      set({ profile: null });
    }
  },

  fetchProfile: async () => {
    const user = get().user;
    if (!user) return;
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();
    if (!error && data) {
      set({ profile: data as Profile });
    }
  },

  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  },

  signOut: async () => {
    await supabase.auth.signOut();
    set({ session: null, user: null, profile: null });
  },
}));
