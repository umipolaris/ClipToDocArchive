"use client";

import { CSSProperties, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
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
  all_day: boolean;
  location: string | null;
  comment: string | null;
};

type DashboardTaskListResponse = {
  month: string;
  items: DashboardTaskItem[];
  generated_at: string;
};

type DashboardTaskSettingsResponse = {
  categories: string[];
  category_colors: Record<string, string>;
  allow_all_day: boolean;
  use_location: boolean;
  use_comment: boolean;
  default_time: string;
  generated_at: string;
};

type TaskFilter = "ALL" | string;

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const CATEGORY_COLOR_PALETTE = ["#059669", "#0284C7", "#7C3AED", "#EA580C", "#D9466F", "#0F766E", "#475569", "#7C2D12", "#166534"];
const DEFAULT_CATEGORY_COLORS: Record<string, string> = { 할일: "#059669", 회의: "#0284C7" };

const DEFAULT_TASK_SETTINGS: DashboardTaskSettingsResponse = {
  categories: ["할일", "회의"],
  category_colors: { ...DEFAULT_CATEGORY_COLORS },
  allow_all_day: true,
  use_location: true,
  use_comment: true,
  default_time: "09:00",
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
  const dt = new Date(item.scheduled_at);
  if (Number.isNaN(dt.getTime())) return "-";
  if (item.all_day) {
    return `${dateKeyFromDate(dt)} (종일)`;
  }
  return dt.toLocaleString("ko-KR");
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

function isTodayKey(dateKey: string): boolean {
  return dateKey === dateKeyFromDate(new Date());
}

function isTomorrowKey(dateKey: string): boolean {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return dateKey === dateKeyFromDate(tomorrow);
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
  return out.length > 0 ? out : ["할일", "회의"];
}

function isValidTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
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
    return {
      categories,
      category_colors: categoryColors,
      allow_all_day: typeof parsed.allow_all_day === "boolean" ? parsed.allow_all_day : true,
      use_location: typeof parsed.use_location === "boolean" ? parsed.use_location : true,
      use_comment: typeof parsed.use_comment === "boolean" ? parsed.use_comment : true,
      default_time: defaultTime,
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
      allow_all_day: !!settings.allow_all_day,
      use_location: !!settings.use_location,
      use_comment: !!settings.use_comment,
      default_time: isValidTime(settings.default_time) ? settings.default_time : "09:00",
      generated_at: settings.generated_at || new Date().toISOString(),
    }),
  );
}

export function DashboardSummary() {
  const [data, setData] = useState<DashboardSummaryResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [statsOpen, setStatsOpen] = useState(false);

  const [monthKey, setMonthKey] = useState(monthKeyFromDate(new Date()));
  const [tasks, setTasks] = useState<DashboardTaskItem[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState("");
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
  const [taskAllDay, setTaskAllDay] = useState(false);
  const [taskLocation, setTaskLocation] = useState("");
  const [taskComment, setTaskComment] = useState("");

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
        default_time: isValidTime(res.default_time) ? res.default_time : "09:00",
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

  const loadTasks = useCallback(async (targetMonth: string) => {
    setTasksLoading(true);
    setTasksError("");
    try {
      const res = await apiGet<DashboardTaskListResponse>(`/dashboard/tasks?month=${encodeURIComponent(targetMonth)}`);
      setTasks(res.items || []);
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : "일정 목록 로드 실패");
      setTasks([]);
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks(monthKey);
  }, [loadTasks, monthKey]);

  useEffect(() => {
    if (taskFilter === "ALL") return;
    if (!taskSettings.categories.includes(taskFilter)) {
      setTaskFilter("ALL");
    }
  }, [taskFilter, taskSettings.categories]);

  const tasksByDate = useMemo(() => {
    const map = new Map<string, DashboardTaskItem[]>();
    for (const item of tasks) {
      const key = dateKeyFromDate(new Date(item.scheduled_at));
      const existing = map.get(key);
      if (existing) existing.push(item);
      else map.set(key, [item]);
    }
    for (const [, arr] of map.entries()) {
      arr.sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
    }
    return map;
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    let arr = tasks;
    if (taskFilter !== "ALL") {
      arr = arr.filter((item) => item.category === taskFilter);
    }
    if (selectedDate) {
      arr = arr.filter((item) => dateKeyFromDate(new Date(item.scheduled_at)) === selectedDate);
    }
    return [...arr].sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  }, [selectedDate, taskFilter, tasks]);

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
      setTaskCategory(taskSettings.categories[0] || "할일");
      setTaskTitle("");
      setTaskDate(dateKey);
      setTaskTime(taskSettings.default_time || "09:00");
      setTaskAllDay(false);
      setTaskLocation("");
      setTaskComment("");
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
      setTaskCategory(taskSettings.categories.includes(item.category) ? item.category : taskSettings.categories[0] || "할일");
      setTaskTitle(item.title);
      setTaskDate(toDateInputValue(item.scheduled_at));
      setTaskTime(item.all_day ? taskSettings.default_time || "09:00" : toTimeInputValue(item.scheduled_at));
      setTaskAllDay(item.all_day);
      setTaskLocation(item.location || "");
      setTaskComment(item.comment || "");
      setTaskModalOpen(true);
    },
    [taskSettings.categories, taskSettings.default_time],
  );

  const closeTaskModal = useCallback(() => {
    setTaskModalOpen(false);
    setEditingTaskId(null);
    setTaskFormError("");
  }, []);

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

    const datetimeLocal = allDay ? `${taskDate}T00:00:00` : `${taskDate}T${taskTime}:00`;
    const parsed = new Date(datetimeLocal);
    if (Number.isNaN(parsed.getTime())) {
      setTaskFormError("날짜/시간 형식이 올바르지 않습니다.");
      return;
    }

    setTaskSubmitting(true);
    try {
      const payload = {
        category,
        title,
        scheduled_at: parsed.toISOString(),
        all_day: allDay,
        location: taskSettings.use_location ? taskLocation.trim() || null : null,
        comment: taskSettings.use_comment ? taskComment.trim() || null : null,
      };
      if (editingTaskId) {
        await apiPatch<DashboardTaskItem>(`/dashboard/tasks/${editingTaskId}`, payload);
      } else {
        await apiPost<DashboardTaskItem>("/dashboard/tasks", payload);
      }
      closeTaskModal();
      await loadTasks(monthKey);
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
    if (!isValidTime(settingsDefaultTime.trim())) {
      setSettingsFormError("기본 시간은 HH:MM 형식이어야 합니다.");
      return;
    }

    const localNext: DashboardTaskSettingsResponse = {
      categories,
      category_colors: categoryColors,
      allow_all_day: settingsAllowAllDay,
      use_location: settingsUseLocation,
      use_comment: settingsUseComment,
      default_time: settingsDefaultTime.trim(),
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
          allow_all_day: settingsAllowAllDay,
          use_location: settingsUseLocation,
          use_comment: settingsUseComment,
          default_time: settingsDefaultTime.trim(),
        }),
      });
      const nextCategories = normalizeCategoryList(next.categories || []);
      const normalized = {
        ...next,
        categories: nextCategories,
        category_colors: normalizeCategoryColorMap(next.category_colors || {}, nextCategories),
      };
      setTaskSettings(normalized);
      setTaskCategory((prev) => (normalized.categories.includes(prev) ? prev : normalized.categories[0]));
      setTaskTime(normalized.default_time || "09:00");
      saveLocalTaskSettings(normalized);
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
      } else {
        setSettingsFormError(message);
      }
    } finally {
      setSettingsSubmitting(false);
    }
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
                설정
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

          {!taskSettingsApiSupported ? (
            <p className="mt-2 text-[11px] text-amber-700">설정 API 미지원 서버입니다. 카테고리/변수 설정은 이 브라우저에 로컬 저장됩니다.</p>
          ) : null}
          {taskSettingsLoading ? <p className="mt-2 text-xs text-stone-600">일정 설정 로딩 중...</p> : null}
          {taskSettingsError ? <p className="mt-2 text-xs text-red-700">설정 오류: {taskSettingsError}</p> : null}
          {tasksError ? <p className="mt-2 text-xs text-red-700">일정 로드 실패: {tasksError}</p> : null}
          {tasksLoading ? <p className="mt-2 text-sm text-stone-500">일정 목록 로딩 중...</p> : null}
          {!tasksLoading ? (
            <ul className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
              {filteredTasks.length === 0 ? <li className="text-sm text-stone-500">등록된 일정이 없습니다.</li> : null}
              {filteredTasks.map((item) => {
                const itemDateKey = dateKeyFromDate(new Date(item.scheduled_at));
                const isToday = isTodayKey(itemDateKey);
                const isTomorrow = isTomorrowKey(itemDateKey);
                const emphasisClass = isToday
                  ? "border-rose-300 bg-rose-50"
                  : isTomorrow
                    ? "border-amber-300 bg-amber-50"
                    : "border-stone-200 bg-white";
                return (
                  <li key={item.id} className={`rounded border px-2 py-2 text-xs ${emphasisClass}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1">
                        <a href={`/dashboard/tasks/${item.id}`} className="min-w-0 flex-1 line-clamp-2 font-semibold leading-5 text-stone-900 hover:text-accent hover:underline">
                          {item.title}
                        </a>
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
              const isToday = isTodayKey(cell.dateKey);
              const isSelected = selectedDate === cell.dateKey;
              const weekdayIndex = cellIndex % 7;
              const weekendTextClass = weekdayIndex === 0 ? "text-rose-600" : weekdayIndex === 6 ? "text-blue-600" : "";
              return (
                <div
                  key={cell.dateKey}
                  className={`min-h-[90px] rounded border p-1 ${
                    cell.inMonth ? "bg-white" : "bg-stone-50 text-stone-400"
                  } ${isToday ? "border-accent/70 ring-1 ring-accent/50" : "border-stone-200"} ${
                    isSelected ? "shadow-[inset_0_0_0_1px_rgba(15,118,110,0.55)]" : ""
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <button
                      type="button"
                      onClick={() => setSelectedDate((prev) => (prev === cell.dateKey ? null : cell.dateKey))}
                      className={`rounded px-1 text-[11px] font-semibold hover:bg-stone-100 ${weekendTextClass} ${isToday ? "text-accent" : ""}`}
                      title={`${cell.dateKey} 필터`}
                    >
                      {cell.day}
                    </button>
                    {dayTasks.length > 0 ? <span className="text-[10px] text-stone-500">{dayTasks.length}</span> : null}
                  </div>
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
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="inline-flex items-center gap-2 rounded border border-stone-300 bg-stone-50 px-2 py-1.5 text-xs text-stone-700">
                <input type="checkbox" checked={taskAllDay} onChange={(event) => setTaskAllDay(event.target.checked)} />
                종일 일정
              </label>
              {!taskAllDay ? (
                <label className="space-y-1 text-xs">
                  <span className="text-stone-700">시간 *</span>
                  <input
                    type="time"
                    className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                    value={taskTime}
                    onChange={(event) => setTaskTime(event.target.value)}
                    required
                  />
                </label>
              ) : (
                <div />
              )}
            </div>
          ) : (
            <label className="space-y-1 text-xs">
              <span className="text-stone-700">시간 *</span>
              <input
                type="time"
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={taskTime}
                onChange={(event) => setTaskTime(event.target.value)}
                required
              />
            </label>
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
    </section>
  );
}
