/**
 * Bottom tab navigator — redirects to login if no session.
 */

import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "../../src/store/auth";
import { colors } from "../../src/lib/theme";

export default function TabsLayout() {
  const { session, isLoading } = useAuthStore();

  if (!isLoading && !session) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.navy },
        headerTintColor: "#FFFFFF",
        headerTitleStyle: { fontWeight: "700" },
        tabBarStyle: {
          backgroundColor: colors.navyDark,
          borderTopColor: colors.border,
          height: 64,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: colors.orange,
        tabBarInactiveTintColor: "#475569",
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Jobs",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="briefcase-outline" size={size} color={color} />
          ),
          headerTitle: "Roybal Restoration",
        }}
      />
      <Tabs.Screen
        name="new-job"
        options={{
          title: "New Job",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="add-circle-outline" size={size} color={color} />
          ),
          headerTitle: "Create Job",
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
          headerTitle: "Settings",
        }}
      />
    </Tabs>
  );
}
