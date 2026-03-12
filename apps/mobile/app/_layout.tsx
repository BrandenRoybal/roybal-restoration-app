/**
 * Root layout — initializes Supabase auth listener,
 * then routes to (auth) or (tabs) based on session state.
 */

import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { supabase } from "../src/lib/supabase";
import { useAuthStore } from "../src/store/auth";

export default function RootLayout() {
  const { setSession } = useAuthStore();

  useEffect(() => {
    // Restore existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => setSession(session)
    );

    return () => subscription.unsubscribe();
  }, [setSession]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" backgroundColor="#0A1628" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="job/[id]" />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
