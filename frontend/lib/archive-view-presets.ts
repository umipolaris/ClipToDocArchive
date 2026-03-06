import {
  ARCHIVE_COLUMN_ORDER_DEFAULT,
  normalizeArchiveVisibleColumns,
  type ArchiveColumnKey,
  type ArchiveListDensity,
} from "@/lib/archive-list-preferences";

export type ArchiveViewPresetPayload = {
  category_filter: string;
  year_filter: number | null;
  month_filter: number | null;
  review_status: string;
  search_query: string;
  sort_by: string;
  sort_order: string;
  page_size: number;
  density: ArchiveListDensity;
  visible_columns: ArchiveColumnKey[];
};

export type ArchiveViewPreset = {
  id: string;
  name: string;
  payload: ArchiveViewPresetPayload;
  created_at: string;
  updated_at: string;
};

const STORAGE_KEY = "archive-view-presets.v1";

function nowIso(): string {
  return new Date().toISOString();
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizePayload(input: Partial<ArchiveViewPresetPayload>): ArchiveViewPresetPayload {
  return {
    category_filter: typeof input.category_filter === "string" ? input.category_filter : "",
    year_filter: Number.isInteger(input.year_filter) ? (input.year_filter as number) : null,
    month_filter: Number.isInteger(input.month_filter) ? (input.month_filter as number) : null,
    review_status: typeof input.review_status === "string" ? input.review_status : "",
    search_query: typeof input.search_query === "string" ? input.search_query : "",
    sort_by: typeof input.sort_by === "string" ? input.sort_by : "event_date",
    sort_order: typeof input.sort_order === "string" ? input.sort_order : "desc",
    page_size: Number.isInteger(input.page_size) && (input.page_size as number) > 0 ? (input.page_size as number) : 50,
    density: input.density === "compact" ? "compact" : "default",
    visible_columns: normalizeArchiveVisibleColumns(
      Array.isArray(input.visible_columns) ? (input.visible_columns as ArchiveColumnKey[]) : ARCHIVE_COLUMN_ORDER_DEFAULT,
    ),
  };
}

function normalizePreset(input: Partial<ArchiveViewPreset>): ArchiveViewPreset | null {
  if (!input || typeof input !== "object") return null;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return null;
  const createdAt = typeof input.created_at === "string" && input.created_at ? input.created_at : nowIso();
  const updatedAt = typeof input.updated_at === "string" && input.updated_at ? input.updated_at : createdAt;
  return {
    id: typeof input.id === "string" && input.id ? input.id : createId(),
    name,
    payload: normalizePayload((input.payload || {}) as Partial<ArchiveViewPresetPayload>),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function loadArchiveViewPresets(): ArchiveViewPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizePreset(item))
      .filter((item): item is ArchiveViewPreset => Boolean(item))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  } catch {
    return [];
  }
}

export function saveArchiveViewPresets(presets: ArchiveViewPreset[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // ignore storage errors
  }
}

export function upsertArchiveViewPreset(presets: ArchiveViewPreset[], name: string, payload: ArchiveViewPresetPayload): ArchiveViewPreset[] {
  const normalizedName = name.trim();
  if (!normalizedName) return presets;
  const now = nowIso();
  const existing = presets.find((preset) => preset.name === normalizedName);
  if (existing) {
    const next = presets.map((preset) =>
      preset.id === existing.id
        ? {
            ...preset,
            payload: normalizePayload(payload),
            updated_at: now,
          }
        : preset,
    );
    return next.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }
  const created: ArchiveViewPreset = {
    id: createId(),
    name: normalizedName,
    payload: normalizePayload(payload),
    created_at: now,
    updated_at: now,
  };
  return [created, ...presets];
}

export function removeArchiveViewPreset(presets: ArchiveViewPreset[], id: string): ArchiveViewPreset[] {
  return presets.filter((preset) => preset.id !== id);
}
