/**
 * Design system tokens — shared across mobile components.
 */

export const colors = {
  navy: "#0A1628",
  navyDark: "#0F172A",
  orange: "#F97316",
  success: "#22C55E",
  warning: "#EAB308",
  danger: "#EF4444",
  bgLight: "#F8FAFC",
  bgDark: "#0F172A",
  // Text
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  textMuted: "#475569",
  // Borders
  border: "#1E293B",
  borderLight: "#334155",
  // Cards
  card: "#0F172A",
  cardBorder: "#1E293B",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  full: 9999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 28,
} as const;

/** Moisture status color mapping */
export const moistureColor = {
  dry: colors.success,
  monitoring: colors.warning,
  wet: colors.danger,
} as const;
