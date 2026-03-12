/**
 * Settings / Profile screen — view profile info and sign out.
 */

import { View, Text, TouchableOpacity, StyleSheet, Alert, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "../../src/store/auth";
import { colors, spacing, radius } from "../../src/lib/theme";

const ROLE_LABELS = { admin: "Administrator", tech: "Field Technician", viewer: "Viewer" };

export default function SettingsScreen() {
  const router = useRouter();
  const { profile, user, signOut } = useAuthStore();

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          await signOut();
          router.replace("/(auth)/login");
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Profile card */}
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {(profile?.full_name ?? "?")[0]?.toUpperCase() ?? "?"}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{profile?.full_name ?? "Loading…"}</Text>
          <Text style={styles.email}>{user?.email ?? ""}</Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>
              {ROLE_LABELS[profile?.role ?? "tech"]}
            </Text>
          </View>
        </View>
      </View>

      {/* Info rows */}
      {profile?.phone ? (
        <InfoRow icon="call-outline" label="Phone" value={profile.phone} />
      ) : null}

      <View style={styles.divider} />

      {/* Company info */}
      <SectionHeader title="Company" />
      <InfoRow icon="business-outline" label="Company" value="Roybal Construction, LLC" />
      <InfoRow icon="location-outline" label="Location" value="Fairbanks / North Pole, AK" />

      <View style={styles.divider} />

      {/* App info */}
      <SectionHeader title="App" />
      <InfoRow icon="code-slash-outline" label="Version" value="1.0.0" />

      {/* Sign out */}
      <TouchableOpacity style={styles.signOutBtn} onPress={handleSignOut} activeOpacity={0.8}>
        <Ionicons name="log-out-outline" size={20} color={colors.danger} />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function InfoRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon as any} size={18} color={colors.textMuted} style={{ width: 24 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value}</Text>
      </View>
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  content: { padding: spacing.md, paddingBottom: 48 },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.navyDark,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 16,
    marginBottom: 24,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.orange,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 24, fontWeight: "800" },
  name: { color: colors.textPrimary, fontSize: 17, fontWeight: "700" },
  email: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  roleBadge: {
    alignSelf: "flex-start",
    backgroundColor: colors.orange + "22",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    marginTop: 6,
  },
  roleText: { color: colors.orange, fontSize: 11, fontWeight: "700" },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 20 },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    marginBottom: 12,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    gap: 12,
  },
  infoLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "600" },
  infoValue: { color: colors.textPrimary, fontSize: 14, marginTop: 2 },
  signOutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.danger + "44",
    borderRadius: radius.md,
    height: 52,
    marginTop: 32,
    gap: 10,
    backgroundColor: colors.danger + "11",
  },
  signOutText: { color: colors.danger, fontSize: 15, fontWeight: "700" },
});
