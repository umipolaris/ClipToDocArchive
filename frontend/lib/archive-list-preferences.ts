export type ArchiveListDensity = "default" | "compact";

export type ArchiveColumnKey = "date" | "title" | "category" | "tags" | "file" | "modified" | "review";

export type ArchiveListPreferences = {
  density: ArchiveListDensity;
  visibleColumns: ArchiveColumnKey[];
};

export const ARCHIVE_PREF_STORAGE_KEY = "archive-list-preferences.v1";

const LEGACY_ARCHIVE_COLUMN_ORDER_DEFAULT: ArchiveColumnKey[] = ["date", "title", "category", "tags", "file", "modified", "review"];

export const ARCHIVE_COLUMN_ORDER_DEFAULT: ArchiveColumnKey[] = ["date", "category", "title", "tags", "file", "modified", "review"];

export const ARCHIVE_COLUMN_LABELS: Record<ArchiveColumnKey, string> = {
  date: "날짜",
  title: "제목",
  category: "분류",
  tags: "태그",
  file: "파일",
  modified: "최종수정",
  review: "검토",
};

export const ARCHIVE_COLUMN_WIDTHS: Record<ArchiveColumnKey, string> = {
  date: "92px",
  title: "minmax(280px,2.8fr)",
  category: "84px",
  tags: "minmax(126px,0.84fr)",
  file: "minmax(75px,0.5fr)",
  modified: "120px",
  review: "100px",
};

export const ARCHIVE_COLUMN_MIN_WIDTH: Record<ArchiveColumnKey, number> = {
  date: 92,
  title: 280,
  category: 84,
  tags: 126,
  file: 75,
  modified: 120,
  review: 100,
};

export const DEFAULT_ARCHIVE_LIST_PREFERENCES: ArchiveListPreferences = {
  density: "default",
  visibleColumns: ARCHIVE_COLUMN_ORDER_DEFAULT,
};

function isArchiveDensity(value: unknown): value is ArchiveListDensity {
  return value === "default" || value === "compact";
}

function isArchiveColumnKey(value: unknown): value is ArchiveColumnKey {
  return (
    value === "date" ||
    value === "title" ||
    value === "category" ||
    value === "tags" ||
    value === "file" ||
    value === "modified" ||
    value === "review"
  );
}

function isSameOrder(a: ArchiveColumnKey[], b: ArchiveColumnKey[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, idx) => value === b[idx]);
}

export function normalizeArchiveVisibleColumns(input: unknown): ArchiveColumnKey[] {
  if (!Array.isArray(input)) return ARCHIVE_COLUMN_ORDER_DEFAULT;

  const deduped: ArchiveColumnKey[] = [];
  for (const candidate of input) {
    if (!isArchiveColumnKey(candidate)) continue;
    if (deduped.includes(candidate)) continue;
    deduped.push(candidate);
  }
  if (!deduped.includes("title")) deduped.push("title");
  if (deduped.length === 0) return ARCHIVE_COLUMN_ORDER_DEFAULT;
  if (isSameOrder(deduped, LEGACY_ARCHIVE_COLUMN_ORDER_DEFAULT)) {
    return ARCHIVE_COLUMN_ORDER_DEFAULT;
  }
  return deduped;
}

export function normalizeArchiveListPreferences(input: unknown): ArchiveListPreferences {
  if (!input || typeof input !== "object") {
    return DEFAULT_ARCHIVE_LIST_PREFERENCES;
  }
  const value = input as Partial<ArchiveListPreferences>;
  return {
    density: isArchiveDensity(value.density) ? value.density : DEFAULT_ARCHIVE_LIST_PREFERENCES.density,
    visibleColumns: normalizeArchiveVisibleColumns(value.visibleColumns),
  };
}

export function loadArchiveListPreferences(): ArchiveListPreferences {
  if (typeof window === "undefined") return DEFAULT_ARCHIVE_LIST_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(ARCHIVE_PREF_STORAGE_KEY);
    if (!raw) return DEFAULT_ARCHIVE_LIST_PREFERENCES;
    const parsed = JSON.parse(raw);
    return normalizeArchiveListPreferences(parsed);
  } catch {
    return DEFAULT_ARCHIVE_LIST_PREFERENCES;
  }
}

export function saveArchiveListPreferences(preferences: ArchiveListPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ARCHIVE_PREF_STORAGE_KEY, JSON.stringify(normalizeArchiveListPreferences(preferences)));
  } catch {
    // ignore localStorage quota/permission errors
  }
}
