"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore, Download, HardDrive, RefreshCcw, ShieldAlert, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPostFormWithProgress, buildApiUrl } from "@/lib/api-client";

type BackupKind = "db" | "objects" | "config";
type ConfigRestoreMode = "preview" | "apply";

type BackupFileItem = {
  kind: BackupKind;
  filename: string;
  size_bytes: number;
  created_at: string;
  sha256: string | null;
  download_url: string;
};

type BackupFilesResponse = {
  kind: BackupKind;
  items: BackupFileItem[];
};

type BackupRunResponse = {
  kind: BackupKind;
  filename: string;
  size_bytes: number;
  created_at: string;
  sha256: string | null;
};

type BackupRunAllResponse = {
  items: BackupRunResponse[];
};

type BackupDeleteResponse = {
  status: string;
  kind: BackupKind;
  filename: string;
  meta_deleted: boolean;
};

type BackupDeleteAllResponse = {
  status: string;
  deleted_total: number;
  deleted_meta_total: number;
  deleted_by_kind: Record<string, number>;
  meta_deleted_by_kind: Record<string, number>;
  errors: string[];
};

type BackupRestoreDbResponse = {
  status: string;
  filename: string;
  target_db: string;
  promoted?: boolean;
  promoted_from?: string | null;
};

type BackupRestoreObjectsResponse = {
  status: string;
  filename: string;
  restored_count: number;
  replace_existing: boolean;
};

type BackupRestoreConfigResponse = {
  status: string;
  filename: string;
  mode: ConfigRestoreMode;
  total_files: number;
  files: string[];
};

type BackupScheduleSettingsResponse = {
  scope: string;
  enabled: boolean;
  interval_days: number;
  run_time: string;
  schedule_timezone?: string;
  target_dir: string;
  backup_export_root: string;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_output_dir: string | null;
  updated_at: string | null;
};

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

const KIND_LABEL: Record<BackupKind, string> = {
  db: "DB",
  objects: "첨부파일",
  config: "설정",
};

type OperationProgress = {
  label: string;
  phase: string;
  percent: number;
  failed: boolean;
};

export function AdminBackupManager() {
  const [filesByKind, setFilesByKind] = useState<Record<BackupKind, BackupFileItem[]>>({
    db: [],
    objects: [],
    config: [],
  });
  const [loadingByKind, setLoadingByKind] = useState<Record<BackupKind, boolean>>({
    db: false,
    objects: false,
    config: false,
  });
  const [running, setRunning] = useState<string>("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [dbFilename, setDbFilename] = useState("");
  const [dbTarget, setDbTarget] = useState("archive_restore");
  const [dbConfirm, setDbConfirm] = useState(false);
  const [dbPromoteToActive, setDbPromoteToActive] = useState(false);
  const [dbUploadFile, setDbUploadFile] = useState<File | null>(null);
  const [dbUploadInputKey, setDbUploadInputKey] = useState(0);

  const [objectsFilename, setObjectsFilename] = useState("");
  const [objectsReplaceExisting, setObjectsReplaceExisting] = useState(true);
  const [objectsConfirm, setObjectsConfirm] = useState(false);
  const [objectsUploadFile, setObjectsUploadFile] = useState<File | null>(null);
  const [objectsUploadInputKey, setObjectsUploadInputKey] = useState(0);

  const [configFilename, setConfigFilename] = useState("");
  const [configMode, setConfigMode] = useState<ConfigRestoreMode>("preview");
  const [configConfirm, setConfigConfirm] = useState(false);
  const [configUploadFile, setConfigUploadFile] = useState<File | null>(null);
  const [configUploadInputKey, setConfigUploadInputKey] = useState(0);
  const [configPreviewFiles, setConfigPreviewFiles] = useState<string[]>([]);
  const [configPreviewTotal, setConfigPreviewTotal] = useState(0);
  const [progress, setProgress] = useState<OperationProgress | null>(null);

  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleIntervalDays, setScheduleIntervalDays] = useState(1);
  const [scheduleRunTime, setScheduleRunTime] = useState("02:00");
  const [scheduleTargetDir, setScheduleTargetDir] = useState("scheduled");
  const [scheduleTimezone, setScheduleTimezone] = useState("UTC");
  const [scheduleExportRoot, setScheduleExportRoot] = useState("/backup-export");
  const [scheduleLastRunAt, setScheduleLastRunAt] = useState<string | null>(null);
  const [scheduleLastStatus, setScheduleLastStatus] = useState<string | null>(null);
  const [scheduleLastError, setScheduleLastError] = useState<string | null>(null);
  const [scheduleLastOutputDir, setScheduleLastOutputDir] = useState<string | null>(null);

  const progressTimerRef = useRef<number | null>(null);
  const progressHideTimerRef = useRef<number | null>(null);

  const clearProgressTimers = useCallback(() => {
    if (progressTimerRef.current != null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    if (progressHideTimerRef.current != null) {
      window.clearTimeout(progressHideTimerRef.current);
      progressHideTimerRef.current = null;
    }
  }, []);

  const beginProgress = useCallback(
    (label: string, phase: string) => {
      clearProgressTimers();
      setProgress({
        label,
        phase,
        percent: 8,
        failed: false,
      });
      progressTimerRef.current = window.setInterval(() => {
        setProgress((prev) => {
          if (!prev) return prev;
          if (prev.percent >= 92) return prev;
          return { ...prev, percent: prev.percent + 2 };
        });
      }, 500);
    },
    [clearProgressTimers],
  );

  const setProgressPhase = useCallback((phase: string) => {
    setProgress((prev) => (prev ? { ...prev, phase } : prev));
  }, []);

  const setProgressPercent = useCallback((percent: number, phase?: string) => {
    const clamped = Math.max(0, Math.min(99, Math.round(percent)));
    setProgress((prev) => {
      if (!prev) return prev;
      if (phase) {
        return { ...prev, phase, percent: clamped };
      }
      return { ...prev, percent: clamped };
    });
  }, []);

  const finishProgress = useCallback(
    (ok: boolean, phase: string) => {
      clearProgressTimers();
      setProgress((prev) =>
        prev
          ? {
              ...prev,
              phase,
              percent: 100,
              failed: !ok,
            }
          : null,
      );
      progressHideTimerRef.current = window.setTimeout(() => {
        setProgress(null);
        progressHideTimerRef.current = null;
      }, ok ? 1200 : 3000);
    },
    [clearProgressTimers],
  );

  useEffect(() => () => clearProgressTimers(), [clearProgressTimers]);

  const loadKind = useCallback(async (kind: BackupKind) => {
    setLoadingByKind((prev) => ({ ...prev, [kind]: true }));
    try {
      const res = await apiGet<BackupFilesResponse>(`/admin/backups/files?kind=${kind}`);
      setFilesByKind((prev) => ({ ...prev, [kind]: res.items || [] }));
    } finally {
      setLoadingByKind((prev) => ({ ...prev, [kind]: false }));
    }
  }, []);

  const loadSchedule = useCallback(async () => {
    setScheduleLoading(true);
    try {
      const res = await apiGet<BackupScheduleSettingsResponse>("/admin/backups/schedule");
      setScheduleEnabled(Boolean(res.enabled));
      setScheduleIntervalDays(Number.isFinite(res.interval_days) ? Math.max(1, Math.min(60, Math.round(res.interval_days))) : 1);
      setScheduleRunTime(typeof res.run_time === "string" && res.run_time ? res.run_time : "02:00");
      setScheduleTimezone(typeof res.schedule_timezone === "string" && res.schedule_timezone ? res.schedule_timezone : "UTC");
      setScheduleTargetDir((res.target_dir || "scheduled").trim() || "scheduled");
      setScheduleExportRoot(res.backup_export_root || "/backup-export");
      setScheduleLastRunAt(res.last_run_at ?? null);
      setScheduleLastStatus(res.last_status ?? null);
      setScheduleLastError(res.last_error ?? null);
      setScheduleLastOutputDir(res.last_output_dir ?? null);
    } finally {
      setScheduleLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadKind("db"), loadKind("objects"), loadKind("config"), loadSchedule()]);
  }, [loadKind, loadSchedule]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!dbFilename) setDbFilename(filesByKind.db[0]?.filename ?? "");
  }, [dbFilename, filesByKind.db]);

  useEffect(() => {
    if (!objectsFilename) setObjectsFilename(filesByKind.objects[0]?.filename ?? "");
  }, [filesByKind.objects, objectsFilename]);

  useEffect(() => {
    if (!configFilename) setConfigFilename(filesByKind.config[0]?.filename ?? "");
  }, [configFilename, filesByKind.config]);

  const runBackup = async (kind: BackupKind) => {
    setRunning(kind);
    setError("");
    setMessage("");
    beginProgress(`${KIND_LABEL[kind]} 백업`, "백업 생성 중...");
    try {
      const res = await apiPost<BackupRunResponse>(`/admin/backups/run/${kind}`, {});
      setMessage(`${KIND_LABEL[kind]} 백업 완료: ${res.filename}`);
      await loadKind(kind);
      finishProgress(true, "완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : `${KIND_LABEL[kind]} 백업 실패`);
      finishProgress(false, "실패");
    } finally {
      setRunning("");
    }
  };

  const runBackupAll = async () => {
    setRunning("all");
    setError("");
    setMessage("");
    beginProgress("전체 백업", "백업 생성 중...");
    try {
      const res = await apiPost<BackupRunAllResponse>("/admin/backups/run-all", {});
      setMessage(`전체 백업 완료: ${res.items.map((x) => `${KIND_LABEL[x.kind]}(${x.filename})`).join(", ")}`);
      await refreshAll();
      finishProgress(true, "완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : "전체 백업 실패");
      finishProgress(false, "실패");
    } finally {
      setRunning("");
    }
  };

  const saveSchedule = async () => {
    const normalizedInterval = Math.max(1, Math.min(60, Math.round(Number(scheduleIntervalDays) || 1)));
    const normalizedRunTime = (scheduleRunTime || "").trim() || "02:00";
    const normalizedTargetDir = (scheduleTargetDir || "").trim() || "scheduled";

    setScheduleSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await apiPost<BackupScheduleSettingsResponse>("/admin/backups/schedule", {
        enabled: scheduleEnabled,
        interval_days: normalizedInterval,
        run_time: normalizedRunTime,
        target_dir: normalizedTargetDir,
      });
      setScheduleEnabled(Boolean(res.enabled));
      setScheduleIntervalDays(Number.isFinite(res.interval_days) ? Math.max(1, Math.min(60, Math.round(res.interval_days))) : 1);
      setScheduleRunTime(typeof res.run_time === "string" && res.run_time ? res.run_time : "02:00");
      setScheduleTimezone(typeof res.schedule_timezone === "string" && res.schedule_timezone ? res.schedule_timezone : "UTC");
      setScheduleTargetDir((res.target_dir || "scheduled").trim() || "scheduled");
      setScheduleExportRoot(res.backup_export_root || "/backup-export");
      setScheduleLastRunAt(res.last_run_at ?? null);
      setScheduleLastStatus(res.last_status ?? null);
      setScheduleLastError(res.last_error ?? null);
      setScheduleLastOutputDir(res.last_output_dir ?? null);
      setMessage(`자동 전체 백업 스케줄 저장 완료 (${res.enabled ? "ON" : "OFF"})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "자동 백업 스케줄 저장 실패");
    } finally {
      setScheduleSaving(false);
    }
  };

  const runScheduleNow = async () => {
    setRunning("schedule-now");
    setError("");
    setMessage("");
    beginProgress("자동 스케줄 백업", "전체 백업 실행 중...");
    try {
      const res = await apiPost<BackupRunAllResponse>("/admin/backups/schedule/run-now", {});
      const summary = (res.items || []).map((x) => `${KIND_LABEL[x.kind]}(${x.filename})`).join(", ");
      setMessage(summary ? `스케줄 백업 1회 실행 완료: ${summary}` : "스케줄 백업 1회 실행 완료");
      await refreshAll();
      finishProgress(true, "완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : "스케줄 백업 1회 실행 실패");
      finishProgress(false, "실패");
    } finally {
      setRunning("");
    }
  };

  const deleteBackupFile = async (kind: BackupKind, filename: string) => {
    const confirmed = window.confirm(`백업 파일을 삭제할까요?\n${filename}`);
    if (!confirmed) return;

    setRunning(`delete-${kind}`);
    setError("");
    setMessage("");
    try {
      const res = await apiDelete<BackupDeleteResponse>(`/admin/backups/files/${kind}/${encodeURIComponent(filename)}`);
      setMessage(`백업 삭제 완료: ${res.filename}`);
      await loadKind(kind);
      if (kind === "db" && dbFilename === filename) {
        setDbFilename("");
      }
      if (kind === "objects" && objectsFilename === filename) {
        setObjectsFilename("");
      }
      if (kind === "config" && configFilename === filename) {
        setConfigFilename("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "백업 파일 삭제 실패");
    } finally {
      setRunning("");
    }
  };

  const deleteAllBackupFiles = async () => {
    const confirmed = window.confirm("모든 백업 파일(DB/첨부/설정)을 전체 삭제할까요?\n이 작업은 되돌릴 수 없습니다.");
    if (!confirmed) return;

    setRunning("delete-all");
    setError("");
    setMessage("");
    try {
      const res = await apiDelete<BackupDeleteAllResponse>("/admin/backups/files?confirm=true");
      const byKind = ["db", "objects", "config"]
        .map((kind) => `${KIND_LABEL[kind as BackupKind]} ${res.deleted_by_kind?.[kind] ?? 0}건`)
        .join(", ");
      const errSuffix = res.errors && res.errors.length > 0 ? ` (일부 오류 ${res.errors.length}건)` : "";
      setMessage(`전체 삭제 완료: 총 ${res.deleted_total}건 (${byKind})${errSuffix}`);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "전체 삭제 실패");
    } finally {
      setRunning("");
    }
  };

  const restoreDb = async () => {
    setRunning("restore-db");
    setError("");
    setMessage("");
    beginProgress("DB 복구", "복구 적용 중...");
    try {
      const res = await apiPost<BackupRestoreDbResponse>("/admin/backups/restore/db", {
        filename: dbFilename,
        target_db: dbTarget.trim(),
        confirm: dbConfirm,
        promote_to_active: dbPromoteToActive,
      });
      if (res.promoted) {
        setMessage(`DB 복구+운영전환 완료: ${res.filename} -> ${res.promoted_from} -> ${res.target_db}`);
      } else {
        setMessage(`DB 복구 완료: ${res.filename} -> ${res.target_db}`);
      }
      finishProgress(true, "완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : "DB 복구 실패");
      finishProgress(false, "실패");
    } finally {
      setRunning("");
    }
  };

  const uploadAndRestoreDb = async () => {
    if (!dbUploadFile) {
      setError("업로드할 DB 백업 파일(.dump)을 선택하세요.");
      return;
    }
    setRunning("upload-restore-db");
    setError("");
    setMessage("");
    beginProgress("DB 업로드 복구", "파일 업로드 중...");
    let switchedToServerPhase = false;
    try {
      const form = new FormData();
      form.append("file", dbUploadFile);
      form.append("target_db", dbTarget.trim());
      form.append("confirm", String(dbConfirm));
      form.append("promote_to_active", String(dbPromoteToActive));
      const res = await apiPostFormWithProgress<BackupRestoreDbResponse>(
        "/admin/backups/upload-and-restore/db",
        form,
        (p) => {
          const scaled = Math.max(8, Math.min(70, Math.round((p.percent / 100) * 70)));
          setProgressPercent(scaled, `파일 업로드 중... ${p.percent}%`);
          if (p.percent >= 100 && !switchedToServerPhase) {
            switchedToServerPhase = true;
            setProgressPhase("서버 복구 적용 중...");
          }
        },
      );
      if (!switchedToServerPhase) {
        setProgressPhase("서버 복구 적용 중...");
      }
      setProgressPercent(90);
      if (res.promoted) {
        setMessage(`DB 업로드 복구+운영전환 완료: ${res.filename} -> ${res.promoted_from} -> ${res.target_db}`);
      } else {
        setMessage(`DB 업로드 복구 완료: ${res.filename} -> ${res.target_db}`);
      }
      setDbFilename(res.filename);
      setDbUploadFile(null);
      setDbUploadInputKey((prev) => prev + 1);
      await loadKind("db");
      finishProgress(true, "완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : "DB 업로드 복구 실패");
      finishProgress(false, "실패");
    } finally {
      setRunning("");
    }
  };

  const restoreObjects = async () => {
    setRunning("restore-objects");
    setError("");
    setMessage("");
    beginProgress("첨부파일 복구", "복구 적용 중...");
    try {
      const res = await apiPost<BackupRestoreObjectsResponse>("/admin/backups/restore/objects", {
        filename: objectsFilename,
        replace_existing: objectsReplaceExisting,
        confirm: objectsConfirm,
      });
      setMessage(`첨부 복구 완료: ${res.restored_count}개 복원됨`);
      finishProgress(true, "완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : "첨부 복구 실패");
      finishProgress(false, "실패");
    } finally {
      setRunning("");
    }
  };

  const uploadAndRestoreObjects = async () => {
    if (!objectsUploadFile) {
      setError("업로드할 첨부 백업 파일(.tar.gz)을 선택하세요.");
      return;
    }
    setRunning("upload-restore-objects");
    setError("");
    setMessage("");
    beginProgress("첨부파일 업로드 복구", "파일 업로드 중...");
    let switchedToServerPhase = false;
    try {
      const form = new FormData();
      form.append("file", objectsUploadFile);
      form.append("replace_existing", String(objectsReplaceExisting));
      form.append("confirm", String(objectsConfirm));
      const res = await apiPostFormWithProgress<BackupRestoreObjectsResponse>(
        "/admin/backups/upload-and-restore/objects",
        form,
        (p) => {
          const scaled = Math.max(8, Math.min(70, Math.round((p.percent / 100) * 70)));
          setProgressPercent(scaled, `파일 업로드 중... ${p.percent}%`);
          if (p.percent >= 100 && !switchedToServerPhase) {
            switchedToServerPhase = true;
            setProgressPhase("서버 복구 적용 중...");
          }
        },
      );
      if (!switchedToServerPhase) {
        setProgressPhase("서버 복구 적용 중...");
      }
      setProgressPercent(90);
      setMessage(`첨부 업로드 복구 완료: ${res.restored_count}개 복원됨`);
      setObjectsFilename(res.filename);
      setObjectsUploadFile(null);
      setObjectsUploadInputKey((prev) => prev + 1);
      await loadKind("objects");
      finishProgress(true, "완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : "첨부 업로드 복구 실패");
      finishProgress(false, "실패");
    } finally {
      setRunning("");
    }
  };

  const restoreConfig = async () => {
    setRunning("restore-config");
    setError("");
    setMessage("");
    setConfigPreviewFiles([]);
    setConfigPreviewTotal(0);
    beginProgress("설정 복구", configMode === "preview" ? "설정 미리보기 생성 중..." : "설정 적용 중...");
    try {
      const res = await apiPost<BackupRestoreConfigResponse>("/admin/backups/restore/config", {
        filename: configFilename,
        mode: configMode,
        confirm: configConfirm,
      });
      setMessage(
        configMode === "preview"
          ? `설정 미리보기 완료: ${res.total_files}개`
          : `설정 적용 완료: ${res.total_files}개`,
      );
      setConfigPreviewFiles(res.files ?? []);
      setConfigPreviewTotal(res.total_files ?? 0);
      finishProgress(true, "완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : "설정 복구 실패");
      finishProgress(false, "실패");
    } finally {
      setRunning("");
    }
  };

  const uploadAndRestoreConfig = async () => {
    if (!configUploadFile) {
      setError("업로드할 설정 백업 파일(.tar.gz)을 선택하세요.");
      return;
    }
    setRunning("upload-restore-config");
    setError("");
    setMessage("");
    setConfigPreviewFiles([]);
    setConfigPreviewTotal(0);
    beginProgress("설정 업로드 복구", "파일 업로드 중...");
    let switchedToServerPhase = false;
    try {
      const form = new FormData();
      form.append("file", configUploadFile);
      form.append("mode", configMode);
      form.append("confirm", String(configConfirm));
      const res = await apiPostFormWithProgress<BackupRestoreConfigResponse>(
        "/admin/backups/upload-and-restore/config",
        form,
        (p) => {
          const scaled = Math.max(8, Math.min(70, Math.round((p.percent / 100) * 70)));
          setProgressPercent(scaled, `파일 업로드 중... ${p.percent}%`);
          if (p.percent >= 100 && !switchedToServerPhase) {
            switchedToServerPhase = true;
            setProgressPhase("서버 복구 적용 중...");
          }
        },
      );
      if (!switchedToServerPhase) {
        setProgressPhase("서버 복구 적용 중...");
      }
      setProgressPercent(90);
      setMessage(
        configMode === "preview"
          ? `설정 업로드 미리보기 완료: ${res.total_files}개`
          : `설정 업로드 적용 완료: ${res.total_files}개`,
      );
      setConfigPreviewFiles(res.files ?? []);
      setConfigPreviewTotal(res.total_files ?? 0);
      setConfigFilename(res.filename);
      setConfigUploadFile(null);
      setConfigUploadInputKey((prev) => prev + 1);
      await loadKind("config");
      finishProgress(true, "완료");
    } catch (err) {
      setError(err instanceof Error ? err.message : "설정 업로드 복구 실패");
      finishProgress(false, "실패");
    } finally {
      setRunning("");
    }
  };

  const backupSections = useMemo(
    () =>
      (["db", "objects", "config"] as BackupKind[]).map((kind) => ({
        kind,
        label: KIND_LABEL[kind],
        items: filesByKind[kind],
        loading: loadingByKind[kind],
      })),
    [filesByKind, loadingByKind],
  );

  const resolvedScheduleTargetPath = useMemo(() => {
    const target = (scheduleTargetDir || "").trim() || "scheduled";
    const isAbsolute = /^([A-Za-z]:[\\/]|\/|\\\\)/.test(target);
    if (isAbsolute) return target;
    const root = (scheduleExportRoot || "/backup-export").replace(/[\\/]+$/, "");
    const rel = target.replace(/^[\\/]+/, "");
    return `${root}/${rel}`;
  }, [scheduleExportRoot, scheduleTargetDir]);

  return (
    <section className="space-y-4">
      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            className="inline-flex items-center gap-1 rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            onClick={() => void runBackup("db")}
            disabled={running !== ""}
            type="button"
          >
            <HardDrive className="h-3.5 w-3.5" />
            DB 백업 실행
          </button>
          <button
            className="inline-flex items-center gap-1 rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            onClick={() => void runBackup("objects")}
            disabled={running !== ""}
            type="button"
          >
            <HardDrive className="h-3.5 w-3.5" />
            첨부 백업 실행
          </button>
          <button
            className="inline-flex items-center gap-1 rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
            onClick={() => void runBackup("config")}
            disabled={running !== ""}
            type="button"
          >
            <HardDrive className="h-3.5 w-3.5" />
            설정 백업 실행
          </button>
          <button
            className="inline-flex items-center gap-1 rounded border border-stone-300 px-3 py-2 text-xs hover:bg-stone-50 disabled:opacity-60"
            onClick={() => void runBackupAll()}
            disabled={running !== ""}
            type="button"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            전체 백업
          </button>
          <button
            className="inline-flex items-center gap-1 rounded border border-stone-300 px-3 py-2 text-xs hover:bg-stone-50 disabled:opacity-60"
            onClick={() => void refreshAll()}
            disabled={running !== ""}
            type="button"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            목록 새로고침
          </button>
        </div>
        <p className="text-xs text-stone-500">대용량 백업은 시간이 오래 걸릴 수 있습니다.</p>
      </article>

      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <h3 className="mb-2 text-sm font-semibold">자동 전체 백업 스케줄</h3>
        <div className="grid gap-2 md:grid-cols-[auto_140px_140px_1fr_auto_auto] md:items-center">
          <label className="inline-flex items-center gap-1 text-xs text-stone-700">
            <input type="checkbox" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.target.checked)} />
            자동백업 ON/OFF
          </label>
          <label className="flex items-center gap-1 text-xs text-stone-700">
            <span>주기(일)</span>
            <input
              type="number"
              min={1}
              max={60}
              value={scheduleIntervalDays}
              onChange={(e) => setScheduleIntervalDays(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
              className="w-16 rounded border border-stone-300 px-2 py-1 text-xs"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-stone-700">
            <span>시간</span>
            <input
              type="time"
              value={scheduleRunTime}
              onChange={(e) => setScheduleRunTime(e.target.value || "02:00")}
              className="rounded border border-stone-300 px-2 py-1 text-xs"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-stone-700">
            <span>복사폴더</span>
            <input
              value={scheduleTargetDir}
              onChange={(e) => setScheduleTargetDir(e.target.value)}
              className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-xs"
              placeholder="scheduled"
            />
          </label>
          <button
            type="button"
            onClick={() => void saveSchedule()}
            className="inline-flex items-center justify-center rounded border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-50 disabled:opacity-60"
            disabled={running !== "" || scheduleSaving || scheduleLoading}
          >
            저장
          </button>
          <button
            type="button"
            onClick={() => void runScheduleNow()}
            className="inline-flex items-center justify-center rounded border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
            disabled={running !== "" || scheduleSaving || scheduleLoading}
          >
            지금 1회 실행
          </button>
        </div>
        <p className="mt-2 text-[11px] text-stone-600">
          복사폴더는 절대경로를 입력하면 해당 경로로 저장됩니다. 경로 생성/쓰기 권한이 없으면 저장 시 오류가 표시됩니다.
        </p>
        <div className="mt-2 grid gap-1 text-[11px] text-stone-600 md:grid-cols-2">
          <p>현재 상태: {scheduleEnabled ? "ON" : "OFF"}</p>
          <p>스케줄 시간대: {scheduleTimezone}</p>
          <p className="truncate" title={resolvedScheduleTargetPath}>실제 저장 경로: {resolvedScheduleTargetPath}</p>
          <p>마지막 실행: {scheduleLastRunAt ? formatDateTime(scheduleLastRunAt) : "-"}</p>
          <p>초기 기본값: OFF</p>
          <p>기본 루트(상대경로 기준): {scheduleExportRoot}</p>
          <p>마지막 상태: {scheduleLastStatus || "-"}</p>
          <p className="md:col-span-2 truncate" title={scheduleLastOutputDir || ""}>마지막 출력 폴더: {scheduleLastOutputDir || "-"}</p>
          {scheduleLastError ? <p className="md:col-span-2 text-red-700">최근 오류: {scheduleLastError}</p> : null}
        </div>
      </article>

      {progress ? (
        <article className="rounded-lg border border-stone-200 bg-white p-3 shadow-panel">
          <div className="mb-1 flex items-center justify-between gap-3">
            <p className="truncate text-xs font-semibold text-stone-700">{progress.label}</p>
            <p className={`text-xs ${progress.failed ? "text-red-700" : "text-stone-600"}`}>{progress.percent}%</p>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-stone-200">
            <div
              className={`h-full rounded-full transition-[width] duration-200 ${progress.failed ? "bg-red-500" : "bg-emerald-500"}`}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <p className={`mt-1 text-[11px] ${progress.failed ? "text-red-700" : "text-stone-600"}`}>{progress.phase}</p>
        </article>
      ) : null}

      {message ? <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
      {error ? <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">백업 파일 목록</h3>
          <button
            className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 hover:bg-red-100 disabled:opacity-60"
            type="button"
            onClick={() => void deleteAllBackupFiles()}
            disabled={running !== ""}
          >
            <Trash2 className="h-3.5 w-3.5" />
            전체 삭제
          </button>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          {backupSections.map((section) => (
            <div key={section.kind} className="rounded border border-stone-200">
              <div className="flex items-center justify-between border-b border-stone-200 px-2 py-1.5 text-xs font-semibold">
                <span>{section.label}</span>
                <span>{section.items.length}건</span>
              </div>
              <div className="max-h-52 overflow-y-auto p-2">
                {section.loading ? <p className="text-xs text-stone-500">로딩 중...</p> : null}
                {!section.loading && section.items.length === 0 ? <p className="text-xs text-stone-500">백업 파일 없음</p> : null}
                <ul className="space-y-1 text-xs">
                  {section.items.map((item) => (
                    <li key={`${item.kind}-${item.filename}`} className="rounded border border-stone-100 bg-stone-50 p-1.5">
                      <p className="truncate font-medium text-stone-800" title={item.filename}>
                        {item.filename}
                      </p>
                      <p className="text-[11px] text-stone-500">
                        {formatBytes(item.size_bytes)} · {formatDateTime(item.created_at)}
                      </p>
                      <a
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent underline"
                        href={buildApiUrl(item.download_url)}
                      >
                        <Download className="h-3 w-3" />
                        다운로드
                      </a>
                      <button
                        className="ml-2 mt-1 inline-flex items-center gap-1 rounded border border-red-200 px-1.5 py-0.5 text-[11px] text-red-700 hover:bg-red-50 disabled:opacity-60"
                        type="button"
                        onClick={() => void deleteBackupFile(item.kind, item.filename)}
                        disabled={running !== ""}
                      >
                        <Trash2 className="h-3 w-3" />
                        삭제
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </article>

      <article className="rounded-lg border border-stone-200 bg-panel p-3 shadow-panel">
        <h3 className="mb-2 text-sm font-semibold">복구(import)</h3>
        <div className="space-y-4">
          <div className="rounded border border-stone-200 p-2">
            <p className="mb-1 text-xs font-semibold">DB 복구 (별도 대상 DB)</p>
            <p className="mb-2 text-[11px] text-amber-700">
              기본은 별도 DB로만 복원됩니다. `복구 후 운영 DB 자동 전환`을 체크하면 자동으로 archive 전환까지 수행됩니다.
            </p>
            <div className="grid gap-2 md:grid-cols-[1fr_180px_auto]">
              <select className="rounded border border-stone-300 px-2 py-1.5 text-xs" value={dbFilename} onChange={(e) => setDbFilename(e.target.value)}>
                <option value="">백업 파일 선택</option>
                {filesByKind.db.map((item) => (
                  <option key={item.filename} value={item.filename}>
                    {item.filename}
                  </option>
                ))}
              </select>
              <input
                className="rounded border border-stone-300 px-2 py-1.5 text-xs"
                placeholder="target_db"
                value={dbTarget}
                onChange={(e) => setDbTarget(e.target.value)}
              />
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 px-2 py-1.5 text-xs hover:bg-stone-50 disabled:opacity-60"
                onClick={() => void restoreDb()}
                disabled={running !== "" || !dbFilename}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                DB 복구 실행
              </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
              <input
                key={dbUploadInputKey}
                type="file"
                className="rounded border border-stone-300 px-2 py-1.5 text-xs"
                accept=".dump"
                onChange={(e) => setDbUploadFile(e.target.files?.[0] ?? null)}
              />
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-2 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                onClick={() => void uploadAndRestoreDb()}
                disabled={running !== "" || !dbUploadFile}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                업로드 후 복구
              </button>
            </div>
            <label className="mt-2 inline-flex items-center gap-1 text-[11px] text-stone-700">
              <input type="checkbox" checked={dbConfirm} onChange={(e) => setDbConfirm(e.target.checked)} />
              위험 작업 확인 (confirm)
            </label>
            <label className="mt-1 inline-flex items-center gap-1 text-[11px] text-stone-700">
              <input type="checkbox" checked={dbPromoteToActive} onChange={(e) => setDbPromoteToActive(e.target.checked)} />
              복구 후 운영 DB 자동 전환 (archive)
            </label>
          </div>

          <div className="rounded border border-stone-200 p-2">
            <p className="mb-1 text-xs font-semibold">첨부파일 복구</p>
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <select className="rounded border border-stone-300 px-2 py-1.5 text-xs" value={objectsFilename} onChange={(e) => setObjectsFilename(e.target.value)}>
                <option value="">백업 파일 선택</option>
                {filesByKind.objects.map((item) => (
                  <option key={item.filename} value={item.filename}>
                    {item.filename}
                  </option>
                ))}
              </select>
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 px-2 py-1.5 text-xs hover:bg-stone-50 disabled:opacity-60"
                onClick={() => void restoreObjects()}
                disabled={running !== "" || !objectsFilename}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                첨부 복구 실행
              </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
              <input
                key={objectsUploadInputKey}
                type="file"
                className="rounded border border-stone-300 px-2 py-1.5 text-xs"
                onChange={(e) => setObjectsUploadFile(e.target.files?.[0] ?? null)}
              />
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-2 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                onClick={() => void uploadAndRestoreObjects()}
                disabled={running !== "" || !objectsUploadFile}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                업로드 후 복구
              </button>
            </div>
            <p className="mt-1 text-[11px] text-stone-500">지원 형식: `.tar.gz`, `.tgz`</p>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-stone-700">
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={objectsReplaceExisting} onChange={(e) => setObjectsReplaceExisting(e.target.checked)} />
                기존 첨부 전체 교체
              </label>
              <label className="inline-flex items-center gap-1">
                <input type="checkbox" checked={objectsConfirm} onChange={(e) => setObjectsConfirm(e.target.checked)} />
                위험 작업 확인 (confirm)
              </label>
            </div>
          </div>

          <div className="rounded border border-stone-200 p-2">
            <p className="mb-1 text-xs font-semibold">설정 복구</p>
            <p className="mb-2 text-[11px] text-stone-600">
              `preview`는 적용 대상 파일만 미리보기(실제 변경 없음), `apply`는 설정 파일을 실제로 덮어씁니다.
            </p>
            <div className="grid gap-2 md:grid-cols-[1fr_120px_auto]">
              <select className="rounded border border-stone-300 px-2 py-1.5 text-xs" value={configFilename} onChange={(e) => setConfigFilename(e.target.value)}>
                <option value="">백업 파일 선택</option>
                {filesByKind.config.map((item) => (
                  <option key={item.filename} value={item.filename}>
                    {item.filename}
                  </option>
                ))}
              </select>
              <select className="rounded border border-stone-300 px-2 py-1.5 text-xs" value={configMode} onChange={(e) => setConfigMode(e.target.value as ConfigRestoreMode)}>
                <option value="preview">preview</option>
                <option value="apply">apply</option>
              </select>
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-stone-300 px-2 py-1.5 text-xs hover:bg-stone-50 disabled:opacity-60"
                onClick={() => void restoreConfig()}
                disabled={running !== "" || !configFilename}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                설정 복구 실행
              </button>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto]">
              <input
                key={configUploadInputKey}
                type="file"
                className="rounded border border-stone-300 px-2 py-1.5 text-xs"
                onChange={(e) => setConfigUploadFile(e.target.files?.[0] ?? null)}
              />
              <button
                className="inline-flex items-center justify-center gap-1 rounded border border-indigo-300 bg-indigo-50 px-2 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                onClick={() => void uploadAndRestoreConfig()}
                disabled={running !== "" || !configUploadFile}
                type="button"
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                업로드 후 복구
              </button>
            </div>
            <p className="mt-1 text-[11px] text-stone-500">지원 형식: `.tar.gz`, `.tgz`</p>
            <label className="mt-2 inline-flex items-center gap-1 text-[11px] text-stone-700">
              <input type="checkbox" checked={configConfirm} onChange={(e) => setConfigConfirm(e.target.checked)} />
              apply 모드 위험 작업 확인 (confirm)
            </label>
            {configPreviewTotal > 0 ? (
              <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
                <p className="inline-flex items-center gap-1 font-semibold">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  복구 대상 파일 {configPreviewTotal}건
                </p>
                <ul className="mt-1 list-disc pl-4">
                  {configPreviewFiles.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </article>
    </section>
  );
}
