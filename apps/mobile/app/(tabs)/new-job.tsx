/**
 * New Job screen — create a new restoration job.
 * On success, navigates to the job detail screen.
 */

import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../src/lib/supabase";
import { useAuthStore } from "../../src/store/auth";
import { colors, spacing, radius } from "../../src/lib/theme";
import type { LossType, LossCategory } from "@roybal/shared";

const LOSS_TYPES: { value: LossType; label: string; icon: string }[] = [
  { value: "water", label: "Water", icon: "water-outline" },
  { value: "fire", label: "Fire", icon: "flame-outline" },
  { value: "mold", label: "Mold", icon: "leaf-outline" },
  { value: "smoke", label: "Smoke", icon: "cloudy-outline" },
  { value: "other", label: "Other", icon: "help-circle-outline" },
];

const LOSS_CATEGORIES: { value: LossCategory; label: string; desc: string }[] = [
  { value: "cat1", label: "Category 1", desc: "Clean water" },
  { value: "cat2", label: "Category 2", desc: "Grey water" },
  { value: "cat3", label: "Category 3", desc: "Black water" },
];

interface FormData {
  property_address: string;
  owner_name: string;
  owner_phone: string;
  owner_email: string;
  date_of_loss: string;
  loss_type: LossType | "";
  loss_category: LossCategory | "";
  insurance_carrier: string;
  claim_number: string;
  adjuster_name: string;
  adjuster_phone: string;
  notes: string;
}

export default function NewJobScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<FormData>({
    property_address: "",
    owner_name: "",
    owner_phone: "",
    owner_email: "",
    date_of_loss: new Date().toISOString().split("T")[0] ?? "",
    loss_type: "",
    loss_category: "",
    insurance_carrier: "",
    claim_number: "",
    adjuster_name: "",
    adjuster_phone: "",
    notes: "",
  });

  const update = (field: keyof FormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleCreate = async () => {
    if (!form.property_address.trim()) {
      Alert.alert("Required", "Property address is required.");
      return;
    }

    setLoading(true);
    const { data, error } = await supabase
      .from("jobs")
      .insert({
        property_address: form.property_address.trim(),
        owner_name: form.owner_name.trim() || null,
        owner_phone: form.owner_phone.trim() || null,
        owner_email: form.owner_email.trim() || null,
        date_of_loss: form.date_of_loss || null,
        loss_type: form.loss_type || null,
        loss_category: form.loss_category || null,
        insurance_carrier: form.insurance_carrier.trim() || null,
        claim_number: form.claim_number.trim() || null,
        adjuster_name: form.adjuster_name.trim() || null,
        adjuster_phone: form.adjuster_phone.trim() || null,
        notes: form.notes.trim() || null,
        created_by: user?.id,
        assigned_tech_ids: user?.id ? [user.id] : [],
        status: "new",
      })
      .select()
      .single();

    setLoading(false);

    if (error) {
      Alert.alert("Error", error.message);
      return;
    }

    router.replace(`/job/${data.id}`);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Property Info */}
      <SectionHeader title="Property Information" />

      <FieldLabel label="Property Address *" />
      <TextInput
        style={styles.input}
        placeholder="123 Fairbanks Rd, North Pole, AK"
        placeholderTextColor={colors.textMuted}
        value={form.property_address}
        onChangeText={(v) => update("property_address", v)}
      />

      <FieldLabel label="Owner Name" />
      <TextInput
        style={styles.input}
        placeholder="John Smith"
        placeholderTextColor={colors.textMuted}
        value={form.owner_name}
        onChangeText={(v) => update("owner_name", v)}
      />

      <View style={styles.row}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <FieldLabel label="Phone" />
          <TextInput
            style={styles.input}
            placeholder="(907) 555-0100"
            placeholderTextColor={colors.textMuted}
            value={form.owner_phone}
            onChangeText={(v) => update("owner_phone", v)}
            keyboardType="phone-pad"
          />
        </View>
        <View style={{ flex: 1, marginLeft: 8 }}>
          <FieldLabel label="Date of Loss" />
          <TextInput
            style={styles.input}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.textMuted}
            value={form.date_of_loss}
            onChangeText={(v) => update("date_of_loss", v)}
          />
        </View>
      </View>

      {/* Loss Type */}
      <SectionHeader title="Loss Type" />
      <View style={styles.optionRow}>
        {LOSS_TYPES.map((t) => (
          <TouchableOpacity
            key={t.value}
            style={[
              styles.optionChip,
              form.loss_type === t.value && styles.optionChipActive,
            ]}
            onPress={() => update("loss_type", t.value)}
          >
            <Ionicons
              name={t.icon as any}
              size={20}
              color={form.loss_type === t.value ? colors.orange : colors.textMuted}
            />
            <Text
              style={[
                styles.optionLabel,
                form.loss_type === t.value && { color: colors.orange },
              ]}
            >
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Loss Category */}
      <SectionHeader title="Loss Category" />
      <View style={styles.optionRow}>
        {LOSS_CATEGORIES.map((c) => (
          <TouchableOpacity
            key={c.value}
            style={[
              styles.catChip,
              form.loss_category === c.value && styles.optionChipActive,
            ]}
            onPress={() => update("loss_category", c.value)}
          >
            <Text
              style={[
                styles.catLabel,
                form.loss_category === c.value && { color: colors.orange },
              ]}
            >
              {c.label}
            </Text>
            <Text style={styles.catDesc}>{c.desc}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Insurance */}
      <SectionHeader title="Insurance Information" />

      <FieldLabel label="Insurance Carrier" />
      <TextInput
        style={styles.input}
        placeholder="State Farm"
        placeholderTextColor={colors.textMuted}
        value={form.insurance_carrier}
        onChangeText={(v) => update("insurance_carrier", v)}
      />

      <FieldLabel label="Claim Number" />
      <TextInput
        style={styles.input}
        placeholder="CLM-12345678"
        placeholderTextColor={colors.textMuted}
        value={form.claim_number}
        onChangeText={(v) => update("claim_number", v)}
      />

      <FieldLabel label="Adjuster Name" />
      <TextInput
        style={styles.input}
        placeholder="Jane Doe"
        placeholderTextColor={colors.textMuted}
        value={form.adjuster_name}
        onChangeText={(v) => update("adjuster_name", v)}
      />

      <FieldLabel label="Adjuster Phone" />
      <TextInput
        style={styles.input}
        placeholder="(907) 555-0200"
        placeholderTextColor={colors.textMuted}
        value={form.adjuster_phone}
        onChangeText={(v) => update("adjuster_phone", v)}
        keyboardType="phone-pad"
      />

      {/* Notes */}
      <SectionHeader title="Notes" />
      <TextInput
        style={[styles.input, styles.textarea]}
        placeholder="Initial observations, scope notes…"
        placeholderTextColor={colors.textMuted}
        value={form.notes}
        onChangeText={(v) => update("notes", v)}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
      />

      {/* Submit */}
      <TouchableOpacity
        style={[styles.submitBtn, loading && { opacity: 0.6 }]}
        onPress={handleCreate}
        disabled={loading}
        activeOpacity={0.8}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="checkmark-circle" size={20} color="#fff" />
            <Text style={styles.submitText}>Create Job</Text>
          </>
        )}
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function FieldLabel({ label }: { label: string }) {
  return <Text style={styles.label}>{label}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  content: { padding: spacing.md },
  sectionHeader: {
    marginTop: 24,
    marginBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: colors.orange,
    paddingLeft: 10,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: "600", marginBottom: 6 },
  input: {
    backgroundColor: colors.navyDark,
    borderRadius: radius.md,
    height: 48,
    paddingHorizontal: 14,
    color: colors.textPrimary,
    fontSize: 15,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
  },
  textarea: { height: 96, paddingTop: 12 },
  row: { flexDirection: "row" },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  optionChip: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: colors.navyDark,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 72,
    gap: 4,
  },
  optionChipActive: { borderColor: colors.orange },
  optionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  catChip: {
    flex: 1,
    minWidth: 100,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.navyDark,
    borderWidth: 1,
    borderColor: colors.border,
  },
  catLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: "700" },
  catDesc: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.orange,
    borderRadius: radius.md,
    height: 56,
    marginTop: 24,
    gap: 10,
  },
  submitText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
