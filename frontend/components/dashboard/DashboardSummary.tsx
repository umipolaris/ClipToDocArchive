"use client";

import { useSearchParams } from "next/navigation";
import { CSSProperties, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  CalendarDays,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock3,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Files,
  FolderOpen,
  ListChecks,
  ListFilter,
  MapPin,
  MessageSquare,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { apiFetch, apiGet, apiPatch, apiPost, buildApiUrl } from "@/lib/api-client";
import { reviewStatusLabel } from "@/lib/labels";
import { ModalShell } from "@/components/common/ModalShell";

type DashboardCategoryCount = {
  category: string;
  count: number;
};

type DashboardErrorCodeCount = {
  error_code: string;
  count: number;
};

type DashboardRecentDocument = {
  id: string;
  title: string;
  category: string;
  first_file_id: string | null;
  first_file_extension: string | null;
  event_date: string | null;
  ingested_at: string;
  review_status: "NONE" | "NEEDS_REVIEW" | "RESOLVED";
};

type DashboardPinnedDocument = {
  id: string;
  title: string;
  category: string;
  event_date: string | null;
  ingested_at: string;
  review_status: "NONE" | "NEEDS_REVIEW" | "RESOLVED";
};

type DashboardPinnedCategory = {
  category: string;
  count: number;
  documents: DashboardPinnedDocument[];
};

type DashboardSummaryResponse = {
  total_documents: number;
  recent_uploads_7d: number;
  needs_review_count: number;
  failed_jobs_count: number;
  retry_scheduled_count: number;
  dead_letter_count: number;
  failed_error_codes: DashboardErrorCodeCount[];
  categories: DashboardCategoryCount[];
  pinned_by_category?: DashboardPinnedCategory[];
  recent_documents: DashboardRecentDocument[];
  generated_at: string;
};

type DashboardTaskItem = {
  id: string;
  category: string;
  title: string;
  scheduled_at: string;
  ended_at: string | null;
  all_day: boolean;
  location: string | null;
  comment: string | null;
  linked_document_id: string | null;
  linked_document_title: string | null;
  linked_file_id: string | null;
  linked_file_name: string | null;
  linked_file_download_path: string | null;
};

type ArchiveDocumentListItem = {
  id: string;
  title: string;
  event_date: string | null;
  file_count: number;
};

type ArchiveDocumentListResponse = {
  items: ArchiveDocumentListItem[];
  page: number;
  size: number;
  total: number;
};

type ArchiveDocumentFileItem = {
  id: string;
  original_filename: string;
  download_path: string;
};

type ArchiveDocumentDetailResponse = {
  id: string;
  title: string;
  files: ArchiveDocumentFileItem[];
};

type DashboardTaskListResponse = {
  month: string;
  items: DashboardTaskItem[];
  generated_at: string;
};

type DashboardTaskSettingsResponse = {
  categories: string[];
  category_colors: Record<string, string>;
  holidays: Record<string, string>;
  allow_all_day: boolean;
  use_location: boolean;
  use_comment: boolean;
  default_time: string;
  list_range_past_days: number;
  list_range_future_months: number;
  generated_at: string;
};

type TaskFilter = "ALL" | string;

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const CATEGORY_COLOR_PALETTE = ["#059669", "#0284C7", "#7C3AED", "#EA580C", "#D9466F", "#0F766E", "#475569", "#7C2D12", "#166534"];
const DEFAULT_CATEGORY_COLORS: Record<string, string> = { 할일: "#059669", 회의: "#0284C7" };
const DEFAULT_TASK_LIST_RANGE_PAST_DAYS = 7;
const DEFAULT_TASK_LIST_RANGE_FUTURE_MONTHS = 2;
const MAX_TASK_LIST_RANGE_PAST_DAYS = 365;
const MAX_TASK_LIST_RANGE_FUTURE_MONTHS = 24;
const MAX_TASK_HOLIDAYS = 400;

const DEFAULT_TASK_SETTINGS: DashboardTaskSettingsResponse = {
  categories: ["할일", "회의"],
  category_colors: { ...DEFAULT_CATEGORY_COLORS },
  holidays: {},
  allow_all_day: true,
  use_location: true,
  use_comment: true,
  default_time: "09:00",
  list_range_past_days: DEFAULT_TASK_LIST_RANGE_PAST_DAYS,
  list_range_future_months: DEFAULT_TASK_LIST_RANGE_FUTURE_MONTHS,
  generated_at: "",
};

const LOCAL_TASK_SETTINGS_KEY = "dashboard-task-settings-local-v1";

function pad2(v: number): string {
  return String(v).padStart(2, "0");
}

function monthKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function dateKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatDateTime(value: string): string {
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? "-" : dt.toLocaleString("ko-KR");
}

function formatTaskSchedule(item: DashboardTaskItem): string {
  const startedAt = new Date(item.scheduled_at);
  if (Number.isNaN(startedAt.getTime())) return "-";
  if (item.all_day) {
    return `${dateKeyFromDate(startedAt)} (종일)`;
  }
  const startedLabel = `${dateKeyFromDate(startedAt)} ${pad2(startedAt.getHours())}:${pad2(startedAt.getMinutes())}`;
  if (item.ended_at) {
    const endedAt = new Date(item.ended_at);
    if (!Number.isNaN(endedAt.getTime()) && endedAt.getTime() > startedAt.getTime()) {
      const endedLabel = `${dateKeyFromDate(endedAt)} ${pad2(endedAt.getHours())}:${pad2(endedAt.getMinutes())}`;
      return `${startedLabel} ~ ${endedLabel}`;
    }
  }
  return startedLabel;
}

function toDateInputValue(value: string): string {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return dateKeyFromDate(new Date());
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function toTimeInputValue(value: string): string {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "09:00";
  return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

function formatTimeValue(value: string): string {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function isTodayKey(dateKey: string): boolean {
  return dateKey === dateKeyFromDate(new Date());
}

function isTomorrowKey(dateKey: string): boolean {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return dateKey === dateKeyFromDate(tomorrow);
}

function isMeetingCategory(category: string): boolean {
  return category.toLowerCase().includes("회의");
}

function parseMonthKey(monthKey: string): { year: number; month: number } {
  const [y, m] = monthKey.split("-").map((v) => Number(v));
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }
  return { year: y, month: m };
}

function moveMonthKey(monthKey: string, delta: number): string {
  const { year, month } = parseMonthKey(monthKey);
  const dt = new Date(year, month - 1 + delta, 1);
  return monthKeyFromDate(dt);
}

function buildCalendarCells(monthKey: string): Array<{ dateKey: string; inMonth: boolean; day: number }> {
  const { year, month } = parseMonthKey(monthKey);
  const first = new Date(year, month - 1, 1);
  const startWeekday = first.getDay();
  const lastDay = new Date(year, month, 0).getDate();
  const prevLastDay = new Date(year, month - 1, 0).getDate();

  const cells: Array<{ dateKey: string; inMonth: boolean; day: number }> = [];
  for (let i = 0; i < startWeekday; i += 1) {
    const day = prevLastDay - startWeekday + i + 1;
    const date = new Date(year, month - 2, day);
    cells.push({ dateKey: dateKeyFromDate(date), inMonth: false, day: date.getDate() });
  }
  for (let day = 1; day <= lastDay; day += 1) {
    const date = new Date(year, month - 1, day);
    cells.push({ dateKey: dateKeyFromDate(date), inMonth: true, day });
  }
  while (cells.length % 7 !== 0) {
    const idx = cells.length - (startWeekday + lastDay);
    const date = new Date(year, month, idx + 1);
    cells.push({ dateKey: dateKeyFromDate(date), inMonth: false, day: date.getDate() });
  }
  return cells;
}

function normalizeCategoryList(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of raw) {
    const token = name.trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token.slice(0, 80));
  }
  const bounded = out.slice(0, 30);
  return bounded.length > 0 ? bounded : ["할일", "회의"];
}

function isValidTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function addMinutesToTime(value: string, minutes: number): string {
  if (!isValidTime(value)) return "";
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return "";
  const totalMinutes = (hour * 60 + minute + minutes + 24 * 60) % (24 * 60);
  const nextHour = Math.floor(totalMinutes / 60);
  const nextMinute = totalMinutes % 60;
  return `${pad2(nextHour)}:${pad2(nextMinute)}`;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeTaskListRangePastDays(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TASK_LIST_RANGE_PAST_DAYS;
  return clampInteger(parsed, 0, MAX_TASK_LIST_RANGE_PAST_DAYS);
}

function normalizeTaskListRangeFutureMonths(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TASK_LIST_RANGE_FUTURE_MONTHS;
  return clampInteger(parsed, 0, MAX_TASK_LIST_RANGE_FUTURE_MONTHS);
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addMonthsClamped(base: Date, months: number): Date {
  const year = base.getFullYear();
  const month = base.getMonth();
  const day = base.getDate();
  const firstOfTarget = new Date(year, month + months, 1, 0, 0, 0, 0);
  const lastDay = new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth() + 1, 0).getDate();
  return new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth(), Math.min(day, lastDay), 0, 0, 0, 0);
}

function buildTaskListRange(now: Date, pastDays: number, futureMonths: number): {
  startDate: Date;
  endDateInclusive: Date;
  endDateExclusive: Date;
} {
  const today = startOfLocalDay(now);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - normalizeTaskListRangePastDays(pastDays));
  const endDateInclusive = addMonthsClamped(today, normalizeTaskListRangeFutureMonths(futureMonths));
  const endDateExclusive = new Date(endDateInclusive);
  endDateExclusive.setDate(endDateExclusive.getDate() + 1);
  return { startDate, endDateInclusive, endDateExclusive };
}

function normalizeHolidayDateKey(value: unknown): string | null {
  const token = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(token)) return null;
  const [year, month, day] = token.split("-").map((part) => Number(part));
  const dt = new Date(year, month - 1, day);
  if (dateKeyFromDate(dt) !== token) return null;
  return token;
}

function normalizeHolidayName(value: unknown): string | null {
  const token = String(value || "").trim();
  if (!token) return null;
  return token.slice(0, 80);
}

function normalizeHolidaysMap(raw: Record<string, unknown> | null | undefined): Record<string, string> {
  const source = raw && typeof raw === "object" ? raw : {};
  const out: Record<string, string> = {};
  for (const [rawDate, rawName] of Object.entries(source)) {
    const dateKey = normalizeHolidayDateKey(rawDate);
    const name = normalizeHolidayName(rawName);
    if (!dateKey || !name) continue;
    out[dateKey] = name;
  }
  const sorted = Object.entries(out)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, MAX_TASK_HOLIDAYS);
  return Object.fromEntries(sorted);
}

function normalizeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const token = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(token)) return token.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(token)) {
    return `#${token[1]}${token[1]}${token[2]}${token[2]}${token[3]}${token[3]}`.toUpperCase();
  }
  return null;
}

function defaultCategoryColor(category: string): string {
  if (DEFAULT_CATEGORY_COLORS[category]) return DEFAULT_CATEGORY_COLORS[category];
  const hash = Array.from(category).reduce((acc, ch) => ((acc * 31 + ch.charCodeAt(0)) >>> 0), 0);
  return CATEGORY_COLOR_PALETTE[hash % CATEGORY_COLOR_PALETTE.length];
}

function normalizeCategoryColorMap(raw: Record<string, string> | null | undefined, categories: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const category of categories) {
    const parsed = normalizeHexColor(raw?.[category]);
    out[category] = parsed || defaultCategoryColor(category);
  }
  return out;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(hex) || "#64748B";
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function alphaColor(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function categoryBadgeStyle(category: string, colorMap: Record<string, string>): CSSProperties {
  const base = normalizeHexColor(colorMap[category]) || defaultCategoryColor(category);
  return {
    borderColor: alphaColor(base, 0.45),
    backgroundColor: alphaColor(base, 0.14),
    color: base,
  };
}

function fileExtensionMeta(ext: string | null | undefined): { label: string; icon: LucideIcon; className: string } | null {
  if (!ext) return null;
  const normalized = ext.toLowerCase().replace(/^\./, "");
  if (!normalized) return null;
  if (["xls", "xlsx", "csv"].includes(normalized)) {
    return { label: normalized.toUpperCase(), icon: FileSpreadsheet, className: "border-emerald-300 bg-emerald-50 text-emerald-700" };
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(normalized)) {
    return { label: normalized.toUpperCase(), icon: FileImage, className: "border-cyan-300 bg-cyan-50 text-cyan-700" };
  }
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(normalized)) {
    return { label: normalized.toUpperCase(), icon: FileVideo, className: "border-violet-300 bg-violet-50 text-violet-700" };
  }
  if (["mp3", "wav", "m4a", "aac", "flac"].includes(normalized)) {
    return { label: normalized.toUpperCase(), icon: FileAudio, className: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700" };
  }
  if (["zip", "rar", "7z", "tar", "gz"].includes(normalized)) {
    return { label: normalized.toUpperCase(), icon: FileArchive, className: "border-amber-300 bg-amber-50 text-amber-700" };
  }
  return { label: normalized.toUpperCase(), icon: FileText, className: "border-stone-300 bg-stone-50 text-stone-700" };
}

function extensionFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const token = filename.trim();
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0 || dot === token.length - 1) return null;
  return token.slice(dot + 1).toLowerCase();
}

function loadLocalTaskSettings(): DashboardTaskSettingsResponse | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(LOCAL_TASK_SETTINGS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DashboardTaskSettingsResponse>;
    const categories = normalizeCategoryList(Array.isArray(parsed.categories) ? parsed.categories : []);
    const defaultTime = typeof parsed.default_time === "string" && isValidTime(parsed.default_time) ? parsed.default_time : "09:00";
    const categoryColors = normalizeCategoryColorMap(
      parsed.category_colors && typeof parsed.category_colors === "object"
        ? (parsed.category_colors as Record<string, string>)
        : {},
      categories,
    );
    const holidays = normalizeHolidaysMap(parsed.holidays && typeof parsed.holidays === "object" ? (parsed.holidays as Record<string, unknown>) : {});
    return {
      categories,
      category_colors: categoryColors,
      holidays,
      allow_all_day: typeof parsed.allow_all_day === "boolean" ? parsed.allow_all_day : true,
      use_location: typeof parsed.use_location === "boolean" ? parsed.use_location : true,
      use_comment: typeof parsed.use_comment === "boolean" ? parsed.use_comment : true,
      default_time: defaultTime,
      list_range_past_days:
        parsed.list_range_past_days === undefined
          ? DEFAULT_TASK_LIST_RANGE_PAST_DAYS
          : normalizeTaskListRangePastDays(parsed.list_range_past_days),
      list_range_future_months:
        parsed.list_range_future_months === undefined
          ? DEFAULT_TASK_LIST_RANGE_FUTURE_MONTHS
          : normalizeTaskListRangeFutureMonths(parsed.list_range_future_months),
      generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : "",
    };
  } catch {
    return null;
  }
}

function saveLocalTaskSettings(settings: DashboardTaskSettingsResponse): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    LOCAL_TASK_SETTINGS_KEY,
    JSON.stringify({
      categories: normalizeCategoryList(settings.categories || []),
      category_colors: normalizeCategoryColorMap(settings.category_colors || {}, normalizeCategoryList(settings.categories || [])),
      holidays: normalizeHolidaysMap(settings.holidays || {}),
      allow_all_day: !!settings.allow_all_day,
      use_location: !!settings.use_location,
      use_comment: !!settings.use_comment,
      default_time: isValidTime(settings.default_time) ? settings.default_time : "09:00",
      list_range_past_days: normalizeTaskListRangePastDays(settings.list_range_past_days),
      list_range_future_months: normalizeTaskListRangeFutureMonths(settings.list_range_future_months),
      generated_at: settings.generated_at || new Date().toISOString(),
    }),
  );
}

export function DashboardSummary() {
  const searchParams = useSearchParams();
  const editTaskQueryInflightRef = useRef<string | null>(null);
  const listTasksRequestSeqRef = useRef(0);
  const taskListElementRef = useRef<HTMLUListElement | null>(null);
  const didAutoCenterTodayInListRef = useRef(false);

  const [data, setData] = useState<DashboardSummaryResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [statsOpen, setStatsOpen] = useState(false);

  const [monthKey, setMonthKey] = useState(monthKeyFromDate(new Date()));
  const [calendarTasks, setCalendarTasks] = useState<DashboardTaskItem[]>([]);
  const [listTasks, setListTasks] = useState<DashboardTaskItem[]>([]);
  const [listTasksLoading, setListTasksLoading] = useState(false);
  const [listTasksLoadedOnce, setListTasksLoadedOnce] = useState(false);
  const [listTasksError, setListTasksError] = useState("");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("ALL");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const [taskSettings, setTaskSettings] = useState<DashboardTaskSettingsResponse>(DEFAULT_TASK_SETTINGS);
  const [taskSettingsLoading, setTaskSettingsLoading] = useState(true);
  const [taskSettingsError, setTaskSettingsError] = useState("");
  const [taskSettingsApiSupported, setTaskSettingsApiSupported] = useState(true);

  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [taskFormError, setTaskFormError] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [taskCategory, setTaskCategory] = useState("할일");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDate, setTaskDate] = useState(dateKeyFromDate(new Date()));
  const [taskTime, setTaskTime] = useState("09:00");
  const [taskEndTime, setTaskEndTime] = useState("");
  const [taskEndTimeTouched, setTaskEndTimeTouched] = useState(false);
  const [taskAllDay, setTaskAllDay] = useState(false);
  const [taskLocation, setTaskLocation] = useState("");
  const [taskComment, setTaskComment] = useState("");
  const [taskLinkedDocumentId, setTaskLinkedDocumentId] = useState("");
  const [taskLinkedDocumentTitle, setTaskLinkedDocumentTitle] = useState("");
  const [taskLinkedFileId, setTaskLinkedFileId] = useState("");
  const [archiveDocumentsLoading, setArchiveDocumentsLoading] = useState(false);
  const [archiveDocumentsError, setArchiveDocumentsError] = useState("");
  const [archiveDocuments, setArchiveDocuments] = useState<ArchiveDocumentListItem[]>([]);
  const [archiveFilesLoading, setArchiveFilesLoading] = useState(false);
  const [archiveFilesError, setArchiveFilesError] = useState("");
  const [archiveFiles, setArchiveFiles] = useState<ArchiveDocumentFileItem[]>([]);

  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsSubmitting, setSettingsSubmitting] = useState(false);
  const [settingsFormError, setSettingsFormError] = useState("");
  const [settingsFormNotice, setSettingsFormNotice] = useState("");
  const [settingsCategoryInput, setSettingsCategoryInput] = useState("");
  const [settingsCategories, setSettingsCategories] = useState<string[]>(DEFAULT_TASK_SETTINGS.categories);
  const [settingsCategoryColors, setSettingsCategoryColors] = useState<Record<string, string>>(DEFAULT_TASK_SETTINGS.category_colors);
  const [settingsAllowAllDay, setSettingsAllowAllDay] = useState(true);
  const [settingsUseLocation, setSettingsUseLocation] = useState(true);
  const [settingsUseComment, setSettingsUseComment] = useState(true);
  const [settingsDefaultTime, setSettingsDefaultTime] = useState("09:00");
  const [settingsListRangePastDays, setSettingsListRangePastDays] = useState(DEFAULT_TASK_LIST_RANGE_PAST_DAYS);
  const [settingsListRangeFutureMonths, setSettingsListRangeFutureMonths] = useState(DEFAULT_TASK_LIST_RANGE_FUTURE_MONTHS);

  const [calendarSettingsModalOpen, setCalendarSettingsModalOpen] = useState(false);
  const [calendarSettingsSubmitting, setCalendarSettingsSubmitting] = useState(false);
  const [calendarSettingsError, setCalendarSettingsError] = useState("");
  const [calendarSettingsNotice, setCalendarSettingsNotice] = useState("");
  const [calendarHolidays, setCalendarHolidays] = useState<Record<string, string>>(DEFAULT_TASK_SETTINGS.holidays);
  const [calendarHolidayDate, setCalendarHolidayDate] = useState(dateKeyFromDate(new Date()));
  const [calendarHolidayName, setCalendarHolidayName] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      setLoading(true);
      setError("");
      try {
        const next = await apiGet<DashboardSummaryResponse>("/dashboard/summary?recent_limit=9");
        if (!cancelled) setData(next);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "대시보드 로드 실패");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSummary();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadTaskSettings = useCallback(async () => {
    setTaskSettingsLoading(true);
    setTaskSettingsError("");
    try {
      const res = await apiGet<DashboardTaskSettingsResponse>("/dashboard/task-settings");
      const categories = normalizeCategoryList(res.categories || []);
      const categoryColors = normalizeCategoryColorMap(res.category_colors || {}, categories);
      const normalized: DashboardTaskSettingsResponse = {
        ...res,
        categories,
        category_colors: categoryColors,
        holidays: normalizeHolidaysMap(res.holidays || {}),
        default_time: isValidTime(res.default_time) ? res.default_time : "09:00",
        list_range_past_days: normalizeTaskListRangePastDays(res.list_range_past_days),
        list_range_future_months: normalizeTaskListRangeFutureMonths(res.list_range_future_months),
      };
      setTaskSettingsApiSupported(true);
      setTaskSettings(normalized);
      setTaskCategory((prev) => (categories.includes(prev) ? prev : categories[0]));
      setTaskTime(normalized.default_time);
    } catch (err) {
      const message = err instanceof Error ? err.message : "일정 설정 로드 실패";
      // 구버전 백엔드(설정 API 미지원)에서는 기본값으로 조용히 폴백한다.
      if (message.includes("404")) {
        setTaskSettingsApiSupported(false);
        setTaskSettingsError("");
        const local = loadLocalTaskSettings();
        if (local) {
          setTaskSettings(local);
          setTaskCategory((prev) => (local.categories.includes(prev) ? prev : local.categories[0]));
          setTaskTime(local.default_time);
          return;
        }
      } else {
        setTaskSettingsError(message);
      }
      setTaskSettings(DEFAULT_TASK_SETTINGS);
      setTaskCategory(DEFAULT_TASK_SETTINGS.categories[0]);
      setTaskTime(DEFAULT_TASK_SETTINGS.default_time);
    } finally {
      setTaskSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTaskSettings();
  }, [loadTaskSettings]);

  const taskListWindow = useMemo(() => {
    const range = buildTaskListRange(new Date(), taskSettings.list_range_past_days, taskSettings.list_range_future_months);
    const startDateKey = dateKeyFromDate(range.startDate);
    const endDateKey = dateKeyFromDate(range.endDateInclusive);
    return {
      ...range,
      startDateKey,
      endDateKey,
      startAtIso: range.startDate.toISOString(),
      endAtIso: range.endDateExclusive.toISOString(),
      label: `${startDateKey} ~ ${endDateKey}`,
    };
  }, [taskSettings.list_range_future_months, taskSettings.list_range_past_days]);

  const loadCalendarTasks = useCallback(async (targetMonth: string) => {
    try {
      const res = await apiGet<DashboardTaskListResponse>(`/dashboard/tasks?month=${encodeURIComponent(targetMonth)}`);
      setCalendarTasks(res.items || []);
    } catch {
      setCalendarTasks([]);
    }
  }, []);

  useEffect(() => {
    void loadCalendarTasks(monthKey);
  }, [loadCalendarTasks, monthKey]);

  const loadListTasks = useCallback(async (startAtIso: string, endAtIso: string) => {
    const requestSeq = listTasksRequestSeqRef.current + 1;
    listTasksRequestSeqRef.current = requestSeq;
    setListTasksLoadedOnce(false);
    setListTasksLoading(true);
    setListTasksError("");
    try {
      const query = `start_at=${encodeURIComponent(startAtIso)}&end_at=${encodeURIComponent(endAtIso)}`;
      const res = await apiGet<DashboardTaskListResponse>(`/dashboard/tasks?${query}`);
      if (listTasksRequestSeqRef.current !== requestSeq) return;
      setListTasks(res.items || []);
    } catch (err) {
      if (listTasksRequestSeqRef.current !== requestSeq) return;
      setListTasksError(err instanceof Error ? err.message : "일정 목록 로드 실패");
      setListTasks([]);
    } finally {
      if (listTasksRequestSeqRef.current !== requestSeq) return;
      setListTasksLoadedOnce(true);
      setListTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (taskSettingsLoading) return;
    void loadListTasks(taskListWindow.startAtIso, taskListWindow.endAtIso);
  }, [loadListTasks, taskListWindow.endAtIso, taskListWindow.startAtIso, taskSettingsLoading]);

  useEffect(() => {
    didAutoCenterTodayInListRef.current = false;
  }, [taskListWindow.endAtIso, taskListWindow.startAtIso]);

  useEffect(() => {
    if (taskFilter === "ALL") return;
    if (!taskSettings.categories.includes(taskFilter)) {
      setTaskFilter("ALL");
    }
  }, [taskFilter, taskSettings.categories]);

  useEffect(() => {
    if (!selectedDate) return;
    if (selectedDate < taskListWindow.startDateKey || selectedDate > taskListWindow.endDateKey) {
      setSelectedDate(null);
    }
  }, [selectedDate, taskListWindow.endDateKey, taskListWindow.startDateKey]);

  const tasksByDate = useMemo(() => {
    const map = new Map<string, DashboardTaskItem[]>();
    for (const item of calendarTasks) {
      const key = dateKeyFromDate(new Date(item.scheduled_at));
      const existing = map.get(key);
      if (existing) existing.push(item);
      else map.set(key, [item]);
    }
    for (const [, arr] of map.entries()) {
      arr.sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
    }
    return map;
  }, [calendarTasks]);

  const filteredTasks = useMemo(() => {
    let arr = listTasks;
    if (taskFilter !== "ALL") {
      arr = arr.filter((item) => item.category === taskFilter);
    }
    if (selectedDate) {
      arr = arr.filter((item) => dateKeyFromDate(new Date(item.scheduled_at)) === selectedDate);
    }
    return [...arr].sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  }, [selectedDate, taskFilter, listTasks]);

  useEffect(() => {
    if (!listTasksLoadedOnce || listTasksLoading) return;
    if (didAutoCenterTodayInListRef.current) return;
    const listElement = taskListElementRef.current;
    if (!listElement) return;

    const todayKey = dateKeyFromDate(new Date());
    const targetTask = filteredTasks.find((item) => {
      const itemDateKey = dateKeyFromDate(new Date(item.scheduled_at));
      return itemDateKey >= todayKey;
    });

    let cancelled = false;
    let firstRaf = 0;

    const alignToTargetCenter = (targetId: string): boolean => {
      const target = Array.from(listElement.querySelectorAll<HTMLElement>("[data-task-id]")).find(
        (node) => node.dataset.taskId === targetId,
      );
      if (!target) return false;
      const maxScrollTop = Math.max(0, listElement.scrollHeight - listElement.clientHeight);
      const listRect = listElement.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const relativeTop = targetRect.top - listRect.top + listElement.scrollTop;
      const targetCenter = relativeTop + targetRect.height / 2;
      const nextScrollTop = targetCenter - listElement.clientHeight / 2;
      listElement.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
      return true;
    };

    const runAlign = (attempt: number) => {
      if (cancelled) return;
      if (!targetTask) {
        listElement.scrollTop = 0;
        didAutoCenterTodayInListRef.current = true;
        return;
      }
      const aligned = alignToTargetCenter(targetTask.id);
      if (aligned || attempt >= 4) {
        didAutoCenterTodayInListRef.current = true;
        return;
      }
      window.requestAnimationFrame(() => runAlign(attempt + 1));
    };

    firstRaf = window.requestAnimationFrame(() => runAlign(0));
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(firstRaf);
    };
  }, [filteredTasks, listTasksLoadedOnce, listTasksLoading]);

  const calendarCells = useMemo(() => buildCalendarCells(monthKey), [monthKey]);
  const taskFilterOptions = useMemo<TaskFilter[]>(() => ["ALL", ...taskSettings.categories], [taskSettings.categories]);

  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - 6);
  const timelineRecent7dHref = `/timeline?scale=day&from=${encodeURIComponent(dateKeyFromDate(from))}&to=${encodeURIComponent(dateKeyFromDate(now))}`;

  const metricCards: Array<{ label: string; value: string; href: string; icon: LucideIcon }> = data
    ? [
        { label: "총 문서 수", value: data.total_documents.toLocaleString("ko-KR"), href: "/archive", icon: Files },
        {
          label: "최근 7일 업로드",
          value: data.recent_uploads_7d.toLocaleString("ko-KR"),
          href: timelineRecent7dHref,
          icon: CalendarDays,
        },
        {
          label: "검토 필요",
          value: data.needs_review_count.toLocaleString("ko-KR"),
          href: "/review-queue",
          icon: ListFilter,
        },
        { label: "실패 작업", value: data.failed_jobs_count.toLocaleString("ko-KR"), href: "/admin", icon: CircleAlert },
        { label: "재시도 대기", value: data.retry_scheduled_count.toLocaleString("ko-KR"), href: "/admin", icon: Clock3 },
        { label: "DLQ", value: data.dead_letter_count.toLocaleString("ko-KR"), href: "/admin", icon: ShieldCheck },
      ]
    : [];

  const pinnedByCategory = data?.pinned_by_category || [];
  const recentDocuments = data?.recent_documents || [];
  const failedErrorCodes = data?.failed_error_codes || [];

  const resetTaskFormForDate = useCallback(
    (dateKey: string) => {
      setTaskFormError("");
      setEditingTaskId(null);
      const defaultCategory = taskSettings.categories[0] || "할일";
      const defaultTime = taskSettings.default_time || "09:00";
      setTaskCategory(defaultCategory);
      setTaskTitle("");
      setTaskDate(dateKey);
      setTaskTime(defaultTime);
      setTaskEndTime(addMinutesToTime(defaultTime, 60));
      setTaskEndTimeTouched(false);
      setTaskAllDay(false);
      setTaskLocation("");
      setTaskComment("");
      setTaskLinkedDocumentId("");
      setTaskLinkedDocumentTitle("");
      setTaskLinkedFileId("");
      setArchiveDocumentsError("");
      setArchiveDocuments([]);
      setArchiveFilesError("");
      setArchiveFiles([]);
    },
    [taskSettings.categories, taskSettings.default_time],
  );

  const openTaskModal = useCallback(
    (dateKey: string) => {
      resetTaskFormForDate(dateKey);
      setTaskModalOpen(true);
    },
    [resetTaskFormForDate],
  );

  const openTaskEditModal = useCallback(
    (item: DashboardTaskItem) => {
      setTaskFormError("");
      setEditingTaskId(item.id);
      const nextCategory = taskSettings.categories.includes(item.category) ? item.category : taskSettings.categories[0] || "할일";
      const startTime = item.all_day ? taskSettings.default_time || "09:00" : toTimeInputValue(item.scheduled_at);
      const endTimeFromItem = item.ended_at ? toTimeInputValue(item.ended_at) : "";
      const shouldDefaultEnd = !item.all_day && !endTimeFromItem;
      setTaskCategory(nextCategory);
      setTaskTitle(item.title);
      setTaskDate(toDateInputValue(item.scheduled_at));
      setTaskTime(startTime);
      setTaskEndTime(shouldDefaultEnd ? addMinutesToTime(startTime, 60) : endTimeFromItem);
      setTaskEndTimeTouched(!shouldDefaultEnd && Boolean(endTimeFromItem));
      setTaskAllDay(item.all_day);
      setTaskLocation(item.location || "");
      setTaskComment(item.comment || "");
      setTaskLinkedDocumentId(item.linked_document_id || "");
      setTaskLinkedDocumentTitle(item.linked_document_title || "");
      setTaskLinkedFileId(item.linked_file_id || "");
      setArchiveDocumentsError("");
      setArchiveDocuments([]);
      setArchiveFilesError("");
      setArchiveFiles([]);
      setTaskModalOpen(true);
    },
    [taskSettings.categories, taskSettings.default_time],
  );

  const closeTaskModal = useCallback(() => {
    setTaskModalOpen(false);
    setEditingTaskId(null);
    setTaskFormError("");
  }, []);

  const clearEditTaskIdQuery = useCallback(() => {
    if (!searchParams.has("edit_task_id")) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("edit_task_id");
    const qs = next.toString();
    if (typeof window === "undefined") return;
    const nextUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [searchParams]);

  useEffect(() => {
    const editTaskId = (searchParams.get("edit_task_id") || "").trim();
    if (!editTaskId || taskSettingsLoading) return;
    if (editTaskQueryInflightRef.current === editTaskId) return;
    editTaskQueryInflightRef.current = editTaskId;

    let cancelled = false;
    async function openTaskModalFromQuery() {
      try {
        const task = await apiGet<DashboardTaskItem>(`/dashboard/tasks/${encodeURIComponent(editTaskId)}`);
        if (!cancelled) {
          openTaskEditModal(task);
        }
      } catch (err) {
        if (!cancelled) {
          setListTasksError(err instanceof Error ? err.message : "일정 수정창 로드 실패");
        }
      } finally {
        if (!cancelled) {
          editTaskQueryInflightRef.current = null;
          clearEditTaskIdQuery();
        }
      }
    }

    void openTaskModalFromQuery();
    return () => {
      cancelled = true;
      editTaskQueryInflightRef.current = null;
    };
  }, [clearEditTaskIdQuery, openTaskEditModal, searchParams, taskSettingsLoading]);

  const loadArchiveDocumentsForDate = useCallback(
    async (dateKey: string) => {
      if (!dateKey) {
        setArchiveDocuments([]);
        return;
      }
      setArchiveDocumentsLoading(true);
      setArchiveDocumentsError("");
      try {
        const query = `page=1&size=100&event_date_from=${encodeURIComponent(dateKey)}&event_date_to=${encodeURIComponent(
          dateKey,
        )}&sort_by=ingested_at&sort_order=desc`;
        const res = await apiGet<ArchiveDocumentListResponse>(`/documents?${query}`);
        const items = (res.items || []).map((doc) => ({
          id: doc.id,
          title: doc.title,
          event_date: doc.event_date,
          file_count: doc.file_count ?? 0,
        }));
        const hasCurrentLinkedDocument = !!taskLinkedDocumentId && items.some((doc) => doc.id === taskLinkedDocumentId);
        const mergedItems =
          !hasCurrentLinkedDocument && taskLinkedDocumentId
            ? [
                {
                  id: taskLinkedDocumentId,
                  title: taskLinkedDocumentTitle || "기존 연결 게시물",
                  event_date: dateKey,
                  file_count: 0,
                },
                ...items,
              ]
            : items;
        setArchiveDocuments(mergedItems);
      } catch (err) {
        setArchiveDocumentsError(err instanceof Error ? err.message : "아카이브 게시물 조회 실패");
        setArchiveDocuments([]);
      } finally {
        setArchiveDocumentsLoading(false);
      }
    },
    [taskLinkedDocumentId, taskLinkedDocumentTitle],
  );

  const loadArchiveFilesForDocument = useCallback(async (documentId: string) => {
    if (!documentId) {
      setArchiveFiles([]);
      return;
    }
    setArchiveFilesLoading(true);
    setArchiveFilesError("");
    try {
      const res = await apiGet<ArchiveDocumentDetailResponse>(`/documents/${documentId}`);
      const files = Array.isArray(res.files)
        ? res.files.map((file) => ({
            id: file.id,
            original_filename: file.original_filename,
            download_path: file.download_path,
          }))
        : [];
      setArchiveFiles(files);
      setTaskLinkedDocumentTitle(res.title || "");
      setTaskLinkedFileId((prev) => (files.some((file) => file.id === prev) ? prev : ""));
    } catch (err) {
      setArchiveFilesError(err instanceof Error ? err.message : "첨부파일 조회 실패");
      setArchiveFiles([]);
      setTaskLinkedFileId("");
    } finally {
      setArchiveFilesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!taskModalOpen || !editingTaskId || !isMeetingCategory(taskCategory)) {
      setArchiveDocuments([]);
      setArchiveDocumentsError("");
      setArchiveFiles([]);
      setArchiveFilesError("");
      return;
    }
    void loadArchiveDocumentsForDate(taskDate);
  }, [editingTaskId, loadArchiveDocumentsForDate, taskCategory, taskDate, taskModalOpen]);

  useEffect(() => {
    if (!taskModalOpen || !editingTaskId || !isMeetingCategory(taskCategory) || !taskLinkedDocumentId) {
      setArchiveFiles([]);
      setArchiveFilesError("");
      setTaskLinkedFileId("");
      return;
    }
    void loadArchiveFilesForDocument(taskLinkedDocumentId);
  }, [editingTaskId, loadArchiveFilesForDocument, taskCategory, taskLinkedDocumentId, taskModalOpen]);

  useEffect(() => {
    if (!taskModalOpen) return;
    if (taskAllDay) {
      setTaskEndTime("");
      setTaskEndTimeTouched(false);
      return;
    }
    if (taskEndTimeTouched) return;
    const baseTime = isValidTime(taskTime) ? taskTime : taskSettings.default_time || "09:00";
    setTaskEndTime(addMinutesToTime(baseTime, 60));
  }, [taskAllDay, taskEndTimeTouched, taskModalOpen, taskSettings.default_time, taskTime]);

  useEffect(() => {
    if (isMeetingCategory(taskCategory)) return;
    setTaskLinkedDocumentId("");
    setTaskLinkedDocumentTitle("");
    setTaskLinkedFileId("");
    setArchiveDocuments([]);
    setArchiveDocumentsError("");
    setArchiveFiles([]);
    setArchiveFilesError("");
  }, [taskCategory]);

  const submitTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTaskFormError("");

    const category = taskCategory.trim();
    const title = taskTitle.trim();
    if (!category) {
      setTaskFormError("카테고리를 선택하세요.");
      return;
    }
    if (!taskSettings.categories.includes(category)) {
      setTaskFormError("유효하지 않은 카테고리입니다. 설정을 확인하세요.");
      return;
    }
    if (!title) {
      setTaskFormError("제목을 입력하세요.");
      return;
    }
    if (!taskDate) {
      setTaskFormError("날짜를 입력하세요.");
      return;
    }

    const allowAllDay = taskSettings.allow_all_day;
    const allDay = allowAllDay ? taskAllDay : false;
    if (!allDay && !taskTime) {
      setTaskFormError("시간을 입력하세요.");
      return;
    }
    let endTime = taskEndTime.trim();
    if (!allDay && !endTime && !taskEndTimeTouched) {
      endTime = addMinutesToTime(taskTime, 60);
    }
    if (!allDay && endTime && !isValidTime(endTime)) {
      setTaskFormError("종료 시간 형식이 올바르지 않습니다.");
      return;
    }
    const linkedDocumentId = taskLinkedDocumentId.trim();
    const linkedFileId = taskLinkedFileId.trim();
    if (linkedDocumentId && !linkedFileId) {
      setTaskFormError("첨부파일까지 선택해야 일정에 연결할 수 있습니다.");
      return;
    }
    if (!linkedDocumentId && linkedFileId) {
      setTaskFormError("먼저 아카이브 게시물을 선택하세요.");
      return;
    }

    const datetimeLocal = allDay ? `${taskDate}T00:00:00` : `${taskDate}T${taskTime}:00`;
    const parsed = new Date(datetimeLocal);
    if (Number.isNaN(parsed.getTime())) {
      setTaskFormError("날짜/시간 형식이 올바르지 않습니다.");
      return;
    }
    const parsedEnd = !allDay && endTime ? new Date(`${taskDate}T${endTime}:00`) : null;
    if (parsedEnd && Number.isNaN(parsedEnd.getTime())) {
      setTaskFormError("종료 시간 형식이 올바르지 않습니다.");
      return;
    }
    if (parsedEnd && parsedEnd.getTime() <= parsed.getTime()) {
      setTaskFormError("종료 시간은 시작 시간보다 늦어야 합니다.");
      return;
    }

    setTaskSubmitting(true);
    try {
      const payload = {
        category,
        title,
        scheduled_at: parsed.toISOString(),
        ended_at: parsedEnd ? parsedEnd.toISOString() : null,
        all_day: allDay,
        location: taskSettings.use_location ? taskLocation.trim() || null : null,
        comment: taskSettings.use_comment ? taskComment.trim() || null : null,
        linked_document_id: linkedDocumentId || null,
        linked_file_id: linkedFileId || null,
      };
      let savedTask: DashboardTaskItem;
      if (editingTaskId) {
        savedTask = await apiPatch<DashboardTaskItem>(`/dashboard/tasks/${editingTaskId}`, payload);
      } else {
        savedTask = await apiPost<DashboardTaskItem>("/dashboard/tasks", payload);
      }

      const expectedLinkedDocumentId = linkedDocumentId || null;
      const expectedLinkedFileId = linkedFileId || null;
      if (savedTask.linked_document_id !== expectedLinkedDocumentId || savedTask.linked_file_id !== expectedLinkedFileId) {
        throw new Error("첨부파일 연결이 서버(DB)에 저장되지 않았습니다. 서버 마이그레이션/배포 상태를 확인하세요.");
      }
      const expectedEndedAtMs = parsedEnd ? parsedEnd.getTime() : null;
      const savedEndedAtMs = savedTask.ended_at ? new Date(savedTask.ended_at).getTime() : null;
      if (expectedEndedAtMs !== savedEndedAtMs) {
        throw new Error("종료 시간이 서버(DB)에 저장되지 않았습니다. 백엔드 최신 배포/마이그레이션 상태를 확인하세요.");
      }

      closeTaskModal();
      await Promise.all([
        loadCalendarTasks(monthKey),
        loadListTasks(taskListWindow.startAtIso, taskListWindow.endAtIso),
      ]);
    } catch (err) {
      setTaskFormError(err instanceof Error ? err.message : editingTaskId ? "일정 수정 실패" : "일정 등록 실패");
    } finally {
      setTaskSubmitting(false);
    }
  };

  const openSettingsModal = () => {
    setSettingsFormError("");
    setSettingsFormNotice("");
    setSettingsCategoryInput("");
    setSettingsCategories([...taskSettings.categories]);
    setSettingsCategoryColors(normalizeCategoryColorMap(taskSettings.category_colors || {}, taskSettings.categories));
    setSettingsAllowAllDay(taskSettings.allow_all_day);
    setSettingsUseLocation(taskSettings.use_location);
    setSettingsUseComment(taskSettings.use_comment);
    setSettingsDefaultTime(taskSettings.default_time || "09:00");
    setSettingsListRangePastDays(normalizeTaskListRangePastDays(taskSettings.list_range_past_days));
    setSettingsListRangeFutureMonths(normalizeTaskListRangeFutureMonths(taskSettings.list_range_future_months));
    setSettingsModalOpen(true);
  };

  const addSettingsCategory = () => {
    const token = settingsCategoryInput.trim();
    if (!token) return;
    setSettingsCategories((prev) => {
      const next = normalizeCategoryList([...prev, token]);
      setSettingsCategoryColors((prevColors) => normalizeCategoryColorMap(prevColors, next));
      return next;
    });
    setSettingsCategoryInput("");
  };

  const onSettingsCategoryInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addSettingsCategory();
  };

  const removeSettingsCategory = (name: string) => {
    setSettingsCategories((prev) => {
      const next = prev.filter((item) => item !== name);
      const normalized = normalizeCategoryList(next);
      setSettingsCategoryColors((prevColors) => normalizeCategoryColorMap(prevColors, normalized));
      return normalized;
    });
  };

  const updateSettingsCategoryColor = (name: string, color: string) => {
    const normalizedColor = normalizeHexColor(color);
    if (!normalizedColor) return;
    setSettingsCategoryColors((prev) => ({
      ...prev,
      [name]: normalizedColor,
    }));
  };

  const submitTaskSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSettingsFormError("");
    setSettingsFormNotice("");

    const categories = normalizeCategoryList(settingsCategories);
    const categoryColors = normalizeCategoryColorMap(settingsCategoryColors, categories);
    const preservedHolidays = normalizeHolidaysMap(taskSettings.holidays || {});
    if (!isValidTime(settingsDefaultTime.trim())) {
      setSettingsFormError("기본 시간은 HH:MM 형식이어야 합니다.");
      return;
    }
    const listRangePastDays = normalizeTaskListRangePastDays(settingsListRangePastDays);
    const listRangeFutureMonths = normalizeTaskListRangeFutureMonths(settingsListRangeFutureMonths);

    const localNext: DashboardTaskSettingsResponse = {
      categories,
      category_colors: categoryColors,
      holidays: preservedHolidays,
      allow_all_day: settingsAllowAllDay,
      use_location: settingsUseLocation,
      use_comment: settingsUseComment,
      default_time: settingsDefaultTime.trim(),
      list_range_past_days: listRangePastDays,
      list_range_future_months: listRangeFutureMonths,
      generated_at: new Date().toISOString(),
    };

    // 설정 API 미지원 서버에서는 로컬 설정으로 저장해 계속 사용할 수 있게 한다.
    if (!taskSettingsApiSupported) {
      setTaskSettings(localNext);
      setTaskCategory((prev) => (localNext.categories.includes(prev) ? prev : localNext.categories[0]));
      setTaskTime(localNext.default_time);
      saveLocalTaskSettings(localNext);
      setSettingsFormNotice("서버 설정 API 미지원: 브라우저 로컬 설정으로 저장했습니다.");
      setSettingsModalOpen(false);
      return;
    }

    setSettingsSubmitting(true);
    try {
      const next = await apiFetch<DashboardTaskSettingsResponse>("/dashboard/task-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categories,
          category_colors: categoryColors,
          holidays: preservedHolidays,
          allow_all_day: settingsAllowAllDay,
          use_location: settingsUseLocation,
          use_comment: settingsUseComment,
          default_time: settingsDefaultTime.trim(),
          list_range_past_days: listRangePastDays,
          list_range_future_months: listRangeFutureMonths,
        }),
      });
      const nextCategories = normalizeCategoryList(next.categories || []);
      const normalized = {
        ...next,
        categories: nextCategories,
        category_colors: normalizeCategoryColorMap(next.category_colors || {}, nextCategories),
        holidays: normalizeHolidaysMap(next.holidays || {}),
        list_range_past_days: normalizeTaskListRangePastDays(next.list_range_past_days),
        list_range_future_months: normalizeTaskListRangeFutureMonths(next.list_range_future_months),
      };
      setTaskSettings(normalized);
      setTaskCategory((prev) => (normalized.categories.includes(prev) ? prev : normalized.categories[0]));
      setTaskTime(normalized.default_time || "09:00");
      saveLocalTaskSettings(normalized);
      await loadTaskSettings();
      setSettingsModalOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "설정 저장 실패";
      if (message.includes("404")) {
        setTaskSettingsApiSupported(false);
        setTaskSettings(localNext);
        setTaskCategory((prev) => (localNext.categories.includes(prev) ? prev : localNext.categories[0]));
        setTaskTime(localNext.default_time);
        saveLocalTaskSettings(localNext);
        setSettingsFormNotice("서버 설정 API 미지원: 브라우저 로컬 설정으로 저장했습니다.");
        setSettingsModalOpen(false);
      } else if (message.includes("403")) {
        setSettingsFormError("설정 저장 권한이 없습니다. 관리자 또는 편집자 계정으로 로그인하세요.");
      } else {
        setSettingsFormError(message);
      }
    } finally {
      setSettingsSubmitting(false);
    }
  };

  const openCalendarSettingsModal = () => {
    setCalendarSettingsError("");
    setCalendarSettingsNotice("");
    setCalendarHolidays(normalizeHolidaysMap(taskSettings.holidays || {}));
    setCalendarHolidayDate(dateKeyFromDate(new Date()));
    setCalendarHolidayName("");
    setCalendarSettingsModalOpen(true);
  };

  const persistCalendarHolidays = async (
    rawHolidays: Record<string, string>,
    options?: { closeModalOnSuccess?: boolean; successNotice?: string },
  ): Promise<boolean> => {
    const closeModalOnSuccess = !!options?.closeModalOnSuccess;
    const successNotice = options?.successNotice || "";
    const holidays = normalizeHolidaysMap(rawHolidays);

    setCalendarSettingsError("");
    setCalendarSettingsNotice("");

    const categories = normalizeCategoryList(taskSettings.categories || []);
    const categoryColors = normalizeCategoryColorMap(taskSettings.category_colors || {}, categories);
    const defaultTime = isValidTime(taskSettings.default_time) ? taskSettings.default_time : "09:00";
    const listRangePastDays = normalizeTaskListRangePastDays(taskSettings.list_range_past_days);
    const listRangeFutureMonths = normalizeTaskListRangeFutureMonths(taskSettings.list_range_future_months);

    const localNext: DashboardTaskSettingsResponse = {
      categories,
      category_colors: categoryColors,
      holidays,
      allow_all_day: !!taskSettings.allow_all_day,
      use_location: !!taskSettings.use_location,
      use_comment: !!taskSettings.use_comment,
      default_time: defaultTime,
      list_range_past_days: listRangePastDays,
      list_range_future_months: listRangeFutureMonths,
      generated_at: new Date().toISOString(),
    };

    if (!taskSettingsApiSupported) {
      setTaskSettings(localNext);
      setCalendarHolidays(holidays);
      saveLocalTaskSettings(localNext);
      setCalendarSettingsNotice("서버 설정 API 미지원: 브라우저 로컬 설정으로 저장했습니다.");
      if (closeModalOnSuccess) setCalendarSettingsModalOpen(false);
      return true;
    }

    setCalendarSettingsSubmitting(true);
    try {
      const next = await apiFetch<DashboardTaskSettingsResponse>("/dashboard/task-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categories,
          category_colors: categoryColors,
          holidays,
          allow_all_day: localNext.allow_all_day,
          use_location: localNext.use_location,
          use_comment: localNext.use_comment,
          default_time: defaultTime,
          list_range_past_days: listRangePastDays,
          list_range_future_months: listRangeFutureMonths,
        }),
      });
      const nextCategories = normalizeCategoryList(next.categories || []);
      const normalized: DashboardTaskSettingsResponse = {
        ...next,
        categories: nextCategories,
        category_colors: normalizeCategoryColorMap(next.category_colors || {}, nextCategories),
        holidays: normalizeHolidaysMap(next.holidays || {}),
        default_time: isValidTime(next.default_time) ? next.default_time : "09:00",
        list_range_past_days: normalizeTaskListRangePastDays(next.list_range_past_days),
        list_range_future_months: normalizeTaskListRangeFutureMonths(next.list_range_future_months),
      };
      setTaskSettings(normalized);
      setCalendarHolidays(normalized.holidays);
      saveLocalTaskSettings(normalized);
      if (successNotice) {
        setCalendarSettingsNotice(successNotice);
      }
      if (closeModalOnSuccess) setCalendarSettingsModalOpen(false);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "캘린더 설정 저장 실패";
      if (message.includes("404")) {
        setTaskSettingsApiSupported(false);
        setTaskSettings(localNext);
        setCalendarHolidays(holidays);
        saveLocalTaskSettings(localNext);
        setCalendarSettingsNotice("서버 설정 API 미지원: 브라우저 로컬 설정으로 저장했습니다.");
        if (closeModalOnSuccess) setCalendarSettingsModalOpen(false);
      } else if (message.includes("403")) {
        setCalendarSettingsError("설정 저장 권한이 없습니다. 관리자 또는 편집자 계정으로 로그인하세요.");
      } else {
        setCalendarSettingsError(message);
      }
      return false;
    } finally {
      setCalendarSettingsSubmitting(false);
    }
  };

  const addOrUpdateCalendarHoliday = async () => {
    setCalendarSettingsError("");
    setCalendarSettingsNotice("");
    const dateKey = normalizeHolidayDateKey(calendarHolidayDate);
    if (!dateKey) {
      setCalendarSettingsError("휴일 날짜 형식이 올바르지 않습니다.");
      return;
    }
    const holidayName = normalizeHolidayName(calendarHolidayName);
    if (!holidayName) {
      setCalendarSettingsError("휴일 이름을 입력하세요.");
      return;
    }
    const nextHolidays = normalizeHolidaysMap({ ...calendarHolidays, [dateKey]: holidayName });
    setCalendarHolidays(nextHolidays);
    setCalendarHolidayName("");
    await persistCalendarHolidays(nextHolidays, { successNotice: "휴일 설정을 저장했습니다." });
  };

  const removeCalendarHoliday = async (dateKey: string) => {
    setCalendarSettingsError("");
    setCalendarSettingsNotice("");
    const next = { ...calendarHolidays };
    delete next[dateKey];
    const normalized = normalizeHolidaysMap(next);
    setCalendarHolidays(normalized);
    await persistCalendarHolidays(normalized, { successNotice: "휴일 설정을 저장했습니다." });
  };

  const submitCalendarSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCalendarSettingsError("");
    setCalendarSettingsNotice("");

    let holidays = normalizeHolidaysMap(calendarHolidays);
    const pendingHolidayName = normalizeHolidayName(calendarHolidayName);
    if (pendingHolidayName) {
      const pendingHolidayDate = normalizeHolidayDateKey(calendarHolidayDate);
      if (!pendingHolidayDate) {
        setCalendarSettingsError("휴일 날짜 형식이 올바르지 않습니다.");
        return;
      }
      holidays = normalizeHolidaysMap({ ...holidays, [pendingHolidayDate]: pendingHolidayName });
      setCalendarHolidayName("");
    }
    setCalendarHolidays(holidays);
    await persistCalendarHolidays(holidays, { closeModalOnSuccess: true });
  };

  if (loading) {
    return <p className="text-sm text-stone-600">대시보드 집계 로딩 중...</p>;
  }

  if (error || !data) {
    return <p className="text-sm text-red-700">대시보드 집계 로드 실패: {error || "unknown"}</p>;
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="rounded border border-stone-300 bg-white px-2 py-1 text-[11px] text-stone-700">
          총 {data.total_documents.toLocaleString("ko-KR")}
        </span>
        <span className="rounded border border-stone-300 bg-white px-2 py-1 text-[11px] text-stone-700">
          7일 {data.recent_uploads_7d.toLocaleString("ko-KR")}
        </span>
        <span className="rounded border border-stone-300 bg-white px-2 py-1 text-[11px] text-stone-700">
          검토 {data.needs_review_count.toLocaleString("ko-KR")}
        </span>
        <button
          type="button"
          onClick={() => setStatsOpen((prev) => !prev)}
          className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          통계
          {statsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {statsOpen ? (
        <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {metricCards.map((card) => (
              <button
                key={card.label}
                type="button"
                onClick={() => window.location.assign(card.href)}
                className="rounded-lg border border-stone-200 bg-panel p-3 text-left shadow-panel transition hover:border-stone-300"
              >
                <p className="inline-flex items-center gap-1 text-xs text-stone-500">
                  <card.icon className="h-3.5 w-3.5" />
                  {card.label}
                </p>
                <p className="mt-1 text-xl font-bold">{card.value}</p>
              </button>
            ))}
          </div>
          <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
            <h2 className="inline-flex items-center gap-1 text-sm font-semibold text-stone-700">
              <CircleAlert className="h-4 w-4 text-accent" />
              실패 코드 분포
            </h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {failedErrorCodes.length === 0 ? <li className="text-stone-500">실패 코드 없음</li> : null}
              {failedErrorCodes.map((item) => (
                <li key={item.error_code} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-stone-700">{item.error_code}</span>
                  <span className="font-medium text-stone-900">{item.count.toLocaleString("ko-KR")}</span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
          <h2 className="inline-flex items-center gap-1 text-sm font-semibold text-stone-700">
            <Pin className="h-4 w-4 text-accent" />
            카테고리별 고정글
          </h2>
          <div className="mt-3 space-y-3">
            {pinnedByCategory.length === 0 ? <p className="text-sm text-stone-500">고정글이 없습니다.</p> : null}
            {pinnedByCategory.map((group) => (
              <section key={`pin-${group.category}`} className="rounded border border-stone-200 p-2">
                <p className="mb-1 text-xs font-semibold text-stone-700">
                  {group.category} ({group.count})
                </p>
                <ul className="space-y-1.5">
                  {group.documents.map((doc) => (
                    <li key={`pin-doc-${doc.id}`}>
                      <a
                        href={`/documents/${doc.id}`}
                        className="block rounded border border-stone-200 px-2 py-1.5 text-xs transition hover:border-stone-300"
                      >
                        <p className="font-medium text-stone-900">{doc.title}</p>
                        <p className="text-[11px] text-stone-600">
                          이벤트일: {doc.event_date || "-"} | 상태: {reviewStatusLabel(doc.review_status)}
                        </p>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </article>

        <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
          <div className="flex items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-1 text-sm font-semibold text-stone-700">
              <ListChecks className="h-4 w-4 text-accent" />
              일정 목록
            </h2>
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => openTaskModal(selectedDate || dateKeyFromDate(new Date()))}
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50"
              >
                <CalendarPlus className="h-3.5 w-3.5" />
                등록
              </button>
              <button
                type="button"
                onClick={openSettingsModal}
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50"
              >
                <Settings2 className="h-3.5 w-3.5" />
                일정 설정
              </button>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1">
            {taskFilterOptions.map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setTaskFilter(filter)}
                className={`rounded border px-2 py-1 text-xs ${taskFilter === filter ? "ring-1 ring-accent/40" : "hover:opacity-85"}`}
                style={
                  filter === "ALL"
                    ? undefined
                    : categoryBadgeStyle(filter, taskSettings.category_colors || {})
                }
              >
                {filter === "ALL" ? "전체" : filter}
              </button>
            ))}
            {selectedDate ? (
              <button
                type="button"
                onClick={() => setSelectedDate(null)}
                className="rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
              >
                날짜필터 해제: {selectedDate}
              </button>
            ) : null}
          </div>
          <p className="mt-2 text-[11px] text-stone-500">표시 기간: {taskListWindow.label}</p>

          {!taskSettingsApiSupported ? (
            <p className="mt-2 text-[11px] text-amber-700">설정 API 미지원 서버입니다. 카테고리/변수 설정은 이 브라우저에 로컬 저장됩니다.</p>
          ) : null}
          {taskSettingsLoading ? <p className="mt-2 text-xs text-stone-600">일정 설정 로딩 중...</p> : null}
          {taskSettingsError ? <p className="mt-2 text-xs text-red-700">설정 오류: {taskSettingsError}</p> : null}
          {listTasksError ? <p className="mt-2 text-xs text-red-700">일정 로드 실패: {listTasksError}</p> : null}
          {listTasksLoading ? <p className="mt-2 text-sm text-stone-500">일정 목록 로딩 중...</p> : null}
          {!listTasksLoading ? (
            <ul ref={taskListElementRef} className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
              {filteredTasks.length === 0 ? <li className="text-sm text-stone-500">등록된 일정이 없습니다.</li> : null}
              {filteredTasks.map((item) => {
                const itemDateKey = dateKeyFromDate(new Date(item.scheduled_at));
                const isToday = isTodayKey(itemDateKey);
                const isTomorrow = isTomorrowKey(itemDateKey);
                const linkedFileMeta = fileExtensionMeta(extensionFromFilename(item.linked_file_name));
                const emphasisClass = isToday
                  ? "border-rose-300 bg-rose-50"
                  : isTomorrow
                    ? "border-amber-300 bg-amber-50"
                    : "border-stone-200 bg-white";
                return (
                  <li key={item.id} data-task-id={item.id} className={`rounded border px-2 py-2 text-xs ${emphasisClass}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1">
                        <a href={`/dashboard/tasks/${item.id}`} className="min-w-0 flex-1 line-clamp-2 font-semibold leading-5 text-stone-900 hover:text-accent hover:underline">
                          {item.title}
                        </a>
                        {item.linked_file_download_path ? (
                          <a
                            href={buildApiUrl(item.linked_file_download_path)}
                            className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] font-semibold ${
                              linkedFileMeta ? linkedFileMeta.className : "border-stone-300 bg-white text-stone-700"
                            }`}
                            title={item.linked_file_name ? `${item.linked_file_name} 다운로드` : "첨부파일 다운로드"}
                            aria-label={item.linked_file_name ? `${item.linked_file_name} 다운로드` : "첨부파일 다운로드"}
                            download
                          >
                            {linkedFileMeta ? (
                              <>
                                <linkedFileMeta.icon className="h-3 w-3" />
                                {linkedFileMeta.label}
                              </>
                            ) : (
                              <Paperclip className="h-3 w-3" />
                            )}
                          </a>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => openTaskEditModal(item)}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
                          title="일정 수정"
                          aria-label="일정 수정"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span
                          className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                          style={categoryBadgeStyle(item.category, taskSettings.category_colors || {})}
                        >
                          {item.category}
                        </span>
                        {isToday ? (
                          <span className="rounded border border-rose-300 bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800">
                            TODAY
                          </span>
                        ) : null}
                        {isTomorrow ? (
                          <span className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                            TOMORROW
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <p className="mt-1 text-stone-700">일시: {formatTaskSchedule(item)}</p>
                    {!item.all_day && item.ended_at ? <p className="mt-0.5 text-stone-700">종료: {formatTimeValue(item.ended_at)}</p> : null}
                    {item.location ? (
                      <p className="mt-0.5 inline-flex items-center gap-1 text-stone-700">
                        <MapPin className="h-3.5 w-3.5 text-stone-500" />
                        장소: {item.location}
                      </p>
                    ) : null}
                    {item.comment ? (
                      <p className="mt-0.5 inline-flex items-center gap-1 text-stone-700">
                        <MessageSquare className="h-3.5 w-3.5 text-stone-500" />
                        {item.comment}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </article>

        <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
          <div className="flex items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-1 text-sm font-semibold text-stone-700">
              <CalendarDays className="h-4 w-4 text-accent" />
              월간 캘린더
            </h2>
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={openCalendarSettingsModal}
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50"
                title="캘린더 설정"
              >
                <Settings2 className="h-3.5 w-3.5" />
                캘린더 설정
              </button>
              <button
                type="button"
                onClick={() => setMonthKey(monthKeyFromDate(new Date()))}
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50"
                title="오늘 월로 이동"
              >
                오늘
              </button>
              <button
                type="button"
                onClick={() => setMonthKey((prev) => moveMonthKey(prev, -1))}
                className="rounded border border-stone-300 p-1 hover:bg-stone-50"
                title="이전 달"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[90px] text-center text-sm font-semibold text-stone-800">{monthKey}</span>
              <button
                type="button"
                onClick={() => setMonthKey((prev) => moveMonthKey(prev, 1))}
                className="rounded border border-stone-300 p-1 hover:bg-stone-50"
                title="다음 달"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-7 gap-1">
            {WEEKDAY_LABELS.map((label, weekdayIndex) => (
              <div
                key={`wd-${label}`}
                className={`text-center text-[11px] font-semibold ${
                  weekdayIndex === 0 ? "text-rose-600" : weekdayIndex === 6 ? "text-blue-600" : "text-stone-600"
                }`}
              >
                {label}
              </div>
            ))}
            {calendarCells.map((cell, cellIndex) => {
              const dayTasks = tasksByDate.get(cell.dateKey) || [];
              const holidayName = taskSettings.holidays?.[cell.dateKey] || "";
              const isToday = isTodayKey(cell.dateKey);
              const isSelected = selectedDate === cell.dateKey;
              const weekdayIndex = cellIndex % 7;
              const weekendTextClass = holidayName
                ? "text-rose-700"
                : weekdayIndex === 0
                  ? "text-rose-600"
                  : weekdayIndex === 6
                    ? "text-blue-600"
                    : "";
              const baseCellClass = cell.inMonth ? "bg-white" : "bg-stone-50 text-stone-400";
              const holidayCellClass = holidayName ? "border-rose-300 bg-rose-50/90" : "border-stone-200";
              return (
                <div
                  key={cell.dateKey}
                  className={`min-h-[90px] rounded border p-1 ${baseCellClass} ${holidayCellClass} ${
                    isToday ? "ring-1 ring-accent/50" : ""
                  } ${isSelected ? "shadow-[inset_0_0_0_1px_rgba(15,118,110,0.55)]" : ""}`}
                >
                  <div className="flex items-start justify-between">
                    <button
                      type="button"
                      onClick={() => setSelectedDate((prev) => (prev === cell.dateKey ? null : cell.dateKey))}
                      className={`rounded px-1 text-[11px] font-semibold hover:bg-stone-100 ${weekendTextClass} ${isToday && !holidayName ? "text-accent" : ""}`}
                      title={`${cell.dateKey} 필터`}
                    >
                      {cell.day}
                    </button>
                    {dayTasks.length > 0 ? <span className="text-[10px] text-stone-500">{dayTasks.length}</span> : null}
                  </div>
                  {holidayName ? <p className="mt-0.5 truncate px-1 text-[10px] font-semibold text-rose-700" title={holidayName}>{holidayName}</p> : null}
                  <div className="mt-1 space-y-0.5">
                    {dayTasks.slice(0, 2).map((item) => (
                      <a
                        key={`${cell.dateKey}-${item.id}`}
                        href={`/dashboard/tasks/${item.id}`}
                        className="block truncate rounded border px-1 py-0.5 text-[10px] hover:opacity-80"
                        style={categoryBadgeStyle(item.category, taskSettings.category_colors || {})}
                        title={`${item.category}: ${item.title}`}
                      >
                        {item.category} · {item.title}
                      </a>
                    ))}
                    {dayTasks.length > 2 ? <p className="text-[10px] text-stone-500">+{dayTasks.length - 2}개</p> : null}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-2 text-[11px] text-stone-500">캘린더 날짜 클릭은 등록창 대신 날짜 필터를 적용하고, 일정 클릭 시 상세 페이지로 이동합니다.</p>
        </article>
      </div>

      <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
        <h2 className="inline-flex items-center gap-1 text-sm font-semibold text-stone-700">
          <Files className="h-4 w-4 text-accent" />
          최근 수집 문서
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {recentDocuments.length === 0 ? <li className="text-stone-500">데이터 없음</li> : null}
          {recentDocuments.slice(0, 9).map((doc) => (
            <li key={doc.id}>
              <div className="rounded border border-stone-200 p-2 transition hover:border-stone-300">
                <div className="flex items-center gap-1.5">
                  <a href={`/documents/${doc.id}`} className="line-clamp-1 font-medium text-stone-900 hover:text-accent hover:underline">
                    {doc.title}
                  </a>
                  {(() => {
                    const meta = fileExtensionMeta(doc.first_file_extension);
                    if (!meta || !doc.first_file_id) return null;
                    const Icon = meta.icon;
                    return (
                      <a
                        href={buildApiUrl(`/files/${doc.first_file_id}/download`)}
                        className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] font-semibold ${meta.className}`}
                        title="첨부파일 다운로드"
                      >
                        <Icon className="h-3 w-3" />
                        {meta.label}
                      </a>
                    );
                  })()}
                </div>
                <p className="text-xs text-stone-600">
                  {doc.category} | 수집: {formatDateTime(doc.ingested_at)} | 상태: {reviewStatusLabel(doc.review_status)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </article>

      <div className="flex flex-wrap gap-2 text-sm">
        <a href="/archive" className="inline-flex items-center gap-1 rounded border border-stone-300 px-3 py-1 hover:bg-stone-50">
          <FolderOpen className="h-4 w-4" />
          아카이브 보기
        </a>
        <a href={timelineRecent7dHref} className="inline-flex items-center gap-1 rounded border border-stone-300 px-3 py-1 hover:bg-stone-50">
          <CalendarDays className="h-4 w-4" />
          최근 7일 타임라인
        </a>
        <a href="/review-queue" className="inline-flex items-center gap-1 rounded border border-stone-300 px-3 py-1 hover:bg-stone-50">
          <ListFilter className="h-4 w-4" />
          검토 큐 이동
        </a>
      </div>

      <p className="text-xs text-stone-500">집계 시각: {formatDateTime(data.generated_at)}</p>

      <ModalShell
        open={taskModalOpen}
        onClose={closeTaskModal}
        title={editingTaskId ? "일정 수정" : "일정 등록"}
        maxWidthClassName="max-w-lg"
      >
        <form className="space-y-2" onSubmit={(event) => void submitTask(event)}>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-stone-700">카테고리 *</span>
              <select
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={taskCategory}
                onChange={(event) => setTaskCategory(event.target.value)}
              >
                {taskSettings.categories.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-stone-700">날짜 *</span>
              <input
                type="date"
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={taskDate}
                onChange={(event) => setTaskDate(event.target.value)}
                required
              />
            </label>
          </div>

          <label className="space-y-1 text-xs">
            <span className="text-stone-700">제목 *</span>
            <input
              className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
              placeholder="예: 주간 운영 회의"
              required
            />
          </label>

          {taskSettings.allow_all_day ? (
            <div className="space-y-2">
              <label className="inline-flex items-center gap-2 rounded border border-stone-300 bg-stone-50 px-2 py-1.5 text-xs text-stone-700">
                <input type="checkbox" checked={taskAllDay} onChange={(event) => setTaskAllDay(event.target.checked)} />
                종일 일정
              </label>
              {!taskAllDay ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="space-y-1 text-xs">
                    <span className="text-stone-700">시작 시간 *</span>
                    <input
                      type="time"
                      className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                      value={taskTime}
                      onChange={(event) => setTaskTime(event.target.value)}
                      required
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="text-stone-700">종료 시간 (선택)</span>
                    <input
                      type="time"
                      className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                      value={taskEndTime}
                      onChange={(event) => {
                        setTaskEndTime(event.target.value);
                        setTaskEndTimeTouched(true);
                      }}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="text-stone-700">시작 시간 *</span>
                <input
                  type="time"
                  className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                  value={taskTime}
                  onChange={(event) => setTaskTime(event.target.value)}
                  required
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-stone-700">종료 시간 (선택)</span>
                <input
                  type="time"
                  className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                  value={taskEndTime}
                  onChange={(event) => {
                    setTaskEndTime(event.target.value);
                    setTaskEndTimeTouched(true);
                  }}
                />
              </label>
            </div>
          )}

          {taskSettings.use_location ? (
            <label className="space-y-1 text-xs">
              <span className="text-stone-700">장소 (선택)</span>
              <input
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={taskLocation}
                onChange={(event) => setTaskLocation(event.target.value)}
                placeholder="예: AMC 본관 3층 회의실"
              />
            </label>
          ) : null}

          {taskSettings.use_comment ? (
            <label className="space-y-1 text-xs">
              <span className="text-stone-700">한줄 코멘트 (선택)</span>
              <input
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={taskComment}
                onChange={(event) => setTaskComment(event.target.value)}
                placeholder="예: 계약팀 확인 필요"
                maxLength={300}
              />
            </label>
          ) : null}

          {editingTaskId && isMeetingCategory(taskCategory) ? (
            <section className="space-y-2 rounded border border-stone-200 bg-stone-50/70 p-2">
              <p className="text-xs font-semibold text-stone-700">회의록 첨부 연동</p>

              <label className="space-y-1 text-xs">
                <span className="text-stone-700">같은 날짜 아카이브 게시물</span>
                <select
                  className="w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-sm disabled:bg-stone-100"
                  value={taskLinkedDocumentId}
                  onChange={(event) => {
                    const nextDocumentId = event.target.value;
                    setTaskLinkedDocumentId(nextDocumentId);
                    setTaskLinkedFileId("");
                    if (!nextDocumentId) {
                      setTaskLinkedDocumentTitle("");
                      setArchiveFiles([]);
                      setArchiveFilesError("");
                      return;
                    }
                    const selectedDoc = archiveDocuments.find((doc) => doc.id === nextDocumentId);
                    setTaskLinkedDocumentTitle(selectedDoc?.title || "");
                  }}
                  disabled={archiveDocumentsLoading}
                >
                  <option value="">연결 안 함</option>
                  {archiveDocuments.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.title} ({doc.file_count}개 첨부)
                    </option>
                  ))}
                </select>
              </label>

              {archiveDocumentsLoading ? <p className="text-[11px] text-stone-500">아카이브 게시물 목록 로딩 중...</p> : null}
              {archiveDocumentsError ? <p className="text-[11px] text-red-700">게시물 조회 실패: {archiveDocumentsError}</p> : null}
              {!archiveDocumentsLoading && !archiveDocumentsError && archiveDocuments.length === 0 ? (
                <p className="text-[11px] text-stone-500">선택한 날짜({taskDate})에 아카이브 게시물이 없습니다.</p>
              ) : null}

              <label className="space-y-1 text-xs">
                <span className="text-stone-700">게시물 첨부파일</span>
                <select
                  className="w-full rounded border border-stone-300 bg-white px-2 py-1.5 text-sm disabled:bg-stone-100"
                  value={taskLinkedFileId}
                  onChange={(event) => setTaskLinkedFileId(event.target.value)}
                  disabled={!taskLinkedDocumentId || archiveFilesLoading || archiveFiles.length === 0}
                >
                  <option value="">{taskLinkedDocumentId ? "첨부파일 선택" : "게시물을 먼저 선택하세요"}</option>
                  {archiveFiles.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.original_filename}
                    </option>
                  ))}
                </select>
              </label>

              {archiveFilesLoading ? <p className="text-[11px] text-stone-500">첨부파일 목록 로딩 중...</p> : null}
              {archiveFilesError ? <p className="text-[11px] text-red-700">첨부파일 조회 실패: {archiveFilesError}</p> : null}
              {taskLinkedDocumentId && !archiveFilesLoading && !archiveFilesError && archiveFiles.length === 0 ? (
                <p className="text-[11px] text-stone-500">선택한 게시물에 첨부파일이 없습니다.</p>
              ) : null}
            </section>
          ) : null}

          {taskFormError ? <p className="text-xs text-red-700">{taskFormError}</p> : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-50"
              onClick={closeTaskModal}
              disabled={taskSubmitting}
            >
              취소
            </button>
            <button
              type="submit"
              className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              disabled={taskSubmitting}
            >
              {taskSubmitting ? (editingTaskId ? "수정 중..." : "등록 중...") : editingTaskId ? "수정" : "등록"}
            </button>
          </div>
        </form>
      </ModalShell>

      <ModalShell open={settingsModalOpen} onClose={() => setSettingsModalOpen(false)} title="일정 설정" maxWidthClassName="max-w-lg">
        <form className="space-y-3" onSubmit={(event) => void submitTaskSettings(event)}>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-stone-700">카테고리</p>
            <div className="space-y-1.5">
              {settingsCategories.map((name) => (
                <div key={name} className="flex items-center justify-between gap-2 rounded border border-stone-200 bg-white px-2 py-1.5">
                  <span
                    className="inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold"
                    style={categoryBadgeStyle(name, settingsCategoryColors)}
                  >
                    {name}
                  </span>
                  <div className="inline-flex items-center gap-1">
                    <input
                      type="color"
                      className="h-6 w-8 cursor-pointer rounded border border-stone-300 bg-white p-0.5"
                      value={normalizeHexColor(settingsCategoryColors[name]) || defaultCategoryColor(name)}
                      onChange={(event) => updateSettingsCategoryColor(name, event.target.value)}
                      aria-label={`${name} 색상`}
                    />
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-black/10"
                      onClick={() => removeSettingsCategory(name)}
                      aria-label={`${name} 삭제`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <input
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={settingsCategoryInput}
                onChange={(event) => setSettingsCategoryInput(event.target.value)}
                onKeyDown={onSettingsCategoryInputKeyDown}
                placeholder="카테고리 추가"
                maxLength={80}
              />
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1.5 text-xs hover:bg-stone-50"
                onClick={addSettingsCategory}
              >
                <Plus className="h-3.5 w-3.5" />
                추가
              </button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="inline-flex items-center gap-2 rounded border border-stone-300 bg-stone-50 px-2 py-1.5 text-xs text-stone-700">
              <input type="checkbox" checked={settingsAllowAllDay} onChange={(event) => setSettingsAllowAllDay(event.target.checked)} />
              종일 일정 사용
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-stone-700">기본 시간</span>
              <input
                type="time"
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={settingsDefaultTime}
                onChange={(event) => setSettingsDefaultTime(event.target.value)}
                required
              />
            </label>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-stone-700">목록 시작 (오늘 기준 N일 전)</span>
              <input
                type="number"
                min={0}
                max={MAX_TASK_LIST_RANGE_PAST_DAYS}
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={settingsListRangePastDays}
                onChange={(event) => setSettingsListRangePastDays(normalizeTaskListRangePastDays(event.target.value))}
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-stone-700">목록 종료 (오늘 기준 N개월 후)</span>
              <input
                type="number"
                min={0}
                max={MAX_TASK_LIST_RANGE_FUTURE_MONTHS}
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={settingsListRangeFutureMonths}
                onChange={(event) => setSettingsListRangeFutureMonths(normalizeTaskListRangeFutureMonths(event.target.value))}
              />
            </label>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="inline-flex items-center gap-2 rounded border border-stone-300 bg-stone-50 px-2 py-1.5 text-xs text-stone-700">
              <input type="checkbox" checked={settingsUseLocation} onChange={(event) => setSettingsUseLocation(event.target.checked)} />
              장소 필드 사용
            </label>
            <label className="inline-flex items-center gap-2 rounded border border-stone-300 bg-stone-50 px-2 py-1.5 text-xs text-stone-700">
              <input type="checkbox" checked={settingsUseComment} onChange={(event) => setSettingsUseComment(event.target.checked)} />
              코멘트 필드 사용
            </label>
          </div>

          {settingsFormError ? <p className="text-xs text-red-700">{settingsFormError}</p> : null}
          {settingsFormNotice ? <p className="text-xs text-amber-700">{settingsFormNotice}</p> : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-50"
              onClick={() => setSettingsModalOpen(false)}
              disabled={settingsSubmitting}
            >
              취소
            </button>
            <button
              type="submit"
              className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              disabled={settingsSubmitting}
            >
              {settingsSubmitting ? "저장 중..." : "저장"}
            </button>
          </div>
        </form>
      </ModalShell>

      <ModalShell
        open={calendarSettingsModalOpen}
        onClose={() => setCalendarSettingsModalOpen(false)}
        title="캘린더 설정"
        maxWidthClassName="max-w-lg"
      >
        <form className="space-y-3" onSubmit={(event) => void submitCalendarSettings(event)}>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-stone-700">휴일</p>
            <div className="grid gap-1.5 sm:grid-cols-3">
              <input
                type="date"
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={calendarHolidayDate}
                onChange={(event) => setCalendarHolidayDate(event.target.value)}
                disabled={calendarSettingsSubmitting}
              />
              <input
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={calendarHolidayName}
                onChange={(event) => setCalendarHolidayName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void addOrUpdateCalendarHoliday();
                }}
                placeholder="예: 신정"
                maxLength={80}
                disabled={calendarSettingsSubmitting}
              />
              <button
                type="button"
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 bg-white px-2 py-1.5 text-xs hover:bg-stone-50"
                onClick={() => void addOrUpdateCalendarHoliday()}
                disabled={calendarSettingsSubmitting}
              >
                <Plus className="h-3.5 w-3.5" />
                추가/수정
              </button>
            </div>

            <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-stone-200 bg-white p-2">
              {Object.keys(calendarHolidays).length === 0 ? <p className="text-xs text-stone-500">등록된 휴일이 없습니다.</p> : null}
              {Object.entries(calendarHolidays)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([day, name]) => (
                  <div key={day} className="flex items-center justify-between gap-2 rounded border border-stone-200 px-2 py-1.5">
                    <p className="text-xs text-stone-700">
                      <span className="font-mono">{day}</span> · <span className="font-semibold text-rose-700">{name}</span>
                    </p>
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-black/10"
                      onClick={() => void removeCalendarHoliday(day)}
                      aria-label={`${day} 휴일 삭제`}
                      disabled={calendarSettingsSubmitting}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
            </div>
          </div>

          {calendarSettingsError ? <p className="text-xs text-red-700">{calendarSettingsError}</p> : null}
          {calendarSettingsNotice ? <p className="text-xs text-amber-700">{calendarSettingsNotice}</p> : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-50"
              onClick={() => setCalendarSettingsModalOpen(false)}
              disabled={calendarSettingsSubmitting}
            >
              취소
            </button>
            <button
              type="submit"
              className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              disabled={calendarSettingsSubmitting}
            >
              {calendarSettingsSubmitting ? "저장 중..." : "저장"}
            </button>
          </div>
        </form>
      </ModalShell>
    </section>
  );
}
