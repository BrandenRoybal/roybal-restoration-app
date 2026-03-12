/**
 * Photo Upload & Gallery screen.
 * Camera capture or gallery pick → upload to Supabase Storage → save record.
 */

import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  Image,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Modal,
  TextInput,
  ScrollView,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import { supabase, uploadFile, getSignedUrl } from "../../../src/lib/supabase";
import { useAuthStore } from "../../../src/store/auth";
import { colors, spacing, radius } from "../../../src/lib/theme";
import type { Photo, PhotoCategory, Room } from "@roybal/shared";

const CATEGORIES: { value: PhotoCategory; label: string }[] = [
  { value: "before", label: "Before" },
  { value: "during", label: "During" },
  { value: "after", label: "After" },
  { value: "moisture", label: "Moisture" },
  { value: "equipment", label: "Equipment" },
  { value: "general", label: "General" },
];

const CATEGORY_COLORS: Record<PhotoCategory, string> = {
  before: "#3B82F6",
  during: colors.warning,
  after: colors.success,
  moisture: "#06B6D4",
  equipment: "#8B5CF6",
  general: "#64748B",
};

export default function PhotosScreen() {
  const { id: jobId } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuthStore();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<PhotoCategory>("general");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [captionModal, setCaptionModal] = useState(false);
  const [pendingCaption, setPendingCaption] = useState("");
  const [pendingUri, setPendingUri] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<PhotoCategory | "all">("all");

  const fetchData = useCallback(async () => {
    if (!jobId) return;
    const [photosRes, roomsRes] = await Promise.all([
      supabase
        .from("photos")
        .select("*")
        .eq("job_id", jobId)
        .order("taken_at", { ascending: false }),
      supabase.from("rooms").select("*").eq("job_id", jobId).order("name"),
    ]);
    if (!photosRes.error && photosRes.data) {
      // Resolve signed URLs
      const withUrls = await Promise.all(
        (photosRes.data as Photo[]).map(async (p) => ({
          ...p,
          url: (await getSignedUrl("photos", p.storage_path)) ?? undefined,
        }))
      );
      setPhotos(withUrls);
    }
    if (!roomsRes.error && roomsRes.data) {
      setRooms(roomsRes.data as Room[]);
    }
    setLoading(false);
  }, [jobId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const pickAndUpload = async (source: "camera" | "library") => {
    const permission =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert("Permission Denied", `${source === "camera" ? "Camera" : "Photo library"} access is required.`);
      return;
    }

    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({
            quality: 0.85,
            exif: true,
            allowsEditing: false,
          })
        : await ImagePicker.launchImageLibraryAsync({
            quality: 0.85,
            allowsMultipleSelection: true,
            exif: true,
          });

    if (result.canceled) return;

    // Show caption modal for first image
    const firstUri = result.assets[0]?.uri;
    if (!firstUri) return;
    setPendingUri(firstUri);
    setCaptionModal(true);
  };

  const confirmUpload = async () => {
    if (!pendingUri || !jobId || !user) return;
    setCaptionModal(false);
    setUploading(true);

    try {
      // Get GPS
      let gpsLat: number | null = null;
      let gpsLng: number | null = null;
      const locPerm = await Location.requestForegroundPermissionsAsync();
      if (locPerm.granted) {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        gpsLat = loc.coords.latitude;
        gpsLng = loc.coords.longitude;
      }

      const ext = pendingUri.split(".").pop()?.toLowerCase() ?? "jpg";
      const filename = `${Date.now()}.${ext}`;
      const storagePath = `${jobId}/${selectedRoomId ?? "general"}/${filename}`;

      const uploadedPath = await uploadFile("photos", storagePath, pendingUri, `image/${ext === "jpg" ? "jpeg" : ext}`);
      if (!uploadedPath) throw new Error("Upload failed");

      const { error } = await supabase.from("photos").insert({
        job_id: jobId,
        room_id: selectedRoomId,
        uploaded_by: user.id,
        storage_path: uploadedPath,
        caption: pendingCaption.trim() || null,
        category: selectedCategory,
        taken_at: new Date().toISOString(),
        gps_lat: gpsLat,
        gps_lng: gpsLng,
      });

      if (error) throw error;
      await fetchData();
    } catch (err) {
      Alert.alert("Upload failed", String(err));
    } finally {
      setUploading(false);
      setPendingCaption("");
      setPendingUri(null);
    }
  };

  const filtered = filterCategory === "all"
    ? photos
    : photos.filter((p) => p.category === filterCategory);

  return (
    <View style={styles.container}>
      {/* Upload toolbar */}
      <View style={styles.toolbar}>
        <View style={styles.toolbarRow}>
          <TouchableOpacity style={styles.uploadBtn} onPress={() => pickAndUpload("camera")} disabled={uploading}>
            <Ionicons name="camera" size={22} color="#fff" />
            <Text style={styles.uploadBtnText}>Camera</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.uploadBtn, { backgroundColor: colors.navyDark }]} onPress={() => pickAndUpload("library")} disabled={uploading}>
            <Ionicons name="images" size={22} color={colors.orange} />
            <Text style={[styles.uploadBtnText, { color: colors.orange }]}>Gallery</Text>
          </TouchableOpacity>
        </View>

        {/* Category picker */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 8 }}>
          {CATEGORIES.map((c) => (
            <TouchableOpacity
              key={c.value}
              style={[
                styles.catChip,
                selectedCategory === c.value && { backgroundColor: CATEGORY_COLORS[c.value], borderColor: CATEGORY_COLORS[c.value] },
              ]}
              onPress={() => setSelectedCategory(c.value)}
            >
              <Text style={[styles.catChipText, selectedCategory === c.value && { color: "#fff" }]}>{c.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Room picker */}
        {rooms.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 6 }}>
            <TouchableOpacity
              style={[styles.catChip, !selectedRoomId && styles.catChipActive]}
              onPress={() => setSelectedRoomId(null)}
            >
              <Text style={[styles.catChipText, !selectedRoomId && { color: colors.orange }]}>All Rooms</Text>
            </TouchableOpacity>
            {rooms.map((r) => (
              <TouchableOpacity
                key={r.id}
                style={[styles.catChip, selectedRoomId === r.id && styles.catChipActive]}
                onPress={() => setSelectedRoomId(r.id)}
              >
                <Text style={[styles.catChipText, selectedRoomId === r.id && { color: colors.orange }]}>{r.name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      {/* Filter bar */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterBar} contentContainerStyle={{ gap: 6, paddingHorizontal: spacing.md }}>
        <TouchableOpacity style={[styles.catChip, filterCategory === "all" && styles.catChipActive]} onPress={() => setFilterCategory("all")}>
          <Text style={[styles.catChipText, filterCategory === "all" && { color: colors.orange }]}>All</Text>
        </TouchableOpacity>
        {CATEGORIES.map((c) => (
          <TouchableOpacity
            key={c.value}
            style={[styles.catChip, filterCategory === c.value && { backgroundColor: CATEGORY_COLORS[c.value] + "22", borderColor: CATEGORY_COLORS[c.value] }]}
            onPress={() => setFilterCategory(c.value)}
          >
            <Text style={[styles.catChipText, filterCategory === c.value && { color: CATEGORY_COLORS[c.value] }]}>{c.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Uploading indicator */}
      {uploading && (
        <View style={styles.uploadingBar}>
          <ActivityIndicator color={colors.orange} size="small" />
          <Text style={{ color: colors.orange, marginLeft: 8, fontSize: 13 }}>Uploading photo…</Text>
        </View>
      )}

      {/* Photo grid */}
      {loading ? (
        <ActivityIndicator color={colors.orange} style={{ marginTop: 48 }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          numColumns={3}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <View style={styles.photoCell}>
              {item.url ? (
                <Image source={{ uri: item.url }} style={styles.photoThumb} />
              ) : (
                <View style={[styles.photoThumb, { backgroundColor: colors.navyDark, alignItems: "center", justifyContent: "center" }]}>
                  <Ionicons name="image-outline" size={24} color={colors.textMuted} />
                </View>
              )}
              <View style={[styles.catDot, { backgroundColor: CATEGORY_COLORS[item.category] }]} />
              {item.caption ? (
                <Text style={styles.photoCaption} numberOfLines={1}>{item.caption}</Text>
              ) : null}
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="camera-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyText}>No photos yet</Text>
              <Text style={styles.emptySubText}>Tap Camera or Gallery to add</Text>
            </View>
          }
        />
      )}

      {/* Caption modal */}
      <Modal visible={captionModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add a Caption</Text>
            <TextInput
              style={styles.captionInput}
              placeholder="North wall, base of drywall…"
              placeholderTextColor={colors.textMuted}
              value={pendingCaption}
              onChangeText={setPendingCaption}
              autoFocus
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.navyDark, borderColor: colors.border }]}
                onPress={() => { setCaptionModal(false); setPendingUri(null); }}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: colors.orange }]} onPress={confirmUpload}>
                <Text style={[styles.modalBtnText, { color: "#fff" }]}>Upload</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.navy },
  toolbar: {
    backgroundColor: colors.navyDark,
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  toolbarRow: { flexDirection: "row", gap: 10 },
  uploadBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: colors.orange, borderRadius: radius.md, height: 46, gap: 8,
    borderWidth: 1, borderColor: colors.orange,
  },
  uploadBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  catChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full,
    backgroundColor: colors.navyDark, borderWidth: 1, borderColor: colors.border,
  },
  catChipActive: { borderColor: colors.orange },
  catChipText: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
  filterBar: { paddingVertical: spacing.sm, maxHeight: 44 },
  uploadingBar: {
    flexDirection: "row", alignItems: "center", backgroundColor: colors.orange + "11",
    padding: spacing.sm, paddingHorizontal: spacing.md,
  },
  grid: { padding: 2, paddingBottom: 24 },
  photoCell: { flex: 1 / 3, margin: 2, position: "relative" },
  photoThumb: { width: "100%", aspectRatio: 1, borderRadius: radius.sm },
  catDot: {
    position: "absolute", top: 5, right: 5,
    width: 8, height: 8, borderRadius: 4,
    borderWidth: 1.5, borderColor: colors.navy,
  },
  photoCaption: {
    fontSize: 9, color: colors.textMuted,
    paddingHorizontal: 2, marginTop: 2,
  },
  empty: { alignItems: "center", marginTop: 64, gap: 8 },
  emptyText: { color: colors.textMuted, fontSize: 16, fontWeight: "600" },
  emptySubText: { color: colors.textMuted, fontSize: 13 },
  modalOverlay: {
    flex: 1, backgroundColor: "#000000AA",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: colors.navyDark, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: spacing.lg, borderTopWidth: 1, borderColor: colors.border,
  },
  modalTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: "700", marginBottom: 16 },
  captionInput: {
    backgroundColor: colors.navy, borderRadius: radius.md, height: 48,
    paddingHorizontal: 14, color: colors.textPrimary, fontSize: 15,
    borderWidth: 1, borderColor: colors.border, marginBottom: 16,
  },
  modalBtns: { flexDirection: "row", gap: 10 },
  modalBtn: {
    flex: 1, height: 48, borderRadius: radius.md,
    alignItems: "center", justifyContent: "center", borderWidth: 1,
  },
  modalBtnText: { fontWeight: "700", fontSize: 15, color: colors.textSecondary },
});
