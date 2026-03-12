/**
 * Login screen — email/password sign-in via Supabase Auth.
 * Dark navy background with safety orange accent.
 */

import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuthStore } from "../../src/store/auth";
import { colors } from "../../src/lib/theme";

export default function LoginScreen() {
  const router = useRouter();
  const signIn = useAuthStore((s) => s.signIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert("Missing fields", "Please enter your email and password.");
      return;
    }
    setLoading(true);
    const error = await signIn(email.trim(), password);
    setLoading(false);
    if (error) {
      Alert.alert("Login failed", error);
    } else {
      router.replace("/(tabs)/");
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <View style={styles.inner}>
        {/* Logo / Header */}
        <View style={styles.header}>
          <Text style={styles.logoText}>ROYBAL</Text>
          <Text style={styles.logoSub}>RESTORATION</Text>
          <View style={styles.logoAccent} />
          <Text style={styles.tagline}>Field Documentation App</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="tech@roybalrestoration.com"
            placeholderTextColor="#64748B"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            returnKeyType="next"
          />

          <Text style={[styles.label, { marginTop: 16 }]}>Password</Text>
          <TextInput
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor="#64748B"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            returnKeyType="done"
            onSubmitEditing={handleLogin}
          />

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign In</Text>
            )}
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>
          Contact your administrator to create or reset your account.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.navy,
  },
  inner: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  header: {
    alignItems: "center",
    marginBottom: 48,
  },
  logoText: {
    fontSize: 36,
    fontWeight: "800",
    color: "#FFFFFF",
    letterSpacing: 6,
  },
  logoSub: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.orange,
    letterSpacing: 8,
    marginTop: 2,
  },
  logoAccent: {
    width: 48,
    height: 3,
    backgroundColor: colors.orange,
    marginVertical: 12,
    borderRadius: 2,
  },
  tagline: {
    fontSize: 13,
    color: "#94A3B8",
    letterSpacing: 1,
  },
  form: {
    backgroundColor: "#0F172A",
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: "#1E293B",
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#94A3B8",
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: "#1E293B",
    borderRadius: 10,
    height: 52,
    paddingHorizontal: 16,
    color: "#F1F5F9",
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#334155",
  },
  button: {
    backgroundColor: colors.orange,
    borderRadius: 10,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  footer: {
    textAlign: "center",
    color: "#475569",
    fontSize: 12,
    marginTop: 32,
    lineHeight: 18,
  },
});
