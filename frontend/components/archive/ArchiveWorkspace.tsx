"use client";

import { type CSSProperties, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiDelete, apiGet, apiPatch, apiPostForm, buildApiUrl } from "@/lib/api-client";
import { getCurrentUser, type UserRole } from "@/lib/auth";
import type { ApiDocumentHistoryResponse, ApiDocumentListResponse } from "@/lib/api-contract";
import { FileTypeBadge } from "@/components/common/FileTypeBadge";
import { ModalShell } from "@/components/common/ModalShell";
import { StatusBadge, type StatusTone } from "@/components/common/StatusBadge";
import { SafeRichContentEditor } from "@/components/editor/SafeRichContentEditor";
import { RichContentView } from "@/components/editor/RichContentView";
import { DocumentCommentsPanel } from "@/components/documents/DocumentCommentsPanel";
import {
  CalendarDays,
  Eye,
  FileText,
  FolderTree,
  Search,
  ShieldCheck,
  Tag,
  Paperclip,
  FilterX,
  ArrowUpDown,
  ListFilter,
  Clock3,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Pencil,
  AlignLeft,
  RefreshCcw,
  Files,
  History,
  List,
  MessageSquare,
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
  Pin,
  GitBranch,
} from "lucide-react";
import { reviewStatusLabel } from "@/lib/labels";
import {
  ARCHIVE_COLUMN_LABELS,
  ARCHIVE_COLUMN_MIN_WIDTH,
  ARCHIVE_COLUMN_ORDER_DEFAULT,
  ARCHIVE_COLUMN_WIDTHS,
  DEFAULT_ARCHIVE_LIST_PREFERENCES,
  loadArchiveListPreferences,
  saveArchiveListPreferences,
  type ArchiveColumnKey,
  type ArchiveListDensity,
} from "@/lib/archive-list-preferences";
import {
  loadArchiveViewPresets,
  removeArchiveViewPreset,
  saveArchiveViewPresets,
  upsertArchiveViewPreset,
  type ArchiveViewPreset,
} from "@/lib/archive-view-presets";
import { normalizeRichContentHtml } from "@/lib/rich-content";

type ReviewStatus = "NONE" | "NEEDS_REVIEW" | "RESOLVED";
type DocumentSortBy = "event_date" | "ingested_at" | "created_at" | "title" | "last_modified_at";
type SortOrder = "desc" | "asc";

type ArchiveMonthNode = {
  month: number;
  count: number;
};

type ArchiveYearNode = {
  year: number;
  count: number;
  months: ArchiveMonthNode[];
};

type ArchiveCategoryNode = {
  category: string;
  count: number;
  years: ArchiveYearNode[];
};

type ArchiveTreeResponse = {
  categories: ArchiveCategoryNode[];
  generated_at: string;
};

type DocumentListItem = {
  id: string;
  title: string;
  description: string;
  category: string | null;
  event_date: string | null;
  ingested_at: string;
  is_pinned: boolean;
  last_modified_at: string | null;
  tags: string[];
  file_count: number;
  comment_count: number;
  files: DocumentListFileItem[];
  review_status: ReviewStatus;
  review_reasons: string[];
};

type DocumentListFileItem = {
  id: string;
  original_filename: string;
  download_path?: string;
};

type DocumentListApiItem = ApiDocumentListResponse["items"][number] & {
  is_pinned?: boolean;
  pinned_at?: string | null;
  comment_count?: number;
};

type DocumentListResponse = Omit<ApiDocumentListResponse, "items"> & {
  items: DocumentListApiItem[];
};

type DocumentFileItem = {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  checksum_sha256: string;
  storage_backend: string;
  download_path?: string;
};

type DocumentVersionItem = {
  version_no: number;
  changed_at: string;
  change_reason: string;
  title: string;
  event_date: string | null;
};

type DocumentVersionSnapshotResponse = {
  document_id: string;
  version_no: number;
  changed_at: string;
  change_reason: string;
  title: string;
  description: string;
  summary: string;
  category_id: string | null;
  category: string | null;
  event_date: string | null;
  tags: string[];
};

type DocumentDetailResponse = {
  id: string;
  source: string;
  source_ref: string | null;
  title: string;
  description: string;
  caption_raw: string;
  summary: string;
  category_id: string | null;
  category: string | null;
  categories?: string[];
  event_date: string | null;
  ingested_at: string;
  is_pinned: boolean;
  pinned_at: string | null;
  review_status: ReviewStatus;
  review_reasons: string[];
  current_version_no: number;
  tags: string[];
  files: DocumentFileItem[];
  versions: DocumentVersionItem[];
};

type DetailTab = "meta" | "files" | "versions" | "history";
type DetailMetaMode = "view" | "edit";

type DocumentHistoryResponse = ApiDocumentHistoryResponse;
type DocumentHistoryItem = DocumentHistoryResponse["items"][number];

type ManualPostCategoryOptionsResponse = {
  categories: string[];
};

type ReviewQueueApproveResponse = {
  document_id: string;
  updated: boolean;
  review_status: ReviewStatus;
  review_reasons: string[];
};

const DEFAULT_PAGE_SIZE = 50;
const NEW_POST_WINDOW_MS = 4 * 60 * 60 * 1000;

function formatDate(value: string | null): string {
  if (!value) return "-";
  return value;
}

function formatDateTime(value: string): string {
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? "-" : dt.toLocaleString("ko-KR");
}

function isRecentlyPosted(value: string): boolean {
  const dt = new Date(value);
  const ts = dt.getTime();
  if (Number.isNaN(ts)) return false;
  const diff = Date.now() - ts;
  return diff >= 0 && diff <= NEW_POST_WINDOW_MS;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function hashText(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h << 5) - h + value.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function categoryBadgeStyle(category: string | null): CSSProperties {
  if (!category?.trim()) {
    return {
      borderColor: "#d6d3d1",
      backgroundColor: "#f5f5f4",
      color: "#57534e",
    };
  }
  const hash = hashText(category.trim().toLowerCase());
  const hue = hash % 360;
  const borderHue = (hue + 4) % 360;
  const textHue = (hue + 2) % 360;
  return {
    borderColor: `hsl(${borderHue} 55% 72%)`,
    backgroundColor: `hsl(${hue} 90% 96%)`,
    color: `hsl(${textHue} 46% 30%)`,
  };
}

function dateString(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function yearMonthRange(year: number, month: number | null): { from: string; to: string } {
  if (month == null) {
    return {
      from: dateString(year, 1, 1),
      to: dateString(year, 12, 31),
    };
  }
  const lastDay = new Date(year, month, 0).getDate();
  return {
    from: dateString(year, month, 1),
    to: dateString(year, month, lastDay),
  };
}

function parseOptionalPositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseReviewStatus(value: string | null): ReviewStatus | "" {
  if (value === "NONE" || value === "NEEDS_REVIEW" || value === "RESOLVED") return value;
  return "";
}

function parseSortBy(value: string | null): DocumentSortBy {
  if (value === "event_date" || value === "ingested_at" || value === "created_at" || value === "title" || value === "last_modified_at") return value;
  return "event_date";
}

function parseSortOrder(value: string | null): SortOrder {
  if (value === "asc" || value === "desc") return value;
  return "desc";
}

function parseTagInput(value: string): string[] {
  return value
    .split(/[,\n]/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function hasMeaningfulRichText(value: string | null | undefined): boolean {
  if (!value) return false;
  const stripped = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 && stripped !== "-";
}

function isErrorReason(reason: string): boolean {
  const upper = reason.toUpperCase();
  return upper.includes("ERROR") || upper.includes("FAIL") || upper.includes("EXCEPTION");
}

function statusBadgeForDocument(item: Pick<DocumentListItem, "review_status" | "review_reasons">): {
  primary: { tone: StatusTone; label: string };
} {
  if (item.review_reasons.some(isErrorReason)) {
    return { primary: { tone: "error", label: "오류" } };
  }
  if (item.review_status === "NEEDS_REVIEW") {
    return { primary: { tone: "review", label: "검토필요" } };
  }
  if (item.review_status === "RESOLVED") {
    return { primary: { tone: "resolved", label: "검토완료" } };
  }
  return { primary: { tone: "normal", label: "정상" } };
}

function fileDownloadUrl(downloadPath: string | undefined, fileId: string): string {
  return buildApiUrl(downloadPath || `/files/${fileId}/download`);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || target.isContentEditable;
}

export function ArchiveWorkspace() {
  const searchParams = useSearchParams();

  const initialCategory = searchParams.get("category") || "";
  const initialYear = parseOptionalPositiveInt(searchParams.get("year"));
  const initialMonth = parseOptionalPositiveInt(searchParams.get("month"));
  const initialReviewStatus = parseReviewStatus(searchParams.get("review_status"));
  const initialSearchQuery = searchParams.get("q") || "";
  const initialSortBy = parseSortBy(searchParams.get("sort_by"));
  const initialSortOrder = parseSortOrder(searchParams.get("sort_order"));
  const initialPage = parseOptionalPositiveInt(searchParams.get("page")) || 1;

  const [tree, setTree] = useState<ArchiveTreeResponse | null>(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState("");

  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(initialPage);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState("");

  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>("meta");
  const [detailMetaMode, setDetailMetaMode] = useState<DetailMetaMode>("view");
  const [detail, setDetail] = useState<DocumentDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailNotice, setDetailNotice] = useState("");
  const [historyItems, setHistoryItems] = useState<DocumentHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyTotal, setHistoryTotal] = useState(0);
  const [fileActionLoadingId, setFileActionLoadingId] = useState<string | null>(null);
  const [addUploads, setAddUploads] = useState<File[]>([]);
  const [addInputKey, setAddInputKey] = useState(0);
  const [replaceTargetFileId, setReplaceTargetFileId] = useState("");
  const [replaceUpload, setReplaceUpload] = useState<File | null>(null);
  const [replaceInputKey, setReplaceInputKey] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [docActionLoading, setDocActionLoading] = useState(false);
  const [versionSnapshot, setVersionSnapshot] = useState<DocumentVersionSnapshotResponse | null>(null);
  const [versionSnapshotLoading, setVersionSnapshotLoading] = useState(false);
  const [versionSnapshotError, setVersionSnapshotError] = useState("");
  const [selectedVersionNo, setSelectedVersionNo] = useState<number | null>(null);

  const [editTitle, setEditTitle] = useState("");
  const [editDescriptionHtml, setEditDescriptionHtml] = useState("<p></p>");
  const [editSummary, setEditSummary] = useState("");
  const [editCategoryNames, setEditCategoryNames] = useState<string[]>([]);
  const [customCategoryName, setCustomCategoryName] = useState("");
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [categoryOptionsLoading, setCategoryOptionsLoading] = useState(true);
  const [categoryOptionsError, setCategoryOptionsError] = useState("");
  const [editEventDate, setEditEventDate] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editIsPinned, setEditIsPinned] = useState(false);
  const [editReviewStatus, setEditReviewStatus] = useState<ReviewStatus>("NONE");

  const [categoryFilter, setCategoryFilter] = useState(initialCategory);
  const [yearFilter, setYearFilter] = useState<number | null>(initialYear);
  const [monthFilter, setMonthFilter] = useState<number | null>(initialMonth);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus | "">(initialReviewStatus);
  const [searchInput, setSearchInput] = useState(initialSearchQuery);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [sortBy, setSortBy] = useState<DocumentSortBy>(initialSortBy);
  const [sortOrder, setSortOrder] = useState<SortOrder>(initialSortOrder);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [bulkSelectedDocIds, setBulkSelectedDocIds] = useState<string[]>([]);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkActionError, setBulkActionError] = useState("");
  const [bulkActionNotice, setBulkActionNotice] = useState("");
  const [listDensity, setListDensity] = useState<ArchiveListDensity>(DEFAULT_ARCHIVE_LIST_PREFERENCES.density);
  const [visibleColumns, setVisibleColumns] = useState<ArchiveColumnKey[]>(DEFAULT_ARCHIVE_LIST_PREFERENCES.visibleColumns);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [columnOptionsOpen, setColumnOptionsOpen] = useState(false);
  const [viewPresets, setViewPresets] = useState<ArchiveViewPreset[]>([]);
  const [viewPresetName, setViewPresetName] = useState("");
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [listToolsPanelOpen, setListToolsPanelOpen] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(initialCategory || null);
  const [expandedYearsByCategory, setExpandedYearsByCategory] = useState<Record<string, number | null>>(
    initialCategory ? { [initialCategory]: initialYear ?? null } : {},
  );

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [pageSize, total]);
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (searchQuery.trim()) count += 1;
    if (reviewStatus) count += 1;
    if (categoryFilter) count += 1;
    if (yearFilter != null) count += 1;
    if (monthFilter != null) count += 1;
    if (sortBy !== "event_date") count += 1;
    if (sortOrder !== "desc") count += 1;
    return count;
  }, [categoryFilter, monthFilter, reviewStatus, searchQuery, sortBy, sortOrder, yearFilter]);
  const isAdmin = userRole === "ADMIN";
  const canQuickResolveReview = userRole === "ADMIN" || userRole === "REVIEWER";
  const allSelectedOnPage = items.length > 0 && items.every((item) => bulkSelectedDocIds.includes(item.id));
  const tableGridTemplate = useMemo(() => {
    const widths = visibleColumns.map((column) => ARCHIVE_COLUMN_WIDTHS[column]);
    return isAdmin ? ["34px", ...widths].join(" ") : widths.join(" ");
  }, [isAdmin, visibleColumns]);
  const tableMinWidth = useMemo(() => {
    const columnWidth = visibleColumns.reduce((sum, column) => sum + ARCHIVE_COLUMN_MIN_WIDTH[column], 0);
    const extraWidth = isAdmin ? 34 : 0;
    return Math.max(620, columnWidth + extraWidth);
  }, [isAdmin, visibleColumns]);
  const listRowClassName = listDensity === "compact" ? "min-h-11 py-1 text-[11px]" : "min-h-14 py-1.5 text-xs";
  const titleClassName = listDensity === "compact" ? "truncate text-[12px] font-medium text-stone-900" : "truncate text-sm font-medium text-stone-900";
  const detailId = detail?.id ?? null;
  const detailAttachmentLinks = useMemo(
    () =>
      (detail?.files ?? []).map((file) => ({
        label: file.original_filename,
        href: fileDownloadUrl(file.download_path, file.id),
      })),
    [detail?.files],
  );
  const detailTabButtonClass = (tab: DetailTab) =>
    `rounded border px-2 py-1 text-xs ${
      detailTab === tab ? "border-accent bg-accent/10 text-accent" : "border-stone-300 text-stone-700 hover:bg-stone-50"
    }`;

  useEffect(() => {
    const nextCategory = searchParams.get("category") || "";
    const nextYear = parseOptionalPositiveInt(searchParams.get("year"));
    setCategoryFilter(nextCategory);
    setYearFilter(nextYear);
    setMonthFilter(parseOptionalPositiveInt(searchParams.get("month")));
    setReviewStatus(parseReviewStatus(searchParams.get("review_status")));
    const q = searchParams.get("q") || "";
    setSearchInput(q);
    setSearchQuery(q);
    setSortBy(parseSortBy(searchParams.get("sort_by")));
    setSortOrder(parseSortOrder(searchParams.get("sort_order")));
    setPage(parseOptionalPositiveInt(searchParams.get("page")) || 1);
    setExpandedCategory(nextCategory || null);
    setExpandedYearsByCategory(nextCategory ? { [nextCategory]: nextYear ?? null } : {});
  }, [searchParams]);

  useEffect(() => {
    const loaded = loadArchiveListPreferences();
    setListDensity(loaded.density);
    setVisibleColumns(loaded.visibleColumns);
    setViewPresets(loadArchiveViewPresets());
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return;
    saveArchiveListPreferences({
      density: listDensity,
      visibleColumns,
    });
  }, [listDensity, prefsLoaded, visibleColumns]);

  useEffect(() => {
    let cancelled = false;

    async function loadCategoryOptions() {
      setCategoryOptionsLoading(true);
      setCategoryOptionsError("");
      try {
        const res = await apiGet<ManualPostCategoryOptionsResponse>("/documents/manual-post/category-options");
        if (cancelled) return;
        const names = Array.from(
          new Set(
            (res.categories ?? [])
              .map((name) => name?.trim())
              .filter((name): name is string => Boolean(name)),
          ),
        );
        setCategoryOptions(names);
      } catch (err) {
        if (!cancelled) {
          setCategoryOptionsError(err instanceof Error ? err.message : "카테고리 목록 로드 실패");
          setCategoryOptions([]);
        }
      } finally {
        if (!cancelled) setCategoryOptionsLoading(false);
      }
    }

    async function loadCurrentUserRole() {
      try {
        const user = await getCurrentUser();
        if (!cancelled) {
          setUserRole(user?.role ?? null);
        }
      } catch {
        if (!cancelled) {
          setUserRole(null);
        }
      }
    }

    void loadCategoryOptions();
    void loadCurrentUserRole();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onArchiveRefresh = () => {
      setRefreshTick((prev) => prev + 1);
    };
    window.addEventListener("archive:refresh", onArchiveRefresh);
    return () => {
      window.removeEventListener("archive:refresh", onArchiveRefresh);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isDetailModalOpen || docsLoading || items.length === 0) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const currentIndex = selectedDocId ? items.findIndex((item) => item.id === selectedDocId) : -1;
        if (event.key === "ArrowDown") {
          const nextIndex = currentIndex >= 0 ? Math.min(items.length - 1, currentIndex + 1) : 0;
          setSelectedDocId(items[nextIndex].id);
        } else {
          const nextIndex = currentIndex >= 0 ? Math.max(0, currentIndex - 1) : items.length - 1;
          setSelectedDocId(items[nextIndex].id);
        }
      }

      if (event.key === "Enter" && selectedDocId) {
        event.preventDefault();
        setIsDetailModalOpen(true);
      }

      if (event.key === "Delete" && isAdmin && selectedDocId) {
        event.preventDefault();
        const target = items.find((row) => row.id === selectedDocId);
        if (!target) return;
        const confirmed = window.confirm(`선택 문서를 삭제하시겠습니까?\n${target.title}`);
        if (!confirmed) return;
        void (async () => {
          try {
            setBulkActionLoading(true);
            setBulkActionError("");
            setBulkActionNotice("");
            await apiDelete<{ status: string; document_id: string }>(`/documents/${selectedDocId}`);
            setBulkActionNotice("선택 문서 삭제가 완료되었습니다.");
            setRefreshTick((prev) => prev + 1);
            setSelectedDocId(null);
            setBulkSelectedDocIds((prev) => prev.filter((id) => id !== selectedDocId));
          } catch (err) {
            setBulkActionError(err instanceof Error ? err.message : "선택 문서 삭제 실패");
          } finally {
            setBulkActionLoading(false);
          }
        })();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [docsLoading, isAdmin, isDetailModalOpen, items, selectedDocId]);

  useEffect(() => {
    if (!selectedDocId) return;
    const row = document.querySelector<HTMLElement>(`[data-doc-id="${selectedDocId}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedDocId]);

  useEffect(() => {
    let cancelled = false;
    async function loadTree() {
      setTreeLoading(true);
      setTreeError("");
      try {
        const res = await apiGet<ArchiveTreeResponse>("/archive/tree");
        if (!cancelled) setTree(res);
      } catch (err) {
        if (!cancelled) {
          setTreeError(err instanceof Error ? err.message : "archive tree load failed");
        }
      } finally {
        if (!cancelled) setTreeLoading(false);
      }
    }
    void loadTree();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDocuments() {
      setDocsLoading(true);
      setDocsError("");
      try {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("size", String(pageSize));
        if (searchQuery.trim()) params.set("q", searchQuery.trim());
        if (categoryFilter) params.set("category_name", categoryFilter);
        if (reviewStatus) params.set("review_status", reviewStatus);
        params.set("sort_by", sortBy);
        params.set("sort_order", sortOrder);
        if (yearFilter != null) {
          const range = yearMonthRange(yearFilter, monthFilter);
          params.set("event_date_from", range.from);
          params.set("event_date_to", range.to);
        }

        const res = await apiGet<DocumentListResponse>(`/documents?${params.toString()}`);
        if (cancelled) return;

        setItems(
          (res.items || []).map((item) => ({
            id: item.id,
            title: item.title,
            description: item.description || "",
            category: item.category ?? null,
            event_date: item.event_date ?? null,
            ingested_at: item.ingested_at,
            is_pinned: item.is_pinned ?? false,
            last_modified_at: item.last_modified_at ?? item.ingested_at,
            tags: item.tags ?? [],
            file_count: item.file_count ?? 0,
            comment_count: item.comment_count ?? 0,
            files: item.files ?? [],
            review_status: item.review_status ?? "NONE",
            review_reasons: item.review_reasons ?? [],
          })),
        );
        setTotal(res.total);
        setBulkSelectedDocIds((prev) => prev.filter((docId) => res.items.some((item) => item.id === docId)));
        setSelectedDocId((prev) => {
          if (prev && res.items.some((x) => x.id === prev)) return prev;
          return null;
        });
      } catch (err) {
        if (!cancelled) {
          setDocsError(err instanceof Error ? err.message : "documents load failed");
          setItems([]);
          setTotal(0);
          setBulkSelectedDocIds([]);
          setSelectedDocId(null);
        }
      } finally {
        if (!cancelled) setDocsLoading(false);
      }
    }

    void loadDocuments();
    return () => {
      cancelled = true;
    };
  }, [page, pageSize, searchQuery, categoryFilter, yearFilter, monthFilter, reviewStatus, sortBy, sortOrder, refreshTick]);

  useEffect(() => {
    if (!selectedDocId) {
      setDetail(null);
      setDetailError("");
      setDetailTab("meta");
      setDetailMetaMode("view");
      setHistoryItems([]);
      setHistoryError("");
      setHistoryTotal(0);
      return;
    }
    setDetailTab("meta");

    let cancelled = false;

    async function loadDetail() {
      setDetailLoading(true);
      setDetailError("");
      setDetailNotice("");
      try {
        const res = await apiGet<DocumentDetailResponse>(`/documents/${selectedDocId}`);
        if (!cancelled) {
          setDetail(res);
          setDetailMetaMode("view");
        }
      } catch (err) {
        if (!cancelled) {
          setDetailError(err instanceof Error ? err.message : "detail load failed");
          setDetail(null);
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedDocId]);

  useEffect(() => {
    if (!detailId) return;
    let cancelled = false;
    async function loadHistory() {
      setHistoryLoading(true);
      setHistoryError("");
      try {
        const res = await apiGet<DocumentHistoryResponse>(`/documents/${detailId}/history?page=1&size=30`);
        if (!cancelled) {
          setHistoryItems(res.items ?? []);
          setHistoryTotal(res.total ?? 0);
        }
      } catch (err) {
        if (!cancelled) {
          setHistoryItems([]);
          setHistoryTotal(0);
          setHistoryError(err instanceof Error ? err.message : "이력 조회 실패");
        }
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    }
    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, [detailId, refreshTick]);

  useEffect(() => {
    if (!detail || detail.files.length === 0) {
      setAddUploads([]);
      setAddInputKey((prev) => prev + 1);
      setReplaceTargetFileId("");
      setReplaceUpload(null);
      setReplaceInputKey((prev) => prev + 1);
      return;
    }
    setReplaceTargetFileId((prev) => {
      if (prev && detail.files.some((f) => f.id === prev)) return prev;
      return detail.files[0].id;
    });
    setAddUploads([]);
    setAddInputKey((prev) => prev + 1);
    setReplaceUpload(null);
    setReplaceInputKey((prev) => prev + 1);
  }, [detail]);

  useEffect(() => {
    if (!detail) {
      setEditTitle("");
      setEditDescriptionHtml("<p></p>");
      setEditSummary("");
      setEditCategoryNames([]);
      setCustomCategoryName("");
      setEditEventDate("");
      setEditTags("");
      setEditIsPinned(false);
      setEditReviewStatus("NONE");
      setDetailMetaMode("view");
      setVersionSnapshot(null);
      setVersionSnapshotError("");
      setSelectedVersionNo(null);
      return;
    }
    setEditTitle(detail.title);
    setEditDescriptionHtml(normalizeRichContentHtml(detail.description || ""));
    setEditSummary(detail.summary || "");
    const initialCategories = Array.from(
      new Set(
        (detail.categories && detail.categories.length > 0 ? detail.categories : detail.category ? [detail.category] : [])
          .map((name) => name?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    );
    setEditCategoryNames(initialCategories);
    setCustomCategoryName("");
    setEditEventDate(detail.event_date ?? "");
    setEditTags(detail.tags.join(", "));
    setEditIsPinned(detail.is_pinned);
    setEditReviewStatus(detail.review_status);
    setDetailMetaMode("view");
    setVersionSnapshot(null);
    setVersionSnapshotError("");
    setSelectedVersionNo(null);
  }, [detail]);

  const deleteDetailFile = async (fileId: string) => {
    if (!detail) return;
    const fileRow = detail.files.find((f) => f.id === fileId);
    const filename = fileRow?.original_filename || "선택 파일";
    const confirmed = window.confirm(`파일을 삭제하시겠습니까?\n${filename}`);
    if (!confirmed) return;

    setFileActionLoadingId(fileId);
    setDetailError("");
    setDetailNotice("");
    try {
      const res = await apiDelete<DocumentDetailResponse>(`/documents/${detail.id}/files/${fileId}`);
      setDetail(res);
      setDetailNotice("파일 삭제가 완료되었습니다.");
      setRefreshTick((prev) => prev + 1);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "파일 삭제 실패");
    } finally {
      setFileActionLoadingId(null);
    }
  };

  const addDetailFiles = async () => {
    if (!detail) return;
    if (addUploads.length === 0) {
      setDetailError("추가할 파일을 선택하세요.");
      return;
    }

    const uploadCount = addUploads.length;
    setFileActionLoadingId("__add__");
    setDetailError("");
    setDetailNotice("");
    try {
      const form = new FormData();
      for (const file of addUploads) {
        form.append("files", file);
      }
      form.append("change_reason", "manual_file_add_ui");
      const res = await apiPostForm<DocumentDetailResponse>(`/documents/${detail.id}/files`, form);
      setDetail(res);
      setAddUploads([]);
      setAddInputKey((prev) => prev + 1);
      setDetailNotice(`파일 ${uploadCount}개 추가가 완료되었습니다.`);
      setRefreshTick((prev) => prev + 1);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "파일 추가 실패");
    } finally {
      setFileActionLoadingId(null);
    }
  };

  const replaceDetailFile = async () => {
    if (!detail) return;
    if (!replaceTargetFileId) {
      setDetailError("교체 대상 파일을 선택하세요.");
      return;
    }
    if (!replaceUpload) {
      setDetailError("업로드할 파일을 선택하세요.");
      return;
    }

    setFileActionLoadingId(replaceTargetFileId);
    setDetailError("");
    setDetailNotice("");
    try {
      const form = new FormData();
      form.append("file", replaceUpload);
      form.append("change_reason", "manual_file_replace_ui");
      const res = await apiPostForm<DocumentDetailResponse>(`/documents/${detail.id}/files/${replaceTargetFileId}/replace`, form);
      setDetail(res);
      setReplaceUpload(null);
      setReplaceInputKey((prev) => prev + 1);
      setDetailNotice("파일 교체가 완료되었습니다.");
      setRefreshTick((prev) => prev + 1);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "파일 교체 실패");
    } finally {
      setFileActionLoadingId(null);
    }
  };

  const toggleCategorySelection = (categoryName: string) => {
    const normalized = categoryName.trim();
    if (!normalized) return;
    setEditCategoryNames((prev) => {
      if (prev.includes(normalized)) {
        return prev.filter((name) => name !== normalized);
      }
      return [...prev, normalized];
    });
  };

  const addCustomCategorySelection = () => {
    const normalized = customCategoryName.trim();
    if (!normalized) return;
    setEditCategoryNames((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
    setCustomCategoryName("");
  };

  const removeCategorySelection = (categoryName: string) => {
    setEditCategoryNames((prev) => prev.filter((name) => name !== categoryName));
  };

  const saveDetailDocument = async () => {
    if (!detail) return;
    if (!editTitle.trim()) {
      setDetailError("제목은 비워둘 수 없습니다.");
      return;
    }

    setDocActionLoading(true);
    setDetailError("");
    setDetailNotice("");
    try {
      const payload = {
        title: editTitle.trim(),
        description: normalizeRichContentHtml(editDescriptionHtml),
        summary: editSummary,
        category_name: editCategoryNames[0] || null,
        category_names: editCategoryNames,
        event_date: editEventDate || null,
        tags: parseTagInput(editTags),
        is_pinned: editIsPinned,
        review_status: editReviewStatus,
      };
      const res = await apiPatch<DocumentDetailResponse>(`/documents/${detail.id}`, payload);
      setDetail(res);
      setDetailMetaMode("view");
      setDetailNotice("게시물 수정이 완료되었습니다.");
      setRefreshTick((prev) => prev + 1);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "게시물 수정 실패");
    } finally {
      setDocActionLoading(false);
    }
  };

  const resetDetailMetaEditor = () => {
    if (!detail) return;
    setEditTitle(detail.title);
    setEditDescriptionHtml(normalizeRichContentHtml(detail.description || ""));
    setEditSummary(detail.summary || "");
    const initialCategories = Array.from(
      new Set(
        (detail.categories && detail.categories.length > 0 ? detail.categories : detail.category ? [detail.category] : [])
          .map((name) => name?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    );
    setEditCategoryNames(initialCategories);
    setCustomCategoryName("");
    setEditEventDate(detail.event_date ?? "");
    setEditTags(detail.tags.join(", "));
    setEditIsPinned(detail.is_pinned);
    setEditReviewStatus(detail.review_status);
    setDetailMetaMode("view");
  };

  const quickResolveDetailReview = async () => {
    if (!detail) return;

    setDocActionLoading(true);
    setDetailError("");
    setDetailNotice("");
    try {
      await apiPatch<ReviewQueueApproveResponse>(`/review-queue/${detail.id}`, { approve: true });
      const refreshed = await apiGet<DocumentDetailResponse>(`/documents/${detail.id}`);
      setDetail(refreshed);
      setEditReviewStatus("RESOLVED");
      setDetailNotice("검토 완료 처리되었습니다.");
      setRefreshTick((prev) => prev + 1);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "검토 완료 처리 실패");
    } finally {
      setDocActionLoading(false);
    }
  };

  const deleteDetailDocument = async () => {
    if (!detail) return;
    const confirmed = window.confirm(`게시물을 삭제하시겠습니까?\n${detail.title}`);
    if (!confirmed) return;

    setDocActionLoading(true);
    setDetailError("");
    setDetailNotice("");
    try {
      await apiDelete<{ status: string; document_id: string }>(`/documents/${detail.id}`);
      setSelectedDocId(null);
      setDetail(null);
      setDetailMetaMode("view");
      setIsDetailModalOpen(false);
      setDetailNotice("게시물 삭제가 완료되었습니다.");
      setRefreshTick((prev) => prev + 1);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "게시물 삭제 실패");
    } finally {
      setDocActionLoading(false);
    }
  };

  const loadVersionSnapshot = async (versionNo: number) => {
    if (!detail) return;
    setVersionSnapshotLoading(true);
    setVersionSnapshotError("");
    setSelectedVersionNo(versionNo);
    try {
      const res = await apiGet<DocumentVersionSnapshotResponse>(`/documents/${detail.id}/versions/${versionNo}/snapshot`);
      setVersionSnapshot(res);
    } catch (err) {
      setVersionSnapshot(null);
      setVersionSnapshotError(err instanceof Error ? err.message : "버전 스냅샷 조회 실패");
    } finally {
      setVersionSnapshotLoading(false);
    }
  };

  const toggleDocSelection = (docId: string, checked: boolean) => {
    setBulkSelectedDocIds((prev) => {
      if (checked) {
        if (prev.includes(docId)) return prev;
        return [...prev, docId];
      }
      return prev.filter((id) => id !== docId);
    });
  };

  const toggleSelectAllOnPage = (checked: boolean) => {
    if (!checked) {
      setBulkSelectedDocIds([]);
      return;
    }
    setBulkSelectedDocIds(items.map((item) => item.id));
  };

  const markSelectedNeedsReview = async () => {
    if (!isAdmin || bulkSelectedDocIds.length === 0 || bulkActionLoading) return;
    const targets = [...bulkSelectedDocIds];
    const confirmed = window.confirm(`선택한 ${targets.length}건을 검토 필요 상태로 변경할까요?`);
    if (!confirmed) return;

    setBulkActionLoading(true);
    setBulkActionError("");
    setBulkActionNotice("");
    try {
      const results = await Promise.allSettled(
        targets.map((id) =>
          apiPatch<DocumentDetailResponse>(`/documents/${id}`, {
            review_status: "NEEDS_REVIEW",
          }),
        ),
      );

      const successIds: string[] = [];
      const failedIds: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") successIds.push(targets[index]);
        else failedIds.push(targets[index]);
      });

      if (successIds.length > 0) {
        setRefreshTick((prev) => prev + 1);
      }
      setBulkSelectedDocIds(failedIds);

      if (failedIds.length === 0) {
        setBulkActionNotice(`검토 필요 상태 변경 완료: ${successIds.length}건`);
      } else {
        setBulkActionError(`일부 실패: 성공 ${successIds.length}건, 실패 ${failedIds.length}건`);
      }
    } catch (err) {
      setBulkActionError(err instanceof Error ? err.message : "일괄 검토상태 변경 실패");
    } finally {
      setBulkActionLoading(false);
    }
  };

  const deleteSelectedDocuments = async () => {
    if (!isAdmin || bulkSelectedDocIds.length === 0 || bulkActionLoading) return;
    const targets = [...bulkSelectedDocIds];
    const confirmed = window.confirm(`선택한 ${targets.length}건을 삭제할까요?\n첨부 연결도 함께 정리됩니다.`);
    if (!confirmed) return;

    setBulkActionLoading(true);
    setBulkActionError("");
    setBulkActionNotice("");
    try {
      const results = await Promise.allSettled(
        targets.map((id) => apiDelete<{ status: string; document_id: string }>(`/documents/${id}`)),
      );

      const successIds: string[] = [];
      const failedIds: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") successIds.push(targets[index]);
        else failedIds.push(targets[index]);
      });

      if (successIds.length > 0) {
        if (selectedDocId && successIds.includes(selectedDocId)) {
          setSelectedDocId(null);
          setDetail(null);
          setIsDetailModalOpen(false);
        }
        setRefreshTick((prev) => prev + 1);
      }
      setBulkSelectedDocIds(failedIds);

      if (failedIds.length === 0) {
        setBulkActionNotice(`게시물 삭제 완료: ${successIds.length}건`);
      } else {
        setBulkActionError(`일부 실패: 삭제 ${successIds.length}건, 실패 ${failedIds.length}건`);
      }
    } catch (err) {
      setBulkActionError(err instanceof Error ? err.message : "일괄 삭제 실패");
    } finally {
      setBulkActionLoading(false);
    }
  };

  const clearFilters = () => {
    setCategoryFilter("");
    setYearFilter(null);
    setMonthFilter(null);
    setExpandedCategory(null);
    setExpandedYearsByCategory({});
    setReviewStatus("");
    setSearchInput("");
    setSearchQuery("");
    setSortBy("event_date");
    setSortOrder("desc");
    setPageSize(DEFAULT_PAGE_SIZE);
    setPage(1);
    setBulkSelectedDocIds([]);
    setBulkActionError("");
    setBulkActionNotice("");
  };

  const saveCurrentViewPreset = () => {
    const normalizedName = viewPresetName.trim();
    if (!normalizedName) {
      setBulkActionError("프리셋 이름을 입력하세요.");
      return;
    }
    const next = upsertArchiveViewPreset(viewPresets, normalizedName, {
      category_filter: categoryFilter,
      year_filter: yearFilter,
      month_filter: monthFilter,
      review_status: reviewStatus,
      search_query: searchQuery,
      sort_by: sortBy,
      sort_order: sortOrder,
      page_size: pageSize,
      density: listDensity,
      visible_columns: visibleColumns,
    });
    setViewPresets(next);
    saveArchiveViewPresets(next);
    setBulkActionError("");
    setBulkActionNotice(`프리셋 저장 완료: ${normalizedName}`);
    setViewPresetName("");
  };

  const applyViewPreset = (preset: ArchiveViewPreset) => {
    const payload = preset.payload;
    setCategoryFilter(payload.category_filter || "");
    setYearFilter(payload.year_filter ?? null);
    setMonthFilter(payload.month_filter ?? null);
    setExpandedCategory(payload.category_filter || null);
    setExpandedYearsByCategory(payload.category_filter ? { [payload.category_filter]: payload.year_filter ?? null } : {});
    setReviewStatus(parseReviewStatus(payload.review_status || null));
    setSearchInput(payload.search_query || "");
    setSearchQuery(payload.search_query || "");
    setSortBy(parseSortBy(payload.sort_by || null));
    setSortOrder(parseSortOrder(payload.sort_order || null));
    setPageSize(payload.page_size > 0 ? payload.page_size : DEFAULT_PAGE_SIZE);
    setListDensity(payload.density === "compact" ? "compact" : "default");
    setVisibleColumns(payload.visible_columns?.length ? payload.visible_columns : ARCHIVE_COLUMN_ORDER_DEFAULT);
    setPage(1);
    setBulkActionNotice(`프리셋 적용: ${preset.name}`);
    setBulkActionError("");
  };

  const deleteViewPreset = (presetId: string) => {
    const next = removeArchiveViewPreset(viewPresets, presetId);
    setViewPresets(next);
    saveArchiveViewPresets(next);
    setBulkActionNotice("프리셋 삭제 완료");
    setBulkActionError("");
  };

  const toggleColumnSort = (target: DocumentSortBy) => {
    if (sortBy === target) {
      setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(target);
      setSortOrder("desc");
    }
    setPage(1);
  };

  const sortMarker = (target: DocumentSortBy): string => {
    if (sortBy !== target) return "↕";
    return sortOrder === "desc" ? "↓" : "↑";
  };

  const applySearch = () => {
    setSearchQuery(searchInput);
    setPage(1);
  };

  const selectCategory = (category: string) => {
    setExpandedCategory(category);
    setExpandedYearsByCategory((prev) => ({ ...prev, [category]: null }));
    setCategoryFilter(category);
    setYearFilter(null);
    setMonthFilter(null);
    setPage(1);
  };

  const selectYear = (category: string, year: number) => {
    setExpandedCategory(category);
    setExpandedYearsByCategory((prev) => ({ ...prev, [category]: year }));
    setCategoryFilter(category);
    setYearFilter(year);
    setMonthFilter(null);
    setPage(1);
  };

  const selectMonth = (category: string, year: number, month: number) => {
    setExpandedCategory(category);
    setExpandedYearsByCategory((prev) => ({ ...prev, [category]: year }));
    setCategoryFilter(category);
    setYearFilter(year);
    setMonthFilter(month);
    setPage(1);
  };

  const toggleDensity = () => {
    setListDensity((prev) => (prev === "default" ? "compact" : "default"));
  };

  const toggleColumnVisibility = (column: ArchiveColumnKey, checked: boolean) => {
    if (column === "title") return;
    setVisibleColumns((prev) => {
      if (checked) {
        const expanded = [...prev, column];
        return ARCHIVE_COLUMN_ORDER_DEFAULT.filter((item) => expanded.includes(item));
      }
      const reduced = prev.filter((item) => item !== column);
      return reduced.length > 0 ? reduced : ["title"];
    });
  };

  const moveColumn = (column: ArchiveColumnKey, direction: "up" | "down") => {
    setVisibleColumns((prev) => {
      const index = prev.indexOf(column);
      if (index < 0) return prev;
      if (direction === "up" && index === 0) return prev;
      if (direction === "down" && index === prev.length - 1) return prev;
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      const next = [...prev];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(250px,1.8fr)_minmax(0,10.2fr)]">
      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <div className="mb-3 rounded-lg border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-amber-50 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold tracking-wide text-emerald-700">분류 탐색</p>
              <p className="text-sm font-semibold text-stone-800">카테고리 필터</p>
              <p className="mt-1 text-[11px] text-stone-600">카테고리, 연도, 월 순서로 문서를 빠르게 좁혀보세요.</p>
            </div>
            <div className="flex items-center gap-1">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white text-accent shadow-sm">
                <FolderTree className="h-4 w-4" />
              </span>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white text-stone-600 shadow-sm">
                <CalendarDays className="h-4 w-4" />
              </span>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white text-stone-600 shadow-sm">
                <Tag className="h-4 w-4" />
              </span>
            </div>
          </div>
        </div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="inline-flex items-center gap-1 text-sm font-semibold">
            <FolderTree className="h-4 w-4 text-accent" />
            분류 / 연도 / 월
          </h3>
          <button className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50" onClick={clearFilters}>
            <FilterX className="h-3.5 w-3.5" />
            필터 초기화
          </button>
        </div>
        {treeLoading ? <p className="text-sm text-stone-600">트리 로딩 중...</p> : null}
        {treeError ? <p className="text-sm text-red-700">트리 로드 실패: {treeError}</p> : null}
        {!treeLoading && !treeError && tree && tree.categories.length === 0 ? (
          <p className="text-sm text-stone-600">데이터 없음</p>
        ) : null}
        <div className="space-y-2">
          {tree?.categories.map((cat) => {
            const isCategoryExpanded = expandedCategory === cat.category;
            const expandedYear = expandedYearsByCategory[cat.category] ?? null;
            return (
              <div key={cat.category} className="rounded border border-stone-200 p-2">
                <button
                  className={`w-full rounded px-2 py-1 text-left text-sm ${
                    categoryFilter === cat.category && yearFilter == null ? "bg-stone-100 font-medium" : "hover:bg-stone-50"
                  }`}
                  onClick={() => selectCategory(cat.category)}
                >
                  <span className="inline-flex items-center gap-1">
                    {isCategoryExpanded ? <ChevronDown className="h-3.5 w-3.5 text-stone-500" /> : <ChevronRight className="h-3.5 w-3.5 text-stone-500" />}
                    <FileText className="h-3.5 w-3.5 text-stone-500" />
                    {cat.category} ({cat.count})
                  </span>
                </button>
                {isCategoryExpanded ? (
                  <div className="ml-2 mt-1 space-y-1">
                    {cat.years.map((yearNode) => {
                      const isYearExpanded = expandedYear === yearNode.year;
                      return (
                        <div key={`${cat.category}-${yearNode.year}`}>
                          <button
                            className={`w-full rounded px-2 py-1 text-left text-xs ${
                              categoryFilter === cat.category && yearFilter === yearNode.year && monthFilter == null
                                ? "bg-stone-100 font-medium"
                                : "hover:bg-stone-50"
                            }`}
                            onClick={() => selectYear(cat.category, yearNode.year)}
                          >
                            <span className="inline-flex items-center gap-1">
                              {isYearExpanded ? <ChevronDown className="h-3 w-3 text-stone-500" /> : <ChevronRight className="h-3 w-3 text-stone-500" />}
                              <CalendarDays className="h-3.5 w-3.5 text-stone-500" />
                              {yearNode.year}년 ({yearNode.count})
                            </span>
                          </button>
                          {isYearExpanded ? (
                            <div className="ml-5 mt-1 flex flex-wrap gap-1">
                              {yearNode.months.map((monthNode) => (
                                <button
                                  key={`${cat.category}-${yearNode.year}-${monthNode.month}`}
                                  className={`rounded border px-2 py-0.5 text-xs ${
                                    categoryFilter === cat.category &&
                                    yearFilter === yearNode.year &&
                                    monthFilter === monthNode.month
                                      ? "border-accent bg-accent text-white"
                                      : "border-stone-300 hover:bg-stone-50"
                                  }`}
                                  onClick={() => selectMonth(cat.category, yearNode.year, monthNode.month)}
                                >
                                  {monthNode.month}월 ({monthNode.count})
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </article>

      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <div className="mb-3 rounded border border-stone-200 bg-stone-50 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
              onClick={() => setSearchPanelOpen((prev) => !prev)}
              type="button"
            >
              <Search className="h-3.5 w-3.5" />
              검색/필터
              {searchPanelOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
              onClick={() => setListToolsPanelOpen((prev) => !prev)}
              type="button"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              보기/컬럼설정
              {listToolsPanelOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <span className="text-[11px] text-stone-600">활성 필터 {activeFilterCount}개</span>
            {activeFilterCount > 0 ? (
              <button className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100" onClick={clearFilters}>
                <FilterX className="h-3.5 w-3.5" />
                필터 초기화
              </button>
            ) : null}
            <div className="ml-auto inline-flex items-center gap-2">
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
              >
                <Files className="h-3.5 w-3.5" />
                대시보드
              </Link>
              <Link
                href="/mind-map"
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
              >
                <GitBranch className="h-3.5 w-3.5" />
                마인드맵
              </Link>
              <Link
                href="/manual-post"
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
              >
                <Pencil className="h-3.5 w-3.5" />
                상세게시
              </Link>
            </div>
          </div>
        </div>

        {searchPanelOpen ? (
          <div className="mb-3 grid gap-2 rounded border border-stone-200 bg-stone-50 p-2 md:grid-cols-[1fr_180px_160px_120px_auto_auto]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-stone-400" />
              <input
                className="w-full rounded border border-stone-300 py-2 pl-8 pr-3 text-sm"
                placeholder="제목/본문 검색"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </label>
            <label className="relative block">
              <ListFilter className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-stone-400" />
              <select
                className="w-full rounded border border-stone-300 py-2 pl-8 pr-2 text-sm"
                value={reviewStatus}
                onChange={(e) => {
                  setReviewStatus((e.target.value as ReviewStatus | "") || "");
                  setPage(1);
                }}
              >
                <option value="">검토상태 전체</option>
                <option value="NONE">{reviewStatusLabel("NONE")}</option>
                <option value="NEEDS_REVIEW">{reviewStatusLabel("NEEDS_REVIEW")}</option>
                <option value="RESOLVED">{reviewStatusLabel("RESOLVED")}</option>
              </select>
            </label>
            <label className="relative block">
              <CalendarDays className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-stone-400" />
              <select
                className="w-full rounded border border-stone-300 py-2 pl-8 pr-2 text-sm"
                value={sortBy}
                onChange={(e) => {
                  setSortBy(parseSortBy(e.target.value));
                  setPage(1);
                }}
              >
                <option value="event_date">정렬: 문서시점</option>
                <option value="last_modified_at">정렬: 최종수정</option>
                <option value="ingested_at">정렬: 수집시점</option>
                <option value="created_at">정렬: 생성시점</option>
                <option value="title">정렬: 제목</option>
              </select>
            </label>
            <label className="relative block">
              <ArrowUpDown className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-stone-400" />
              <select
                className="w-full rounded border border-stone-300 py-2 pl-8 pr-2 text-sm"
                value={sortOrder}
                onChange={(e) => {
                  setSortOrder(parseSortOrder(e.target.value));
                  setPage(1);
                }}
              >
                <option value="desc">내림차순</option>
                <option value="asc">오름차순</option>
              </select>
            </label>
            <button className="inline-flex items-center gap-1 rounded bg-accent px-3 py-2 text-sm text-white" onClick={applySearch}>
              <Search className="h-4 w-4" />
              검색 적용
            </button>
            <button className="inline-flex items-center gap-1 rounded border border-stone-300 px-3 py-2 text-sm hover:bg-stone-50" onClick={clearFilters}>
              <FilterX className="h-4 w-4" />
              초기화
            </button>
          </div>
        ) : null}

        {listToolsPanelOpen ? (
          <div className="mb-3 rounded border border-stone-200 bg-stone-50 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
                onClick={toggleDensity}
                type="button"
              >
                <List className="h-3.5 w-3.5" />
                {listDensity === "default" ? "컴팩트 보기" : "기본 밀도 보기"}
              </button>
              <button
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
                onClick={() => setColumnOptionsOpen((prev) => !prev)}
                type="button"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                컬럼 설정
              </button>
              <span className="text-[11px] text-stone-600">단축키: ↑/↓ 선택 이동, Enter 상세 열기, Del(관리자 삭제)</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="w-full max-w-[240px] rounded border border-stone-300 px-2 py-1 text-xs"
                value={viewPresetName}
                onChange={(e) => setViewPresetName(e.target.value)}
                placeholder="화면 프리셋 이름"
              />
              <button
                className="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100"
                onClick={saveCurrentViewPreset}
                type="button"
              >
                현재 화면 저장
              </button>
            </div>
            {viewPresets.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {viewPresets.map((preset) => (
                  <span key={`preset-${preset.id}`} className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-1.5 py-1 text-[11px]">
                    <button className="font-medium text-stone-800 hover:underline" onClick={() => applyViewPreset(preset)} type="button">
                      {preset.name}
                    </button>
                    <button
                      className="rounded border border-red-200 px-1 py-0.5 text-[10px] text-red-600 hover:bg-red-50"
                      onClick={() => deleteViewPreset(preset.id)}
                      type="button"
                      title="프리셋 삭제"
                    >
                      삭제
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {columnOptionsOpen ? (
              <div className="mt-2 space-y-1 rounded border border-stone-200 bg-white p-2">
                {ARCHIVE_COLUMN_ORDER_DEFAULT.map((column) => {
                  const checked = visibleColumns.includes(column);
                  const orderIndex = visibleColumns.indexOf(column);
                  return (
                    <div key={`archive-column-${column}`} className="flex items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-2 text-xs text-stone-700">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={column === "title"}
                          onChange={(e) => toggleColumnVisibility(column, e.target.checked)}
                        />
                        {ARCHIVE_COLUMN_LABELS[column]}
                        {column === "title" ? <span className="text-[10px] text-stone-500">(필수)</span> : null}
                      </label>
                      {checked ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            className="rounded border border-stone-300 px-1 py-0.5 text-[10px] hover:bg-stone-100 disabled:opacity-50"
                            onClick={() => moveColumn(column, "up")}
                            disabled={orderIndex <= 0}
                            type="button"
                            title="위로 이동"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button
                            className="rounded border border-stone-300 px-1 py-0.5 text-[10px] hover:bg-stone-100 disabled:opacity-50"
                            onClick={() => moveColumn(column, "down")}
                            disabled={orderIndex < 0 || orderIndex >= visibleColumns.length - 1}
                            type="button"
                            title="아래로 이동"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-[10px] text-stone-400">숨김</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mb-2 text-xs text-stone-600">
          총 {total.toLocaleString("ko-KR")}건 | 페이지 {page}/{totalPages}
        </div>

        {isAdmin ? (
          <div className="sticky top-0 z-20 mb-2 rounded border border-stone-200 bg-stone-50 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-stone-600">선택 {bulkSelectedDocIds.length}건</span>
              <button
                className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                onClick={() => void deleteSelectedDocuments()}
                disabled={bulkActionLoading || bulkSelectedDocIds.length === 0}
              >
                {bulkActionLoading ? "처리 중..." : "선택 삭제"}
              </button>
              <button
                className="rounded border border-amber-300 px-2 py-1 text-xs text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                onClick={() => void markSelectedNeedsReview()}
                disabled={bulkActionLoading || bulkSelectedDocIds.length === 0}
              >
                {bulkActionLoading ? "처리 중..." : "검토 필요로 변경"}
              </button>
              <button
                className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100 disabled:opacity-50"
                onClick={() => setBulkSelectedDocIds([])}
                disabled={bulkActionLoading || bulkSelectedDocIds.length === 0}
              >
                선택 해제
              </button>
            </div>
            {bulkActionError ? <p className="mt-1 text-xs text-red-700">{bulkActionError}</p> : null}
            {bulkActionNotice ? <p className="mt-1 text-xs text-emerald-700">{bulkActionNotice}</p> : null}
          </div>
        ) : null}

        {docsLoading ? <p className="text-sm text-stone-600">문서 목록 로딩 중...</p> : null}
        {docsError ? <p className="text-sm text-red-700">목록 로드 실패: {docsError}</p> : null}

        {!docsLoading && !docsError ? (
          <div className="rounded border border-stone-200">
            <div className="max-h-[520px] overflow-auto">
              <div style={{ minWidth: `${tableMinWidth}px` }}>
                <div className="grid border-b border-stone-200 px-2 py-1.5 text-[11px] text-stone-500" style={{ gridTemplateColumns: tableGridTemplate }}>
                  {isAdmin ? (
                    <label className="inline-flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={allSelectedOnPage}
                        onChange={(e) => toggleSelectAllOnPage(e.target.checked)}
                        disabled={docsLoading || items.length === 0 || bulkActionLoading}
                        title="현재 페이지 전체 선택"
                      />
                    </label>
                  ) : null}
                  {visibleColumns.map((column) => {
                    if (column === "date") {
                      return (
                        <button
                          key="header-date"
                          className="inline-flex items-center gap-1 text-left hover:text-stone-800"
                          onClick={() => toggleColumnSort("event_date")}
                          type="button"
                          title="날짜 정렬"
                        >
                          <Clock3 className="h-3.5 w-3.5" />
                          날짜 {sortMarker("event_date")}
                        </button>
                      );
                    }
                    if (column === "modified") {
                      return (
                        <button
                          key="header-modified"
                          className="inline-flex items-center gap-1 text-left text-[10px] leading-tight hover:text-stone-800"
                          onClick={() => toggleColumnSort("last_modified_at")}
                          type="button"
                          title="최종수정 정렬"
                        >
                          <History className="h-3.5 w-3.5" />
                          최종수정 {sortMarker("last_modified_at")}
                        </button>
                      );
                    }
                    if (column === "title") {
                      return (
                        <span key="header-title" className="inline-flex items-center gap-1">
                          <FileText className="h-3.5 w-3.5" />
                          제목
                        </span>
                      );
                    }
                    if (column === "category") {
                      return (
                        <span key="header-category" className="inline-flex items-center gap-1">
                          <FolderTree className="h-3.5 w-3.5" />
                          분류
                        </span>
                      );
                    }
                    if (column === "tags") {
                      return (
                        <span key="header-tags" className="inline-flex items-center gap-1">
                          <Tag className="h-3.5 w-3.5" />
                          태그
                        </span>
                      );
                    }
                    if (column === "file") {
                      return (
                        <span key="header-file" className="inline-flex items-center gap-1">
                          <Paperclip className="h-3.5 w-3.5" />
                          파일
                        </span>
                      );
                    }
                    return (
                      <span key="header-review" className="inline-flex items-center gap-1">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        검토
                      </span>
                    );
                  })}
                </div>
                {items.length === 0 ? <p className="px-3 py-3 text-sm text-stone-600">조건에 맞는 문서가 없습니다.</p> : null}
                {items.map((item) => (
                  <div
                    key={item.id}
                    data-doc-id={item.id}
                    className={`grid cursor-pointer items-center border-b border-stone-100 px-2 ${listRowClassName} ${
                      selectedDocId === item.id ? "bg-stone-50" : "hover:bg-stone-50"
                    }`}
                    style={{ gridTemplateColumns: tableGridTemplate }}
                    onClick={() => {
                      setSelectedDocId(item.id);
                      setIsDetailModalOpen(true);
                    }}
                  >
                    {isAdmin ? (
                      <label className="inline-flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={bulkSelectedDocIds.includes(item.id)}
                          onChange={(e) => toggleDocSelection(item.id, e.target.checked)}
                          disabled={bulkActionLoading}
                        />
                      </label>
                    ) : null}
                    {visibleColumns.map((column) => {
                      if (column === "date") {
                        return <span key={`${item.id}-date`}>{formatDate(item.event_date)}</span>;
                      }
                      if (column === "title") {
                        const showNew = isRecentlyPosted(item.ingested_at);
                        return (
                          <div key={`${item.id}-title`} className="min-w-0">
                            <div className="flex items-center gap-1">
                              <p className={titleClassName}>{item.title}</p>
                              {item.is_pinned ? (
                                <span className="inline-flex items-center gap-0.5 rounded border border-amber-200 bg-amber-50 px-1 py-0.5 text-[10px] font-semibold text-amber-800">
                                  <Pin className="h-3 w-3" />
                                  고정
                                </span>
                              ) : null}
                              {item.comment_count > 0 ? (
                                <span className="inline-flex items-center gap-0.5 rounded border border-sky-200 bg-sky-50 px-1 py-0.5 text-[10px] font-semibold text-sky-700">
                                  <MessageSquare className="h-3 w-3" />
                                  {item.comment_count}
                                </span>
                              ) : null}
                              {showNew ? <StatusBadge tone="new" label="신규" compact /> : null}
                            </div>
                          </div>
                        );
                      }
                      if (column === "category") {
                        const categoryLabel = item.category || "미분류";
                        return (
                          <div key={`${item.id}-category`} className="min-w-0">
                            <span
                              className="inline-flex max-w-full items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold"
                              style={categoryBadgeStyle(item.category)}
                              title={categoryLabel}
                            >
                              <span className="truncate">{categoryLabel}</span>
                            </span>
                          </div>
                        );
                      }
                      if (column === "tags") {
                        return (
                          <span key={`${item.id}-tags`} className="truncate">
                            {item.tags.join(", ") || "-"}
                          </span>
                        );
                      }
                      if (column === "file") {
                        return (
                          <div key={`${item.id}-file`} className="min-w-0 truncate">
                            {item.files.length > 0 ? (
                              <span className="inline-flex max-w-full items-center gap-1">
                                <Paperclip className="h-3.5 w-3.5 shrink-0 text-stone-500" />
                                <a
                                  className="inline-flex min-w-0 items-center gap-1 text-blue-700 hover:bg-blue-50"
                                  href={fileDownloadUrl(item.files[0].download_path, item.files[0].id)}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <FileTypeBadge filename={item.files[0].original_filename} compact />
                                  <span className="max-w-[10rem] truncate">{item.files[0].original_filename}</span>
                                </a>
                              </span>
                            ) : (
                              <span className="text-stone-500">-</span>
                            )}
                            {item.file_count > 1 ? <span className="ml-1 text-[11px] text-stone-500">+{item.file_count - 1}</span> : null}
                          </div>
                        );
                      }
                      if (column === "modified") {
                        return (
                          <span
                            key={`${item.id}-modified`}
                            className={`truncate text-stone-500 ${
                              listDensity === "compact" ? "text-[9px] leading-tight" : "text-[10px] leading-tight"
                            }`}
                          >
                            {formatDateTime(item.last_modified_at || item.ingested_at)}
                          </span>
                        );
                      }
                      return (
                        <div key={`${item.id}-review`} className="flex flex-wrap items-center gap-1">
                          {(() => {
                            const status = statusBadgeForDocument(item);
                            return <StatusBadge tone={status.primary.tone} label={status.primary.label} compact />;
                          })()}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-stone-600">페이지 크기</label>
            <select
              className="rounded border border-stone-300 px-2 py-1 text-xs"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            >
              {[20, 50, 100, 200].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
          <button
            className="rounded border border-stone-300 px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            이전
          </button>
          <button
            className="rounded border border-stone-300 px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            다음
          </button>
          </div>
        </div>
      </article>

      <ModalShell
        open={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title="문서 상세"
        maxWidthClassName="max-w-[96vw]"
      >
        {detailLoading ? <p className="text-sm text-stone-600">상세 로딩 중...</p> : null}
        {detailError ? <p className="text-sm text-red-700">상세 처리 오류: {detailError}</p> : null}
        {detailNotice ? <p className="text-sm text-emerald-700">{detailNotice}</p> : null}
        {!detailLoading && !detailError && !detail ? <p className="text-sm text-stone-600">문서를 선택하세요.</p> : null}

        {!detailLoading && !detailError && detail ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <p className="font-medium text-stone-900">{detail.title}</p>
                <p className="text-xs text-stone-600">
                  {(detail.categories && detail.categories.length > 0 ? detail.categories.join(", ") : detail.category || "미분류")} | 이벤트일 {formatDate(detail.event_date)} | 수집 {formatDateTime(detail.ingested_at)}
                </p>
                <div className="flex flex-wrap items-center gap-1">
                  {detail.is_pinned ? (
                    <span className="inline-flex items-center gap-0.5 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                      <Pin className="h-3 w-3" />
                      고정글
                    </span>
                  ) : null}
                  {(() => {
                    const status = statusBadgeForDocument({
                      review_status: detail.review_status,
                      review_reasons: detail.review_reasons,
                    });
                    return <StatusBadge tone={status.primary.tone} label={status.primary.label} compact />;
                  })()}
                  {detail.review_reasons.length > 0 ? (
                    <span className="rounded border border-stone-300 bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-700">
                      사유 {detail.review_reasons.length}건
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className="rounded border border-cyan-600 bg-cyan-600 px-2 py-1 text-xs text-white hover:bg-cyan-700 disabled:opacity-50"
                  onClick={() => void quickResolveDetailReview()}
                  disabled={
                    docActionLoading ||
                    Boolean(fileActionLoadingId) ||
                    !canQuickResolveReview ||
                    (detail.review_status === "RESOLVED" && detail.review_reasons.length === 0)
                  }
                  title={!canQuickResolveReview ? "REVIEWER/ADMIN 권한에서만 사용 가능" : "검토 사유를 정리하고 완료 처리"}
                >
                  {docActionLoading ? "처리 중..." : "검토 완료"}
                </button>
                {detailMetaMode === "view" ? (
                  <button
                    className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                    onClick={() => setDetailMetaMode("edit")}
                    disabled={docActionLoading || Boolean(fileActionLoadingId)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    편집모드
                  </button>
                ) : (
                  <>
                    <button
                      className="rounded border border-emerald-600 bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                      onClick={() => void saveDetailDocument()}
                      disabled={docActionLoading || Boolean(fileActionLoadingId)}
                    >
                      {docActionLoading ? "저장 중..." : "게시물 저장"}
                    </button>
                    <button
                      className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                      onClick={resetDetailMetaEditor}
                      disabled={docActionLoading || Boolean(fileActionLoadingId)}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      보기전환
                    </button>
                  </>
                )}
                <button
                  className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                  onClick={() => void deleteDetailDocument()}
                  disabled={docActionLoading || Boolean(fileActionLoadingId)}
                >
                  {docActionLoading ? "처리 중..." : "게시물 삭제"}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1 border-b border-stone-200 pb-2">
              <button type="button" className={detailTabButtonClass("meta")} onClick={() => setDetailTab("meta")}>
                메타
              </button>
              <button type="button" className={detailTabButtonClass("files")} onClick={() => setDetailTab("files")}>
                파일
              </button>
              <button type="button" className={detailTabButtonClass("versions")} onClick={() => setDetailTab("versions")}>
                버전
              </button>
              <button type="button" className={detailTabButtonClass("history")} onClick={() => setDetailTab("history")}>
                이력
              </button>
            </div>

            {detailTab === "meta" ? (
              <div className="space-y-3">
                {detailMetaMode === "view" ? (
                  <>
                    <div className="rounded border border-stone-200 bg-white p-3">
                      <p className="mb-2 inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
                        <FileText className="h-3.5 w-3.5" />
                        문서 본문
                      </p>
                      <RichContentView html={normalizeRichContentHtml(detail.description || "")} />
                    </div>
                    {hasMeaningfulRichText(detail.summary) ? (
                      <div className="rounded border border-stone-200 bg-stone-50 p-2">
                        <p className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
                          <AlignLeft className="h-3.5 w-3.5" />
                          요약
                        </p>
                        <RichContentView html={normalizeRichContentHtml(detail.summary)} className="text-xs" />
                      </div>
                    ) : null}
                    <details className="rounded border border-stone-200 bg-stone-50 p-2">
                      <summary className="cursor-pointer select-none text-xs font-semibold text-stone-700">
                        원본 캡션 펼치기
                      </summary>
                      <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded border border-stone-200 bg-white p-2 text-xs text-stone-700">
                        {detail.caption_raw || "-"}
                      </pre>
                    </details>
                    <DocumentCommentsPanel documentId={detail.id} compact inlineComposer />
                  </>
                ) : (
                  <div>
                    <p className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
                      <Pencil className="h-3.5 w-3.5" />
                      리치 편집
                    </p>
                    <div className="space-y-2 rounded border border-stone-200 p-2">
                      <input
                        className="w-full rounded border border-stone-300 px-2 py-1 text-xs"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        placeholder="제목"
                      />
                      <div className="space-y-2 rounded border border-stone-200 p-2">
                        <p className="text-[11px] font-semibold text-stone-700">카테고리(복수 선택 가능)</p>
                        <div className="grid max-h-24 grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-2 gap-y-1 overflow-auto rounded border border-stone-200 bg-white p-2">
                          {categoryOptions.map((name) => (
                            <label key={name} className="flex min-w-0 items-center gap-2 text-[11px] text-stone-700">
                              <input type="checkbox" checked={editCategoryNames.includes(name)} onChange={() => toggleCategorySelection(name)} />
                              <span className="truncate">{name}</span>
                            </label>
                          ))}
                          {categoryOptions.length === 0 ? <p className="text-[11px] text-stone-500">등록된 카테고리가 없습니다.</p> : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            className="w-full rounded border border-stone-300 px-2 py-1 text-xs"
                            value={customCategoryName}
                            onChange={(e) => setCustomCategoryName(e.target.value)}
                            placeholder="신규 카테고리명"
                          />
                          <button
                            type="button"
                            className="rounded border border-stone-300 bg-white px-2 py-1 text-[11px] text-stone-700 hover:bg-stone-50"
                            onClick={addCustomCategorySelection}
                          >
                            추가
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {editCategoryNames.length === 0 ? <span className="text-[11px] text-stone-500">선택된 카테고리 없음</span> : null}
                          {editCategoryNames.map((name, idx) => (
                            <button
                              key={name}
                              type="button"
                              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${idx === 0 ? "border-accent bg-accent/10 text-accent" : "border-stone-300 bg-white text-stone-700"}`}
                              title={idx === 0 ? "기본 카테고리" : "보조 카테고리"}
                              onClick={() => removeCategorySelection(name)}
                            >
                              <span>{name}</span>
                              <span>×</span>
                            </button>
                          ))}
                        </div>
                      </div>
                      {categoryOptionsLoading ? <p className="text-[11px] text-stone-500">카테고리 목록 로딩 중...</p> : null}
                      {categoryOptionsError ? <p className="text-[11px] text-amber-700">목록 로드 실패: {categoryOptionsError}</p> : null}
                      <input
                        className="w-full rounded border border-stone-300 px-2 py-1 text-xs"
                        type="date"
                        value={editEventDate}
                        onChange={(e) => setEditEventDate(e.target.value)}
                      />
                      <SafeRichContentEditor
                        value={editDescriptionHtml}
                        onChange={setEditDescriptionHtml}
                        minHeightClassName="min-h-[240px]"
                        attachmentLinks={detailAttachmentLinks}
                      />
                      <textarea
                        className="min-h-16 w-full rounded border border-stone-300 px-2 py-1 text-xs"
                        value={editSummary}
                        onChange={(e) => setEditSummary(e.target.value)}
                        placeholder="요약 (직접 수정)"
                      />
                      <textarea
                        className="min-h-16 w-full rounded border border-stone-300 px-2 py-1 text-xs"
                        value={editTags}
                        onChange={(e) => setEditTags(e.target.value)}
                        placeholder="태그(쉼표 또는 줄바꿈)"
                      />
                      <label className="inline-flex items-center gap-2 rounded border border-stone-300 bg-stone-50 px-2 py-1 text-xs text-stone-700">
                        <input
                          type="checkbox"
                          checked={editIsPinned}
                          onChange={(e) => setEditIsPinned(e.target.checked)}
                        />
                        고정글로 설정 (대시보드 상단 노출)
                      </label>
                      <select
                        className="w-full rounded border border-stone-300 px-2 py-1 text-xs"
                        value={editReviewStatus}
                        onChange={(e) => setEditReviewStatus(e.target.value as ReviewStatus)}
                      >
                        <option value="NONE">{reviewStatusLabel("NONE")}</option>
                        <option value="NEEDS_REVIEW">{reviewStatusLabel("NEEDS_REVIEW")}</option>
                        <option value="RESOLVED">{reviewStatusLabel("RESOLVED")}</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {detailTab === "files" ? (
              <div className="space-y-3">
                <div>
                  <p className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
                    <Paperclip className="h-3.5 w-3.5" />
                    파일 추가
                  </p>
                  <div className="space-y-2 rounded border border-stone-200 p-2">
                    <input
                      key={addInputKey}
                      className="w-full rounded border border-stone-300 px-2 py-1 text-xs"
                      type="file"
                      multiple
                      onChange={(e) => setAddUploads(Array.from(e.target.files ?? []))}
                    />
                    {addUploads.length > 0 ? (
                      <p className="line-clamp-3 break-all text-[11px] text-stone-600">
                        {addUploads.map((file) => file.name).join(", ")}
                      </p>
                    ) : null}
                    <button
                      className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
                      onClick={() => void addDetailFiles()}
                      disabled={docActionLoading || Boolean(fileActionLoadingId) || addUploads.length === 0}
                    >
                      {fileActionLoadingId === "__add__" ? "추가 중..." : `선택 파일 ${addUploads.length || 0}개 추가`}
                    </button>
                  </div>
                </div>
                <div>
                  <p className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
                    <RefreshCcw className="h-3.5 w-3.5" />
                    파일 교체
                  </p>
                  {detail.files.length === 0 ? (
                    <p className="text-xs text-stone-500">교체할 파일이 없습니다.</p>
                  ) : (
                    <div className="space-y-2 rounded border border-stone-200 p-2">
                      <select
                        className="w-full rounded border border-stone-300 px-2 py-1 text-xs"
                        value={replaceTargetFileId}
                        onChange={(e) => setReplaceTargetFileId(e.target.value)}
                      >
                        {detail.files.map((file) => (
                          <option key={`${detail.id}-replace-${file.id}`} value={file.id}>
                            {file.original_filename}
                          </option>
                        ))}
                      </select>
                      <input
                        key={replaceInputKey}
                        className="w-full rounded border border-stone-300 px-2 py-1 text-xs"
                        type="file"
                        onChange={(e) => setReplaceUpload(e.target.files?.[0] ?? null)}
                      />
                      <button
                        className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
                        onClick={() => void replaceDetailFile()}
                        disabled={docActionLoading || Boolean(fileActionLoadingId) || !replaceUpload || !replaceTargetFileId}
                      >
                        {fileActionLoadingId === replaceTargetFileId ? "교체 중..." : "선택 파일 교체"}
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <p className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
                    <Files className="h-3.5 w-3.5" />
                    파일 목록
                  </p>
                  <ul className="space-y-1">
                    {detail.files.length === 0 ? <li className="text-xs text-stone-500">파일 없음</li> : null}
                    {detail.files.map((file) => (
                      <li key={file.id} className="rounded border border-stone-200 p-2 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <a
                            className="inline-flex min-w-0 items-center gap-1 break-all font-medium text-blue-700 hover:underline"
                            href={fileDownloadUrl(file.download_path, file.id)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <FileTypeBadge filename={file.original_filename} mimeType={file.mime_type} />
                            <span className="truncate">{file.original_filename}</span>
                          </a>
                          <button
                            className="rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50 disabled:opacity-50"
                            onClick={() => void deleteDetailFile(file.id)}
                            disabled={docActionLoading || Boolean(fileActionLoadingId)}
                          >
                            {fileActionLoadingId === file.id ? "삭제 중..." : "삭제"}
                          </button>
                        </div>
                        <p className="text-stone-600">
                          {file.mime_type} | {formatBytes(file.size_bytes)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {detailTab === "versions" ? (
              <div className="space-y-2">
                <p className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
                  <History className="h-3.5 w-3.5" />
                  버전 히스토리
                </p>
                <ul className="space-y-1">
                  {detail.versions.length === 0 ? <li className="text-xs text-stone-500">버전 없음</li> : null}
                  {detail.versions.map((version) => (
                    <li key={`${detail.id}-v${version.version_no}`} className="rounded border border-stone-200 p-2 text-xs">
                      <button
                        className={`w-full rounded px-1 py-1 text-left hover:bg-stone-50 ${
                          selectedVersionNo === version.version_no ? "bg-stone-100" : ""
                        }`}
                        onClick={() => void loadVersionSnapshot(version.version_no)}
                        type="button"
                      >
                        <p className="font-medium text-stone-900">
                          v{version.version_no} | {version.change_reason}
                        </p>
                        <p className="text-stone-600">{formatDateTime(version.changed_at)}</p>
                      </button>
                    </li>
                  ))}
                </ul>
                {versionSnapshotLoading ? <p className="mt-2 text-xs text-stone-600">버전 스냅샷 로딩 중...</p> : null}
                {versionSnapshotError ? <p className="mt-2 text-xs text-red-700">{versionSnapshotError}</p> : null}
                {versionSnapshot ? (
                  <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-stone-800">
                    <p className="font-semibold">
                      v{versionSnapshot.version_no} | {versionSnapshot.change_reason}
                    </p>
                    <p className="mt-1 text-stone-700">
                      제목: {versionSnapshot.title} | 분류: {versionSnapshot.category || "미분류"} | 이벤트일:{" "}
                      {formatDate(versionSnapshot.event_date)} | 변경시각: {formatDateTime(versionSnapshot.changed_at)}
                    </p>
                    <p className="mt-1 text-stone-700">태그: {versionSnapshot.tags.join(", ") || "-"}</p>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      <div className="rounded border border-stone-200 bg-white p-2">
                        <p className="mb-1 font-semibold text-stone-700">설명</p>
                        <RichContentView
                          html={normalizeRichContentHtml(versionSnapshot.description || "-")}
                          className="max-h-28 overflow-auto text-[11px]"
                        />
                      </div>
                      <div className="rounded border border-stone-200 bg-white p-2">
                        <p className="mb-1 font-semibold text-stone-700">요약</p>
                        <RichContentView
                          html={normalizeRichContentHtml(versionSnapshot.summary || "-")}
                          className="max-h-28 overflow-auto text-[11px]"
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {detailTab === "history" ? (
              <div className="space-y-2">
                <p className="text-xs text-stone-600">총 {historyTotal.toLocaleString("ko-KR")}건</p>
                {historyLoading ? <p className="text-xs text-stone-600">이력 로딩 중...</p> : null}
                {historyError ? <p className="text-xs text-red-700">이력 로드 실패: {historyError}</p> : null}
                {!historyLoading && !historyError && historyItems.length === 0 ? (
                  <p className="text-xs text-stone-500">표시할 이력이 없습니다.</p>
                ) : null}
                <ul className="space-y-1">
                  {historyItems.map((row) => (
                    <li key={`history-${row.id}`} className="rounded border border-stone-200 p-2 text-xs">
                      <p className="font-medium text-stone-900">
                        {row.action} | {formatDateTime(row.created_at)}
                      </p>
                      <p className="text-stone-600">
                        사용자: {row.actor_username || "-"} | 출처: {row.source || "-"} | 참조: {row.source_ref || "-"}
                      </p>
                      {row.before_json ? (
                        <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-1 text-[10px] text-stone-700">
                          before: {JSON.stringify(row.before_json)}
                        </pre>
                      ) : null}
                      {row.after_json ? (
                        <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-1 text-[10px] text-stone-700">
                          after: {JSON.stringify(row.after_json)}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

          </div>
        ) : null}
      </ModalShell>
    </div>
  );
}
