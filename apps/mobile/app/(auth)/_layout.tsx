import { Redirect, Stack } from "expo-router";
import { useAuthStore } from "../../src/store/auth";

export default function AuthLayout() {
  const { session, isLoading } = useAuthStore();

  // If already logged in, send to the main app
  if (!isLoading && session) {
    return <Redirect href="/(tabs)/" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
    </Stack>
  );
}
