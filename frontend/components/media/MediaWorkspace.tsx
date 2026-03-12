/* eslint-disable @next/next/no-img-element */
"use client";

import { DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Film,
  FileImage,
  ImagePlus,
  Loader2,
  RefreshCcw,
  UploadCloud,
  X,
} from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPostFormWithProgress, buildApiUrl } from "@/lib/api-client";
import { getCurrentUser, type UserRole } from "@/lib/auth";
import { ModalShell } from "@/components/common/ModalShell";
import { RichContentView } from "@/components/editor/RichContentView";

type DocumentListFileItem = {
  id: string;
  original_filename: string;
  download_path?: string;
};

type DocumentListItem = {
  id: string;
  title: string;
  description: string;
  event_date: string | null;
  ingested_at: string;
  file_count: number;
  files: DocumentListFileItem[];
};

type DocumentListResponse = {
  items: DocumentListItem[];
  page: number;
  size: number;
  total: number;
};

type ManualPostResponse = {
  id: string;
};

type DocumentDetailLiteResponse = {
  id: string;
  files: { id: string }[];
};

type DocumentFileItem = {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  download_path?: string;
};

type DocumentDetailResponse = {
  id: string;
  title: string;
  description: string;
  event_date: string | null;
  ingested_at: string;
  files: DocumentFileItem[];
};

type MediaKind = "image" | "video";

type MediaPreviewFile = {
  id: string;
  original_filename: string;
  download_path?: string;
  url: string;
  kind: MediaKind;
};

type MediaCardItem = {
  id: string;
  title: string;
  description: string;
  event_date: string | null;
  ingested_at: string;
  file_count: number;
  cover: MediaPreviewFile;
  media_previews: MediaPreviewFile[];
};

type UploadProgressState = {
  label: string;
  phase: string;
  percent: number;
  loadedBytes: number;
  totalBytes: number;
  failed: boolean;
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tif", "tiff", "heic"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "avi", "mkv", "wmv", "mpeg", "mpg"]);
const PAGE_SIZE = 48;
const SCAN_PAGES_PER_BATCH = 4;

function extensionOf(filename: string): string {
  const normalized = filename.trim().toLowerCase();
  const dotIdx = normalized.lastIndexOf(".");
  if (dotIdx < 0 || dotIdx >= normalized.length - 1) return "";
  return normalized.slice(dotIdx + 1);
}

function detectMediaKind(filename: string, mimeType?: string): MediaKind | null {
  const ext = extensionOf(filename);
  const mime = (mimeType || "").toLowerCase();
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

function fileUrl(fileId: string, downloadPath?: string): string {
  return buildApiUrl(downloadPath || `/files/${fileId}/download`);
}

function fileFingerprint(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function formatDateTime(value: string): string {
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? "-" : dt.toLocaleString("ko-KR");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function toMediaPreviewFromList(file: DocumentListFileItem): MediaPreviewFile | null {
  const kind = detectMediaKind(file.original_filename);
  if (!kind) return null;
  return {
    id: file.id,
    original_filename: file.original_filename,
    download_path: file.download_path,
    url: fileUrl(file.id, file.download_path),
    kind,
  };
}

function toMediaPreviewFromDetail(file: DocumentFileItem): MediaPreviewFile | null {
  const kind = detectMediaKind(file.original_filename, file.mime_type);
  if (!kind) return null;
  return {
    id: file.id,
    original_filename: file.original_filename,
    download_path: file.download_path,
    url: fileUrl(file.id, file.download_path),
    kind,
  };
}

function toMediaCardItem(item: DocumentListItem): MediaCardItem | null {
  const mediaPreviews = item.files.map(toMediaPreviewFromList).filter((value): value is MediaPreviewFile => value !== null);
  if (mediaPreviews.length === 0) return null;
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    event_date: item.event_date,
    ingested_at: item.ingested_at,
    file_count: item.file_count,
    cover: mediaPreviews[0],
    media_previews: mediaPreviews,
  };
}

function MediaThumb({
  file,
  className,
  controls,
}: {
  file: MediaPreviewFile;
  className?: string;
  controls?: boolean;
}) {
  if (file.kind === "video") {
    return (
      <video
        className={className}
        src={file.url}
        controls={Boolean(controls)}
        muted={!controls}
        playsInline
        preload="metadata"
      />
    );
  }
  return <img className={className} src={file.url} alt={file.original_filename} loading="lazy" />;
}

export function MediaWorkspace() {
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [title, setTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [description, setDescription] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null);

  const [items, setItems] = useState<MediaCardItem[]>([]);
  const [listError, setListError] = useState("");
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextRawPage, setNextRawPage] = useState(1);
  const [hasMoreRaw, setHasMoreRaw] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [detail, setDetail] = useState<DocumentDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailActionError, setDetailActionError] = useState("");
  const [detailNotice, setDetailNotice] = useState("");
  const [activeMediaId, setActiveMediaId] = useState<string | null>(null);
  const [detailEditMode, setDetailEditMode] = useState(false);
  const [detailEditTitle, setDetailEditTitle] = useState("");
  const [detailEditEventDate, setDetailEditEventDate] = useState("");
  const [detailEditDescription, setDetailEditDescription] = useState("");
  const [detailActionBusy, setDetailActionBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const progressHideTimerRef = useRef<number | null>(null);

  const canUpload = userRole === "ADMIN" || userRole === "EDITOR";

  const clearProgressHideTimer = useCallback(() => {
    if (progressHideTimerRef.current != null) {
      window.clearTimeout(progressHideTimerRef.current);
      progressHideTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearProgressHideTimer(), [clearProgressHideTimer]);

  const beginUploadProgress = useCallback((label: string, phase: string) => {
    clearProgressHideTimer();
    setUploadProgress({
      label,
      phase,
      percent: 5,
      loadedBytes: 0,
      totalBytes: 0,
      failed: false,
    });
  }, [clearProgressHideTimer]);

  const updateUploadProgress = useCallback(
    (params: Partial<UploadProgressState>) => {
      setUploadProgress((prev) => {
        if (!prev) return prev;
        return { ...prev, ...params };
      });
    },
    [],
  );

  const finishUploadProgress = useCallback(
    (ok: boolean, phase: string) => {
      clearProgressHideTimer();
      setUploadProgress((prev) =>
        prev
          ? {
              ...prev,
              percent: 100,
              phase,
              failed: !ok,
            }
          : null,
      );
      progressHideTimerRef.current = window.setTimeout(() => {
        setUploadProgress(null);
        progressHideTimerRef.current = null;
      }, ok ? 1200 : 3500);
    },
    [clearProgressHideTimer],
  );

  const loadMediaBatch = useCallback(async (params: { reset: boolean; startPage: number }) => {
    const { reset, startPage } = params;
    if (reset) {
      setLoadingInitial(true);
      setListError("");
    } else {
      setLoadingMore(true);
      setListError("");
    }

    try {
      let pageCursor = startPage;
      let maxPages = Number.POSITIVE_INFINITY;
      let scanned = 0;
      const collected: MediaCardItem[] = [];

      while (scanned < SCAN_PAGES_PER_BATCH && pageCursor <= maxPages) {
        const res = await apiGet<DocumentListResponse>(
          `/documents?page=${pageCursor}&size=${PAGE_SIZE}&sort_by=event_date&sort_order=desc`,
        );
        const computedMaxPages = res.total > 0 ? Math.ceil(res.total / Math.max(1, res.size || PAGE_SIZE)) : 0;
        maxPages = Number.isFinite(maxPages) ? Math.min(maxPages, computedMaxPages) : computedMaxPages;

        const mapped = (res.items || []).map(toMediaCardItem).filter((value): value is MediaCardItem => value !== null);
        collected.push(...mapped);
        pageCursor += 1;
        scanned += 1;

        if (computedMaxPages === 0) break;
        if (collected.length >= PAGE_SIZE) break;
      }

      const nextItems = uniqueById(collected).slice(0, PAGE_SIZE);
      if (reset) {
        setItems(nextItems);
      } else {
        setItems((prev) => uniqueById([...prev, ...nextItems]));
      }

      setNextRawPage(pageCursor);
      setHasMoreRaw(pageCursor <= maxPages && maxPages > 0);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "미디어 목록 조회 실패");
    } finally {
      if (reset) setLoadingInitial(false);
      else setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const me = await getCurrentUser();
      if (!cancelled) {
        setUserRole(me?.role ?? null);
      }
      if (!cancelled) {
        await loadMediaBatch({ reset: true, startPage: 1 });
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadMediaBatch]);

  useEffect(() => {
    const detailMedia = detail?.files.map(toMediaPreviewFromDetail).filter((value): value is MediaPreviewFile => value !== null) || [];
    setActiveMediaId(detailMedia[0]?.id ?? null);
  }, [detail]);

  useEffect(() => {
    if (!detail) {
      setDetailEditMode(false);
      setDetailEditTitle("");
      setDetailEditEventDate("");
      setDetailEditDescription("");
      return;
    }
    setDetailEditTitle(detail.title || "");
    setDetailEditEventDate(detail.event_date || "");
    setDetailEditDescription(detail.description || "");
    setDetailEditMode(false);
  }, [detail]);

  const detailMediaFiles = useMemo(
    () => detail?.files.map(toMediaPreviewFromDetail).filter((value): value is MediaPreviewFile => value !== null) || [],
    [detail],
  );

  const activeMedia = useMemo(() => {
    if (detailMediaFiles.length === 0) return null;
    if (!activeMediaId) return detailMediaFiles[0];
    return detailMediaFiles.find((file) => file.id === activeMediaId) || detailMediaFiles[0];
  }, [activeMediaId, detailMediaFiles]);

  const appendFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const mediaOnly = incoming.filter((file) => {
      if (file.type.startsWith("image/") || file.type.startsWith("video/")) return true;
      return detectMediaKind(file.name) !== null;
    });
    if (mediaOnly.length === 0) return;

    setSelectedFiles((prev) => {
      const seen = new Set(prev.map(fileFingerprint));
      const merged = [...prev];
      for (const file of mediaOnly) {
        const key = fileFingerprint(file);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(file);
      }
      return merged;
    });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const dropped = Array.from(event.dataTransfer.files || []);
    appendFiles(dropped);
  };

  const removeFile = (target: File) => {
    const key = fileFingerprint(target);
    setSelectedFiles((prev) => prev.filter((file) => fileFingerprint(file) !== key));
  };

  const resetUploadForm = () => {
    setTitle("");
    setEventDate("");
    setDescription("");
    setSelectedFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canUpload) {
      setUploadError("이 계정은 미디어 업로드 권한이 없습니다.");
      return;
    }
    if (!title.trim()) {
      setUploadError("제목은 필수입니다.");
      return;
    }
    if (!eventDate) {
      setUploadError("날짜는 필수입니다.");
      return;
    }
    if (selectedFiles.length === 0) {
      setUploadError("이미지/영상 파일을 1개 이상 선택하세요.");
      return;
    }

    setSubmitting(true);
    setUploadError("");
    setNotice("");
    beginUploadProgress("미디어 업로드", "게시글 생성 중...");

    try {
      const created = await apiPost<ManualPostResponse>("/documents/manual-post", {
        title: title.trim(),
        description: description.trim(),
        event_date: eventDate,
        summary: description.trim() ? description.trim().slice(0, 400) : null,
        review_status: "NONE",
      });
      updateUploadProgress({
        percent: 15,
        phase: "첨부 업로드 준비 중...",
      });

      try {
        const form = new FormData();
        for (const file of selectedFiles) {
          form.append("files", file);
        }
        form.append("change_reason", "media_gallery_upload");
        await apiPostFormWithProgress<DocumentDetailLiteResponse>(`/documents/${created.id}/files`, form, (p) => {
          const mappedPercent = p.total > 0 ? Math.max(15, Math.min(92, 15 + Math.round(p.percent * 0.77))) : 30;
          updateUploadProgress({
            percent: mappedPercent,
            phase: p.total > 0 ? `첨부 업로드 중... ${p.percent}%` : "첨부 업로드 중...",
            loadedBytes: p.loaded,
            totalBytes: p.total,
          });
        });
      } catch (attachErr) {
        try {
          await apiDelete(`/documents/${created.id}`);
        } catch {
          // ignore rollback error
        }
        throw new Error(
          attachErr instanceof Error ? `게시글은 생성됐지만 첨부 업로드 실패: ${attachErr.message}` : "첨부 업로드 실패",
        );
      }

      updateUploadProgress({
        percent: 96,
        phase: "목록 갱신 중...",
      });
      setNotice(`미디어 게시 완료: ${selectedFiles.length}개 파일`);
      resetUploadForm();
      await loadMediaBatch({ reset: true, startPage: 1 });
      finishUploadProgress(true, "업로드 완료");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "미디어 게시 실패");
      finishUploadProgress(false, "업로드 실패");
    } finally {
      setSubmitting(false);
    }
  };

  const openDetail = async (documentId: string) => {
    setModalOpen(true);
    setDetail(null);
    setDetailError("");
    setDetailActionError("");
    setDetailNotice("");
    setDetailEditMode(false);
    setDetailLoading(true);

    try {
      const res = await apiGet<DocumentDetailResponse>(`/documents/${documentId}`);
      setDetail(res);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "상세 조회 실패");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const refresh = async () => {
    await loadMediaBatch({ reset: true, startPage: 1 });
  };

  const loadMore = async () => {
    if (loadingMore || !hasMoreRaw) return;
    await loadMediaBatch({ reset: false, startPage: nextRawPage });
  };

  const saveDetail = async () => {
    if (!detail) return;
    if (!canUpload) {
      setDetailActionError("이 계정은 게시물 수정 권한이 없습니다.");
      return;
    }
    if (!detailEditTitle.trim()) {
      setDetailActionError("제목은 필수입니다.");
      return;
    }
    if (!detailEditEventDate) {
      setDetailActionError("날짜는 필수입니다.");
      return;
    }

    setDetailActionBusy(true);
    setDetailActionError("");
    setDetailNotice("");
    try {
      const description = detailEditDescription.trim();
      const updated = await apiPatch<DocumentDetailResponse>(`/documents/${detail.id}`, {
        title: detailEditTitle.trim(),
        event_date: detailEditEventDate,
        description,
        summary: description ? description.slice(0, 400) : null,
      });
      setDetail(updated);
      setDetailEditMode(false);
      setDetailNotice("게시물이 수정되었습니다.");
      await loadMediaBatch({ reset: true, startPage: 1 });
    } catch (err) {
      setDetailActionError(err instanceof Error ? err.message : "게시물 수정 실패");
    } finally {
      setDetailActionBusy(false);
    }
  };

  const deleteDetail = async () => {
    if (!detail) return;
    if (!canUpload) {
      setDetailActionError("이 계정은 게시물 삭제 권한이 없습니다.");
      return;
    }
    const confirmed = window.confirm(`게시물을 삭제하시겠습니까?\n${detail.title}`);
    if (!confirmed) return;

    setDetailActionBusy(true);
    setDetailActionError("");
    setDetailNotice("");
    try {
      await apiDelete<{ status: string; document_id: string }>(`/documents/${detail.id}`);
      setModalOpen(false);
      setDetail(null);
      setDetailEditMode(false);
      setNotice("게시물이 삭제되었습니다.");
      await loadMediaBatch({ reset: true, startPage: 1 });
    } catch (err) {
      setDetailActionError(err instanceof Error ? err.message : "게시물 삭제 실패");
    } finally {
      setDetailActionBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
            <ImagePlus className="h-4 w-4 text-accent" />
            미디어 업로드
          </h2>
          <p className="text-[11px] text-stone-500">제목/날짜 필수 · 설명 선택 · 다중 업로드 지원</p>
        </div>

        {canUpload ? (
          <form className="space-y-2" onSubmit={submit}>
            <div
              className={`rounded-lg border border-dashed p-2.5 transition ${
                dragActive ? "border-accent bg-emerald-50" : "border-stone-300 bg-stone-50"
              }`}
              onDragEnter={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragActive(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragActive(false);
              }}
              onDrop={onDrop}
            >
              <div className="grid items-stretch gap-2.5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
                <div className="min-w-0 rounded border border-stone-200 bg-white p-2">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <p className="inline-flex items-center gap-1 text-xs font-medium text-stone-700">
                      <UploadCloud className="h-3.5 w-3.5 text-accent" />
                      파일 목록
                    </p>
                    <button
                      type="button"
                      className="rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      파일 선택
                    </button>
                  </div>
                  <p className="mb-2 text-[11px] text-stone-500">이미지/영상 파일을 드래그해서 추가할 수 있습니다.</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    multiple
                    accept="image/*,video/*"
                    onChange={(event) => appendFiles(Array.from(event.target.files || []))}
                  />

                  {selectedFiles.length > 0 ? (
                    <ul className="max-h-44 space-y-1 overflow-y-auto pr-0.5">
                      {selectedFiles.map((file) => {
                        const key = fileFingerprint(file);
                        const kind = file.type.startsWith("video/") ? "video" : "image";
                        return (
                          <li key={key} className="flex items-center justify-between rounded border border-stone-200 bg-white px-2 py-1 text-xs">
                            <span className="inline-flex min-w-0 items-center gap-1">
                              {kind === "video" ? (
                                <Film className="h-3.5 w-3.5 text-indigo-600" />
                              ) : (
                                <FileImage className="h-3.5 w-3.5 text-emerald-600" />
                              )}
                              <span className="truncate" title={file.name}>
                                {file.name}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="ml-2 rounded border border-stone-300 px-1 py-0.5 text-[11px] hover:bg-stone-100"
                              onClick={() => removeFile(file)}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="rounded border border-stone-200 bg-stone-50 px-2 py-6 text-center text-xs text-stone-500">
                      선택된 파일이 없습니다.
                    </p>
                  )}
                </div>

                <div className="flex h-full min-w-0 flex-col rounded border border-stone-200 bg-white p-2">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_190px]">
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="inline-flex h-4 items-center font-medium text-stone-700">제목 *</span>
                      <input
                        className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="예: 현장 점검 사진 모음"
                        required
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="inline-flex h-4 items-center gap-1 font-medium text-stone-700">
                        <CalendarDays className="h-3.5 w-3.5" />
                        날짜 *
                      </span>
                      <input
                        type="date"
                        className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                        value={eventDate}
                        onChange={(event) => setEventDate(event.target.value)}
                        required
                      />
                    </label>
                  </div>
                  <label className="mt-2 flex min-h-0 flex-1 flex-col gap-1 text-xs">
                    <span className="font-medium text-stone-700">설명 (선택)</span>
                    <textarea
                      className="h-full min-h-24 w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="설명은 선택입니다."
                    />
                  </label>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                disabled={submitting}
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                게시
              </button>
              <button
                type="button"
                className="rounded border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-100"
                onClick={resetUploadForm}
                disabled={submitting}
              >
                초기화
              </button>
            </div>

            {uploadProgress ? (
              <div className="rounded border border-stone-200 bg-white px-2 py-1.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="truncate text-[11px] font-semibold text-stone-700">{uploadProgress.label}</p>
                  <p className={`text-[11px] ${uploadProgress.failed ? "text-red-700" : "text-stone-600"}`}>
                    {uploadProgress.percent}%
                  </p>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-stone-200">
                  <div
                    className={`h-full rounded-full transition-[width] duration-150 ${
                      uploadProgress.failed ? "bg-red-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${uploadProgress.percent}%` }}
                  />
                </div>
                <p className={`mt-1 text-[11px] ${uploadProgress.failed ? "text-red-700" : "text-stone-600"}`}>
                  {uploadProgress.phase}
                  {uploadProgress.totalBytes > 0
                    ? ` (${formatBytes(uploadProgress.loadedBytes)} / ${formatBytes(uploadProgress.totalBytes)})`
                    : ""}
                </p>
              </div>
            ) : null}
          </form>
        ) : (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            현재 계정은 조회 전용입니다. 업로드는 `EDITOR` 또는 `ADMIN` 권한에서 가능합니다.
          </p>
        )}

        {notice ? <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p> : null}
        {uploadError ? <p className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{uploadError}</p> : null}
      </article>

      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
            <Film className="h-4 w-4 text-accent" />
            미디어 갤러리
          </h2>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100 disabled:opacity-60"
            onClick={refresh}
            disabled={loadingInitial || loadingMore}
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${loadingInitial || loadingMore ? "animate-spin" : ""}`} />
            새로고침
          </button>
        </div>

        {listError ? <p className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{listError}</p> : null}

        {loadingInitial ? (
          <p className="text-sm text-stone-500">미디어 목록을 불러오는 중...</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-stone-500">표시할 이미지/영상 게시물이 없습니다.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition hover:border-accent hover:shadow-md"
                onClick={() => void openDetail(item.id)}
              >
                <div className="relative aspect-video bg-stone-900">
                  <MediaThumb file={item.cover} className="h-full w-full object-cover" />
                  <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
                    {item.cover.kind === "video" ? <Film className="h-3 w-3" /> : <FileImage className="h-3 w-3" />}
                    {item.cover.kind === "video" ? "영상" : "이미지"}
                  </span>
                </div>
                <div className="space-y-1 p-2">
                  <p className="line-clamp-1 text-sm font-semibold text-stone-900">{item.title}</p>
                  {item.description?.trim() ? (
                    <RichContentView
                      html={item.description}
                      className="max-h-10 overflow-hidden text-xs leading-5 text-stone-600 [&_p]:m-0 [&_h1]:m-0 [&_h2]:m-0 [&_h3]:m-0 [&_ul]:my-0 [&_ol]:my-0 [&_li]:my-0 [&_blockquote]:my-0 [&_pre]:my-0 [&_table]:my-0 [&_img]:my-0"
                    />
                  ) : (
                    <p className="line-clamp-2 text-xs text-stone-600">설명 없음</p>
                  )}
                  <p className="text-[11px] text-stone-500">
                    날짜: {item.event_date || "-"} · 파일 {item.file_count}개
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {hasMoreRaw && !loadingInitial ? (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-100 disabled:opacity-60"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              {loadingMore ? "불러오는 중..." : "더 보기"}
            </button>
          </div>
        ) : null}
      </article>

      <ModalShell
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setDetail(null);
          setDetailError("");
          setDetailActionError("");
          setDetailNotice("");
          setDetailEditMode(false);
        }}
        title={detail?.title || "미디어 상세"}
        maxWidthClassName="max-w-6xl"
      >
        {detailLoading ? <p className="text-sm text-stone-500">상세 정보를 불러오는 중...</p> : null}
        {detailError ? <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{detailError}</p> : null}
        {detailActionError ? <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{detailActionError}</p> : null}
        {detailNotice ? <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{detailNotice}</p> : null}
        {!detailLoading && !detailError && detail ? (
          <div className="space-y-3">
            {canUpload ? (
              <div className="flex flex-wrap items-center gap-2">
                {detailEditMode ? (
                  <>
                    <button
                      type="button"
                      className="rounded border border-emerald-700 bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
                      onClick={() => void saveDetail()}
                      disabled={detailActionBusy}
                    >
                      {detailActionBusy ? "저장 중..." : "저장"}
                    </button>
                    <button
                      type="button"
                      className="rounded border border-stone-300 bg-white px-3 py-1 text-xs hover:bg-stone-50 disabled:opacity-60"
                      onClick={() => {
                        setDetailEditTitle(detail.title || "");
                        setDetailEditEventDate(detail.event_date || "");
                        setDetailEditDescription(detail.description || "");
                        setDetailEditMode(false);
                        setDetailActionError("");
                      }}
                      disabled={detailActionBusy}
                    >
                      취소
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="rounded border border-stone-300 bg-white px-3 py-1 text-xs hover:bg-stone-50 disabled:opacity-60"
                    onClick={() => {
                      setDetailEditTitle(detail.title || "");
                      setDetailEditEventDate(detail.event_date || "");
                      setDetailEditDescription(detail.description || "");
                      setDetailEditMode(true);
                      setDetailActionError("");
                      setDetailNotice("");
                    }}
                    disabled={detailActionBusy}
                  >
                    수정
                  </button>
                )}
                <button
                  type="button"
                  className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs text-red-700 hover:bg-red-100 disabled:opacity-60"
                  onClick={() => void deleteDetail()}
                  disabled={detailActionBusy}
                >
                  {detailActionBusy ? "처리 중..." : "삭제"}
                </button>
              </div>
            ) : null}

            <div className="rounded border border-stone-200 bg-white p-3 text-xs text-stone-700">
              {detailEditMode ? (
                <div className="space-y-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-semibold text-stone-700">제목 *</span>
                    <input
                      type="text"
                      className="rounded border border-stone-300 px-2 py-1.5 text-sm"
                      value={detailEditTitle}
                      onChange={(event) => setDetailEditTitle(event.target.value)}
                      disabled={detailActionBusy}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-semibold text-stone-700">날짜 *</span>
                    <input
                      type="date"
                      className="rounded border border-stone-300 px-2 py-1.5 text-sm"
                      value={detailEditEventDate}
                      onChange={(event) => setDetailEditEventDate(event.target.value)}
                      disabled={detailActionBusy}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] font-semibold text-stone-700">설명</span>
                    <textarea
                      className="min-h-24 rounded border border-stone-300 px-2 py-1.5 text-sm"
                      value={detailEditDescription}
                      onChange={(event) => setDetailEditDescription(event.target.value)}
                      disabled={detailActionBusy}
                    />
                  </label>
                  <p className="text-[11px] text-stone-500">저장 시 제목/날짜/설명만 변경됩니다.</p>
                </div>
              ) : (
                <>
                  <p className="text-sm font-semibold text-stone-900">{detail.title}</p>
                  <p className="mt-1">날짜: {detail.event_date || "-"}</p>
                  <p>업로드: {formatDateTime(detail.ingested_at)}</p>
                  <div className="mt-2">
                    {detail.description?.trim() ? (
                      <RichContentView
                        html={detail.description}
                        className="text-xs leading-5 text-stone-700 [&_p]:m-0 [&_h1]:m-0 [&_h2]:m-0 [&_h3]:m-0"
                      />
                    ) : (
                      <p>설명 없음</p>
                    )}
                  </div>
                </>
              )}
            </div>

            {activeMedia ? (
              <div className="rounded border border-stone-200 bg-black p-2">
                <MediaThumb
                  file={activeMedia}
                  controls
                  className="max-h-[62vh] w-full rounded bg-black object-contain"
                />
              </div>
            ) : (
              <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                이 게시물에 표시 가능한 이미지/영상이 없습니다.
              </p>
            )}

            {detailMediaFiles.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {detailMediaFiles.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    className={`overflow-hidden rounded border text-left ${
                      activeMediaId === file.id ? "border-accent ring-1 ring-accent" : "border-stone-200"
                    }`}
                    onClick={() => setActiveMediaId(file.id)}
                  >
                    <div className="aspect-video bg-stone-900">
                      <MediaThumb file={file} className="h-full w-full object-cover" />
                    </div>
                    <div className="truncate bg-white px-2 py-1 text-[11px] text-stone-700" title={file.original_filename}>
                      {file.original_filename}
                    </div>
                  </button>
                ))}
              </div>
            ) : null}

            {detail.files.length > 0 ? (
              <div className="rounded border border-stone-200 bg-white p-2">
                <p className="mb-1 text-xs font-semibold text-stone-800">첨부파일 목록</p>
                <ul className="space-y-1 text-xs text-stone-700">
                  {detail.files.map((file) => (
                    <li key={file.id} className="flex items-center justify-between gap-2 rounded border border-stone-100 px-2 py-1">
                      <span className="truncate" title={file.original_filename}>
                        {file.original_filename}
                      </span>
                      <span className="shrink-0 text-[11px] text-stone-500">{formatBytes(file.size_bytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </ModalShell>
    </section>
  );
}
