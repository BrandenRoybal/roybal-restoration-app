/**
 * Auth store (Zustand) for the web admin.
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
  initialize: () => Promise<void>;
  fetchProfile: (userId: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  profile: null,
  isLoading: true,

  initialize: async () => {
    const { data: { session } } = await supabase.auth.getSession();
    set({ session, user: session?.user ?? null, isLoading: false });
    if (session?.user) {
      await get().fetchProfile(session.user.id);
    }

    supabase.auth.onAuthStateChange(async (_event, newSession) => {
      set({ session: newSession, user: newSession?.user ?? null });
      if (newSession?.user) {
        await get().fetchProfile(newSession.user.id);
      } else {
        set({ profile: null });
      }
    });
  },

  fetchProfile: async (userId) => {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    if (data) set({ profile: data as Profile });
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
