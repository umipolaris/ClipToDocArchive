"use client";

import { useEffect, useMemo, useState } from "react";
import { ImagePlus, RefreshCcw, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPostForm, buildApiUrl } from "@/lib/api-client";

type BrandingLogoResponse = {
  exists: boolean;
  logo_file_id: string | null;
  image_url: string | null;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  updated_at: string | null;
};

type BrandingLogoDeleteResponse = {
  status: string;
  removed: boolean;
  previous_file_id: string | null;
};

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function AdminBrandingManager() {
  const [logo, setLogo] = useState<BrandingLogoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const previewUrl = useMemo(() => {
    if (!logo?.exists || !logo.image_url) return "";
    return buildApiUrl(logo.image_url);
  }, [logo]);

  const loadLogo = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiGet<BrandingLogoResponse>("/branding/logo");
      setLogo(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "로고 정보 조회 실패");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLogo();
  }, []);

  const submitUpload = async () => {
    if (!selectedFile) {
      setError("업로드할 로고 이미지를 선택하세요.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.set("file", selectedFile);
      const res = await apiPostForm<BrandingLogoResponse>("/admin/branding/logo", form);
      setLogo(res);
      setSelectedFile(null);
      setNotice("로고가 저장되었습니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "로고 저장 실패");
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!logo?.exists) return;
    if (!window.confirm("현재 로고를 삭제하시겠습니까?")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apiDelete<BrandingLogoDeleteResponse>("/admin/branding/logo");
      setLogo({
        exists: false,
        logo_file_id: null,
        image_url: null,
        filename: null,
        mime_type: null,
        size_bytes: null,
        updated_at: null,
      });
      setNotice("로고가 삭제되었습니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "로고 삭제 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-stone-900">홈페이지 로고</h3>
          <p className="text-xs text-stone-500">메뉴 패널 상단에 노출되는 로고를 설정합니다.</p>
        </div>
        <button
          type="button"
          onClick={() => void loadLogo()}
          className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
          disabled={loading || busy}
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          새로고침
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
        <div className="rounded border border-stone-200 bg-stone-50 p-3">
          {loading ? <p className="text-xs text-stone-500">로고 로딩 중...</p> : null}
          {!loading && logo?.exists && previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt={logo.filename || "홈페이지 로고"} className="h-28 w-full rounded bg-white object-contain p-1" />
          ) : null}
          {!loading && !logo?.exists ? (
            <div className="flex h-28 items-center justify-center rounded bg-white text-xs text-stone-500">등록된 로고 없음</div>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="grid gap-2 text-xs text-stone-700 sm:grid-cols-2">
            <p>파일명: {logo?.filename || "-"}</p>
            <p>크기: {formatBytes(logo?.size_bytes ?? null)}</p>
            <p>MIME: {logo?.mime_type || "-"}</p>
            <p>수정시각: {logo?.updated_at ? new Date(logo.updated_at).toLocaleString() : "-"}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
              onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
              className="max-w-full rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 file:mr-2 file:rounded file:border-0 file:bg-stone-100 file:px-2 file:py-1 file:text-xs file:font-medium"
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => void submitUpload()}
              className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busy || !selectedFile}
            >
              <ImagePlus className="h-3.5 w-3.5" />
              {logo?.exists ? "로고 교체" : "로고 업로드"}
            </button>
            <button
              type="button"
              onClick={() => void submitDelete()}
              className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busy || !logo?.exists}
            >
              <Trash2 className="h-3.5 w-3.5" />
              로고 삭제
            </button>
          </div>

          {selectedFile ? <p className="text-xs text-stone-600">선택 파일: {selectedFile.name}</p> : null}
          {error ? <p className="text-xs text-red-700">{error}</p> : null}
          {notice ? <p className="text-xs text-emerald-700">{notice}</p> : null}
        </div>
      </div>
    </section>
  );
}
